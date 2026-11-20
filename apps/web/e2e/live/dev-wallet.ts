// A real Midnight wallet for the live browser suite.
//
// It holds a seed in the test process, syncs against the local network with
// the wallet SDK, and answers the DApp Connector API calls the app makes: the
// page sees an injected wallet exactly as an extension would provide one,
// and every transaction it asks for is genuinely balanced, signed, proven and
// submitted. Only the transport is unusual: calls cross from the page to this
// process through a Playwright binding.
//
// It proves the way a real wallet does, through the connector's
// getProvingProvider: the page hands over each proof preimage and its key
// location, and the wallet resolves the keys and asks its proof server. A real
// wallet asks the dApp for the key bytes; this one reads the same compiler
// output from disk, which keeps a ninety-megabyte key from crossing the test
// driver (Playwright copies every request body it sees, and a body that large
// stalls it).

import { fileURLToPath } from "node:url";

import { httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { LedgerTransaction, ZKConfigRegistry } from "@midnight-ntwrk/midnight-js-types";
import { MidnightBech32m, ShieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import type {
  CombinedTokenTransfer,
  FacadeState,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import type {
  AccountKeys,
  MidnightNodeConfig,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import { createFacadeWalletProviders } from "@sig-net/midnight-examples-lib";

import { managedDirs } from "../../zk-assets.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const TTL_MS = 30 * 60 * 1000;

// A refused proof request says why only in its body, which the proving client
// drops; print it so a failure names its cause.
const plainFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await plainFetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!res.ok && /:6300\/(check|prove)/.test(url)) {
    console.log(
      `proof server ${String(res.status)} on ${url}: ${(await res.clone().text()).slice(0, 600)}`,
    );
  }
  return res;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

/** One output a dApp asks the wallet to pay, as the connector describes it. */
export interface DesiredShieldedOutput {
  readonly kind: "shielded";
  readonly type: string;
  readonly value: bigint;
  readonly recipient: string;
}

/** How long a wallet may take to report a synced state before the test is told why it waits. */
const SYNC_WAIT_MS = 10 * 60_000;

/** A synced wallet answering connector calls. */
export class DevWallet {
  private constructor(
    readonly label: string,
    readonly facade: WalletFacade,
    readonly keys: AccountKeys,
    readonly config: MidnightNodeConfig,
  ) {}

  /**
   * Open and sync a wallet through a registry, which owns its lifetime.
   *
   * @param registry - The registry for the target network.
   * @param label - A name for logs.
   * @param seed - The wallet seed, hex or mnemonic.
   * @returns The synced wallet.
   */
  static async open(registry: WalletRegistry, label: string, seed: string): Promise<DevWallet> {
    const { facade, keys } = await registry.wallet(seed, label);
    return new DevWallet(label, facade, keys, registry.config);
  }

  /**
   * @returns The latest synced state.
   * @throws {Error} When the wallet reports no synced state within ten minutes, so a test fails
   * with the cause instead of waiting on a stalled indexer for its whole budget.
   */
  async state(): Promise<FacadeState> {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the ${this.label} wallet reported no synced state in ten minutes`));
      }, SYNC_WAIT_MS);
    });
    try {
      return await Promise.race([this.facade.waitForSyncedState(), stalled]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns The bech32m shielded address the app shows and other wallets pay. */
  async shieldedAddress(): Promise<string> {
    const s = await this.state();
    return MidnightBech32m.encode(this.config.networkId, s.shielded.address).asString();
  }

  /**
   * Shielded balance of one token.
   *
   * @param tokenType - The raw token type, hex.
   * @returns Base units.
   */
  async balance(tokenType: string): Promise<bigint> {
    return (await this.state()).shielded.balances[tokenType] ?? 0n;
  }

  /**
   * Answer one connector call.
   *
   * @param method - The DApp Connector API method.
   * @param args - Its arguments.
   * @returns What the connector returns.
   * @throws {Error} For a method the app is not expected to call.
   */
  async call(method: string, args: readonly unknown[]): Promise<unknown> {
    const s = await this.state();
    switch (method) {
      case "getConfiguration":
        return {
          indexerUri: this.config.indexerUrl,
          indexerWsUri: this.config.indexerWsUrl,
          substrateNodeUri: this.config.nodeUrl,
          proverServerUri: this.config.proofServerUrl,
          networkId: this.config.networkId,
        };
      case "getConnectionStatus":
        return { status: "connected", networkId: this.config.networkId };
      case "getShieldedAddresses":
        return {
          shieldedAddress: await this.shieldedAddress(),
          shieldedCoinPublicKey: this.keys.shieldedSecretKeys.coinPublicKey,
          shieldedEncryptionPublicKey: this.keys.shieldedSecretKeys.encryptionPublicKey,
        };
      case "getUnshieldedAddress":
        return {
          unshieldedAddress: MidnightBech32m.encode(
            this.config.networkId,
            s.unshielded.address,
          ).asString(),
        };
      case "getShieldedBalances":
        return { ...s.shielded.balances };
      case "getUnshieldedBalances":
        return { ...s.unshielded.balances };
      case "getDustBalance":
        return { balance: s.dust.balance(new Date()), cap: 0n };
      case "hintUsage":
        return undefined;
      case "balanceUnsealedTransaction":
        return { tx: await this.balanceUnsealed(String(args[0])) };
      case "balanceSealedTransaction":
        return { tx: await this.balanceSealed(String(args[0])) };
      case "submitTransaction":
        await this.submit(String(args[0]));
        return undefined;
      case "provingCheck":
        return this.prover().check(bytes(String(args[0])), String(args[1]));
      case "provingProve":
        return hex(
          await this.prover().prove(
            bytes(String(args[0])),
            String(args[1]),
            typeof args[2] === "bigint" ? args[2] : undefined,
          ),
        );
      case "makeTransfer":
        return { tx: await this.transfer(args[0] as readonly DesiredShieldedOutput[]) };
      default:
        throw new Error(`the dev wallet does not implement ${method}`);
    }
  }

  #prover: ReturnType<typeof httpClientProvingProvider> | undefined;

  /** One proving provider over every Kinko contract's keys, the vault's and Signet's. */
  private prover(): ReturnType<typeof httpClientProvingProvider> {
    this.#prover ??= httpClientProvingProvider(
      this.config.proofServerUrl,
      new ZKConfigRegistry(
        [...Object.values(managedDirs(REPO_ROOT)), signetManagedDir()].map(
          (dir) => new NodeZkConfigProvider<string>(dir),
        ),
      ) as never,
      { timeout: 15 * 60 * 1000 },
    );
    return this.#prover;
  }

  private async balanceUnsealed(txHex: string): Promise<string> {
    const tx = LedgerTransaction.fromBytes("v9", "Unbound", bytes(txHex));
    const { walletProvider } = createFacadeWalletProviders(
      this.facade,
      this.keys,
      this.config.networkId,
    );
    const finalized = await walletProvider.balanceTx(tx);
    return hex(finalized.serialize());
  }

  /** Add this wallet's fee to someone else's bound transaction, such as a card's. */
  private async balanceSealed(txHex: string): Promise<string> {
    const tx = this.facade.adoptTransaction(bytes(txHex), "Finalized");
    const recipe = await this.facade.balanceFinalizedTransaction(tx, {
      ttl: new Date(Date.now() + TTL_MS),
    });
    const signed = await this.facade.signRecipe(recipe, this.keys.unshieldedKeystore.signDataAsync);
    return hex((await this.facade.finalizeRecipe(signed)).serialize());
  }

  private async submit(txHex: string): Promise<void> {
    await this.facade.submitTransaction(this.facade.adoptTransaction(bytes(txHex), "Finalized"));
  }

  private async transfer(outputs: readonly DesiredShieldedOutput[]): Promise<string> {
    const transfer: CombinedTokenTransfer = {
      type: "shielded",
      outputs: outputs.map((o) => ({
        type: o.type,
        amount: o.value,
        receiverAddress: MidnightBech32m.parse(o.recipient).decode(
          ShieldedAddress,
          this.config.networkId,
        ),
      })),
    };
    const ttl = new Date(Date.now() + TTL_MS);
    const prepared = await this.facade.transferTransaction([transfer], { ttl, payFees: false });
    const recipe = await this.facade.balanceUnprovenTransaction(prepared.transaction, { ttl });
    const signed = await this.facade.signRecipe(recipe, this.keys.unshieldedKeystore.signDataAsync);
    const finalized = await this.facade.finalizeRecipe(signed);
    return hex(finalized.serialize());
  }
}

function signetManagedDir(): string {
  return `${REPO_ROOT}engine/vault/contract/src/managed/SignetSigner`;
}

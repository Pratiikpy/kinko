// A card, opened as a wallet.
//
// The card's keys drive a wallet SDK facade like any Midnight wallet's, synced
// from the indexer, so its balance is read from the chain rather than from
// anything Kinko keeps. It spends with real proofs. It never pays a fee: every
// transaction it builds balances its own value only and is bound before it
// leaves, and a FeePayer adds the DUST and submits.
//
// A card holds only shielded tokens and never balances a fee, so its dust wallet is built
// but never started: a dust sync replays every DUST event in the chain's history, which on a
// public network would keep a card from opening for many minutes. Its unshielded wallet does
// start: a card's address has no transactions, so it syncs in seconds, and a started wallet
// is what moves to the post-fork engine when the chain's history crosses the ledger hard
// fork, as preprod's does. Left unstarted it stays on the pre-fork engine and refuses every
// transaction the card builds. A card is ready once its shielded wallet has caught up.
//
// The facade also acts at the lowest protocol version its wallets have reached, and the idle
// dust wallet never reaches one, so it reports the shielded wallet's version instead.
//
// The same object answers the DApp Connector API (`connector`), so the code
// that pays an invoice from a wallet pays it from a card unchanged.

import type { Configuration, ConnectedAPI, DesiredOutput } from "@midnightntwrk/dapp-connector-api";
import * as ledger from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { MidnightBech32m, ShieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  type FacadeState,
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { PublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import {
  catchError,
  combineLatest,
  defer,
  filter,
  firstValueFrom,
  map,
  type Observable,
  of,
  timeout,
} from "rxjs";

import type { FeePayer, FeeReceipt } from "./fees.ts";
import { type CardAddresses, cardAddresses, type CardKeys, deriveCardKeys } from "./keys.ts";
import { walletSeed } from "./seed.ts";
import { cardSnapshot } from "./snapshot.ts";

/** The services a card wallet reads from. */
export interface CardNetwork {
  readonly networkId: string;
  readonly indexerHttpUrl: string;
  readonly indexerWsUrl: string;
  /** Proves the card's spends. A local proof server keeps the card's keys on this machine. */
  readonly proofServerUrl: string;
  /** Reported to dApps through the connector. The card itself never submits. */
  readonly nodeUrl: string;
}

/** What a card holds, as last read from the chain. */
export interface CardState {
  /** True once the card has caught up with the chain. */
  readonly synced: boolean;
  /** 0 to 1 while catching up, or null before the wallet knows how far it has to go. */
  readonly progress: number | null;
  /** Shielded balances by raw token type. */
  readonly balances: Readonly<Record<string, bigint>>;
}

/** How long a card's transaction may wait before it is no longer valid. */
const TTL_MS = 30 * 60 * 1000;

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function stateOf(shielded: FacadeState["shielded"]): CardState {
  const synced = shielded.progress.isStrictlyComplete();
  const { appliedIndex, highestIndex } = shielded.progress;
  const progress =
    highestIndex > 0n ? Math.min(1, Number((appliedIndex * 1000n) / highestIndex) / 1000) : null;
  return {
    synced,
    progress: synced ? 1 : progress,
    balances: { ...shielded.balances },
  };
}

/**
 * A sub-wallet that is never started, so it never syncs. Every other call reaches the real
 * wallet, which the facade consults only for the token kind it holds, and a card only ever
 * balances shielded tokens. Its state reports the protocol version of the shielded wallet,
 * the one wallet that does sync, so the facade's version follows the chain.
 *
 * @param wallet - The sub-wallet.
 * @param shielded - The card's shielded wallet's states, read when the facade subscribes.
 * @returns The same wallet, with `start` doing nothing and a `state` that follows `shielded`.
 */
function idle<T extends { readonly state: Observable<object> }>(
  wallet: T,
  shielded: () => Observable<{ readonly protocolVersion: unknown }>,
): T {
  return new Proxy(wallet, {
    get(target, key) {
      if (key === "start") return () => Promise.resolve();
      if (key === "state") {
        return combineLatest([target.state, defer(shielded)]).pipe(
          map(
            ([own, leader]) =>
              new Proxy(own, {
                get(state, field) {
                  if (field === "protocolVersion") return leader.protocolVersion;
                  const value: unknown = Reflect.get(state, field, state);
                  return typeof value === "function"
                    ? (value as (...a: unknown[]) => unknown).bind(state)
                    : value;
                },
              }),
          ),
        );
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * How long a card started from a snapshot has to show it is working, in ms: caught up, or applying
 * events past the snapshot's. A tree that does not match the chain's makes the wallet refuse the
 * events that follow, so it never advances and never shows a wrong balance; this is how long it is
 * given before the card is started again from the chain's first event.
 */
const SNAPSHOT_PROOF_MS = 45_000;

/** A card opened as a wallet. Call {@link CardWallet.stop} when done with it. */
export class CardWallet {
  private constructor(
    readonly network: CardNetwork,
    readonly addresses: CardAddresses,
    private readonly keys: CardKeys,
    private readonly facade: WalletFacade,
    private readonly feePayer: FeePayer,
    /** Where this card's wallet started: from a published snapshot, or the chain's first event. */
    readonly startedFrom: "snapshot" | "chain",
  ) {}

  /**
   * Open a card and start syncing it.
   *
   * @param entropy - The card's entropy, from `cardEntropy`.
   * @param network - Where to sync and prove.
   * @param feePayer - Who pays the card's fees.
   * @param options - How to start. `snapshot` is a coin-free shielded wallet snapshot taken at or
   *   before the card was made (see `cardSnapshot`): the card then replays the chain from there
   *   instead of from its first event. Without it the card replays everything.
   * @param options.snapshot - A coin-free shielded snapshot to start from; none replays everything.
   * @returns The wallet, syncing.
   */
  static async open(
    entropy: Uint8Array,
    network: CardNetwork,
    feePayer: FeePayer,
    options: { readonly snapshot?: string } = {},
  ): Promise<CardWallet> {
    const { snapshot } = options;
    if (snapshot === undefined) return CardWallet.start(entropy, network, feePayer);
    // A snapshot that cannot be restored, or whose tree the chain refuses, falls back to
    // replaying the chain: a card must never be stuck because an optional shortcut failed.
    try {
      const wallet = await CardWallet.start(entropy, network, feePayer, snapshot);
      if (await wallet.advancing(SNAPSHOT_PROOF_MS)) return wallet;
      await wallet.stop();
    } catch {
      // Fall through to the chain.
    }
    return CardWallet.start(entropy, network, feePayer);
  }

  private static async start(
    entropy: Uint8Array,
    network: CardNetwork,
    feePayer: FeePayer,
    snapshot?: string,
  ): Promise<CardWallet> {
    const keys = deriveCardKeys(walletSeed(entropy), network.networkId);
    const addresses = cardAddresses(keys, network.networkId);
    const leader: {
      wallet?: Awaited<ReturnType<ReturnType<typeof ShieldedWallet>["startWithSeed"]>>;
    } = {};
    const shieldedStates = (): Observable<{ readonly protocolVersion: unknown }> => {
      if (!leader.wallet) throw new Error("the card's shielded wallet is not built yet");
      return leader.wallet.state;
    };
    const facade = await WalletFacade.init({
      configuration: {
        networkId: network.networkId,
        indexerClientConnection: {
          indexerHttpUrl: network.indexerHttpUrl,
          indexerWsUrl: network.indexerWsUrl,
        },
        provingServerUrl: new URL(network.proofServerUrl),
        relayURL: new URL(network.nodeUrl.replace(/^http/, "ws")),
        costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(
          WalletEntrySchema,
          mergeWalletEntries,
        ),
      },
      // A card never submits: its transactions go to a fee payer, which submits.
      submissionService: () => ({
        submitTransaction: (): Promise<never> =>
          Promise.reject(new Error("A card cannot submit on its own; its fee payer submits.")),
        close: () => Promise.resolve(),
      }),
      shielded: async (cfg) => {
        leader.wallet =
          snapshot === undefined
            ? await ShieldedWallet(cfg).startWithSeed(keys.seeds.shielded)
            : ShieldedWallet(cfg).restore(cardSnapshot(snapshot, addresses, network.networkId));
        return leader.wallet;
      },
      unshielded: (cfg) =>
        UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keys.unshieldedKeystore)),
      dust: async (cfg) =>
        idle(
          await DustWallet(cfg).startWithSeed(
            keys.seeds.dust,
            ledger.LedgerParameters.initialParameters().dust,
          ),
          shieldedStates,
        ),
    });
    await facade.start(keys.seeds);
    return new CardWallet(
      network,
      addresses,
      keys,
      facade,
      feePayer,
      snapshot === undefined ? "chain" : "snapshot",
    );
  }

  /**
   * Whether the wallet is working: caught up with the chain, or applying events it had not.
   *
   * @param timeoutMs - How long it has to show it.
   * @returns True as soon as it does, false when the time runs out first.
   */
  private advancing(timeoutMs: number): Promise<boolean> {
    let first: bigint | undefined;
    return firstValueFrom(
      this.facade.shielded.state.pipe(
        filter((state) => {
          const applied = state.progress.appliedIndex;
          first ??= applied;
          return state.progress.isStrictlyComplete() || applied > first;
        }),
        map(() => true),
        timeout({ first: timeoutMs, with: () => of(false) }),
        catchError(() => of(false)),
      ),
    );
  }

  /** @returns The card's state as it changes. */
  state(): Observable<CardState> {
    return this.facade.shielded.state.pipe(map(stateOf));
  }

  /** @returns The card's state once it has caught up with the chain. */
  async synced(): Promise<CardState> {
    return stateOf(await this.facade.shielded.waitForSyncedState());
  }

  /**
   * @param tokenType - Raw token type, hex.
   * @returns The card's balance of it, once synced.
   */
  async balance(tokenType: string): Promise<bigint> {
    return (await this.synced()).balances[tokenType] ?? 0n;
  }

  /**
   * Send the card's whole balance of one token to an address.
   *
   * @param tokenType - Raw token type, hex.
   * @param recipient - Bech32m shielded address.
   * @param feePayer - Who pays this transfer's fee; the card's own payer unless given.
   * @returns What was moved, and who paid the fee.
   * @throws {Error} When the card holds none of it.
   */
  async sweep(
    tokenType: string,
    recipient: string,
    feePayer: FeePayer = this.feePayer,
  ): Promise<{ amount: bigint } & FeeReceipt> {
    const amount = await this.balance(tokenType);
    if (amount === 0n) throw new Error("This card holds nothing to move.");
    const tx = await this.transfer([
      { kind: "shielded", type: tokenType, value: amount, recipient },
    ]);
    const receipt = await feePayer.pay(tx);
    return { amount, ...receipt };
  }

  /**
   * The card's shielded wallet as a snapshot: the commitment tree as of the last event it
   * applied, and the coins it holds. For a wallet that holds no coin, this is what
   * {@link cardSnapshot} turns into the start of any card made after it.
   *
   * @returns The snapshot, as the wallet serializes it.
   */
  snapshot(): Promise<string> {
    return this.facade.shielded.serializeState();
  }

  /** Stop syncing. The card can be opened again from its secret at any time. */
  async stop(): Promise<void> {
    await this.facade.stop();
  }

  private async bind(recipe: Parameters<WalletFacade["signRecipe"]>[0]): Promise<string> {
    const signed = await this.facade.signRecipe(recipe, this.keys.unshieldedKeystore.signDataAsync);
    const finalized = await this.facade.finalizeRecipe(signed);
    return hex(finalized.serialize());
  }

  /**
   * Build, prove and bind a shielded transfer from the card, with no fee.
   *
   * @param outputs - What to pay, as the connector describes it.
   * @returns The bound transaction, hex.
   */
  private async transfer(outputs: readonly DesiredOutput[]): Promise<string> {
    const ttl = new Date(Date.now() + TTL_MS);
    const prepared = await this.facade.transferTransaction(
      [
        {
          type: "shielded",
          outputs: outputs.map((o) => {
            if (o.kind !== "shielded") throw new Error("A card pays only shielded outputs.");
            return {
              type: o.type,
              amount: o.value,
              receiverAddress: MidnightBech32m.parse(o.recipient).decode(
                ShieldedAddress,
                this.network.networkId,
              ),
            };
          }),
        },
      ],
      { ttl, payFees: false },
    );
    const recipe = await this.facade.balanceUnprovenTransaction(prepared.transaction, {
      ttl,
      tokenKindsToBalance: ["shielded"],
    });
    return this.bind(recipe);
  }

  /**
   * Balance a dApp's proven, unbound transaction with the card's own coins, and bind it.
   *
   * @param txHex - The dApp's transaction, hex.
   * @returns The bound transaction, hex.
   */
  private async balanceUnsealed(txHex: string): Promise<string> {
    const tx = this.facade.adoptTransaction(bytes(txHex), "Unbound");
    const recipe = await this.facade.balanceUnboundTransaction(tx, {
      ttl: new Date(Date.now() + TTL_MS),
      tokenKindsToBalance: ["shielded"],
    });
    return this.bind(recipe);
  }

  /**
   * The card as a DApp Connector, for code that already pays from a wallet.
   *
   * Balancing never adds a fee, and submitting hands the bound transaction to
   * the card's fee payer. Methods a card cannot honour refuse with a reason.
   * It offers no proving provider, so a dApp proves through its own proof
   * server, the same path it takes for a wallet that does not prove.
   *
   * @param circuitHint - Told to a sponsor alongside each submission.
   * @returns The connector.
   */
  connector(circuitHint?: string): ConnectedAPI {
    const configuration: Configuration = {
      indexerUri: this.network.indexerHttpUrl,
      indexerWsUri: this.network.indexerWsUrl,
      proverServerUri: this.network.proofServerUrl,
      substrateNodeUri: this.network.nodeUrl,
      networkId: this.network.networkId,
    };
    const cannot = (what: string) => (): Promise<never> =>
      Promise.reject(new Error(`A Kinko card cannot ${what}.`));
    const api = {
      getConfiguration: () => Promise.resolve(configuration),
      getConnectionStatus: () =>
        Promise.resolve({ status: "connected", networkId: this.network.networkId }),
      getShieldedAddresses: () =>
        Promise.resolve({
          shieldedAddress: this.addresses.shielded,
          shieldedCoinPublicKey: this.addresses.coinPublicKey,
          shieldedEncryptionPublicKey: this.addresses.encryptionPublicKey,
        }),
      getShieldedBalances: async () => ({ ...(await this.synced()).balances }),
      getUnshieldedBalances: () => Promise.resolve({}),
      getDustBalance: () => Promise.resolve({ balance: 0n, cap: 0n }),
      getUnshieldedAddress: cannot("receive unshielded tokens"),
      getDustAddress: cannot("hold DUST"),
      getTxHistory: () => Promise.resolve([]),
      hintUsage: () => Promise.resolve(),
      balanceUnsealedTransaction: async (tx: string) => ({ tx: await this.balanceUnsealed(tx) }),
      balanceSealedTransaction: cannot("pay another transaction's fee"),
      makeTransfer: async (outputs: DesiredOutput[]) => ({ tx: await this.transfer(outputs) }),
      makeIntent: cannot("make swap intents"),
      signData: cannot("sign data"),
      submitTransaction: async (tx: string) => {
        await this.feePayer.pay(tx, circuitHint);
      },
    };
    return api as unknown as ConnectedAPI;
  }
}

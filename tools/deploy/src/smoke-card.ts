// A live smoke test of card wallets, from Node: a payer funds a fresh gift
// card, the card pays a merchant's invoice with Kinko's sponsor paying the fee,
// and the payer's own wallet pays the fee to sweep the rest back. Balances are
// read from the chain after each step.
//
//   yarn workspace @kinko/sponsor start      (in another shell)
//   yarn workspace @kinko/deploy smoke:card
//
// Reads the root .env (seeds, network) and deployments/<network>.json.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CardWallet, type FeePayer, newCardSecret, sponsorFeePayer } from "@kinko/card";
import {
  emptyPayPrivateState,
  invoiceCommitmentOf,
  KinkoPay,
  newInvoiceSecrets,
  newPaymentSecrets,
  ownerTagOf,
  type PayPrivateState,
  toHex,
} from "@kinko/kinko-pay";
import {
  findDeployedContract,
  withContractScopedTransaction,
} from "@midnight-ntwrk/midnight-js/contracts";
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
} from "@midnight-ntwrk/midnight-js/types";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";
import * as ledger from "@midnightntwrk/ledger-v9";
import { MidnightBech32m, ShieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import {
  getMidnightNodeConfig,
  type MidnightNodeConfig,
  type RegisteredWallet,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import {
  createCrossContractProofServerProvider,
  createFacadeWalletProviders,
  type FacadeWalletProviders,
} from "@sig-net/midnight-examples-lib";

import { MANAGED_PATHS, payCompiled } from "./bindings.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FUND = 3_000_000n;
const INVOICE = 1_000_000n;
const TTL_MS = 30 * 60 * 1000;
const STORE_PASSWORD = `Kinko-${randomBytes(12).toString("hex")}-Card`;

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

function env(): Record<string, string | undefined> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(
    resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env"),
    "utf8",
  ).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return { ...out, ...process.env };
}

async function timed<T>(what: string, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`${what}...`);
  const out = await work();
  console.log(`${what}: ${String(Date.now() - start)} ms`);
  return out;
}

async function until(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/**
 * A funded wallet as a DApp Connector, enough to pay a card's fee.
 *
 * @param wallet - The funded wallet.
 * @returns The two connector calls a fee payer makes.
 */
function walletConnector(wallet: RegisteredWallet): ConnectedAPI {
  return {
    balanceSealedTransaction: async (txHex: string) => {
      const tx = wallet.facade.adoptTransaction(bytes(txHex), "Finalized");
      const recipe = await wallet.facade.balanceFinalizedTransaction(tx, {
        ttl: new Date(Date.now() + TTL_MS),
      });
      const signed = await wallet.facade.signRecipe(
        recipe,
        wallet.keys.unshieldedKeystore.signDataAsync,
      );
      return { tx: hex((await wallet.facade.finalizeRecipe(signed)).serialize()) };
    },
    submitTransaction: async (txHex: string) => {
      await wallet.facade.submitTransaction(
        wallet.facade.adoptTransaction(bytes(txHex), "Finalized"),
      );
    },
  } as unknown as ConnectedAPI;
}

/**
 * A shielded transfer from a funded wallet, paid entirely by that wallet.
 *
 * @param wallet - The sender.
 * @param config - The network.
 * @param token - Raw token type, hex.
 * @param to - Bech32m shielded address.
 * @param amount - Base units.
 */
async function send(
  wallet: RegisteredWallet,
  config: MidnightNodeConfig,
  token: string,
  to: string,
  amount: bigint,
) {
  const ttl = new Date(Date.now() + TTL_MS);
  const receiverAddress = MidnightBech32m.parse(to).decode(ShieldedAddress, config.networkId);
  const prepared = await wallet.facade.transferTransaction(
    [{ type: "shielded", outputs: [{ type: token, amount, receiverAddress }] }],
    { ttl, payFees: false },
  );
  const recipe = await wallet.facade.balanceUnprovenTransaction(prepared.transaction, { ttl });
  const signed = await wallet.facade.signRecipe(
    recipe,
    wallet.keys.unshieldedKeystore.signDataAsync,
  );
  await wallet.facade.submitTransaction(await wallet.facade.finalizeRecipe(signed));
}

const balanceOf = async (wallet: RegisteredWallet, token: string): Promise<bigint> =>
  (await wallet.facade.waitForSyncedState()).shielded.balances[token] ?? 0n;

const e = env();
const config = getMidnightNodeConfig(e);
const deployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", `${config.networkId}.json`), "utf8"),
) as { pay: { contractAddress: string }; kusdColor: string };
const kusd = deployment.kusdColor;
const sponsor: FeePayer = sponsorFeePayer({
  endpoint: e.KINKO_SPONSOR_URL ?? "http://127.0.0.1:3300",
});
const registry = new WalletRegistry(config, e);
let card: CardWallet | undefined;
try {
  const merchant = await registry.wallet(e.BEARER_SEED ?? "", "merchant");
  const payer = await registry.wallet(e.USER_SEED ?? "", "payer");

  card = await timed("open a fresh gift card", () =>
    CardWallet.open(
      newCardSecret(),
      {
        networkId: config.networkId,
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
        proofServerUrl: config.proofServerUrl,
        nodeUrl: config.nodeUrl,
      },
      sponsor,
    ),
  );
  const theCard = card;
  console.log(`card ${theCard.addresses.shielded}`);
  await timed("payer funds the card with 3 KUSD", () =>
    send(payer, config, kusd, theCard.addresses.shielded, FUND),
  );
  await timed("card sees 3 KUSD", () =>
    until("card funding", async () => (await theCard.balance(kusd)) === FUND),
  );

  // The merchant opens a $1 invoice.
  const m = joinPay(merchant, config, merchant.keys.shieldedSecretKeys.coinPublicKey);
  const { salt, ownerSecret } = newInvoiceSecrets();
  const terms = {
    merchantKey: new Uint8Array(32).fill(9),
    payout: bytes(merchant.keys.shieldedSecretKeys.coinPublicKey),
    amount: INVOICE,
    kind: KinkoPay.InvoiceKind.STANDARD,
    token: KinkoPay.TokenKind.KUSD,
    salt,
    owner: ownerTagOf(ownerSecret),
    expiresAt: 0n,
  };
  const base: PayPrivateState = {
    ...emptyPayPrivateState(),
    merchantKey: terms.merchantKey,
    merchantPayout: { bytes: terms.payout },
    salt,
    // What the payer's link carries: the invoice's public owner tag.
    invoiceOwner: terms.owner,
    amount: INVOICE,
  };
  const mc = await findDeployedContract(
    m as never,
    {
      contractAddress: deployment.pay.contractAddress,
      compiledContract: payCompiled,
      privateStateId: "kinko_pay",
      initialPrivateState: { ...base, ownerSecret },
    } as never,
  );
  await timed("merchant creates a $1 invoice", () =>
    (
      mc as unknown as { callTx: { create_invoice: (...a: unknown[]) => Promise<unknown> } }
    ).callTx.create_invoice(terms.kind, terms.token, terms.expiresAt),
  );
  console.log(`invoice ${toHex(invoiceCommitmentOf(terms))}`);
  const merchantBefore = await balanceOf(merchant, kusd);

  // The card pays it. The card has no DUST: the sponsor pays the fee.
  const api = theCard.connector("settle_invoice");
  const cardProviders = joinPay(
    undefined,
    config,
    theCard.addresses.coinPublicKey,
    api,
    theCard.addresses.encryptionPublicKey,
  );
  const payment = newPaymentSecrets(bytes(theCard.addresses.coinPublicKey));
  const pc = await findDeployedContract(
    cardProviders as never,
    {
      contractAddress: deployment.pay.contractAddress,
      compiledContract: payCompiled,
      privateStateId: "kinko_pay",
      initialPrivateState: {
        ...base,
        payerKey: payment.payerKey,
        payerRefund: { bytes: payment.refundTo },
        paymentIndex: payment.index,
      },
    } as never,
  );
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: bytes(kusd),
    value: INVOICE,
  };
  const encKey = (
    await merchant.facade.waitForSyncedState()
  ).shielded.address.encryptionPublicKeyString();
  await timed("card pays the invoice, sponsor pays the fee", () =>
    withContractScopedTransaction(
      cardProviders as never,
      async (ctx: unknown) => {
        await (
          pc as unknown as { callTx: { settle_invoice: (...a: unknown[]) => Promise<unknown> } }
        ).callTx.settle_invoice(ctx, terms.kind, terms.token, coin);
      },
      {
        additionalCoinEncPublicKeyMappings: new Map([
          [merchant.keys.shieldedSecretKeys.coinPublicKey, encKey],
        ]),
      },
    ),
  );
  await timed("merchant receives $1", () =>
    until(
      "merchant payout",
      async () => (await balanceOf(merchant, kusd)) === merchantBefore + INVOICE,
    ),
  );
  await timed("card holds $2", () =>
    until("card change", async () => (await theCard.balance(kusd)) === FUND - INVOICE),
  );

  // The payer moves what is left back, paying the fee from their own wallet.
  const payerBefore = await balanceOf(payer, kusd);
  const payerAddress = MidnightBech32m.encode(
    config.networkId,
    (await payer.facade.waitForSyncedState()).shielded.address,
  ).asString();
  const swept = await timed("sweep the card back, payer's wallet pays the fee", () =>
    theCard.sweep(kusd, payerAddress, walletFeePayerFor(payer)),
  );
  console.log(`swept ${String(swept.amount)}, fee paid by ${swept.paidBy}`);
  await timed("payer receives $2", () =>
    until("sweep", async () => (await balanceOf(payer, kusd)) === payerBefore + FUND - INVOICE),
  );
  await timed("card is empty", () =>
    until("empty card", async () => (await theCard.balance(kusd)) === 0n),
  );
  console.log(
    "PASS: funded, paid an invoice with a sponsored fee, swept back with a wallet-paid fee",
  );
} finally {
  await card?.stop();
  await registry.close();
}

function walletFeePayerFor(wallet: RegisteredWallet): FeePayer {
  const api = walletConnector(wallet);
  return {
    kind: "wallet",
    async pay(tx) {
      const { tx: balanced } = await api.balanceSealedTransaction(tx, { payFees: true });
      await api.submitTransaction(balanced);
      return { paidBy: "wallet" };
    },
  };
}

/**
 * Providers for calling kinko_pay as one party: a registered wallet, or a card's connector.
 *
 * @param wallet - A funded wallet, or undefined for a card.
 * @param config - The network.
 * @param coinPublicKey - The caller's coin key, hex.
 * @param api - The card's connector, when the caller is a card.
 * @param encryptionPublicKey - The card's encryption key, hex.
 * @returns The provider set.
 */
function joinPay(
  wallet: RegisteredWallet | undefined,
  config: MidnightNodeConfig,
  coinPublicKey: string,
  api?: ConnectedAPI,
  encryptionPublicKey?: string,
) {
  const zk = new NodeZkConfigProvider<string>(MANAGED_PATHS.pay);
  const store = mkdtempSync(join(tmpdir(), "kinko-card-smoke-"));
  const { walletProvider, midnightProvider } = api
    ? connectorProviders(api, coinPublicKey, encryptionPublicKey ?? "")
    : facadeProviders(wallet, config);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: join(store, "ps"),
      signingKeyStoreName: join(store, "keys"),
      accountId: coinPublicKey,
      privateStoragePasswordProvider: () => STORE_PASSWORD,
    }),
    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),
    zkConfigProvider: zk,
    proofProvider: createCrossContractProofServerProvider(config.proofServerUrl, [zk]),
    walletProvider,
    midnightProvider,
    config: { networkId: config.networkId, ttlSeconds: TTL_MS / 1000 },
  };
}

/**
 * The wallet halves of a provider set over a card's connector, which balances and submits
 * through the card and its fee payer.
 *
 * @param api - The card's connector.
 * @param coinPublicKey - The card's coin key, hex.
 * @param encryptionPublicKey - The card's encryption key, hex.
 * @returns The balancer and the submitter.
 */
function connectorProviders(
  api: ConnectedAPI,
  coinPublicKey: string,
  encryptionPublicKey: string,
): FacadeWalletProviders {
  return {
    walletProvider: createLedger9WalletProvider({
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
      balanceTx: async (tx) => {
        const { tx: balanced } = await api.balanceUnsealedTransaction(hex(tx.serialize()));
        return bytes(balanced);
      },
    }),
    midnightProvider: createLedger9MidnightProvider(async (tx) => {
      await api.submitTransaction(hex(tx.serialize()));
      const [id] = tx.deserialize({ v9: ledger.Transaction }).identifiers();
      if (!id) throw new Error("the submitted transaction has no identifier");
      return id;
    }),
  };
}

/**
 * The wallet halves of a provider set over a registered wallet, which pays its own fee.
 *
 * @param wallet - The wallet.
 * @param config - The network.
 * @returns The balancer and the submitter.
 * @throws {Error} When there is no wallet.
 */
function facadeProviders(
  wallet: RegisteredWallet | undefined,
  config: MidnightNodeConfig,
): FacadeWalletProviders {
  if (!wallet) throw new Error("a party needs a wallet or a card");
  return createFacadeWalletProviders(wallet.facade, wallet.keys, config.networkId);
}

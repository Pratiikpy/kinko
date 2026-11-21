// A live smoke test of the batch circuit, from Node and without a browser: a merchant wallet
// creates four invoices on the deployed kinko_pay, a payer wallet pays all four in one
// settle_batch call with real proofs, and then the merchant refunds one of the four payments with
// the payer's secrets. The app pays batches as plain transfers, so this is the only live run of
// the circuit. It checks, on chain, that
//
//   - each receipt the batch returns is the receipt the app recomputes from the payer's keys,
//   - the payer is out the batch total and the merchant is paid,
//   - one batch payment is refunded to the payer's own key, and only once.
//
//   yarn workspace @kinko/deploy smoke:batch
//
// Reads the root .env (seeds, network) and deployments/<network>.json.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  emptyPayPrivateState,
  invoiceCommitmentOf,
  KinkoPay,
  newInvoiceSecrets,
  newPaymentSecrets,
  ownerTagOf,
  type PayPrivateState,
  receiptOf,
  toHex,
} from "@kinko/kinko-pay";
import {
  findDeployedContract,
  withContractScopedTransaction,
} from "@midnight-ntwrk/midnight-js/contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import {
  getMidnightNodeConfig,
  type RegisteredWallet,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import {
  createCrossContractProofServerProvider,
  createFacadeWalletProviders,
} from "@sig-net/midnight-examples-lib";

import { MANAGED_PATHS, payCompiled } from "./bindings.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Four small invoices, $0.10 to $0.40, so the batch moves $1.00 in all. */
const AMOUNTS = [100_000n, 200_000n, 300_000n, 400_000n] as const;
const TOTAL = AMOUNTS.reduce((sum, a) => sum + a, 0n);
const REFUNDED = 2; // the third invoice's payment is the one refunded
const CALL_TTL_SECONDS = 30 * 60;
const SMOKE_PASSWORD = `Kinko-${randomBytes(12).toString("hex")}-Smoke`;

function env(): Record<string, string | undefined> {
  const file = resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env");
  const out: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
    }
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

function join_(wallet: RegisteredWallet, config: ReturnType<typeof getMidnightNodeConfig>) {
  const zk = new NodeZkConfigProvider<string>(MANAGED_PATHS.pay);
  const store = mkdtempSync(join(tmpdir(), "kinko-smoke-batch-"));
  const { walletProvider, midnightProvider } = createFacadeWalletProviders(
    wallet.facade,
    wallet.keys,
    config.networkId,
  );
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: join(store, "ps"),
      signingKeyStoreName: join(store, "keys"),
      accountId: walletProvider.getCoinPublicKey(),
      privateStoragePasswordProvider: () => SMOKE_PASSWORD,
    }),
    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),
    zkConfigProvider: zk,
    proofProvider: createCrossContractProofServerProvider(config.proofServerUrl, [zk]),
    walletProvider,
    midnightProvider,
    config: { networkId: config.networkId, ttlSeconds: CALL_TTL_SECONDS },
  };
  return { providers, walletProvider };
}

type CallTx = Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;

function circuit(contract: unknown, name: string): (...a: unknown[]) => Promise<unknown> {
  const fn = (contract as { callTx: CallTx }).callTx[name];
  if (!fn) throw new Error(`the contract has no circuit called ${name}`);
  return fn;
}

const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const fill = (n: number): Uint8Array => new Uint8Array(32).fill(n);

const e = env();
const config = getMidnightNodeConfig(e);
const deployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", `${config.networkId}.json`), "utf8"),
) as { pay: { contractAddress: string }; kusdColor: string };
const registry = new WalletRegistry(config, e);
try {
  const merchant = await registry.wallet(e.BEARER_SEED ?? "", "merchant");
  const payer = await registry.wallet(e.USER_SEED ?? "", "payer");
  const m = join_(merchant, config);
  const p = join_(payer, config);
  const merchantKusd = async (): Promise<bigint> =>
    (await merchant.facade.waitForSyncedState()).shielded.balances[deployment.kusdColor] ?? 0n;
  const payerKusd = async (): Promise<bigint> =>
    (await payer.facade.waitForSyncedState()).shielded.balances[deployment.kusdColor] ?? 0n;
  const merchantEnc = (
    await merchant.facade.waitForSyncedState()
  ).shielded.address.encryptionPublicKeyString();
  const payerEnc = (
    await payer.facade.waitForSyncedState()
  ).shielded.address.encryptionPublicKeyString();
  const merchantBefore = await merchantKusd();
  const payerBefore = await payerKusd();
  console.log(`before: merchant ${String(merchantBefore)} payer ${String(payerBefore)}`);
  if (payerBefore < TOTAL) throw new Error(`the payer holds ${String(payerBefore)} KUSD`);

  const payout = bytes(m.walletProvider.getCoinPublicKey());
  const invoices = AMOUNTS.map((amount, i) => {
    const { salt, ownerSecret } = newInvoiceSecrets();
    const terms = {
      merchantKey: fill(0x71 + i),
      payout,
      amount,
      kind: KinkoPay.InvoiceKind.STANDARD,
      token: KinkoPay.TokenKind.KUSD,
      salt,
      owner: ownerTagOf(ownerSecret),
      expiresAt: 0n,
    };
    return { terms, salt, ownerSecret, amount };
  });

  // The merchant publishes the four invoices, each from its own private state.
  for (const [i, inv] of invoices.entries()) {
    const state: PayPrivateState = {
      ...emptyPayPrivateState(),
      merchantKey: inv.terms.merchantKey,
      merchantPayout: { bytes: payout },
      salt: inv.salt,
      amount: inv.amount,
      ownerSecret: inv.ownerSecret,
    };
    const mc = await findDeployedContract(
      m.providers as never,
      {
        contractAddress: deployment.pay.contractAddress,
        compiledContract: payCompiled,
        privateStateId: `kinko_pay_batch_${String(i)}`,
        initialPrivateState: state,
      } as never,
    );
    await timed(`create_invoice ${String(i)}`, () =>
      circuit(mc, "create_invoice")(inv.terms.kind, inv.terms.token, inv.terms.expiresAt),
    );
  }

  // The payer pays all four in one call.
  const payment = newPaymentSecrets(bytes(p.walletProvider.getCoinPublicKey()), bytes(payerEnc));
  const batchState: PayPrivateState = {
    ...emptyPayPrivateState(),
    payerKey: payment.payerKey,
    payerRefund: { bytes: payment.refundTo },
    payerRefundEnc: payment.refundEnc,
    paymentIndex: payment.index,
    batchAmounts: invoices.map((i) => i.amount),
    batchSalts: invoices.map((i) => i.salt),
    batchOwners: invoices.map((i) => i.terms.owner),
    batchMerchants: invoices.map((i) => i.terms.merchantKey),
    batchPayouts: invoices.map(() => ({ bytes: payout })),
    batchIndices: invoices.map(() => 0n),
  };
  const pc = await findDeployedContract(
    p.providers as never,
    {
      contractAddress: deployment.pay.contractAddress,
      compiledContract: payCompiled,
      privateStateId: "kinko_pay_batch_payer",
      initialPrivateState: batchState,
    } as never,
  );
  const kusd = bytes(deployment.kusdColor);
  const coins = invoices.map((i) => ({
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: kusd,
    value: i.amount,
  }));
  let returned: readonly Uint8Array[] = [];
  await timed("settle_batch (four invoices, one proof)", () =>
    withContractScopedTransaction(
      p.providers as never,
      async (ctx: unknown) => {
        const out = (await circuit(pc, "settle_batch")(
          ctx,
          KinkoPay.InvoiceKind.STANDARD,
          KinkoPay.TokenKind.KUSD,
          coins,
        )) as { private?: { result?: readonly Uint8Array[] } } | readonly Uint8Array[];
        returned = Array.isArray(out)
          ? out
          : ((out as { private?: { result?: readonly Uint8Array[] } }).private?.result ?? []);
      },
      {
        additionalCoinEncPublicKeyMappings: new Map([
          [m.walletProvider.getCoinPublicKey(), merchantEnc],
        ]),
      },
    ),
  );

  // Each receipt the batch made is the one the app recomputes from the payer's own keys.
  for (const [i, inv] of invoices.entries()) {
    const expected = toHex(
      receiptOf(invoiceCommitmentOf(inv.terms), KinkoPay.InvoiceKind.STANDARD, payment),
    );
    const got = returned[i] ? toHex(returned[i]) : "(not returned)";
    console.log(`receipt ${String(i)}: ${got === expected ? "matches" : `DIFFERS ${got}`}`);
    if (returned.length > 0 && got !== expected) throw new Error(`receipt ${String(i)} differs`);
  }

  const wait = async (read: () => Promise<bigint>, want: bigint, what: string): Promise<void> => {
    const until = Date.now() + 15 * 60_000;
    for (;;) {
      const now = await read();
      if (now === want) return;
      if (Date.now() > until)
        throw new Error(`${what} is ${String(now)}, expected ${String(want)}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  };
  await wait(payerKusd, payerBefore - TOTAL, "the payer's KUSD after the batch");
  await wait(merchantKusd, merchantBefore + TOTAL, "the merchant's KUSD after the batch");
  console.log(`after batch: merchant +${String(TOTAL)} payer -${String(TOTAL)}`);

  // The merchant refunds one batch payment, naming it with the payer's secrets.
  const inv = invoices[REFUNDED];
  if (!inv) throw new Error("no invoice to refund");
  const refundState: PayPrivateState = {
    ...emptyPayPrivateState(),
    merchantKey: inv.terms.merchantKey,
    merchantPayout: { bytes: payout },
    salt: inv.salt,
    amount: inv.amount,
    ownerSecret: inv.ownerSecret,
    payerKey: payment.payerKey,
    payerRefund: { bytes: payment.refundTo },
    payerRefundEnc: payment.refundEnc,
    paymentIndex: payment.index,
  };
  const rc = await findDeployedContract(
    m.providers as never,
    {
      contractAddress: deployment.pay.contractAddress,
      compiledContract: payCompiled,
      privateStateId: "kinko_pay_batch_refund",
      initialPrivateState: refundState,
    } as never,
  );
  const refundCoin = () => ({
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: kusd,
    value: inv.amount,
  });
  await timed("refund_payment (one batch payment)", () =>
    withContractScopedTransaction(
      m.providers as never,
      async (ctx: unknown) => {
        await circuit(rc, "refund_payment")(ctx, inv.terms.kind, inv.terms.token, refundCoin());
      },
      {
        additionalCoinEncPublicKeyMappings: new Map([[toHex(payment.refundTo), payerEnc]]),
      },
    ),
  );
  await wait(payerKusd, payerBefore - TOTAL + inv.amount, "the payer's KUSD after the refund");
  await wait(
    merchantKusd,
    merchantBefore + TOTAL - inv.amount,
    "the merchant's KUSD after the refund",
  );
  console.log(`after refund: payer got ${String(inv.amount)} back`);

  // A second refund of the same payment is refused.
  let refused = "";
  try {
    await withContractScopedTransaction(
      m.providers as never,
      async (ctx: unknown) => {
        await circuit(rc, "refund_payment")(ctx, inv.terms.kind, inv.terms.token, refundCoin());
      },
      {
        additionalCoinEncPublicKeyMappings: new Map([[toHex(payment.refundTo), payerEnc]]),
      },
    );
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  console.log(
    `second refund: ${refused.includes("already refunded") ? "refused" : `NOT REFUSED (${refused})`}`,
  );
  if (!refused.includes("already refunded")) throw new Error("the second refund was not refused");
  console.log("batch smoke passed");
} finally {
  await registry.close();
}

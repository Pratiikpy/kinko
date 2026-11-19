// A live smoke test of the payment path, from Node and without a browser: a
// merchant wallet creates a $1 invoice on the deployed kinko_pay and a payer
// wallet pays it, with real proofs from the configured proof server. Each step
// is timed, so a slow or stalled step is named.
//
//   yarn workspace @kinko/deploy smoke:pay
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
  type PayPrivateState,
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
const AMOUNT = 1_000_000n;
// Every call transaction expires 30 min out.
const CALL_TTL_SECONDS = 30 * 60;
// The private-state store is a throwaway per run; its password only has to pass the rules.
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
  // A fresh store per run: it is encrypted with this run's password.
  const store = mkdtempSync(join(tmpdir(), "kinko-smoke-"));
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

/**
 * A circuit of a joined contract.
 *
 * @param contract - The contract midnight-js joined.
 * @param name - The circuit.
 * @returns The circuit's call.
 * @throws {Error} When the compiled contract has no such circuit.
 */
function circuit(contract: unknown, name: string): (...a: unknown[]) => Promise<unknown> {
  const fn = (contract as { callTx: CallTx }).callTx[name];
  if (!fn) throw new Error(`the contract has no circuit called ${name}`);
  return fn;
}

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
  const merchantState = await merchant.facade.waitForSyncedState();
  const { salt, ownerSecret } = newInvoiceSecrets();
  const terms = {
    merchantKey: new Uint8Array(32).fill(7),
    payout: new Uint8Array(Buffer.from(m.walletProvider.getCoinPublicKey(), "hex")),
    amount: AMOUNT,
    kind: KinkoPay.InvoiceKind.STANDARD,
    token: KinkoPay.TokenKind.KUSD,
    salt,
    expiresAt: 0n,
  };
  const base: PayPrivateState = {
    ...emptyPayPrivateState(),
    merchantKey: terms.merchantKey,
    merchantPayout: { bytes: terms.payout },
    salt,
    amount: AMOUNT,
  };

  const mc = await timed("merchant joins kinko_pay", () =>
    findDeployedContract(
      m.providers as never,
      {
        contractAddress: deployment.pay.contractAddress,
        compiledContract: payCompiled,
        privateStateId: "kinko_pay",
        initialPrivateState: { ...base, ownerSecret },
      } as never,
    ),
  );
  await timed("create_invoice", () =>
    circuit(mc, "create_invoice")(terms.kind, terms.token, terms.expiresAt),
  );
  console.log(`invoice ${toHex(invoiceCommitmentOf(terms))}`);

  const payment = newPaymentSecrets(
    new Uint8Array(Buffer.from(p.walletProvider.getCoinPublicKey(), "hex")),
  );
  const pc = await timed("payer joins kinko_pay", () =>
    findDeployedContract(
      p.providers as never,
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
    ),
  );
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: new Uint8Array(Buffer.from(deployment.kusdColor, "hex")),
    value: AMOUNT,
  };
  const encKey = merchantState.shielded.address.encryptionPublicKeyString();
  await timed("settle_invoice (scoped, with the payout's encryption key)", () =>
    withContractScopedTransaction(
      p.providers as never,
      async (ctx: unknown) => {
        await circuit(pc, "settle_invoice")(ctx, terms.kind, terms.token, coin);
      },
      {
        additionalCoinEncPublicKeyMappings: new Map([
          [m.walletProvider.getCoinPublicKey(), encKey],
        ]),
      },
    ),
  );
  console.log("paid");
} finally {
  await registry.close();
}

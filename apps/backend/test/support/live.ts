// The whole backend on a real contract: a fake indexer serves the state of an
// in-process `kinko_pay` over GraphQL, and the app reads it through the shipped
// provider and decoder. Used by the end-to-end tests and by the client tests,
// which drive the SDK, CLI, MCP server and bot against it.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { fromHex, generateOracleKeypair, KinkoPay, ownerTagOf } from "@kinko/kinko-pay";
import { Asset, type Invoice } from "@kinko/node";

import { createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { silentLogger } from "../../src/log.ts";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { ChainSim, INDEXER_BLOCK, START, type TestInvoice } from "./chain-sim.ts";
import { baseEnv, FakeDeliverer } from "./fixtures.ts";

/** The bot's service token in live tests. */
export const BOT_TOKEN = "b".repeat(40);

/** A running backend on a real contract. */
export interface LiveApp {
  readonly app: ReturnType<typeof createApp>;
  readonly base: string;
  readonly sim: ChainSim;
  readonly deliverer: FakeDeliverer;
  readonly oracle: ReturnType<typeof generateOracleKeypair>;
  /** The backend's clock, in milliseconds. */
  readonly clock: { now: number };
  stop(): Promise<void>;
}

/**
 * Start the backend against a fresh in-process contract.
 *
 * @param env - Extra configuration.
 * @returns The running backend and the handles to drive it.
 */
export const startLiveApp = async (env: Record<string, string> = {}): Promise<LiveApp> => {
  const oracle = generateOracleKeypair();
  const sim = await ChainSim.deploy(oracle.publicKey);
  const clock = { now: Number(START) * 1000 };
  const deliverer = new FakeDeliverer();
  const indexer: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            block: INDEXER_BLOCK,
            contract: { state: Buffer.from(sim.contractState().serialize()).toString("hex") },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => indexer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((indexer.address() as AddressInfo).port)}/api/v4/graphql`;
  const config = loadConfig(
    baseEnv({
      KINKO_INDEXER_URL: url,
      KINKO_BOT_TOKEN: BOT_TOKEN,
      KINKO_ORACLE_SECRET_KEY: oracle.secretKey.toString(16),
      KINKO_ORACLE_KUSD_PER_NIGHT: "0.0913",
      KINKO_ALLOW_PRIVATE_WEBHOOKS: "true",
      ...env,
    }),
  );
  const app = createApp(config, {
    clock: () => clock.now,
    deliverer,
    store: new SqliteStore(":memory:"),
    log: silentLogger,
  });
  const base = `http://127.0.0.1:${String(await app.start({ background: false }))}`;
  return {
    app,
    base,
    sim,
    deliverer,
    oracle,
    clock,
    async stop() {
      await app.stop();
      await new Promise<void>((resolve) =>
        indexer.close(() => {
          resolve();
        }),
      );
    },
  };
};

const KIND: Record<string, KinkoPay.InvoiceKind> = {
  standard: KinkoPay.InvoiceKind.STANDARD,
  multipay: KinkoPay.InvoiceKind.MULTIPAY,
  donation: KinkoPay.InvoiceKind.DONATION,
};

/**
 * What a wallet holds for an invoice the SDK built: the same terms and the
 * owner secret, turned back into the bytes the contract's witnesses take.
 *
 * @param invoice - An invoice from `@kinko/node`.
 * @returns The invoice in the shape the in-process chain publishes.
 */
export const asTestInvoice = (invoice: Invoice): TestInvoice => ({
  commitment: invoice.commitment,
  ownerSecret: fromHex(invoice.ownerSecret),
  terms: {
    merchantKey: fromHex(invoice.merchantKey),
    payout: fromHex(invoice.payoutKey),
    amount: BigInt(invoice.amount),
    kind: KIND[invoice.kind] ?? KinkoPay.InvoiceKind.STANDARD,
    token: invoice.asset === Asset.KUSD ? KinkoPay.TokenKind.KUSD : KinkoPay.TokenKind.NATIVE,
    salt: fromHex(invoice.salt),
    owner: ownerTagOf(fromHex(invoice.ownerSecret)),
    expiresAt: BigInt(invoice.expiresAt),
  },
});

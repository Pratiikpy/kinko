// The chain reader against the real compiled contract. Every state below was
// produced by running the real circuits, then decoded by the shipped code path.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { generateOracleKeypair, KinkoPay, toHex } from "@kinko/kinko-pay";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { connectIndexer } from "../src/chain/indexer.ts";
import { ChainError, IndexerChainReader, type StateProvider } from "../src/chain/reader.ts";
import { ChainInvoiceStatus, InvoiceKindName, TokenName } from "../src/domain/enums.ts";
import { ChainSim, INDEXER_BLOCK, KUSD_COLOR, newTestInvoice, START } from "./support/chain-sim.ts";

const oracle = generateOracleKeypair();
let chain: ChainSim;

beforeAll(async () => {
  chain = await ChainSim.deploy(oracle.publicKey);
});

const providerFor = (sim: ChainSim): StateProvider => ({
  queryContractState: () => Promise.resolve(sim.contractState()),
});

describe("IndexerChainReader on the real contract", () => {
  it("reports an invoice the chain has not seen as absent", async () => {
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(chain),
    });
    expect((await reader.snapshot()).invoice(newTestInvoice().commitment)).toBeUndefined();
  });

  it("follows a standard invoice from open to settled, decoding kind, asset and counts", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    const invoice = newTestInvoice({ token: KinkoPay.TokenKind.KUSD });
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(sim),
      cacheMs: 0,
    });

    await sim.create(invoice);
    expect((await reader.snapshot()).invoice(invoice.commitment)).toEqual({
      status: ChainInvoiceStatus.OPEN,
      kind: InvoiceKindName.STANDARD,
      token: TokenName.KUSD,
      expiresAt: null,
      contributions: 0,
    });

    await sim.pay(invoice);
    expect((await reader.snapshot()).invoice(invoice.commitment)).toMatchObject({
      status: "settled",
      contributions: 1,
    });
  });

  it("counts every contribution to a multipay invoice and sees it close", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    const invoice = newTestInvoice({ kind: KinkoPay.InvoiceKind.MULTIPAY });
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(sim),
      cacheMs: 0,
    });
    await sim.create(invoice);
    await sim.pay(invoice, 0x41);
    await sim.pay(invoice, 0x42);
    expect((await reader.snapshot()).invoice(invoice.commitment)).toMatchObject({
      kind: "multipay",
      status: "open",
      contributions: 2,
    });
    await sim.close(invoice);
    expect((await reader.snapshot()).invoice(invoice.commitment)).toMatchObject({
      status: "settled",
      contributions: 2,
    });
  });

  it("sees a cancellation", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    const invoice = newTestInvoice();
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(sim),
      cacheMs: 0,
    });
    await sim.create(invoice);
    await sim.cancel(invoice);
    expect((await reader.snapshot()).invoice(invoice.commitment)?.status).toBe("cancelled");
  });

  it("converts the invoice's expiry from seconds to milliseconds", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    const invoice = newTestInvoice({ expiresAt: START + 3_600n });
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(sim),
    });
    await sim.create(invoice);
    expect((await reader.snapshot()).invoice(invoice.commitment)?.expiresAt).toBe(
      Number(START + 3_600n) * 1000,
    );
  });

  it("exposes the contract's sealed values and counter", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    await sim.create(newTestInvoice());
    await sim.create(newTestInvoice());
    const snapshot = await new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(sim),
    }).snapshot();
    expect(snapshot.created).toBe(2n);
    expect(snapshot.oraclePublicKey).toEqual({ x: oracle.publicKey.x, y: oracle.publicKey.y });
    expect(snapshot.kusdColor).toBe(toHex(KUSD_COLOR));
  });

  it("holds no amount for an invoice, because the ledger has none", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    const invoice = newTestInvoice({ amount: 424_242n });
    await sim.create(invoice);
    await sim.pay(invoice);
    const snapshot = await new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: providerFor(sim),
    }).snapshot();
    expect(JSON.stringify(snapshot.invoice(invoice.commitment))).not.toContain("424242");
    expect(Object.keys(snapshot.invoice(invoice.commitment) ?? {}).sort()).toEqual([
      "contributions",
      "expiresAt",
      "kind",
      "status",
      "token",
    ]);
  });
});

describe("IndexerChainReader behaviour", () => {
  it("reuses a read within the cache window, and a fresh read bypasses it", async () => {
    let calls = 0;
    const now = { t: 1_000 };
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: { queryContractState: () => (calls++, Promise.resolve(chain.contractState())) },
      cacheMs: 2_000,
      now: () => now.t,
    });
    await reader.snapshot();
    await reader.snapshot();
    expect(calls).toBe(1);
    await reader.snapshot({ fresh: true });
    expect(calls).toBe(2);
    now.t += 2_001;
    await reader.snapshot();
    expect(calls).toBe(3);
  });

  it("gives up on an indexer that never answers, and tries again next time", async () => {
    let calls = 0;
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: { queryContractState: () => (calls++, new Promise(() => undefined)) },
      cacheMs: 0,
      timeoutMs: 30,
    });
    await expect(reader.snapshot()).rejects.toThrow(/no answer within 30 ms/);
    await expect(reader.snapshot()).rejects.toThrow(/no answer/);
    expect(calls).toBe(2);
  });

  it("lets concurrent callers share one request", async () => {
    let calls = 0;
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: {
        queryContractState: async () => (
          calls++,
          await new Promise((r) => setTimeout(r, 20)),
          chain.contractState()
        ),
      },
      cacheMs: 0,
    });
    await Promise.all([reader.snapshot(), reader.snapshot(), reader.snapshot()]);
    expect(calls).toBe(1);
  });

  it("says plainly when the address holds no contract", async () => {
    const reader = new IndexerChainReader({
      contractAddress: "ab".repeat(32),
      provider: { queryContractState: () => Promise.resolve(null) },
    });
    await expect(reader.snapshot()).rejects.toThrow(
      /holds no contract at (ab)+: wrong address, or wrong network/,
    );
  });

  it("wraps an indexer failure, and recovers when it comes back", async () => {
    let failing = true;
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: {
        queryContractState: () =>
          failing
            ? Promise.reject(new Error("ECONNREFUSED"))
            : Promise.resolve(chain.contractState()),
      },
      cacheMs: 0,
    });
    await expect(reader.snapshot()).rejects.toThrow(ChainError);
    await expect(reader.snapshot()).rejects.toThrow(/could not be reached: ECONNREFUSED/);
    failing = false;
    await expect(reader.snapshot()).resolves.toBeDefined();
  });

  it("refuses state that is not a kinko_pay ledger", async () => {
    const { ContractState } = await import("@midnight-ntwrk/compact-runtime");
    const blank = new ContractState();
    const reader = new IndexerChainReader({
      contractAddress: "00".repeat(32),
      provider: { queryContractState: () => Promise.resolve(blank) },
    });
    await expect(reader.snapshot()).rejects.toThrow(/not a kinko_pay ledger/);
  });
});

describe("the real indexer provider against an indexer that answers GraphQL", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const open = server;
    server = undefined;
    if (!open) return;
    await new Promise<void>((resolve) => {
      open.close(() => {
        resolve();
      });
    });
  });

  const serve = async (sim: ChainSim, requests: string[]): Promise<string> => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const { query } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string };
        requests.push(query);
        const state = Buffer.from(sim.contractState().serialize()).toString("hex");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { block: INDEXER_BLOCK, contract: { state } } }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v4/graphql`;
  };

  it("reads a paid invoice through HTTP, serialisation and the compiled ledger decoder", async () => {
    const sim = await ChainSim.deploy(oracle.publicKey);
    const invoice = newTestInvoice();
    await sim.create(invoice);
    await sim.pay(invoice);
    const requests: string[] = [];
    const url = await serve(sim, requests);
    const live = connectIndexer({
      contractAddress: toHex(new Uint8Array(32).fill(7)),
      indexerUri: url,
      indexerWsUri: url.replace("http", "ws"),
    });
    try {
      const snapshot = await live.reader.snapshot();
      expect(snapshot.invoice(invoice.commitment)).toMatchObject({
        status: "settled",
        contributions: 1,
      });
      expect(snapshot.created).toBe(1n);
      expect(requests[0]).toContain("CONTRACT_STATE_WITH_PARAMETERS_QUERY");
    } finally {
      await live.dispose();
    }
  });

  it("reports an unreachable indexer as a ChainError, not a crash", async () => {
    const live = connectIndexer({
      contractAddress: "00".repeat(32),
      indexerUri: "http://127.0.0.1:1/graphql",
      indexerWsUri: "ws://127.0.0.1:1/ws",
      timeoutMs: 1_500,
    });
    try {
      await expect(live.reader.snapshot()).rejects.toThrow(ChainError);
    } finally {
      await live.dispose();
    }
  });
});

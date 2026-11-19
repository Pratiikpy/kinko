import { generateOracleKeypair, KinkoPay, verifyQuote } from "@kinko/kinko-pay";
import { afterEach, describe, expect, it } from "vitest";

import { StaticRateSource } from "../src/oracle/rates.ts";
import {
  containing,
  fakeCommitment,
  field,
  startTestApp,
  type TestApp,
} from "./support/fixtures.ts";

let t: TestApp;
afterEach(async () => {
  await t.stop();
});

const C = fakeCommitment(0xb1);

describe("GET /health", () => {
  it("reports every part's state and exposes no secret", async () => {
    t = await startTestApp({
      env: {
        KINKO_BOT_TOKEN: "b".repeat(40),
        KINKO_ASSISTANT_API_KEY: "assistant-secret-key",
        KINKO_ORACLE_SECRET_KEY: "abc123",
      },
    });
    const reply = await t.call("GET", "/health");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      service: "kinko-backend",
      status: "ok",
      store: "ok",
      chain: { status: "ok", contract: "cd".repeat(32) },
      watcher: { passes: 0, lastError: null },
      oracle: { configured: true, canQuote: false, keyMatchesContract: false },
      assistant: "available",
      bot: "available",
    });
    const text = JSON.stringify(reply.body);
    for (const secret of ["b".repeat(40), "assistant-secret-key", t.config.dataKey])
      expect(text).not.toContain(secret);
  });

  it("says what is not configured instead of pretending", async () => {
    t = await startTestApp();
    expect((await t.call("GET", "/")).body).toMatchObject({
      oracle: { configured: false },
      assistant: "not configured",
      bot: "not configured",
    });
  });

  it("degrades, but stays up, when the chain is unreachable", async () => {
    t = await startTestApp();
    t.chain.failing = true;
    const reply = await t.call("GET", "/health");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: "degraded", chain: { status: "unreachable" } });
  });

  it("reflects what the watcher has done", async () => {
    t = await startTestApp();
    const { key } = await t.register();
    await t.call("POST", "/v1/checkout/sessions", { key, body: { commitment: C } });
    t.chain.open(C, { status: "settled" as never, contributions: 1 });
    await t.app.deps.watcher.tick();
    expect(field((await t.call("GET", "/health")).body, "watcher")).toMatchObject({
      passes: 1,
      settled: 1,
      payments: 1,
      lastError: null,
    });
  });
});

describe("chain reads", () => {
  it("reports an invoice's public state and nothing else", async () => {
    t = await startTestApp();
    t.chain.open(C, { kind: "multipay" as never, expiresAt: 1_900_000_000_000, contributions: 4 });
    const reply = await t.call("GET", `/v1/chain/invoices/${C.toUpperCase()}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      commitment: C,
      found: true,
      status: "open",
      kind: "multipay",
      asset: "KUSD",
      expiresAt: "2030-03-17T17:46:40.000Z",
      contributions: 4,
    });
  });

  it("answers an invoice the chain has not seen yet with unknown, not an error", async () => {
    t = await startTestApp();
    const reply = await t.call("GET", `/v1/chain/invoices/${C}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      found: false,
      status: "unknown",
      kind: null,
      contributions: 0,
    });
  });

  it("rejects a malformed commitment", async () => {
    t = await startTestApp();
    expect((await t.call("GET", "/v1/chain/invoices/not-hex")).status).toBe(400);
    expect((await t.call("GET", `/v1/chain/invoices/${C}00`)).status).toBe(400);
  });

  it("answers 502 when the indexer is down, without internals", async () => {
    t = await startTestApp();
    t.chain.failing = true;
    const reply = await t.call("GET", `/v1/chain/invoices/${C}`);
    expect(reply.status).toBe(502);
    expect(field(reply.body, "error")).toEqual({
      code: "upstream_failed",
      message: containing("could not be read"),
    });
    expect(JSON.stringify(reply.body)).not.toContain("connection refused");
  });

  it("reports the contract's aggregates", async () => {
    t = await startTestApp();
    t.chain.created = 12n;
    t.chain.oracleKey = { x: 11n, y: 22n };
    expect((await t.call("GET", "/v1/chain")).body).toEqual({
      contractAddress: "cd".repeat(32),
      invoicesCreated: "12",
      kusdColor: "c1".repeat(32),
      oraclePublicKey: { x: "11", y: "22" },
    });
  });
});

describe("GET /v1/config", () => {
  it("serves what a client needs to build links, without reading the chain", async () => {
    t = await startTestApp();
    t.chain.failing = true;
    const reply = await t.call("GET", "/v1/config");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      contractAddress: "cd".repeat(32),
      appUrl: "https://app.kinko.example",
      payPath: "/pay",
      checkoutPath: "/checkout",
      invoicePath: "/app/invoices",
      oracle: false,
      assistant: false,
    });
    expect(t.chain.reads).toBe(0);
  });
});

describe("oracle routes", () => {
  const keys = generateOracleKeypair();
  const env = {
    KINKO_ORACLE_SECRET_KEY: keys.secretKey.toString(16),
    KINKO_ORACLE_KUSD_PER_NIGHT: "0.0913",
  };

  it("answers 503 and names the variable when no key is configured", async () => {
    t = await startTestApp();
    const reply = await t.call("POST", "/v1/oracle/quote", {
      body: { baseAmount: "100", fromToken: "NATIVE", toToken: "KUSD" },
    });
    expect(reply.status).toBe(503);
    expect(field(reply.body, "error")).toMatchObject({
      code: "not_configured",
      message: containing("KINKO_ORACLE_SECRET_KEY"),
    });
    expect((await t.call("GET", "/v1/oracle")).body).toMatchObject({
      configured: false,
      canQuote: false,
      publicKey: null,
    });
  });

  it("answers 503 with a key but no rate", async () => {
    t = await startTestApp({ env: { KINKO_ORACLE_SECRET_KEY: env.KINKO_ORACLE_SECRET_KEY } });
    const reply = await t.call("POST", "/v1/oracle/quote", {
      body: { baseAmount: "100", fromToken: "NATIVE", toToken: "KUSD" },
    });
    expect(reply.status).toBe(503);
    expect(field(reply.body, "error.message")).toContain("KINKO_ORACLE_KUSD_PER_NIGHT");
  });

  it("returns a signed quote the contract's verifier accepts", async () => {
    t = await startTestApp({ env });
    const reply = await t.call("POST", "/v1/oracle/quote", {
      body: { baseAmount: "1000000", fromToken: "NATIVE", toToken: "KUSD" },
    });
    expect(reply.status).toBe(200);
    const q = field(reply.body, "quote") as {
      expiresAt: string;
      signature: { announcement: { x: string; y: string }; response: string };
    };
    expect(q).toMatchObject({
      baseAmount: "1000000",
      convertedAmount: "100000",
      fromToken: "NATIVE",
      toToken: "KUSD",
    });
    expect(Number(q.expiresAt)).toBe(Math.floor(t.clock.now() / 1000) + 600);
    const ok = verifyQuote(
      keys.publicKey,
      {
        baseAmount: 1_000_000n,
        convertedAmount: 100_000n,
        fromToken: KinkoPay.TokenKind.NATIVE,
        toToken: KinkoPay.TokenKind.KUSD,
        expiresAt: BigInt(q.expiresAt),
      },
      {
        announcement: {
          x: BigInt(q.signature.announcement.x),
          y: BigInt(q.signature.announcement.y),
        },
        response: BigInt(q.signature.response),
      },
    );
    expect(ok).toBe(true);
    expect(JSON.stringify(reply.body)).not.toContain(keys.secretKey.toString());
  });

  it("validates the request", async () => {
    t = await startTestApp({ env });
    for (const body of [
      {},
      { baseAmount: "0", fromToken: "NATIVE", toToken: "KUSD" },
      { baseAmount: "5", fromToken: "KUSD", toToken: "KUSD" },
      { baseAmount: "5", fromToken: "BTC", toToken: "KUSD" },
      { baseAmount: "5", fromToken: "NATIVE", toToken: "KUSD", extra: 1 },
    ]) {
      expect((await t.call("POST", "/v1/oracle/quote", { body })).status).toBe(400);
    }
  });

  it("tells whether the key it signs with is the one sealed in the contract", async () => {
    t = await startTestApp({ env, overrides: { rates: new StaticRateSource("1") } });
    t.chain.oracleKey = { x: keys.publicKey.x, y: keys.publicKey.y };
    expect((await t.call("GET", "/v1/oracle")).body).toMatchObject({
      configured: true,
      canQuote: true,
      matchesContract: true,
      publicKey: { x: keys.publicKey.x.toString(), y: keys.publicKey.y.toString() },
      quoteTtlSeconds: 600,
      assets: ["NATIVE", "KUSD"],
    });
    expect(field((await t.call("GET", "/health")).body, "oracle")).toMatchObject({
      keyMatchesContract: true,
    });
    t.chain.oracleKey = { x: 1n, y: 2n };
    expect(field((await t.call("GET", "/v1/oracle")).body, "matchesContract")).toBe(false);
    t.chain.failing = true;
    expect(field((await t.call("GET", "/v1/oracle")).body, "matchesContract")).toBeNull();
  });
});

describe("assistant routes", () => {
  it("says it is not configured, and the chat endpoint answers 503", async () => {
    t = await startTestApp();
    expect((await t.call("GET", "/v1/assistant")).body).toEqual({ configured: false, model: null });
    const reply = await t.call("POST", "/v1/assistant/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(reply.status).toBe(503);
    expect(field(reply.body, "error.code")).toBe("not_configured");
  });

  it("answers through the configured provider, after validating what it is sent", async () => {
    let sent = "";
    t = await startTestApp({
      env: { KINKO_ASSISTANT_API_KEY: "k", KINKO_ASSISTANT_MODEL: "gemini-x" },
      overrides: {
        assistantFetch: (_u: unknown, init?: RequestInit) => (
          (sent = init?.body as string),
          Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: "Invoices hide amounts." }] } }],
              }),
              { status: 200 },
            ),
          )
        ),
      },
    });
    expect((await t.call("GET", "/v1/assistant")).body).toEqual({
      configured: true,
      model: "gemini-x",
    });
    const reply = await t.call("POST", "/v1/assistant/chat", {
      body: {
        messages: [{ role: "user", content: "What is public?" }],
        context: { currentPage: "invoices", settledCount: 2 },
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ text: "Invoices hide amounts.", model: "gemini-x" });
    expect(sent).toContain("- currentPage: invoices");
  });

  it("refuses private context before anything is forwarded", async () => {
    let called = false;
    t = await startTestApp({
      env: { KINKO_ASSISTANT_API_KEY: "k" },
      overrides: {
        assistantFetch: (() => (
          (called = true),
          Promise.reject(new Error("no"))
        )) as unknown as typeof fetch,
      },
    });
    const reply = await t.call("POST", "/v1/assistant/chat", {
      body: {
        messages: [{ role: "user", content: "hi" }],
        context: { amount: "42500", merchantKey: "ab".repeat(32) },
      },
    });
    expect(reply.status).toBe(400);
    expect(field(reply.body, "error.message")).toMatch(/Refused: amount, merchantKey/);
    expect(called).toBe(false);
  });

  it("validates the body", async () => {
    t = await startTestApp({ env: { KINKO_ASSISTANT_API_KEY: "k" } });
    for (const body of [
      {},
      { messages: [] },
      { messages: [{ role: "user", content: "" }] },
      { messages: [{ role: "user", content: "hi" }], extra: true },
      [1, 2],
    ]) {
      expect((await t.call("POST", "/v1/assistant/chat", { body })).status).toBe(400);
    }
  });
});

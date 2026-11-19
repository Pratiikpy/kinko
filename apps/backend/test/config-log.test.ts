import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.ts";
import { createLogger, LogLevel, redact } from "../src/log.ts";
import { baseEnv } from "./support/fixtures.ts";

describe("loadConfig", () => {
  it("reads a minimal environment and applies safe defaults", () => {
    const c = loadConfig(baseEnv());
    expect(c.host).toBe("127.0.0.1");
    expect(c.chain.contractAddress).toBe("cd".repeat(32));
    expect(c.chain.indexerUri).toBe("http://localhost:8088/api/v4/graphql");
    expect(c.chain.indexerWsUri).toBe("ws://localhost:8088/api/v4/graphql/ws");
    expect(c.corsOrigins).toEqual([]);
    expect(c.botToken).toBeUndefined();
    expect(c.oracle.secretKey).toBeUndefined();
    expect(c.webhooks.allowPrivateTargets).toBe(false);
    expect(c.appInvoicePath).toBe("/app/invoices");
  });

  it("names the variable and says what to put in it when one is missing", () => {
    expect(() => loadConfig({ KINKO_PAY_ADDRESS: "cd".repeat(32) })).toThrow(
      /KINKO_DATA_KEY is not set.*openssl rand -hex 32/s,
    );
    expect(() => loadConfig({ KINKO_DATA_KEY: "ab".repeat(32) })).toThrow(
      /KINKO_PAY_ADDRESS is not set/,
    );
  });

  it.each([
    [{ KINKO_DATA_KEY: "tooshort" }, /KINKO_DATA_KEY must be exactly 64 hex/],
    [{ KINKO_PAY_ADDRESS: "xyz" }, /KINKO_PAY_ADDRESS must be 64 hex/],
    [{ KINKO_INDEXER_URL: "ftp://x" }, /KINKO_INDEXER_URL must be an http\(s\) URL/],
    [{ KINKO_INDEXER_URL: "nonsense" }, /absolute http\(s\) URL/],
    [{ KINKO_POLL_MS: "10" }, /KINKO_POLL_MS must be a whole number between 1000/],
    [{ KINKO_BOT_TOKEN: "short" }, /KINKO_BOT_TOKEN must be at least 32/],
    [{ KINKO_REGISTRATION_TOKEN: "short" }, /KINKO_REGISTRATION_TOKEN must be at least 16/],
    [{ KINKO_LOG_LEVEL: "loud" }, /KINKO_LOG_LEVEL must be one of/],
    [{ KINKO_TRUST_PROXY: "maybe" }, /must be "true" or "false"/],
    [{ KINKO_ORACLE_SECRET_KEY: "0" }, /KINKO_ORACLE_SECRET_KEY must be/],
    [{ KINKO_ORACLE_SECRET_KEY: "zz" }, /KINKO_ORACLE_SECRET_KEY must be/],
    [{ KINKO_ORACLE_KUSD_PER_NIGHT: "-1" }, /positive decimal/],
    [{ KINKO_ORACLE_KUSD_PER_NIGHT: "0" }, /positive decimal/],
    [{ KINKO_ORACLE_KUSD_PER_NIGHT: "1", KINKO_ORACLE_RATE_URL: "https://x" }, /not both/],
    [{ KINKO_ORACLE_RATE_URL: "https://x.example/price" }, /KINKO_ORACLE_RATE_PATH is required/],
    [{ KINKO_APP_INVOICE_PATH: "invoices" }, /KINKO_APP_INVOICE_PATH must be a path/],
  ])("rejects a bad value: %j", (over, message) => {
    expect(() => loadConfig(baseEnv(over))).toThrow(message);
    expect(() => loadConfig(baseEnv(over))).toThrow(ConfigError);
  });

  it("parses the optional features when they are given", () => {
    const c = loadConfig(
      baseEnv({
        KINKO_BOT_TOKEN: "t".repeat(40),
        KINKO_CORS_ORIGINS: "https://a.example, https://b.example",
        KINKO_ORACLE_SECRET_KEY: "0xabc123",
        KINKO_ORACLE_KUSD_PER_NIGHT: "0.0913",
        KINKO_TRUST_PROXY: "true",
        KINKO_ALLOW_PRIVATE_WEBHOOKS: "1",
        KINKO_LATE_SETTLEMENT_DAYS: "3",
        KINKO_APP_URL: "https://pay.kinko.example/",
      }),
    );
    expect(c.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(c.oracle.secretKey).toBe(0xabc123n);
    expect(c.oracle.rate).toEqual({ kind: "static", kusdPerNight: "0.0913" });
    expect(c.trustProxy).toBe(true);
    expect(c.webhooks.allowPrivateTargets).toBe(true);
    expect(c.chain.lateSettlementMs).toBe(3 * 86_400_000);
    expect(c.appUrl).toBe("https://pay.kinko.example");
  });

  it("derives the indexer socket from the indexer URL unless told otherwise", () => {
    expect(
      loadConfig(baseEnv({ KINKO_INDEXER_URL: "https://indexer.example/api/v4/graphql" })).chain
        .indexerWsUri,
    ).toBe("wss://indexer.example/api/v4/graphql/ws");
    expect(
      loadConfig(baseEnv({ KINKO_INDEXER_WS_URL: "wss://other.example/ws" })).chain.indexerWsUri,
    ).toBe("wss://other.example/ws");
  });
});

describe("logger", () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    return {
      lines,
      log: createLogger(
        (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
        LogLevel.DEBUG,
        {},
        () => new Date(0),
      ),
    };
  };

  it("writes one JSON object per line with time, level and message", () => {
    const { log, lines } = capture();
    log.info("hello", { n: 1 });
    expect(lines).toEqual([
      { time: "1970-01-01T00:00:00.000Z", level: "info", msg: "hello", n: 1 },
    ]);
  });

  it("redacts anything named like a credential, at any depth", () => {
    const { log, lines } = capture();
    log.info("x", {
      authorization: "Bearer kk_secret",
      apiKey: "kk_secret",
      nested: { webhookSecret: "whsec_abc", ok: "visible", deeper: [{ token: "t", fine: 1 }] },
      Signature: "sig",
    });
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/kk_secret|whsec_abc|"sig"/);
    expect(lines[0]).toMatchObject({ nested: { ok: "visible", deeper: [{ fine: 1 }] } });
  });

  it("serialises errors without their stack and bigints as strings", () => {
    expect(redact({ e: new Error("boom"), n: 5n })).toEqual({
      e: { name: "Error", message: "boom" },
      n: "5",
    });
  });

  it("filters below the configured level and carries child fields", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), LogLevel.WARN).child({ requestId: "req_1" });
    log.info("quiet");
    log.warn("loud");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ msg: "loud", requestId: "req_1" });
  });
});

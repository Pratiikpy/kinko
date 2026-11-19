// The HTTP layer over a real server on an ephemeral port, with fake chain readers behind it:
// every route, every validation, the error shapes, the rate limit and CORS.

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { TimedBackingReading } from "../src/backing.ts";
import type { HttpConfig } from "../src/config.ts";
import { RequestKindMismatchError } from "../src/engine.ts";
import { createRelayerServer, type HealthInfo, type RequestTracker } from "../src/http.ts";
import { RequestKind, RequestStage, type TrackedRequest } from "../src/types.ts";
import { idOf, RecordingLogger } from "./fakes.ts";

const HEALTH: HealthInfo = {
  network: "undeployed",
  vaultContractAddress: "11".repeat(32),
  evmVaultAddress: `0x${"ee".repeat(20)}`,
  usdcAddress: `0x${"aa".repeat(20)}`,
  evmChainId: 11155111,
};

const CONFIG: HttpConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: ["https://kinko.app"],
  rateLimitPerMinute: 1000,
  trustProxy: false,
};

const SENT: TrackedRequest = {
  kind: RequestKind.Deposit,
  requestId: idOf("a"),
  stage: RequestStage.Broadcast,
  createdAt: Date.parse("2026-01-01T00:00:00Z"),
  updatedAt: Date.parse("2026-01-01T00:05:00Z"),
  stageEnteredAt: Date.parse("2026-01-01T00:05:00Z"),
  consecutiveFailures: 2,
  evmTxHash: `0x${"cd".repeat(32)}`,
  signedTransaction: "0x02f8",
};

const READING: TimedBackingReading = {
  readAt: Date.parse("2026-01-01T00:10:00Z"),
  reading: {
    usdcInVault: 1_500_000n,
    kusdMinted: 2_000_000n,
    kusdBurned: 500_000n,
    evmVaultAddress: HEALTH.evmVaultAddress,
    ethereumBlock: 1234,
    midnightBlock: 567,
  },
};

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

class FakeTracker implements RequestTracker {
  readonly registered: { kind: RequestKind; requestId: string }[] = [];
  known = new Map<string, TrackedRequest>();
  registerResult: TrackedRequest | undefined = SENT;
  registerError: Error | undefined;
  statusError: Error | undefined;

  register(kind: RequestKind, requestId: string): Promise<TrackedRequest | undefined> {
    this.registered.push({ kind, requestId });
    if (this.registerError !== undefined) return Promise.reject(this.registerError);
    return Promise.resolve(this.registerResult);
  }

  status(requestId: string): TrackedRequest | undefined {
    if (this.statusError !== undefined) throw this.statusError;
    return this.known.get(requestId);
  }
}

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(
  overrides: {
    config?: Partial<HttpConfig>;
    backing?: () => Promise<TimedBackingReading>;
    now?: { at: number };
  } = {},
) {
  const tracker = new FakeTracker();
  const clock = overrides.now ?? { at: 1_000_000 };
  const server = createRelayerServer({
    config: { ...CONFIG, ...overrides.config },
    health: HEALTH,
    tracker,
    backing: { get: overrides.backing ?? (() => Promise.resolve(READING)) },
    depositAddress: (commitmentHex) => `0x${commitmentHex.slice(0, 40)}`,
    clock: () => clock.at,
    logger: new RecordingLogger(),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  return { tracker, clock, base };
}

describe("GET /health", () => {
  it("reports the network, the contracts and the chain", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ ok: true, ...HEALTH });
  });
});

describe("GET /deposit-address", () => {
  it("derives the address of a commitment, whatever its case", async () => {
    const { base } = await serve();
    const commitment = "AB".repeat(32);

    const response = await fetch(`${base}/deposit-address?commitment=${commitment}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ evmAddress: `0x${"ab".repeat(20)}` });
  });

  it.each([
    { name: "no commitment", query: "" },
    { name: "a short commitment", query: "?commitment=abcd" },
    { name: "a commitment that is not hex", query: `?commitment=${"zz".repeat(32)}` },
    { name: "a commitment with a 0x prefix", query: `?commitment=0x${"ab".repeat(31)}` },
    { name: "a commitment one byte too long", query: `?commitment=${"ab".repeat(33)}` },
  ])("refuses $name", async ({ query }) => {
    const { base } = await serve();

    const response = await fetch(`${base}/deposit-address${query}`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe("invalid_commitment");
  });
});

describe("POST /requests", () => {
  const post = (base: string, body: string | object, headers: Record<string, string> = {}) =>
    fetch(`${base}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("accepts a request the vault holds and tracks it by its lowercase id", async () => {
    const { base, tracker } = await serve();

    const response = await post(base, { kind: "deposit", requestId: "AB".repeat(32) });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ requestId: "ab".repeat(32) });
    expect(tracker.registered).toEqual([{ kind: RequestKind.Deposit, requestId: "ab".repeat(32) }]);
  });

  it.each([
    { name: "text that is not JSON", body: "{nope", code: "invalid_json" },
    { name: "a JSON array", body: "[1]", code: "invalid_body" },
    { name: "JSON null", body: "null", code: "invalid_body" },
    { name: "a number", body: "7", code: "invalid_body" },
    { name: "an empty body", body: "", code: "invalid_json" },
    { name: "no kind", body: { requestId: idOf("a") }, code: "invalid_kind" },
    {
      name: "a kind that is not a string",
      body: { kind: 1, requestId: idOf("a") },
      code: "invalid_kind",
    },
    { name: "an unknown kind", body: { kind: "swap", requestId: idOf("a") }, code: "invalid_kind" },
    {
      name: "an upper-case kind",
      body: { kind: "DEPOSIT", requestId: idOf("a") },
      code: "invalid_kind",
    },
    { name: "no request id", body: { kind: "deposit" }, code: "invalid_request_id" },
    {
      name: "a short request id",
      body: { kind: "deposit", requestId: "abcd" },
      code: "invalid_request_id",
    },
    {
      name: "a request id that is not hex",
      body: { kind: "deposit", requestId: "zz".repeat(32) },
      code: "invalid_request_id",
    },
    {
      name: "a request id with a 0x prefix",
      body: { kind: "deposit", requestId: `0x${"ab".repeat(31)}` },
      code: "invalid_request_id",
    },
    {
      name: "a request id that is a number",
      body: { kind: "deposit", requestId: 12 },
      code: "invalid_request_id",
    },
  ])("refuses $name with $code and registers nothing", async ({ body, code }) => {
    const { base, tracker } = await serve();

    const response = await post(base, body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe(code);
    expect(tracker.registered).toEqual([]);
  });

  it("refuses a body over the limit without reading on", async () => {
    const { base, tracker } = await serve();

    const response = await post(base, {
      kind: "deposit",
      requestId: idOf("a"),
      padding: "x".repeat(5000),
    });

    expect(response.status).toBe(413);
    expect(((await response.json()) as ErrorBody).error.code).toBe("payload_too_large");
    expect(tracker.registered).toEqual([]);
  });

  it.each([
    { kind: "deposit", hint: /queue it with the start circuit first$/ },
    { kind: "withdraw", hint: /a withdrawal has an id only once a flush gave it its vault nonce/ },
  ])(
    "answers 404 for a $kind the vault does not hold, saying what to do",
    async ({ kind, hint }) => {
      const { base, tracker } = await serve();
      tracker.registerResult = undefined;

      const response = await post(base, { kind, requestId: idOf("a") });

      expect(response.status).toBe(404);
      const { error } = (await response.json()) as ErrorBody;
      expect(error.code).toBe("request_not_found");
      expect(error.message).toMatch(hint);
    },
  );

  it("answers 409 for an id tracked as the other kind", async () => {
    const { base, tracker } = await serve();
    tracker.registerError = new RequestKindMismatchError(
      idOf("a"),
      RequestKind.Deposit,
      RequestKind.Withdraw,
    );

    const response = await post(base, { kind: "withdraw", requestId: idOf("a") });

    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorBody).error.code).toBe("kind_mismatch");
  });

  it("answers 503 when the vault cannot be read, without leaking why", async () => {
    const { base, tracker } = await serve();
    tracker.registerError = new Error("connect ECONNREFUSED 10.0.0.7:8088");

    const response = await post(base, { kind: "deposit", requestId: idOf("a") });

    expect(response.status).toBe(503);
    const { error } = (await response.json()) as ErrorBody;
    expect(error.code).toBe("chain_unavailable");
    expect(error.message).not.toContain("10.0.0.7");
  });
});

describe("GET /requests/<id>", () => {
  it("reports a tracked request's kind, stage, transaction hash and time, and nothing internal", async () => {
    const { base, tracker } = await serve();
    tracker.known.set(SENT.requestId, SENT);

    const response = await fetch(`${base}/requests/${SENT.requestId.toUpperCase()}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "deposit",
      stage: "broadcast",
      evmTxHash: SENT.evmTxHash,
      updatedAt: "2026-01-01T00:05:00.000Z",
    });
  });

  it("reports why a request failed, and omits the hash it never had", async () => {
    const { base, tracker } = await serve();
    const failed: TrackedRequest = {
      kind: RequestKind.Withdraw,
      requestId: idOf("b"),
      stage: RequestStage.Failed,
      createdAt: 1,
      updatedAt: Date.parse("2026-01-02T00:00:00Z"),
      stageEnteredAt: 1,
      consecutiveFailures: 0,
      error: "timed out after 1500s in stage sent",
    };
    tracker.known.set(failed.requestId, failed);

    const response = await fetch(`${base}/requests/${failed.requestId}`);

    expect(await response.json()).toEqual({
      kind: "withdraw",
      stage: "failed",
      error: "timed out after 1500s in stage sent",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("answers 404 for a request nobody registered, pointing at how to", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/requests/${idOf("c")}`);

    expect(response.status).toBe(404);
    const { error } = (await response.json()) as ErrorBody;
    expect(error.code).toBe("request_not_found");
    expect(error.message).toContain("POST /requests");
  });

  it.each([
    { name: "a short id", path: "abcd" },
    { name: "an id that is not hex", path: "zz".repeat(32) },
    { name: "a malformed percent escape", path: "%E0%A4%A" },
    { name: "a trailing path segment", path: `${idOf("a")}/extra` },
  ])("refuses $name", async ({ path }) => {
    const { base } = await serve();

    const response = await fetch(`${base}/requests/${path}`);

    expect([400, 404]).toContain(response.status);
    expect(((await response.json()) as ErrorBody).error.code).toMatch(
      /invalid_request_id|not_found/,
    );
  });
});

describe("GET /backing", () => {
  it("reports the vault's USDC against the KUSD minted and burned, as strings of base units", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/backing`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usdcInVault: "1500000",
      kusdMinted: "2000000",
      kusdBurned: "500000",
      vaultContractAddress: HEALTH.vaultContractAddress,
      evmVaultAddress: HEALTH.evmVaultAddress,
      usdcAddress: HEALTH.usdcAddress,
      ethereumBlock: 1234,
      midnightBlock: 567,
      updatedAt: "2026-01-01T00:10:00.000Z",
    });
  });

  it("answers 503 when a chain cannot be read, without leaking why", async () => {
    const { base } = await serve({
      backing: () => Promise.reject(new Error("rpc key abc123 rejected")),
    });

    const response = await fetch(`${base}/backing`);

    expect(response.status).toBe(503);
    const { error } = (await response.json()) as ErrorBody;
    expect(error.code).toBe("chain_unavailable");
    expect(error.message).not.toContain("abc123");
  });
});

describe("routing", () => {
  it.each([
    { method: "POST", path: "/health" },
    { method: "GET", path: "/requests" },
    { method: "POST", path: `/requests/${idOf("a")}` },
    { method: "DELETE", path: "/backing" },
    { method: "PUT", path: "/deposit-address" },
  ])("answers 405 to $method $path and names the method it takes", async ({ method, path }) => {
    const { base } = await serve();

    const response = await fetch(`${base}${path}`, { method });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toMatch(/^(GET|POST), OPTIONS$/);
    expect(((await response.json()) as ErrorBody).error.code).toBe("method_not_allowed");
  });

  it.each(["/", "/admin", "/health/extra", "/requests/"])("answers 404 to %s", async (path) => {
    const { base } = await serve();

    const response = await fetch(`${base}${path}`);

    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorBody).error.code).toMatch(/not_found/);
  });

  it("answers 500 with a code and no detail when the relayer itself fails", async () => {
    const { base, tracker } = await serve();
    tracker.statusError = new Error("disk on fire at /var/lib/relayer");

    const response = await fetch(`${base}/requests/${idOf("a")}`);

    expect(response.status).toBe(500);
    const { error } = (await response.json()) as ErrorBody;
    expect(error.code).toBe("internal_error");
    expect(error.message).not.toContain("/var/lib");
  });

  it("never lets a browser sniff or cache an answer", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/health`);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("rate limit", () => {
  it("refuses a client's requests past its minute's allowance, then lets it back in", async () => {
    const { base, clock } = await serve({ config: { rateLimitPerMinute: 3 } });

    const statuses: number[] = [];
    for (let count = 0; count < 4; count += 1)
      statuses.push((await fetch(`${base}/health`)).status);
    const refused = await fetch(`${base}/health`);

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(((await refused.json()) as ErrorBody).error.code).toBe("rate_limited");

    clock.at += 61_000;
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("counts clients by the address our own proxy appended, the rightmost, never by what the caller sent", async () => {
    const { base } = await serve({ config: { rateLimitPerMinute: 1, trustProxy: true } });
    const ask = async (forwarded: string): Promise<number> =>
      (await fetch(`${base}/health`, { headers: { "x-forwarded-for": forwarded } })).status;

    // One real client behind the proxy, claiming a different address each time on the left.
    const first = await ask("1.1.1.1, 203.0.113.5");
    const spoofed = await ask("2.2.2.2, 203.0.113.5");
    // Another real client is not held back by it.
    const other = await ask("203.0.113.6");

    expect([first, spoofed, other]).toEqual([200, 429, 200]);
  });

  it("ignores a forwarded address when no proxy is trusted, so a client cannot dodge its limit", async () => {
    const { base } = await serve({ config: { rateLimitPerMinute: 1, trustProxy: false } });

    const first = await fetch(`${base}/health`, { headers: { "x-forwarded-for": "203.0.113.5" } });
    const second = await fetch(`${base}/health`, { headers: { "x-forwarded-for": "203.0.113.6" } });

    expect([first.status, second.status]).toEqual([200, 429]);
  });
});

describe("CORS", () => {
  it("lets the web app's origin read answers, and says the answer varies by origin", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/health`, { headers: { origin: "https://kinko.app" } });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://kinko.app");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("withholds the header from any other origin", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a preflight with the methods and headers the app uses", async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/requests`, {
      method: "OPTIONS",
      headers: {
        origin: "https://kinko.app",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://kinko.app");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("allows any origin when the operator configured *, and none when none is configured", async () => {
    const open = await serve({ config: { corsOrigins: ["*"] } });
    const closed = await serve({ config: { corsOrigins: [] } });

    const opened = await fetch(`${open.base}/health`, {
      headers: { origin: "https://anywhere.example" },
    });
    const shut = await fetch(`${closed.base}/health`, { headers: { origin: "https://kinko.app" } });

    expect(opened.headers.get("access-control-allow-origin")).toBe("*");
    expect(shut.headers.get("access-control-allow-origin")).toBeNull();
  });
});

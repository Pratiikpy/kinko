import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { containing, field, startTestApp, type TestApp } from "./support/fixtures.ts";

let t: TestApp;
afterEach(async () => {
  await t.stop();
});

describe("responses", () => {
  beforeEach(async () => {
    t = await startTestApp();
  });

  it("sets security headers and a request id on every response, errors included", async () => {
    for (const reply of [
      await t.call("GET", "/health"),
      await t.call("GET", "/nope"),
      await t.call("GET", "/v1/merchant"),
    ]) {
      expect(reply.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
      expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
      expect(reply.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{16}$/);
    }
  });

  it("echoes a sane inbound request id and replaces a hostile one", async () => {
    expect(
      (
        await t.call("GET", "/health", { headers: { "X-Request-Id": "trace-1234_abc" } })
      ).headers.get("x-request-id"),
    ).toBe("trace-1234_abc");
    expect(
      (
        await t.call("GET", "/health", { headers: { "X-Request-Id": "bad id\twith space" } })
      ).headers.get("x-request-id"),
    ).toMatch(/^req_/);
  });

  it("gives every error the same shape, with a code, a message and the request id", async () => {
    const reply = await t.call("GET", "/v1/merchant");
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({
      error: { code: "unauthorized", message: containing("API key") },
      requestId: reply.headers.get("x-request-id"),
    });
    expect(reply.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("answers 404 for an unknown route and 405 with Allow for a known path and a wrong method", async () => {
    const missing = await t.call("GET", "/v1/nothing");
    expect(missing.status).toBe(404);
    expect(field(missing.body, "error.code")).toBe("not_found");
    const wrong = await t.call("PUT", "/v1/merchants");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect(field(wrong.body, "error.code")).toBe("method_not_allowed");
    const several = await t.call("DELETE", "/v1/merchant");
    expect(several.headers.get("allow")).toBe("GET, PATCH");
  });

  it("ignores a trailing slash", async () => {
    expect((await t.call("GET", "/health/")).status).toBe(200);
  });

  it("refuses a body that is not JSON, not declared as JSON, or too large", async () => {
    const notJson = await t.call("POST", "/v1/merchants", {
      rawBody: "{nope",
      headers: { "Content-Type": "application/json" },
    });
    expect(notJson.status).toBe(400);
    expect(field(notJson.body, "error.message")).toMatch(/not valid JSON/);
    const wrongType = await t.call("POST", "/v1/merchants", {
      rawBody: '{"name":"x"}',
      headers: { "Content-Type": "text/plain" },
    });
    expect(wrongType.status).toBe(415);
    const tooBig = await t.call("POST", "/v1/merchants", {
      rawBody: JSON.stringify({ name: "x".repeat(70_000) }),
      headers: { "Content-Type": "application/json" },
    });
    expect(tooBig.status).toBe(413);
    expect(field(tooBig.body, "error.code")).toBe("payload_too_large");
  });

  it("refuses a repeated query parameter rather than guess which one was meant", async () => {
    const { key } = await t.register();
    const reply = await t.call("GET", "/v1/checkout/sessions?limit=1&limit=2", { key });
    expect(reply.status).toBe(400);
    expect(field(reply.body, "error.message")).toMatch(/more than once/);
  });

  it("never leaks the message of an unexpected failure, but logs it with the request id", async () => {
    t.chain.snapshot = () => Promise.reject(new Error("db password is hunter2"));
    const reply = await t.call("GET", "/v1/chain");
    expect(reply.status).toBe(500);
    expect(field(reply.body, "error")).toEqual({
      code: "internal_error",
      message: containing("Quote the request id"),
    });
    expect(JSON.stringify(reply.body)).not.toContain("hunter2");
    const logged = t.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === "unhandled error");
    expect(logged).toMatchObject({
      requestId: reply.headers.get("x-request-id"),
      route: "/v1/chain",
    });
  });

  it("logs a line per request with the route pattern, status and merchant, and no secret anywhere", async () => {
    const { id, key, secret } = await t.register();
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { title: "Private title text" },
    });
    const attach = field(created.body, "attachToken") as string;
    await t.call(
      "POST",
      `/v1/checkout/sessions/${field(created.body, "session.id") as string}/commitment`,
      {
        headers: { Authorization: `Bearer ${attach}` },
        body: { commitment: "ab".repeat(32) },
      },
    );
    const lines = t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const request = lines.find(
      (l) => l.msg === "request" && l.route === "/v1/checkout/sessions" && l.status === 201,
    );
    expect(request).toMatchObject({ method: "POST", merchant: id });
    expect(request?.ms).toEqual(expect.any(Number));
    const all = t.logs.join("\n");
    for (const secretValue of [key, secret, attach, "Private title text"])
      expect(all).not.toContain(secretValue);
  });
});

describe("CORS", () => {
  it("sends no cross-origin permission when no origin is configured", async () => {
    t = await startTestApp();
    const reply = await t.call("GET", "/health", { headers: { Origin: "https://evil.example" } });
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows exactly the configured origins, and varies on Origin", async () => {
    t = await startTestApp({
      env: { KINKO_CORS_ORIGINS: "https://app.example,https://other.example" },
    });
    const allowed = await t.call("GET", "/health", {
      headers: { Origin: "https://other.example" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://other.example");
    expect(allowed.headers.get("vary")).toBe("Origin");
    const refused = await t.call("GET", "/health", { headers: { Origin: "https://evil.example" } });
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(refused.headers.get("vary")).toBe("Origin");
  });

  it("answers a preflight without needing credentials", async () => {
    t = await startTestApp({ env: { KINKO_CORS_ORIGINS: "https://app.example" } });
    const reply = await t.call("OPTIONS", "/v1/checkout/sessions", {
      headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(reply.headers.get("access-control-allow-methods")).toContain("POST");
    expect(reply.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("supports a wildcard when the operator asks for one", async () => {
    t = await startTestApp({ env: { KINKO_CORS_ORIGINS: "*" } });
    expect(
      (
        await t.call("GET", "/health", { headers: { Origin: "https://anything.example" } })
      ).headers.get("access-control-allow-origin"),
    ).toBe("*");
  });
});

describe("rate limiting", () => {
  it("limits registrations per address, with Retry-After", async () => {
    t = await startTestApp({ overrides: { limits: { register: { max: 2, windowMs: 60_000 } } } });
    expect((await t.call("POST", "/v1/merchants", { body: { name: "A" } })).status).toBe(201);
    expect((await t.call("POST", "/v1/merchants", { body: { name: "B" } })).status).toBe(201);
    const limited = await t.call("POST", "/v1/merchants", { body: { name: "C" } });
    expect(limited.status).toBe(429);
    expect(field(limited.body, "error.code")).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("opens the window again after it ends", async () => {
    t = await startTestApp({ overrides: { limits: { register: { max: 1, windowMs: 60_000 } } } });
    await t.call("POST", "/v1/merchants", { body: { name: "A" } });
    expect((await t.call("POST", "/v1/merchants", { body: { name: "B" } })).status).toBe(429);
    t.clock.advance(60_001);
    expect((await t.call("POST", "/v1/merchants", { body: { name: "C" } })).status).toBe(201);
  });

  it("limits everything per address, including failed authentication", async () => {
    t = await startTestApp({ overrides: { limits: { global: { max: 5, windowMs: 60_000 } } } });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await t.call("GET", "/v1/merchant", { key: "kk_wrong" })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("limits a merchant by identity and reports the budget in headers", async () => {
    t = await startTestApp({ overrides: { limits: { merchant: { max: 3, windowMs: 60_000 } } } });
    const { key } = await t.register();
    const first = await t.call("GET", "/v1/merchant", { key });
    expect(first.headers.get("ratelimit-limit")).toBe("3");
    expect(first.headers.get("ratelimit-remaining")).toBe("2");
    await t.call("GET", "/v1/merchant", { key });
    await t.call("GET", "/v1/merchant", { key });
    expect((await t.call("GET", "/v1/merchant", { key })).status).toBe(429);
    const other = await t.register("Other Shop", "https://hooks.example.com/other");
    expect((await t.call("GET", "/v1/merchant", { key: other.key })).status).toBe(200);
  });

  it("limits the oracle and the assistant on their own budgets", async () => {
    t = await startTestApp({
      overrides: {
        limits: { oracle: { max: 1, windowMs: 60_000 }, assistant: { max: 1, windowMs: 60_000 } },
      },
    });
    await t.call("POST", "/v1/oracle/quote", { body: {} });
    expect((await t.call("POST", "/v1/oracle/quote", { body: {} })).status).toBe(429);
    await t.call("POST", "/v1/assistant/chat", { body: {} });
    expect((await t.call("POST", "/v1/assistant/chat", { body: {} })).status).toBe(429);
    expect((await t.call("GET", "/health")).status).toBe(200);
  });
});

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Vault } from "../src/domain/crypto.ts";
import { computeSignature } from "../src/domain/signing.ts";
import { field, matching, startTestApp, type TestApp } from "./support/fixtures.ts";

let t: TestApp;
beforeEach(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await t.stop();
});

describe("POST /v1/merchants", () => {
  it("registers a merchant and returns the key and the webhook secret once", async () => {
    const reply = await t.call("POST", "/v1/merchants", {
      body: { name: "Acme Studio", webhookUrl: "https://hooks.example.com/k" },
    });
    expect(reply.status).toBe(201);
    expect(field(reply.body, "merchant")).toMatchObject({
      name: "Acme Studio",
      webhookUrl: "https://hooks.example.com/k",
      id: matching(/^mer_/),
    });
    expect(field(reply.body, "apiKey.key")).toMatch(/^kk_[A-Za-z0-9_-]{43}$/);
    expect(field(reply.body, "webhookSecret")).toMatch(/^whsec_/);
    expect(JSON.stringify(field(reply.body, "merchant"))).not.toMatch(/secret|sealed/i);
  });

  it("stores the API key only as a hash and the webhook secret only sealed", async () => {
    const { id, key, secret } = await t.register();
    const store = t.app.deps.store;
    expect(store.findApiKeyByHash(createHash("sha256").update(key).digest("hex"))?.merchantId).toBe(
      id,
    );
    const record = store.getMerchant(id);
    expect(record?.webhookSecretSealed).not.toContain(secret);
    expect(new Vault(t.config.dataKey).open(record?.webhookSecretSealed ?? "")).toBe(secret);
    expect(JSON.stringify(store.listApiKeys(id))).not.toContain(key);
  });

  it("registers without a webhook URL", async () => {
    const reply = await t.call("POST", "/v1/merchants", { body: { name: "No Hook" } });
    expect(reply.status).toBe(201);
    expect(field(reply.body, "merchant.webhookUrl")).toBeNull();
  });

  it.each([
    [{}, "name"],
    [{ name: "" }, "name"],
    [{ name: "x".repeat(81) }, "name"],
    [{ name: "A", extra: 1 }, "Unrecognized"],
    [{ name: "A", webhookUrl: "http://hooks.example.com/k" }, "https"],
    [{ name: "A", webhookUrl: "https://127.0.0.1/k" }, "private or reserved"],
    [{ name: "A", webhookUrl: "https://169.254.169.254/" }, "private or reserved"],
    [{ name: "A", webhookUrl: "https://localhost/k" }, "public host name"],
    [{ name: "A", webhookUrl: "not a url" }, "absolute URL"],
    [{ name: "A", webhookUrl: "https://hooks.example.com/k#x" }, "fragment"],
  ])("rejects %j", async (body, message) => {
    const reply = await t.call("POST", "/v1/merchants", { body });
    expect(reply.status).toBe(400);
    expect(field(reply.body, "error.code")).toBe("invalid_request");
    expect(JSON.stringify(field(reply.body, "error"))).toContain(message);
  });

  it("requires the operator's token when one is configured", async () => {
    await t.stop();
    t = await startTestApp({ env: { KINKO_REGISTRATION_TOKEN: "operator-token-1234" } });
    expect((await t.call("POST", "/v1/merchants", { body: { name: "A" } })).status).toBe(401);
    expect(
      (
        await t.call("POST", "/v1/merchants", {
          body: { name: "A" },
          headers: { "X-Registration-Token": "wrong-token-123456" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await t.call("POST", "/v1/merchants", {
          body: { name: "A" },
          headers: { "X-Registration-Token": "operator-token-1234" },
        })
      ).status,
    ).toBe(201);
  });

  it("allows private webhook targets only in development mode", async () => {
    await t.stop();
    t = await startTestApp({ env: { KINKO_ALLOW_PRIVATE_WEBHOOKS: "true" } });
    expect(
      (
        await t.call("POST", "/v1/merchants", {
          body: { name: "Dev", webhookUrl: "http://localhost:9000/hook" },
        })
      ).status,
    ).toBe(201);
  });
});

describe("authentication", () => {
  it.each([
    ["no header", undefined],
    ["a malformed header", "Token abc"],
    ["a key without the marker", "Bearer not-a-kinko-key"],
    ["an unknown key", `Bearer kk_${"x".repeat(43)}`],
    ["an empty bearer", "Bearer "],
  ])("refuses %s", async (_name, header) => {
    const reply = await t.call(
      "GET",
      "/v1/merchant",
      header === undefined ? {} : { headers: { Authorization: header } },
    );
    expect(reply.status).toBe(401);
  });

  it("refuses a revoked key and says so", async () => {
    const { key } = await t.register();
    const second = await t.call("POST", "/v1/merchant/api-keys", {
      key,
      body: { label: "second" },
    });
    const secondKey = field(second.body, "apiKey") as { id: string; key: string };
    expect((await t.call("DELETE", `/v1/merchant/api-keys/${secondKey.id}`, { key })).status).toBe(
      204,
    );
    const reply = await t.call("GET", "/v1/merchant", { key: secondKey.key });
    expect(reply.status).toBe(401);
    expect(field(reply.body, "error.message")).toMatch(/revoked/);
  });

  it("records when a key was last used, not on every request", async () => {
    const { key } = await t.register();
    await t.call("GET", "/v1/merchant", { key });
    const first = field(
      (await t.call("GET", "/v1/merchant/api-keys", { key })).body,
      "data[0].lastUsedAt",
    ) as string;
    expect(first).toBe(new Date(t.clock.now()).toISOString());
    t.clock.advance(10_000);
    await t.call("GET", "/v1/merchant", { key });
    expect(
      field((await t.call("GET", "/v1/merchant/api-keys", { key })).body, "data[0].lastUsedAt"),
    ).toBe(first);
    t.clock.advance(60_000);
    await t.call("GET", "/v1/merchant", { key });
    expect(
      field((await t.call("GET", "/v1/merchant/api-keys", { key })).body, "data[0].lastUsedAt"),
    ).not.toBe(first);
  });
});

describe("merchant settings", () => {
  it("shows the merchant and a count of their sessions by status", async () => {
    const { id, key } = await t.register();
    const reply = await t.call("GET", "/v1/merchant", { key });
    expect(reply.status).toBe(200);
    expect(field(reply.body, "merchant.id")).toBe(id);
    expect(field(reply.body, "sessions")).toEqual({
      draft: 0,
      pending: 0,
      settled: 0,
      cancelled: 0,
      expired: 0,
    });
  });

  it("updates the name and the webhook URL, and turns webhooks off with null", async () => {
    const { key } = await t.register();
    const renamed = await t.call("PATCH", "/v1/merchant", {
      key,
      body: { name: "Acme Two", webhookUrl: "https://hooks.example.com/two" },
    });
    expect(field(renamed.body, "merchant")).toMatchObject({
      name: "Acme Two",
      webhookUrl: "https://hooks.example.com/two",
    });
    const off = await t.call("PATCH", "/v1/merchant", { key, body: { webhookUrl: null } });
    expect(field(off.body, "merchant.webhookUrl")).toBeNull();
    expect(field(off.body, "merchant.name")).toBe("Acme Two");
  });

  it("applies the same URL rules on update, and refuses an empty update", async () => {
    const { key } = await t.register();
    expect(
      (await t.call("PATCH", "/v1/merchant", { key, body: { webhookUrl: "https://10.0.0.1/x" } }))
        .status,
    ).toBe(400);
    expect((await t.call("PATCH", "/v1/merchant", { key, body: {} })).status).toBe(400);
  });

  it("manages API keys: list, create, revoke, and never revoke the last one", async () => {
    const { key } = await t.register();
    const initial = field((await t.call("GET", "/v1/merchant/api-keys", { key })).body, "data") as {
      id: string;
      prefix: string;
      label: string;
      revokedAt: string | null;
    }[];
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      label: "default",
      prefix: key.slice(3, 11),
      revokedAt: null,
    });
    expect(JSON.stringify(initial)).not.toContain(key);

    const lockout = await t.call("DELETE", `/v1/merchant/api-keys/${initial[0]?.id ?? ""}`, {
      key,
    });
    expect(lockout.status).toBe(409);
    expect(field(lockout.body, "error.message")).toMatch(/only active API key/);

    const created = await t.call("POST", "/v1/merchant/api-keys", { key, body: { label: "ci" } });
    expect(created.status).toBe(201);
    expect(field(created.body, "apiKey")).toMatchObject({ label: "ci", key: matching(/^kk_/) });

    expect(
      (
        await t.call("DELETE", `/v1/merchant/api-keys/${initial[0]?.id ?? ""}`, {
          key: field(created.body, "apiKey.key") as string,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await t.call("DELETE", `/v1/merchant/api-keys/${initial[0]?.id ?? ""}`, {
          key: field(created.body, "apiKey.key") as string,
        })
      ).status,
    ).toBe(404);
    expect((await t.call("GET", "/v1/merchant", { key })).status).toBe(401);
  });

  it("cannot revoke another merchant's key", async () => {
    const a = await t.register("A", "https://hooks.example.com/a");
    const b = await t.register("B", "https://hooks.example.com/b");
    await t.call("POST", "/v1/merchant/api-keys", { key: b.key, body: {} });
    const bKeys = field(
      (await t.call("GET", "/v1/merchant/api-keys", { key: b.key })).body,
      "data",
    ) as {
      id: string;
    }[];
    expect(
      (await t.call("DELETE", `/v1/merchant/api-keys/${bKeys[0]?.id ?? ""}`, { key: a.key }))
        .status,
    ).toBe(404);
    expect((await t.call("GET", "/v1/merchant", { key: b.key })).status).toBe(200);
  });

  it("rotates the webhook secret: the new one signs, the old one no longer does", async () => {
    const { key, id, secret } = await t.register();
    const rotated = await t.call("POST", "/v1/merchant/webhook/secret", { key });
    expect(rotated.status).toBe(200);
    expect(field(rotated.body, "webhookSecret")).toMatch(/^whsec_/);
    expect(field(rotated.body, "webhookSecret")).not.toBe(secret);
    const stored = t.app.deps.store.getMerchant(id);
    expect(new Vault(t.config.dataKey).open(stored?.webhookSecretSealed ?? "")).toBe(
      field(rotated.body, "webhookSecret"),
    );
  });
});

describe("webhook test and deliveries", () => {
  it("sends a signed test event at once and reports how the receiver answered", async () => {
    const { key, secret } = await t.register();
    const ok = await t.call("POST", "/v1/merchant/webhook/test", { key });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      delivered: true,
      httpStatus: 200,
      error: null,
      eventId: matching(/^evt_/),
    });
    const sent = t.deliverer.requests[0];
    expect(JSON.parse(sent?.body ?? "")).toMatchObject({
      type: "webhook.test",
      id: field(ok.body, "eventId"),
    });
    const [ts, v1] = (sent?.headers["Kinko-Signature"] ?? "")
      .split(",")
      .map((p) => p.split("=")[1] ?? "");
    expect(v1).toBe(computeSignature(secret, Number(ts), sent?.body ?? ""));

    t.deliverer.respond = () => 500;
    const bad = await t.call("POST", "/v1/merchant/webhook/test", { key });
    expect(bad.body).toMatchObject({
      delivered: false,
      httpStatus: 500,
      error: "the receiver answered 500",
    });
    expect(
      field((await t.call("GET", "/v1/merchant/webhook/deliveries", { key })).body, "data"),
    ).toEqual([]);
  });

  it("says plainly when there is no URL to send to", async () => {
    const registered = await t.call("POST", "/v1/merchants", { body: { name: "No Hook" } });
    const key = field(registered.body, "apiKey.key") as string;
    const reply = await t.call("POST", "/v1/merchant/webhook/test", { key });
    expect(reply.body).toMatchObject({ delivered: false, error: "no webhook URL is configured" });
  });

  it("lists recent deliveries with their state, newest first, only the caller's", async () => {
    const { key, id } = await t.register();
    const other = await t.register("Other", "https://hooks.example.com/o");
    const recorder = t.app.deps.events;
    recorder.record(id, null, "invoice.settled" as never, { n: 1 });
    t.clock.advance(1_000);
    recorder.record(id, null, "invoice.expired" as never, { n: 2 });
    recorder.record(other.id, null, "invoice.settled" as never, { n: 3 });
    await t.app.deps.dispatcher.tick();
    const reply = await t.call("GET", "/v1/merchant/webhook/deliveries?limit=10", { key });
    const data = field(reply.body, "data") as {
      type: string;
      status: string;
      attempts: number;
      eventId: string;
    }[];
    expect(data.map((d) => d.type)).toEqual(["invoice.expired", "invoice.settled"]);
    expect(data[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      eventId: matching(/^evt_/),
    });
    expect((await t.call("GET", "/v1/merchant/webhook/deliveries?limit=0", { key })).status).toBe(
      400,
    );
  });
});

describe("telegram link codes", () => {
  it("issues a code, lists linked chats and unlinks one", async () => {
    const { key, id } = await t.register();
    const code = await t.call("POST", "/v1/merchant/telegram/link-codes", { key });
    expect(code.status).toBe(201);
    expect(field(code.body, "code")).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(new Date(field(code.body, "expiresAt") as string).getTime()).toBe(
      t.clock.now() + 15 * 60_000,
    );
    expect(t.app.deps.store.listLinksForMerchant(id)).toEqual([]);

    t.app.deps.store.linkChat({ chatId: 555, merchantId: id, linkedAt: t.clock.now() });
    expect(field((await t.call("GET", "/v1/merchant/telegram", { key })).body, "chats")).toEqual([
      { chatId: 555, linkedAt: new Date(t.clock.now()).toISOString() },
    ]);
    expect((await t.call("DELETE", "/v1/merchant/telegram/555", { key })).status).toBe(204);
    expect((await t.call("DELETE", "/v1/merchant/telegram/555", { key })).status).toBe(404);
    expect((await t.call("DELETE", "/v1/merchant/telegram/abc", { key })).status).toBe(404);
  });

  it("will not unlink a chat that belongs to someone else", async () => {
    const a = await t.register("A", "https://hooks.example.com/a");
    const b = await t.register("B", "https://hooks.example.com/b");
    t.app.deps.store.linkChat({ chatId: 777, merchantId: b.id, linkedAt: 1 });
    expect((await t.call("DELETE", "/v1/merchant/telegram/777", { key: a.key })).status).toBe(404);
    expect(t.app.deps.store.getLinkByChat(777)?.merchantId).toBe(b.id);
  });
});

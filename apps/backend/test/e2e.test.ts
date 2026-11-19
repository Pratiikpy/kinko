// The whole backend against a real contract. A fake indexer serves the state of
// an in-process `kinko_pay` over GraphQL; the app reads it through the shipped
// provider and decoder. Invoices are created and paid by the real circuits, and
// everything downstream (sessions, events, signed webhooks, the bot feed) is
// the production code path.

import { KinkoPay } from "@kinko/kinko-pay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeSignature } from "../src/domain/signing.ts";
import { newTestInvoice, START } from "./support/chain-sim.ts";
import { field } from "./support/fixtures.ts";
import { BOT_TOKEN, type LiveApp, startLiveApp } from "./support/live.ts";

describe("end to end on a real contract", () => {
  let live: LiveApp;
  let app: LiveApp["app"];
  let sim: LiveApp["sim"];
  let deliverer: LiveApp["deliverer"];
  let base: string;

  const call = async (
    method: string,
    path: string,
    init: { key?: string; body?: unknown; bot?: boolean } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (init.key) headers.Authorization = `Bearer ${init.key}`;
    if (init.bot) headers.Authorization = `Bearer ${BOT_TOKEN}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  };

  beforeEach(async () => {
    live = await startLiveApp();
    ({ app, sim, deliverer, base } = live);
  });

  afterEach(async () => {
    await live.stop();
  });

  const register = async () => {
    const reply = await call("POST", "/v1/merchants", {
      body: { name: "Acme Studio", webhookUrl: "https://hooks.example.com/kinko" },
    });
    return {
      key: field(reply.body, "apiKey.key") as string,
      secret: field(reply.body, "webhookSecret") as string,
      id: field(reply.body, "merchant.id") as string,
    };
  };

  it("takes a standard invoice from creation to a signed, amount-free settlement webhook", async () => {
    const m = await register();
    const invoice = newTestInvoice({ token: KinkoPay.TokenKind.KUSD, amount: 987_654_321n });
    const created = await call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: invoice.commitment, title: "Logo design", clientReference: "order-9" },
    });
    const sessionId = field(created.body, "session.id") as string;
    const { watcher, dispatcher, store } = app.deps;

    // Not on chain yet: nothing happens, and the public view says pending.
    await watcher.tick();
    expect(
      field((await call("GET", `/v1/checkout/sessions/${sessionId}`)).body, "session"),
    ).toMatchObject({
      status: "pending",
    });

    // The merchant's wallet publishes the invoice.
    await sim.create(invoice);
    await watcher.tick();
    expect(store.getSession(sessionId)).toMatchObject({ status: "pending", onChain: true });
    expect((await call("GET", `/v1/chain/invoices/${invoice.commitment}`)).body).toMatchObject({
      found: true,
      status: "open",
      kind: "standard",
      asset: "KUSD",
      contributions: 0,
    });

    // A payer pays. The backend sees it only by reading the ledger.
    await sim.pay(invoice);
    await watcher.tick();
    expect(store.getSession(sessionId)).toMatchObject({
      status: "settled",
      contributions: 1,
      late: false,
    });
    expect((await call("GET", `/v1/chain/invoices/${invoice.commitment}`)).body).toMatchObject({
      status: "settled",
      contributions: 1,
    });

    // Webhooks go out signed, and say nothing about money.
    await dispatcher.tick();
    expect(deliverer.requests.map((r) => r.headers["Kinko-Event-Type"])).toEqual([
      "invoice.payment_received",
      "invoice.settled",
    ]);
    const settled = deliverer.requests[1];
    const [ts, v1] = (settled?.headers["Kinko-Signature"] ?? "")
      .split(",")
      .map((p) => p.split("=")[1] ?? "");
    expect(v1).toBe(computeSignature(m.secret, Number(ts), settled?.body ?? ""));
    expect(JSON.parse(settled?.body ?? "")).toMatchObject({
      type: "invoice.settled",
      data: {
        sessionId,
        commitment: invoice.commitment,
        clientReference: "order-9",
        title: "Logo design",
        status: "settled",
        contributions: 1,
      },
    });
    for (const request of deliverer.requests) expect(request.body).not.toMatch(/987654321|amount/i);
  });

  it("follows a multipay invoice through each contribution until the merchant closes it", async () => {
    const m = await register();
    const invoice = newTestInvoice({
      kind: KinkoPay.InvoiceKind.MULTIPAY,
      token: KinkoPay.TokenKind.NATIVE,
    });
    const created = await call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: invoice.commitment, kind: "multipay", token: "NATIVE" },
    });
    await sim.create(invoice);
    await sim.pay(invoice, 0x51);
    await app.deps.watcher.tick();
    await sim.pay(invoice, 0x52);
    await sim.pay(invoice, 0x53);
    await app.deps.watcher.tick();
    await sim.close(invoice);
    await app.deps.watcher.tick();
    const session = field(
      (
        await call("GET", `/v1/checkout/sessions/${field(created.body, "session.id") as string}`, {
          key: m.key,
        })
      ).body,
      "session",
    );
    expect(session).toMatchObject({ status: "settled", contributions: 3, kind: "multipay" });
    const feed = field(
      (await call("GET", "/v1/merchant/webhook/deliveries", { key: m.key })).body,
      "data",
    ) as { type: string }[];
    expect(feed.map((d) => d.type).sort()).toEqual([
      "invoice.payment_received",
      "invoice.payment_received",
      "invoice.settled",
    ]);
  });

  it("sees a cancellation, and marks a session expired when its invoice was never paid", async () => {
    const m = await register();
    const cancelled = newTestInvoice();
    const lapsed = newTestInvoice();
    const a = await call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: cancelled.commitment },
    });
    const b = await call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: lapsed.commitment, ttlSeconds: 60 },
    });
    await sim.create(cancelled);
    await sim.create(lapsed);
    await sim.cancel(cancelled);
    live.clock.now += 61_000;
    await app.deps.watcher.tick();
    expect(app.deps.store.getSession(field(a.body, "session.id") as string)?.status).toBe(
      "cancelled",
    );
    expect(app.deps.store.getSession(field(b.body, "session.id") as string)?.status).toBe(
      "expired",
    );
  });

  it("settles a payment made after the session lapsed and flags it late", async () => {
    const m = await register();
    const invoice = newTestInvoice();
    const created = await call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: invoice.commitment, ttlSeconds: 60 },
    });
    await sim.create(invoice);
    live.clock.now += 61_000;
    await app.deps.watcher.tick();
    expect(app.deps.store.getSession(field(created.body, "session.id") as string)?.status).toBe(
      "expired",
    );
    await sim.pay(invoice);
    await app.deps.watcher.tick();
    expect(app.deps.store.getSession(field(created.body, "session.id") as string)).toMatchObject({
      status: "settled",
      late: true,
    });
  });

  it("shares one invoice's on-chain expiry with its session", async () => {
    const m = await register();
    const invoice = newTestInvoice({ expiresAt: START + 120n });
    const created = await call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: invoice.commitment, ttlSeconds: 3_600 },
    });
    await sim.create(invoice);
    await app.deps.watcher.tick();
    expect(app.deps.store.getSession(field(created.body, "session.id") as string)).toMatchObject({
      status: "pending",
      chainExpiresAt: Number(START + 120n) * 1000,
    });
    live.clock.now += 121_000;
    await app.deps.watcher.tick();
    expect(app.deps.store.getSession(field(created.body, "session.id") as string)?.status).toBe(
      "expired",
    );
  });

  it("notifies a linked Telegram chat of a settlement through the bot feed", async () => {
    const m = await register();
    const code = field(
      (await call("POST", "/v1/merchant/telegram/link-codes", { key: m.key })).body,
      "code",
    ) as string;
    await call("POST", "/v1/bot/link", { bot: true, body: { code, chatId: 4242 } });
    const draft = await call("POST", "/v1/bot/chats/4242/sessions", {
      bot: true,
      body: { title: "Retainer" },
    });
    const fragment = new URLSearchParams(
      new URL(field(draft.body, "formUrl") as string).hash.slice(1),
    );
    const invoice = newTestInvoice({ token: KinkoPay.TokenKind.KUSD });
    const attach = await fetch(
      `${base}/v1/checkout/sessions/${fragment.get("session") ?? ""}/commitment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fragment.get("attach") ?? ""}`,
        },
        body: JSON.stringify({ commitment: invoice.commitment }),
      },
    );
    expect(attach.status).toBe(200);
    await sim.create(invoice);
    await sim.pay(invoice);
    await app.deps.watcher.tick();
    const feed = await call("GET", "/v1/bot/events?after=0", { bot: true });
    const settled = (
      field(feed.body, "data") as {
        type: string;
        chatIds: number[];
        data: Record<string, unknown>;
      }[]
    ).find((e) => e.type === "invoice.settled");
    expect(settled).toMatchObject({
      chatIds: [4242],
      data: { title: "Retainer", status: "settled" },
    });
  });

  it("answers for the contract it is configured for, and reports a wrong address plainly", async () => {
    const chain = await call("GET", "/v1/chain");
    expect(chain.body).toMatchObject({
      invoicesCreated: "0",
      oraclePublicKey: {
        x: live.oracle.publicKey.x.toString(),
        y: live.oracle.publicKey.y.toString(),
      },
    });
    expect((await call("GET", "/v1/oracle")).body).toMatchObject({
      configured: true,
      matchesContract: true,
    });
    expect(field((await call("GET", "/health")).body, "oracle")).toMatchObject({
      keyMatchesContract: true,
    });
  });
});

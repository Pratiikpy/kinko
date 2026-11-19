import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Vault } from "../src/domain/crypto.ts";
import { DeliveryStatus, EventType } from "../src/domain/enums.ts";
import { EventRecorder } from "../src/domain/events.ts";
import { computeSignature } from "../src/domain/signing.ts";
import { silentLogger } from "../src/log.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, WebhookDispatcher } from "../src/webhooks/dispatcher.ts";
import { BlockedDestinationError, HttpDeliverer } from "../src/webhooks/http-deliverer.ts";
import { FakeDeliverer, TestClock } from "./support/fixtures.ts";

/** Narrow a possibly missing value, failing the test with a clear message when it is absent. */
const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
};

const vault = new Vault("ab".repeat(32));
const SECRET = "whsec_test_secret";
const URL_OK = "https://hooks.example.com/kinko";

describe("WebhookDispatcher", () => {
  let store: SqliteStore;
  let clock: TestClock;
  let deliverer: FakeDeliverer;
  let dispatcher: WebhookDispatcher;
  let recorder: EventRecorder;

  const enqueue = (type = EventType.SETTLED) =>
    recorder.record("mer_1", "cs_1", type, { sessionId: "cs_1", status: "settled" });
  const delivery = () => store.listDeliveries("mer_1", 10)[0];

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    clock = new TestClock();
    deliverer = new FakeDeliverer();
    recorder = new EventRecorder(store, clock.now);
    store.insertMerchant({
      id: "mer_1",
      name: "Acme",
      webhookUrl: URL_OK,
      webhookSecretSealed: vault.seal(SECRET),
      createdAt: 0,
    });
    dispatcher = new WebhookDispatcher({
      store,
      vault,
      deliverer,
      clock: clock.now,
      log: silentLogger,
      timeoutMs: 5_000,
      allowPrivateTargets: false,
    });
  });

  it("delivers the stored body, signed with the merchant's secret and a fresh timestamp", async () => {
    const event = enqueue();
    expect(await dispatcher.tick()).toBe(1);
    const sent = deliverer.requests[0];
    expect(sent?.url).toBe(URL_OK);
    expect(sent?.body).toBe(event.body);
    expect(sent?.timeoutMs).toBe(5_000);
    const signature = sent?.headers["Kinko-Signature"] ?? "";
    const [t, v1] = signature.split(",").map((p) => p.split("=")[1] ?? "");
    expect(Number(t)).toBe(Math.floor(clock.now() / 1000));
    expect(v1).toBe(computeSignature(SECRET, Number(t), event.body));
    expect(sent?.headers).toMatchObject({
      "Content-Type": "application/json",
      "Kinko-Event-Id": event.id,
      "Kinko-Event-Type": "invoice.settled",
      "Kinko-Delivery-Attempt": "1",
    });
    expect(delivery()).toMatchObject({
      status: "delivered",
      attempts: 1,
      lastHttpStatus: 200,
      lastError: null,
      deliveredAt: clock.now(),
    });
    expect(dispatcher.stats).toMatchObject({ attempts: 1, delivered: 1 });
  });

  it("does not redeliver what was delivered", async () => {
    enqueue();
    await dispatcher.tick();
    expect(await dispatcher.tick()).toBe(0);
    expect(deliverer.requests).toHaveLength(1);
  });

  it("retries on the schedule when the receiver fails, and stops when it succeeds", async () => {
    enqueue();
    deliverer.respond = (attempt) => (attempt < 3 ? 500 : 204);
    await dispatcher.tick();
    expect(delivery()).toMatchObject({
      status: "pending",
      attempts: 1,
      lastHttpStatus: 500,
      lastError: "the receiver answered 500",
      nextAttemptAt: clock.now() + 10_000,
    });
    expect(await dispatcher.tick()).toBe(0);

    clock.advance(10_000);
    await dispatcher.tick();
    expect(delivery()).toMatchObject({
      status: "pending",
      attempts: 2,
      nextAttemptAt: clock.now() + 30_000,
    });
    expect(deliverer.requests[1]?.headers["Kinko-Delivery-Attempt"]).toBe("2");

    clock.advance(30_000);
    await dispatcher.tick();
    expect(delivery()).toMatchObject({ status: "delivered", attempts: 3, lastHttpStatus: 204 });
  });

  it("signs each attempt with its own timestamp", async () => {
    enqueue();
    deliverer.respond = (attempt) => (attempt === 1 ? 500 : 200);
    await dispatcher.tick();
    clock.advance(10_000);
    await dispatcher.tick();
    const stamps = deliverer.requests.map((r) => r.headers["Kinko-Signature"]?.split(",")[0]);
    expect(stamps[0]).not.toBe(stamps[1]);
  });

  it("gives up after the last attempt and says so", async () => {
    enqueue();
    deliverer.respond = () => 503;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await dispatcher.tick();
      clock.advance(RETRY_DELAYS_MS[i] ?? 0);
    }
    expect(delivery()).toMatchObject({
      status: DeliveryStatus.FAILED,
      attempts: MAX_ATTEMPTS,
      lastHttpStatus: 503,
    });
    expect(await dispatcher.tick()).toBe(0);
    expect(deliverer.requests).toHaveLength(MAX_ATTEMPTS);
    expect(dispatcher.stats.failedPermanently).toBe(1);
  });

  it("spans about a day across ten attempts", () => {
    expect(MAX_ATTEMPTS).toBe(10);
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(20 * 3_600_000);
    expect(total).toBeLessThan(26 * 3_600_000);
  });

  it("treats a network error as a failed attempt with its message", async () => {
    enqueue();
    deliverer.respond = () => new Error("ECONNRESET");
    await dispatcher.tick();
    expect(delivery()).toMatchObject({
      status: "pending",
      lastHttpStatus: null,
      lastError: "ECONNRESET",
    });
  });

  it("treats a redirect as a failure rather than following it", async () => {
    enqueue();
    deliverer.respond = () => 302;
    await dispatcher.tick();
    expect(delivery()).toMatchObject({ status: "pending", lastHttpStatus: 302 });
  });

  it("uses the merchant's current secret, so a rotation takes effect on the next attempt", async () => {
    const event = enqueue();
    deliverer.respond = (attempt) => (attempt === 1 ? 500 : 200);
    await dispatcher.tick();
    store.updateMerchant("mer_1", { webhookSecretSealed: vault.seal("whsec_rotated") });
    clock.advance(10_000);
    await dispatcher.tick();
    const [t, v1] = (deliverer.requests[1]?.headers["Kinko-Signature"] ?? "")
      .split(",")
      .map((p) => p.split("=")[1] ?? "");
    expect(v1).toBe(computeSignature("whsec_rotated", Number(t), event.body));
  });

  it("fails a delivery whose merchant removed the URL, without sending anything", async () => {
    enqueue();
    store.updateMerchant("mer_1", { webhookUrl: null });
    await dispatcher.tick();
    expect(deliverer.requests).toHaveLength(0);
    expect(delivery()?.lastError).toBe("no webhook URL is configured");
  });

  it("refuses to send to an address the policy forbids, even if it was stored", async () => {
    enqueue();
    store.updateMerchant("mer_1", { webhookUrl: "https://169.254.169.254/latest" });
    await dispatcher.tick();
    expect(deliverer.requests).toHaveLength(0);
    expect(delivery()?.lastError).toMatch(/private or reserved/);
  });

  it("reports an unreadable secret instead of sending an unsigned request", async () => {
    enqueue();
    store.updateMerchant("mer_1", { webhookSecretSealed: new Vault("cd".repeat(32)).seal("x") });
    await dispatcher.tick();
    expect(deliverer.requests).toHaveLength(0);
    expect(delivery()?.lastError).toMatch(/wrong data key/);
  });

  it("sends a test event once, without queueing or retrying", async () => {
    const event = store.insertEvent({
      id: "evt_t",
      merchantId: "mer_1",
      sessionId: null,
      type: EventType.WEBHOOK_TEST,
      body: '{"id":"evt_t"}',
      createdAt: 1,
    });
    deliverer.respond = () => 500;
    const merchant = store.getMerchant("mer_1");
    expect(merchant).toBeDefined();
    const outcome = await dispatcher.sendNow(required(merchant, "the merchant"), event);
    expect(outcome).toEqual({ ok: false, httpStatus: 500, error: "the receiver answered 500" });
    expect(store.listDeliveries("mer_1", 10)).toEqual([]);
  });

  it("works through a backlog in batches", async () => {
    for (let i = 0; i < 30; i++) enqueue();
    expect(await dispatcher.tick()).toBe(25);
    expect(await dispatcher.tick()).toBe(5);
    expect(deliverer.requests).toHaveLength(30);
  });

  it("runs on a timer and stops cleanly", async () => {
    const timed = new WebhookDispatcher({
      store,
      vault,
      deliverer,
      clock: clock.now,
      log: silentLogger,
      timeoutMs: 1000,
      allowPrivateTargets: false,
      intervalMs: 10,
    });
    enqueue();
    timed.start();
    timed.start();
    await new Promise((r) => setTimeout(r, 50));
    await timed.stop();
    expect(deliverer.requests).toHaveLength(1);
  });
});

describe("HttpDeliverer", () => {
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

  const listen = async (
    handler: (req: IncomingMessage, body: string, respond: (status: number) => void) => void,
  ) => {
    const seen: {
      headers: IncomingMessage["headers"];
      body: string;
      method: string | undefined;
    }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ headers: req.headers, body, method: req.method });
        handler(req, body, (status) => {
          res.writeHead(status, status === 302 ? { Location: "http://169.254.169.254/" } : {});
          res.end("ignored");
        });
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`,
      seen,
    };
  };

  const dev = new HttpDeliverer({ allowPrivateTargets: true });
  const request = (url: string, body = '{"a":1}') => ({
    url,
    body,
    timeoutMs: 2_000,
    headers: { "Content-Type": "application/json", "Kinko-Event-Id": "evt_1" },
  });

  it("posts the body and headers and returns the status", async () => {
    const { url, seen } = await listen((_r, _b, respond) => {
      respond(204);
    });
    await expect(dev.deliver(request(url))).resolves.toEqual({ status: 204 });
    expect(seen[0]).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(seen[0]?.headers).toMatchObject({
      "content-type": "application/json",
      "kinko-event-id": "evt_1",
      "content-length": "7",
    });
  });

  it("reports a non-2xx status as an answer, and does not follow a redirect", async () => {
    const { url, seen } = await listen((_r, _b, respond) => {
      respond(302);
    });
    await expect(dev.deliver(request(url))).resolves.toEqual({ status: 302 });
    expect(seen).toHaveLength(1);
  });

  it("times out on a receiver that never answers", async () => {
    const { url } = await listen(() => undefined);
    await expect(dev.deliver({ ...request(url), timeoutMs: 100 })).rejects.toThrow(
      /no answer within 100 ms/,
    );
  });

  it("rejects when nothing is listening", async () => {
    await expect(dev.deliver(request("http://127.0.0.1:1/hook"))).rejects.toThrow();
  });

  it("refuses a private IP literal before connecting", async () => {
    const { url, seen } = await listen((_r, _b, respond) => {
      respond(200);
    });
    await expect(
      new HttpDeliverer({ allowPrivateTargets: false }).deliver(request(url)),
    ).rejects.toThrow(BlockedDestinationError);
    expect(seen).toHaveLength(0);
  });

  it("refuses a host name that resolves to a private address, checked at connect time", async () => {
    const { url, seen } = await listen((_r, _b, respond) => {
      respond(200);
    });
    const byName = url.replace("127.0.0.1", "localhost");
    await expect(
      new HttpDeliverer({ allowPrivateTargets: false }).deliver(request(byName)),
    ).rejects.toThrow(/not a public address/);
    expect(seen).toHaveLength(0);
  });

  it("refuses cloud metadata and IPv6 loopback literals", async () => {
    const strict = new HttpDeliverer({ allowPrivateTargets: false });
    await expect(
      strict.deliver(request("http://169.254.169.254/latest/meta-data")),
    ).rejects.toThrow(BlockedDestinationError);
    await expect(strict.deliver(request("http://[::1]:9/x"))).rejects.toThrow(
      BlockedDestinationError,
    );
  });
});

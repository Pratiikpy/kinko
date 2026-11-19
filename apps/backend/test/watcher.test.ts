import { beforeEach, describe, expect, it } from "vitest";

import type { ChainInvoice } from "../src/chain/reader.ts";
import {
  ChainInvoiceStatus,
  DeliveryStatus,
  EventType,
  InvoiceKindName,
  SessionStatus,
  TokenName,
} from "../src/domain/enums.ts";
import { EventRecorder } from "../src/domain/events.ts";
import { silentLogger } from "../src/log.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import type { SessionRecord } from "../src/store/store.ts";
import { decide, Watcher } from "../src/watcher.ts";
import { FakeChain, TestClock } from "./support/fixtures.ts";

const NOW = 1_000_000;
const C = "ab".repeat(32);

const base = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  seq: 1,
  id: "cs_1",
  merchantId: "mer_1",
  commitment: C,
  kind: InvoiceKindName.STANDARD,
  token: TokenName.KUSD,
  status: SessionStatus.PENDING,
  title: null,
  memo: null,
  amount: null,
  clientReference: null,
  successUrl: null,
  cancelUrl: null,
  createdAt: 0,
  expiresAt: NOW + 60_000,
  settledAt: null,
  contributions: 0,
  onChain: false,
  chainExpiresAt: null,
  late: false,
  attachTokenHash: null,
  ...over,
});

const chain = (over: Partial<ChainInvoice> = {}): ChainInvoice => ({
  status: ChainInvoiceStatus.OPEN,
  kind: InvoiceKindName.STANDARD,
  token: TokenName.KUSD,
  expiresAt: null,
  contributions: 0,
  ...over,
});

const types = (d: ReturnType<typeof decide>) => d.events.map((e) => e.type);

describe("decide", () => {
  it("leaves a pending session alone while the chain has not seen its invoice", () => {
    expect(decide(base(), undefined, NOW)).toEqual({ patch: {}, events: [] });
  });

  it("expires a pending session whose invoice never appeared", () => {
    const d = decide(base({ expiresAt: NOW - 1 }), undefined, NOW);
    expect(d.patch).toEqual({ status: "expired" });
    expect(types(d)).toEqual([EventType.EXPIRED]);
  });

  it("marks the invoice as seen on chain and copies what the chain says about it", () => {
    const d = decide(
      base({ kind: InvoiceKindName.STANDARD, token: TokenName.KUSD }),
      chain({ kind: InvoiceKindName.MULTIPAY, token: TokenName.NATIVE, expiresAt: NOW + 5 }),
      NOW,
    );
    expect(d.patch).toEqual({
      onChain: true,
      kind: "multipay",
      token: "NATIVE",
      chainExpiresAt: NOW + 5,
    });
    expect(d.events).toEqual([]);
  });

  it("announces a payment, with the new total and no amount", () => {
    const d = decide(base({ onChain: true }), chain({ contributions: 2 }), NOW);
    expect(d.patch).toEqual({ contributions: 2 });
    expect(d.events).toEqual([
      { type: EventType.PAYMENT_RECEIVED, extra: { contributions: 2, newPayments: 2 } },
    ]);
  });

  it("announces only the contributions it has not announced before", () => {
    const d = decide(base({ onChain: true, contributions: 2 }), chain({ contributions: 5 }), NOW);
    expect(d.events[0]?.extra).toMatchObject({ contributions: 5, newPayments: 3 });
  });

  it("says nothing when nothing changed", () => {
    const d = decide(base({ onChain: true, contributions: 2 }), chain({ contributions: 2 }), NOW);
    expect(d).toEqual({ patch: {}, events: [] });
  });

  it("settles a paid standard invoice: the payment first, then the settlement", () => {
    const d = decide(
      base({ onChain: true }),
      chain({ status: ChainInvoiceStatus.SETTLED, contributions: 1 }),
      NOW,
    );
    expect(types(d)).toEqual([EventType.PAYMENT_RECEIVED, EventType.SETTLED]);
    expect(d.patch).toMatchObject({ status: "settled", settledAt: NOW, late: false });
  });

  it("settles a closed multipay invoice without repeating payments already announced", () => {
    const d = decide(
      base({ onChain: true, contributions: 3, kind: InvoiceKindName.MULTIPAY }),
      chain({
        kind: InvoiceKindName.MULTIPAY,
        status: ChainInvoiceStatus.SETTLED,
        contributions: 3,
      }),
      NOW,
    );
    expect(types(d)).toEqual([EventType.SETTLED]);
  });

  it("cancels when the merchant cancelled on chain", () => {
    const d = decide(base({ onChain: true }), chain({ status: ChainInvoiceStatus.CANCELLED }), NOW);
    expect(d.patch).toMatchObject({ status: "cancelled" });
    expect(types(d)).toEqual([EventType.CANCELLED]);
  });

  it("expires an open invoice at the session deadline", () => {
    const d = decide(base({ onChain: true, expiresAt: NOW }), chain(), NOW);
    expect(d.patch).toEqual({ status: "expired" });
    expect(types(d)).toEqual([EventType.EXPIRED]);
  });

  it("expires an open invoice at its own on-chain deadline if that comes first", () => {
    const d = decide(
      base({ onChain: true, chainExpiresAt: NOW - 5 }),
      chain({ expiresAt: NOW - 5 }),
      NOW,
    );
    expect(types(d)).toEqual([EventType.EXPIRED]);
  });

  it("does not expire an invoice that is paid, even past the deadline", () => {
    const d = decide(
      base({ onChain: true, expiresAt: NOW - 1 }),
      chain({ status: ChainInvoiceStatus.SETTLED, contributions: 1 }),
      NOW,
    );
    expect(d.patch.status).toBe("settled");
    expect(types(d)).not.toContain(EventType.EXPIRED);
  });

  describe("a payment that arrives after the session expired", () => {
    const expired = (over: Partial<SessionRecord> = {}) =>
      base({ status: SessionStatus.EXPIRED, onChain: true, expiresAt: NOW - 1000, ...over });

    it("settles the session and says it was late, because money arrived", () => {
      const d = decide(
        expired(),
        chain({ status: ChainInvoiceStatus.SETTLED, contributions: 1 }),
        NOW,
      );
      expect(d.patch).toMatchObject({ status: "settled", late: true });
      expect(d.events).toEqual([
        {
          type: EventType.PAYMENT_RECEIVED,
          extra: { contributions: 1, newPayments: 1, late: true },
        },
        { type: EventType.SETTLED, extra: { late: true } },
      ]);
    });

    it("announces a late contribution to a multipay invoice that is still open, and stays expired", () => {
      const d = decide(
        expired({ kind: InvoiceKindName.MULTIPAY }),
        chain({ kind: InvoiceKindName.MULTIPAY, contributions: 1 }),
        NOW,
      );
      expect(types(d)).toEqual([EventType.PAYMENT_RECEIVED]);
      expect(d.patch.status).toBeUndefined();
    });

    it("ignores a cancellation after expiry", () => {
      const d = decide(expired(), chain({ status: ChainInvoiceStatus.CANCELLED }), NOW);
      expect(d.events).toEqual([]);
      expect(d.patch.status).toBeUndefined();
    });

    it("does not expire it again", () => {
      expect(decide(expired(), chain(), NOW).events).toEqual([]);
    });
  });
});

describe("Watcher", () => {
  let store: SqliteStore;
  let reader: FakeChain;
  let clock: TestClock;
  let watcher: Watcher;
  let events: EventRecorder;

  const addSession = (
    id: string,
    commitment: string | null,
    over: Partial<Omit<SessionRecord, "seq">> = {},
  ) =>
    store.insertSession({
      ...base({ id, commitment, expiresAt: clock.now() + 3_600_000, createdAt: clock.now() }),
      ...over,
    });

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    clock = new TestClock();
    reader = new FakeChain();
    events = new EventRecorder(store, clock.now);
    store.insertMerchant({
      id: "mer_1",
      name: "Acme",
      webhookUrl: "https://hooks.example.com/k",
      webhookSecretSealed: "x",
      createdAt: 0,
    });
    watcher = new Watcher({
      store,
      reader,
      events,
      clock: clock.now,
      log: silentLogger,
      pollMs: 1000,
      lateSettlementMs: 7 * 86_400_000,
    });
  });

  it("settles a session when the invoice is paid, and records events and one webhook per event", async () => {
    addSession("cs_1", C, { title: "Invoice 1", clientReference: "order-9" });
    reader.open(C);
    await watcher.tick();
    expect(store.getSession("cs_1")).toMatchObject({ status: "pending", onChain: true });
    expect(store.listEvents(0, 10)).toEqual([]);

    reader.update(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    await watcher.tick();
    const session = store.getSession("cs_1");
    expect(session).toMatchObject({
      status: "settled",
      contributions: 1,
      settledAt: clock.now(),
      late: false,
    });

    const stored = store.listEvents(0, 10);
    expect(stored.map((e) => e.type)).toEqual([EventType.PAYMENT_RECEIVED, EventType.SETTLED]);
    const settled = JSON.parse(stored[1]?.body ?? "") as {
      data: Record<string, unknown>;
      id: string;
      type: string;
    };
    expect(settled.id).toBe(stored[1]?.id);
    expect(settled.data).toMatchObject({
      sessionId: "cs_1",
      commitment: C,
      status: "settled",
      clientReference: "order-9",
      title: "Invoice 1",
      contributions: 1,
      late: false,
    });
    expect(Object.keys(settled.data).join()).not.toMatch(/amount/i);
    expect(store.dueDeliveries(clock.now(), 10)).toHaveLength(2);
  });

  it("is idempotent: a second pass over the same chain records nothing new", async () => {
    addSession("cs_1", C);
    reader.open(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    await watcher.tick();
    const before = store.listEvents(0, 100).length;
    await watcher.tick();
    await watcher.tick();
    expect(store.listEvents(0, 100)).toHaveLength(before);
    expect(watcher.stats.settled).toBe(1);
  });

  it("queues no webhook for a merchant without a URL, but still records the event for the bot", async () => {
    store.updateMerchant("mer_1", { webhookUrl: null });
    addSession("cs_1", C);
    reader.open(C, { status: ChainInvoiceStatus.CANCELLED });
    await watcher.tick();
    expect(store.listEvents(0, 10).map((e) => e.type)).toEqual([EventType.CANCELLED]);
    expect(store.dueDeliveries(clock.now(), 10)).toEqual([]);
  });

  it("announces each contribution to a multipay invoice, then settles when it is closed", async () => {
    addSession("cs_1", C, { kind: InvoiceKindName.MULTIPAY });
    reader.open(C, { kind: InvoiceKindName.MULTIPAY, contributions: 1 });
    await watcher.tick();
    reader.update(C, { contributions: 3 });
    await watcher.tick();
    reader.update(C, { status: ChainInvoiceStatus.SETTLED });
    await watcher.tick();
    const stored = store.listEvents(0, 10).map((e) => ({
      type: e.type,
      data: (JSON.parse(e.body) as { data: Record<string, unknown> }).data,
    }));
    expect(stored.map((e) => e.type)).toEqual([
      EventType.PAYMENT_RECEIVED,
      EventType.PAYMENT_RECEIVED,
      EventType.SETTLED,
    ]);
    expect(stored[1]?.data).toMatchObject({ contributions: 3, newPayments: 2 });
  });

  it("expires a session whose invoice was never created, and tells the merchant", async () => {
    addSession("cs_1", C);
    clock.advance(3_600_001);
    await watcher.tick();
    expect(store.getSession("cs_1")?.status).toBe("expired");
    expect(store.listEvents(0, 10).map((e) => e.type)).toEqual([EventType.EXPIRED]);
  });

  it("expires a draft nobody attached a commitment to, without reading the chain", async () => {
    addSession("cs_d", null, { status: SessionStatus.DRAFT });
    clock.advance(3_600_001);
    await watcher.tick();
    expect(store.getSession("cs_d")?.status).toBe("expired");
    expect(reader.reads).toBe(0);
  });

  it("settles a late payment and flags it", async () => {
    addSession("cs_1", C);
    reader.open(C);
    clock.advance(3_600_001);
    await watcher.tick();
    expect(store.getSession("cs_1")?.status).toBe("expired");

    reader.update(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    await watcher.tick();
    expect(store.getSession("cs_1")).toMatchObject({ status: "settled", late: true });
    const last = store.listEvents(0, 10).at(-1);
    expect(last?.type).toBe(EventType.SETTLED);
    expect((JSON.parse(last?.body ?? "") as { data: { late: boolean } }).data.late).toBe(true);
  });

  it("stops watching an expired session after the late-payment window", async () => {
    addSession("cs_1", C);
    reader.open(C);
    clock.advance(3_600_001);
    await watcher.tick();
    clock.advance(8 * 86_400_000);
    reader.update(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    await watcher.tick();
    expect(store.getSession("cs_1")?.status).toBe("expired");
  });

  it("skips the indexer entirely when nothing is waiting", async () => {
    await watcher.tick();
    expect(reader.reads).toBe(0);
    expect(watcher.stats.lastSuccessAt).toBe(clock.now());
  });

  it("reads the chain once per pass however many sessions are waiting", async () => {
    for (let i = 0; i < 5; i++) addSession(`cs_${String(i)}`, String(i).repeat(64));
    await watcher.tick();
    expect(reader.reads).toBe(1);
  });

  it("survives an unreachable chain, records why, and recovers on the next pass", async () => {
    addSession("cs_1", C);
    reader.open(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    reader.failing = true;
    await expect(watcher.tick()).resolves.toBeUndefined();
    expect(watcher.stats.lastError).toMatch(/could not be reached/);
    expect(store.getSession("cs_1")?.status).toBe("pending");

    reader.failing = false;
    await watcher.tick();
    expect(store.getSession("cs_1")?.status).toBe("settled");
    expect(watcher.stats.lastError).toBeNull();
  });

  it("keeps going when one session cannot be updated", async () => {
    addSession("cs_bad", "01".repeat(32));
    addSession("cs_ok", "02".repeat(32));
    reader.open("01".repeat(32), { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    reader.open("02".repeat(32), { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    const original = store.updateSession.bind(store);
    store.updateSession = (id, patch) => {
      if (id === "cs_bad") throw new Error("disk full");
      return original(id, patch);
    };
    await watcher.tick();
    expect(store.getSession("cs_ok")?.status).toBe("settled");
    expect(store.getSession("cs_bad")?.status).toBe("pending");
  });

  it("writes the session change and its events together or not at all", async () => {
    addSession("cs_1", C);
    reader.open(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    const original = events.record.bind(events);
    let calls = 0;
    events.record = (...args) => {
      calls++;
      if (calls === 2) throw new Error("event store failed");
      return original(...args);
    };
    await watcher.tick();
    // The second event failed, so the whole change was undone: nothing half-recorded.
    expect(store.getSession("cs_1")?.status).toBe("pending");
    expect(store.listEvents(0, 10)).toEqual([]);
    expect(store.dueDeliveries(clock.now(), 10)).toEqual([]);

    events.record = original;
    await watcher.tick();
    expect(store.getSession("cs_1")?.status).toBe("settled");
    expect(store.listEvents(0, 10)).toHaveLength(2);
  });

  it("queues deliveries as pending, due now", async () => {
    addSession("cs_1", C);
    reader.open(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    await watcher.tick();
    for (const d of store.dueDeliveries(clock.now(), 10)) {
      expect(d).toMatchObject({
        status: DeliveryStatus.PENDING,
        attempts: 0,
        nextAttemptAt: clock.now(),
      });
    }
  });

  it("runs on a timer and stops cleanly", async () => {
    const timed = new Watcher({
      store,
      reader,
      events,
      clock: clock.now,
      log: silentLogger,
      pollMs: 10,
      lateSettlementMs: 0,
    });
    addSession("cs_1", C);
    reader.open(C, { status: ChainInvoiceStatus.SETTLED, contributions: 1 });
    timed.start();
    timed.start();
    await new Promise((r) => setTimeout(r, 60));
    await timed.stop();
    const passes = timed.stats.passes;
    expect(passes).toBeGreaterThan(1);
    expect(store.getSession("cs_1")?.status).toBe("settled");
    await new Promise((r) => setTimeout(r, 40));
    expect(timed.stats.passes).toBe(passes);
  });
});

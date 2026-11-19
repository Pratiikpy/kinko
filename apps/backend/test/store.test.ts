import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DeliveryStatus,
  EventType,
  InvoiceKindName,
  SessionStatus,
  TokenName,
} from "../src/domain/enums.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { DuplicateError, type MerchantRecord, type SessionRecord } from "../src/store/store.ts";

const merchant = (id = "mer_1"): MerchantRecord => ({
  id,
  name: "Acme",
  webhookUrl: null,
  webhookSecretSealed: "v1.x.y.z",
  createdAt: 1_000,
});

const session = (over: Partial<Omit<SessionRecord, "seq">> = {}): Omit<SessionRecord, "seq"> => ({
  id: "cs_1",
  merchantId: "mer_1",
  commitment: "aa".repeat(32),
  kind: InvoiceKindName.STANDARD,
  token: TokenName.KUSD,
  status: SessionStatus.PENDING,
  title: null,
  memo: null,
  amount: null,
  clientReference: null,
  successUrl: null,
  cancelUrl: null,
  createdAt: 1_000,
  expiresAt: 10_000,
  settledAt: null,
  contributions: 0,
  onChain: false,
  chainExpiresAt: null,
  late: false,
  attachTokenHash: null,
  ...over,
});

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
  store.insertMerchant(merchant());
});
afterEach(() => {
  store.close();
});

describe("merchants and keys", () => {
  it("round-trips a merchant and updates it", () => {
    expect(store.getMerchant("mer_1")).toEqual(merchant());
    expect(
      store.updateMerchant("mer_1", { name: "Acme 2", webhookUrl: "https://x.example/h" }),
    ).toMatchObject({ name: "Acme 2", webhookUrl: "https://x.example/h" });
    expect(store.getMerchant("mer_1")?.webhookSecretSealed).toBe("v1.x.y.z");
    expect(store.updateMerchant("nobody", { name: "x" })).toBeUndefined();
    expect(store.getMerchant("nobody")).toBeUndefined();
  });

  it("finds a key by hash, lists keys, revokes once, and tracks use", () => {
    const key = {
      id: "key_1",
      merchantId: "mer_1",
      prefix: "abcd1234",
      hash: "h1",
      label: "ci",
      createdAt: 5,
      lastUsedAt: null,
      revokedAt: null,
    };
    store.insertApiKey(key);
    expect(store.findApiKeyByHash("h1")).toEqual(key);
    expect(store.findApiKeyByHash("other")).toBeUndefined();
    store.touchApiKey("key_1", 77);
    expect(store.findApiKeyByHash("h1")?.lastUsedAt).toBe(77);
    expect(store.revokeApiKey("mer_1", "key_1", 99)).toBe(true);
    expect(store.revokeApiKey("mer_1", "key_1", 100)).toBe(false);
    expect(store.revokeApiKey("mer_2", "key_1", 100)).toBe(false);
    expect(store.listApiKeys("mer_1")).toHaveLength(1);
    expect(store.listApiKeys("mer_1")[0]?.revokedAt).toBe(99);
  });

  it("refuses two keys with the same hash", () => {
    const key = {
      id: "key_1",
      merchantId: "mer_1",
      prefix: "p",
      hash: "same",
      label: null,
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: null,
    };
    store.insertApiKey(key);
    expect(() => {
      store.insertApiKey({ ...key, id: "key_2" });
    }).toThrow();
  });
});

describe("sessions", () => {
  it("stores a session and reads it back by id and by commitment", () => {
    const stored = store.insertSession(
      session({ title: "Invoice 1", amount: "42500", onChain: true, late: true }),
    );
    expect(stored.seq).toBeGreaterThan(0);
    expect(store.getSession("cs_1")).toEqual(stored);
    expect(store.getSessionByCommitment("aa".repeat(32))?.id).toBe("cs_1");
    expect(store.getSession("cs_missing")).toBeUndefined();
  });

  it("refuses a second session for the same commitment, in insert and in update", () => {
    store.insertSession(session());
    expect(() => store.insertSession(session({ id: "cs_2" }))).toThrow(DuplicateError);
    store.insertSession(session({ id: "cs_3", commitment: null, status: SessionStatus.DRAFT }));
    expect(() => store.updateSession("cs_3", { commitment: "aa".repeat(32) })).toThrow(
      DuplicateError,
    );
  });

  it("allows many drafts, which have no commitment yet", () => {
    store.insertSession(session({ id: "cs_a", commitment: null, status: SessionStatus.DRAFT }));
    store.insertSession(session({ id: "cs_b", commitment: null, status: SessionStatus.DRAFT }));
    expect(store.listSessions("mer_1", { limit: 10 })).toHaveLength(2);
  });

  it("applies partial updates, including booleans and nulls", () => {
    store.insertSession(session());
    const updated = store.updateSession("cs_1", {
      status: SessionStatus.SETTLED,
      settledAt: 5_000,
      contributions: 3,
      onChain: true,
      late: true,
      chainExpiresAt: 9_000,
    });
    expect(updated).toMatchObject({
      status: "settled",
      settledAt: 5_000,
      contributions: 3,
      onChain: true,
      late: true,
      chainExpiresAt: 9_000,
    });
    expect(store.updateSession("cs_1", { chainExpiresAt: null })?.chainExpiresAt).toBeNull();
    expect(store.updateSession("cs_1", {})?.status).toBe("settled");
    expect(store.updateSession("cs_none", { status: SessionStatus.EXPIRED })).toBeUndefined();
  });

  it("lists newest first, filters by status, and pages by cursor", () => {
    for (let i = 1; i <= 5; i++) {
      store.insertSession(
        session({
          id: `cs_${String(i)}`,
          commitment: String(i).repeat(64),
          status: i % 2 ? SessionStatus.PENDING : SessionStatus.SETTLED,
        }),
      );
    }
    const page1 = store.listSessions("mer_1", { limit: 2 });
    expect(page1.map((s) => s.id)).toEqual(["cs_5", "cs_4"]);
    const page2 = store.listSessions("mer_1", { limit: 2, before: page1.at(-1)?.seq ?? 0 });
    expect(page2.map((s) => s.id)).toEqual(["cs_3", "cs_2"]);
    expect(
      store.listSessions("mer_1", { limit: 10, status: SessionStatus.SETTLED }).map((s) => s.id),
    ).toEqual(["cs_4", "cs_2"]);
  });

  it("never lists another merchant's sessions", () => {
    store.insertMerchant(merchant("mer_2"));
    store.insertSession(session({ merchantId: "mer_2" }));
    expect(store.listSessions("mer_1", { limit: 10 })).toEqual([]);
  });

  it("counts sessions by status, with zeros for the empty ones", () => {
    store.insertSession(session());
    store.insertSession(
      session({ id: "cs_2", commitment: "bb".repeat(32), status: SessionStatus.SETTLED }),
    );
    expect(store.countSessionsByStatus("mer_1")).toEqual({
      draft: 0,
      pending: 1,
      settled: 1,
      cancelled: 0,
      expired: 0,
    });
  });

  it("offers the watcher pending sessions and recently expired ones, but not the rest", () => {
    store.insertSession(session({ id: "cs_pending", commitment: "01".repeat(32) }));
    store.insertSession(
      session({
        id: "cs_recent",
        commitment: "02".repeat(32),
        status: SessionStatus.EXPIRED,
        expiresAt: 9_500,
      }),
    );
    store.insertSession(
      session({
        id: "cs_old",
        commitment: "03".repeat(32),
        status: SessionStatus.EXPIRED,
        expiresAt: 1_000,
      }),
    );
    store.insertSession(
      session({ id: "cs_done", commitment: "04".repeat(32), status: SessionStatus.SETTLED }),
    );
    store.insertSession(session({ id: "cs_draft", commitment: null, status: SessionStatus.DRAFT }));
    expect(store.watchableSessions(10_000, 1_000).map((s) => s.id)).toEqual([
      "cs_pending",
      "cs_recent",
    ]);
    expect(store.watchableSessions(10_000, 0).map((s) => s.id)).toEqual(["cs_pending"]);
  });

  it("finds drafts past their expiry", () => {
    store.insertSession(
      session({ id: "cs_d1", commitment: null, status: SessionStatus.DRAFT, expiresAt: 5_000 }),
    );
    store.insertSession(
      session({ id: "cs_d2", commitment: null, status: SessionStatus.DRAFT, expiresAt: 50_000 }),
    );
    expect(store.expirableDrafts(10_000).map((s) => s.id)).toEqual(["cs_d1"]);
  });
});

describe("events and deliveries", () => {
  const event = (id: string, merchantId = "mer_1") => ({
    id,
    merchantId,
    sessionId: "cs_1",
    type: EventType.SETTLED,
    body: `{"id":"${id}"}`,
    createdAt: 1,
  });

  it("numbers events in order and lists them after a cursor, per merchant", () => {
    store.insertMerchant(merchant("mer_2"));
    const a = store.insertEvent(event("evt_a"));
    store.insertEvent(event("evt_b", "mer_2"));
    const c = store.insertEvent(event("evt_c"));
    expect(c.seq).toBeGreaterThan(a.seq);
    expect(store.listEvents(0, 10).map((e) => e.id)).toEqual(["evt_a", "evt_b", "evt_c"]);
    expect(store.listEvents(a.seq, 10, ["mer_1"]).map((e) => e.id)).toEqual(["evt_c"]);
    expect(store.listEvents(0, 1).map((e) => e.id)).toEqual(["evt_a"]);
    expect(store.listEvents(0, 10, [])).toEqual([]);
    expect(store.latestEventSeq()).toBe(c.seq);
    expect(store.getEvent(a.seq)?.body).toBe('{"id":"evt_a"}');
  });

  it("reports sequence 0 with no events", () => {
    expect(store.latestEventSeq()).toBe(0);
  });

  it("queues deliveries and returns only those due", () => {
    const e = store.insertEvent(event("evt_a"));
    const d = (id: string, nextAttemptAt: number, status = DeliveryStatus.PENDING) => ({
      id,
      eventSeq: e.seq,
      merchantId: "mer_1",
      status,
      attempts: 0,
      nextAttemptAt,
      lastHttpStatus: null,
      lastError: null,
      createdAt: nextAttemptAt,
      deliveredAt: null,
    });
    store.insertDelivery(d("dlv_late", 500));
    store.insertDelivery(d("dlv_soon", 100));
    store.insertDelivery(d("dlv_done", 50, DeliveryStatus.DELIVERED));
    expect(store.dueDeliveries(200, 10).map((x) => x.id)).toEqual(["dlv_soon"]);
    expect(store.dueDeliveries(1_000, 10).map((x) => x.id)).toEqual(["dlv_soon", "dlv_late"]);
    expect(store.dueDeliveries(1_000, 1)).toHaveLength(1);
    store.updateDelivery("dlv_soon", {
      status: DeliveryStatus.FAILED,
      attempts: 10,
      lastError: "boom",
      lastHttpStatus: 500,
    });
    expect(store.getDelivery("dlv_soon")).toMatchObject({
      status: "failed",
      attempts: 10,
      lastError: "boom",
      lastHttpStatus: 500,
    });
    expect(store.listDeliveries("mer_1", 10)).toHaveLength(3);
  });
});

describe("telegram links", () => {
  it("consumes a code once, only before it expires", () => {
    store.insertLinkCode("h1", "mer_1", 2_000);
    expect(store.consumeLinkCode("h1", 3_000)).toBeUndefined();
    store.insertLinkCode("h2", "mer_1", 2_000);
    expect(store.consumeLinkCode("h2", 1_000)).toBe("mer_1");
    expect(store.consumeLinkCode("h2", 1_000)).toBeUndefined();
    expect(store.consumeLinkCode("nope", 1_000)).toBeUndefined();
  });

  it("links chats, moves a chat to another merchant, and unlinks", () => {
    store.insertMerchant(merchant("mer_2"));
    store.linkChat({ chatId: -100, merchantId: "mer_1", linkedAt: 1 });
    store.linkChat({ chatId: 42, merchantId: "mer_1", linkedAt: 2 });
    expect(store.listLinksForMerchant("mer_1").map((l) => l.chatId)).toEqual([-100, 42]);
    expect(store.listLinkedMerchantIds()).toEqual(["mer_1"]);
    store.linkChat({ chatId: 42, merchantId: "mer_2", linkedAt: 3 });
    expect(store.getLinkByChat(42)?.merchantId).toBe("mer_2");
    expect(
      store
        .listLinksForMerchants(["mer_1", "mer_2"])
        .map((l) => l.chatId)
        .sort(),
    ).toEqual([-100, 42]);
    expect(store.listLinksForMerchants([])).toEqual([]);
    expect(store.unlinkChat(42)).toBe(true);
    expect(store.unlinkChat(42)).toBe(false);
  });
});

describe("transactions", () => {
  it("undoes every write when the function throws", () => {
    expect(() =>
      store.transaction(() => {
        store.insertSession(session());
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.getSession("cs_1")).toBeUndefined();
  });

  it("commits when it returns, and returns the value", () => {
    expect(store.transaction(() => store.insertSession(session()).id)).toBe("cs_1");
    expect(store.getSession("cs_1")).toBeDefined();
  });

  it("lets an inner failure roll back alone when the outer catches it", () => {
    store.transaction(() => {
      store.insertSession(session());
      try {
        store.transaction(() => {
          store.insertSession(session({ id: "cs_2", commitment: "bb".repeat(32) }));
          throw new Error("inner");
        });
      } catch {
        /* the outer carries on */
      }
    });
    expect(store.getSession("cs_1")).toBeDefined();
    expect(store.getSession("cs_2")).toBeUndefined();
  });

  it("can be used again after a failed transaction", () => {
    expect(() =>
      store.transaction(() => {
        throw new Error("x");
      }),
    ).toThrow();
    expect(store.transaction(() => 7)).toBe(7);
  });
});

describe("persistence", () => {
  it("keeps data across a reopen, and keeps its schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinko-store-"));
    try {
      const path = join(dir, "nested", "kinko.db");
      const first = new SqliteStore(path);
      first.insertMerchant(merchant());
      first.setMeta("cursor", "41");
      first.close();
      const second = new SqliteStore(path);
      expect(second.getMerchant("mer_1")?.name).toBe("Acme");
      expect(second.getMeta("cursor")).toBe("41");
      second.setMeta("cursor", "42");
      expect(second.getMeta("cursor")).toBe("42");
      expect(second.getMeta("absent")).toBeUndefined();
      expect(second.ping()).toBe(true);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

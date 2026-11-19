// The embedded store: one SQLite file through Node's built-in `node:sqlite`.
//
// Chosen over a native addon because the workspace installs without running
// build scripts, so a dependency that compiles on install would simply not
// work, and over JSON files because a transaction here is a real transaction:
// a session update and the event it announces commit together or not at all.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  DeliveryStatus,
  type EventType,
  type InvoiceKindName,
  SessionStatus,
  type TokenName,
} from "../domain/enums.ts";
import {
  type ApiKeyRecord,
  type DeliveryRecord,
  DuplicateError,
  type EventRecord,
  type MerchantRecord,
  type SessionPatch,
  type SessionQuery,
  type SessionRecord,
  type Store,
  type TelegramLinkRecord,
} from "./store.ts";

/** Each entry upgrades the schema by one version; `PRAGMA user_version` records how far a file has got. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    webhook_url TEXT,
    webhook_secret_sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX api_keys_merchant ON api_keys(merchant_id);
  CREATE TABLE sessions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    commitment TEXT UNIQUE,
    kind TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    memo TEXT,
    amount TEXT,
    client_reference TEXT,
    success_url TEXT,
    cancel_url TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    settled_at INTEGER,
    contributions INTEGER NOT NULL DEFAULT 0,
    on_chain INTEGER NOT NULL DEFAULT 0,
    chain_expires_at INTEGER,
    late INTEGER NOT NULL DEFAULT 0,
    attach_token_hash TEXT
  );
  CREATE INDEX sessions_merchant ON sessions(merchant_id, seq DESC);
  CREATE INDEX sessions_status ON sessions(status, expires_at);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    session_id TEXT,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_merchant ON events(merchant_id, seq);
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_http_status INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_merchant ON deliveries(merchant_id, created_at DESC);
  CREATE TABLE link_codes (
    hash TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE telegram_links (
    chat_id INTEGER PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    linked_at INTEGER NOT NULL
  );
  CREATE INDEX telegram_links_merchant ON telegram_links(merchant_id);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

type Row = Record<string, unknown>;

/** Column names for each patchable session field. */
const SESSION_COLUMNS: Readonly<Record<keyof SessionPatch, string>> = {
  commitment: "commitment",
  kind: "kind",
  token: "token",
  status: "status",
  settledAt: "settled_at",
  contributions: "contributions",
  onChain: "on_chain",
  chainExpiresAt: "chain_expires_at",
  late: "late",
  attachTokenHash: "attach_token_hash",
};

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const toMerchant = (r: Row): MerchantRecord => ({
  id: String(r.id),
  name: String(r.name),
  webhookUrl: text(r.webhook_url),
  webhookSecretSealed: String(r.webhook_secret_sealed),
  createdAt: Number(r.created_at),
});

const toApiKey = (r: Row): ApiKeyRecord => ({
  id: String(r.id),
  merchantId: String(r.merchant_id),
  prefix: String(r.prefix),
  hash: String(r.hash),
  label: text(r.label),
  createdAt: Number(r.created_at),
  lastUsedAt: num(r.last_used_at),
  revokedAt: num(r.revoked_at),
});

const toSession = (r: Row): SessionRecord => ({
  seq: Number(r.seq),
  id: String(r.id),
  merchantId: String(r.merchant_id),
  commitment: text(r.commitment),
  kind: r.kind as InvoiceKindName,
  token: r.token as TokenName,
  status: r.status as SessionStatus,
  title: text(r.title),
  memo: text(r.memo),
  amount: text(r.amount),
  clientReference: text(r.client_reference),
  successUrl: text(r.success_url),
  cancelUrl: text(r.cancel_url),
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  settledAt: num(r.settled_at),
  contributions: Number(r.contributions),
  onChain: Number(r.on_chain) === 1,
  chainExpiresAt: num(r.chain_expires_at),
  late: Number(r.late) === 1,
  attachTokenHash: text(r.attach_token_hash),
});

const toEvent = (r: Row): EventRecord => ({
  seq: Number(r.seq),
  id: String(r.id),
  merchantId: String(r.merchant_id),
  sessionId: text(r.session_id),
  type: r.type as EventType,
  body: String(r.body),
  createdAt: Number(r.created_at),
});

const toDelivery = (r: Row): DeliveryRecord => ({
  id: String(r.id),
  eventSeq: Number(r.event_seq),
  merchantId: String(r.merchant_id),
  status: r.status as DeliveryStatus,
  attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at),
  lastHttpStatus: num(r.last_http_status),
  lastError: text(r.last_error),
  createdAt: Number(r.created_at),
  deliveredAt: num(r.delivered_at),
});

const toLink = (r: Row): TelegramLinkRecord => ({
  chatId: Number(r.chat_id),
  merchantId: String(r.merchant_id),
  linkedAt: Number(r.linked_at),
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/** The SQLite implementation of {@link Store}. */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  /**
   * Open (creating if needed) the database and bring its schema up to date.
   *
   * @param path - A file path, or `:memory:` for a throwaway database.
   * @throws {Error} When the file was written by a newer version of the backend.
   */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#migrate();
  }

  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
    const current = row.user_version;
    if (current > MIGRATIONS.length) {
      throw new Error(
        `database schema version ${String(current)} is newer than this backend understands (${String(MIGRATIONS.length)})`,
      );
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(MIGRATIONS[v] ?? "");
        this.#db.exec(`PRAGMA user_version = ${String(v + 1)}`);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #stmt(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const result = this.#stmt(sql).run(...params);
    return { changes: Number(result.changes), id: Number(result.lastInsertRowid) };
  }

  #one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#stmt(sql).get(...params);
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#stmt(sql).all(...params);
  }

  /** @inheritdoc */
  transaction<T>(fn: () => T): T {
    const outer = this.#depth === 0;
    const savepoint = `sp${String(this.#depth)}`;
    this.#db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      this.#db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth--;
      this.#db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  /** @inheritdoc */
  insertMerchant(m: MerchantRecord): void {
    this.#run(
      "INSERT INTO merchants (id, name, webhook_url, webhook_secret_sealed, created_at) VALUES (?, ?, ?, ?, ?)",
      m.id,
      m.name,
      m.webhookUrl,
      m.webhookSecretSealed,
      m.createdAt,
    );
  }

  /** @inheritdoc */
  getMerchant(id: string): MerchantRecord | undefined {
    const row = this.#one("SELECT * FROM merchants WHERE id = ?", id);
    return row && toMerchant(row);
  }

  /** @inheritdoc */
  updateMerchant(
    id: string,
    patch: Partial<Pick<MerchantRecord, "name" | "webhookUrl" | "webhookSecretSealed">>,
  ): MerchantRecord | undefined {
    const current = this.getMerchant(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.#run(
      "UPDATE merchants SET name = ?, webhook_url = ?, webhook_secret_sealed = ? WHERE id = ?",
      next.name,
      next.webhookUrl,
      next.webhookSecretSealed,
      id,
    );
    return next;
  }

  /** @inheritdoc */
  insertApiKey(k: ApiKeyRecord): void {
    this.#run(
      "INSERT INTO api_keys (id, merchant_id, prefix, hash, label, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      k.id,
      k.merchantId,
      k.prefix,
      k.hash,
      k.label,
      k.createdAt,
      k.lastUsedAt,
      k.revokedAt,
    );
  }

  /** @inheritdoc */
  findApiKeyByHash(hash: string): ApiKeyRecord | undefined {
    const row = this.#one("SELECT * FROM api_keys WHERE hash = ?", hash);
    return row && toApiKey(row);
  }

  /** @inheritdoc */
  listApiKeys(merchantId: string): ApiKeyRecord[] {
    return this.#all(
      "SELECT * FROM api_keys WHERE merchant_id = ? ORDER BY created_at, id",
      merchantId,
    ).map(toApiKey);
  }

  /** @inheritdoc */
  revokeApiKey(merchantId: string, keyId: string, at: number): boolean {
    return (
      this.#run(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL",
        at,
        keyId,
        merchantId,
      ).changes === 1
    );
  }

  /** @inheritdoc */
  touchApiKey(id: string, at: number): void {
    this.#run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", at, id);
  }

  /** @inheritdoc */
  insertSession(s: Omit<SessionRecord, "seq">): SessionRecord {
    try {
      const { id } = this.#run(
        `INSERT INTO sessions (id, merchant_id, commitment, kind, token, status, title, memo, amount, client_reference,
           success_url, cancel_url, created_at, expires_at, settled_at, contributions, on_chain, chain_expires_at, late, attach_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id,
        s.merchantId,
        s.commitment,
        s.kind,
        s.token,
        s.status,
        s.title,
        s.memo,
        s.amount,
        s.clientReference,
        s.successUrl,
        s.cancelUrl,
        s.createdAt,
        s.expiresAt,
        s.settledAt,
        s.contributions,
        s.onChain ? 1 : 0,
        s.chainExpiresAt,
        s.late ? 1 : 0,
        s.attachTokenHash,
      );
      return { ...s, seq: id };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateError("commitment");
      throw error;
    }
  }

  /** @inheritdoc */
  getSession(id: string): SessionRecord | undefined {
    const row = this.#one("SELECT * FROM sessions WHERE id = ?", id);
    return row && toSession(row);
  }

  /** @inheritdoc */
  getSessionByCommitment(commitment: string): SessionRecord | undefined {
    const row = this.#one("SELECT * FROM sessions WHERE commitment = ?", commitment);
    return row && toSession(row);
  }

  /** @inheritdoc */
  listSessions(merchantId: string, query: SessionQuery): SessionRecord[] {
    const clauses = ["merchant_id = ?"];
    const params: SQLInputValue[] = [merchantId];
    if (query.status !== undefined) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.before !== undefined) {
      clauses.push("seq < ?");
      params.push(query.before);
    }
    params.push(query.limit);
    return this.#all(
      `SELECT * FROM sessions WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      ...params,
    ).map(toSession);
  }

  /** @inheritdoc */
  updateSession(id: string, patch: SessionPatch): SessionRecord | undefined {
    const entries = (Object.entries(patch) as [keyof SessionPatch, unknown][]).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${SESSION_COLUMNS[key]} = ?`).join(", ");
      const values = entries.map(([, v]): SQLInputValue =>
        typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue),
      );
      try {
        this.#run(`UPDATE sessions SET ${sets} WHERE id = ?`, ...values, id);
      } catch (error) {
        if (isUniqueViolation(error)) throw new DuplicateError("commitment");
        throw error;
      }
    }
    return this.getSession(id);
  }

  /** @inheritdoc */
  countSessionsByStatus(merchantId: string): Record<SessionStatus, number> {
    const counts = Object.fromEntries(Object.values(SessionStatus).map((s) => [s, 0])) as Record<
      SessionStatus,
      number
    >;
    for (const row of this.#all(
      "SELECT status, COUNT(*) AS n FROM sessions WHERE merchant_id = ? GROUP BY status",
      merchantId,
    )) {
      counts[row.status as SessionStatus] = Number(row.n);
    }
    return counts;
  }

  /** @inheritdoc */
  watchableSessions(now: number, lateWindowMs: number): SessionRecord[] {
    return this.#all(
      `SELECT * FROM sessions
       WHERE commitment IS NOT NULL
         AND (status = ? OR (status = ? AND expires_at > ?))
       ORDER BY seq`,
      SessionStatus.PENDING,
      SessionStatus.EXPIRED,
      now - lateWindowMs,
    ).map(toSession);
  }

  /** @inheritdoc */
  expirableDrafts(now: number): SessionRecord[] {
    return this.#all(
      "SELECT * FROM sessions WHERE commitment IS NULL AND status = ? AND expires_at <= ? ORDER BY seq",
      SessionStatus.DRAFT,
      now,
    ).map(toSession);
  }

  /** @inheritdoc */
  insertEvent(e: Omit<EventRecord, "seq">): EventRecord {
    const { id } = this.#run(
      "INSERT INTO events (id, merchant_id, session_id, type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      e.id,
      e.merchantId,
      e.sessionId,
      e.type,
      e.body,
      e.createdAt,
    );
    return { ...e, seq: id };
  }

  /** @inheritdoc */
  getEvent(seq: number): EventRecord | undefined {
    const row = this.#one("SELECT * FROM events WHERE seq = ?", seq);
    return row && toEvent(row);
  }

  /** @inheritdoc */
  listEvents(after: number, limit: number, merchantIds?: readonly string[]): EventRecord[] {
    if (merchantIds !== undefined) {
      if (merchantIds.length === 0) return [];
      const marks = merchantIds.map(() => "?").join(", ");
      return this.#all(
        `SELECT * FROM events WHERE seq > ? AND merchant_id IN (${marks}) ORDER BY seq LIMIT ?`,
        after,
        ...merchantIds,
        limit,
      ).map(toEvent);
    }
    return this.#all("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).map(
      toEvent,
    );
  }

  /** @inheritdoc */
  insertDelivery(d: DeliveryRecord): void {
    this.#run(
      `INSERT INTO deliveries (id, event_seq, merchant_id, status, attempts, next_attempt_at, last_http_status, last_error, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id,
      d.eventSeq,
      d.merchantId,
      d.status,
      d.attempts,
      d.nextAttemptAt,
      d.lastHttpStatus,
      d.lastError,
      d.createdAt,
      d.deliveredAt,
    );
  }

  /** @inheritdoc */
  getDelivery(id: string): DeliveryRecord | undefined {
    const row = this.#one("SELECT * FROM deliveries WHERE id = ?", id);
    return row && toDelivery(row);
  }

  /** @inheritdoc */
  dueDeliveries(now: number, limit: number): DeliveryRecord[] {
    return this.#all(
      "SELECT * FROM deliveries WHERE status = ? AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at LIMIT ?",
      DeliveryStatus.PENDING,
      now,
      limit,
    ).map(toDelivery);
  }

  /** @inheritdoc */
  updateDelivery(
    id: string,
    patch: Partial<
      Pick<
        DeliveryRecord,
        "status" | "attempts" | "nextAttemptAt" | "lastHttpStatus" | "lastError" | "deliveredAt"
      >
    >,
  ): void {
    const current = this.getDelivery(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.#run(
      "UPDATE deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_http_status = ?, last_error = ?, delivered_at = ? WHERE id = ?",
      next.status,
      next.attempts,
      next.nextAttemptAt,
      next.lastHttpStatus,
      next.lastError,
      next.deliveredAt,
      id,
    );
  }

  /** @inheritdoc */
  listDeliveries(merchantId: string, limit: number): DeliveryRecord[] {
    return this.#all(
      "SELECT * FROM deliveries WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      merchantId,
      limit,
    ).map(toDelivery);
  }

  /** @inheritdoc */
  insertLinkCode(hash: string, merchantId: string, expiresAt: number): void {
    this.#run(
      "INSERT INTO link_codes (hash, merchant_id, expires_at, used_at) VALUES (?, ?, ?, NULL)",
      hash,
      merchantId,
      expiresAt,
    );
  }

  /** @inheritdoc */
  consumeLinkCode(hash: string, now: number): string | undefined {
    const claimed = this.#run(
      "UPDATE link_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
      now,
      hash,
      now,
    );
    if (claimed.changes !== 1) return undefined;
    const row = this.#one("SELECT merchant_id FROM link_codes WHERE hash = ?", hash);
    return row ? String(row.merchant_id) : undefined;
  }

  /** @inheritdoc */
  linkChat(link: TelegramLinkRecord): void {
    this.#run(
      "INSERT INTO telegram_links (chat_id, merchant_id, linked_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET merchant_id = excluded.merchant_id, linked_at = excluded.linked_at",
      link.chatId,
      link.merchantId,
      link.linkedAt,
    );
  }

  /** @inheritdoc */
  unlinkChat(chatId: number): boolean {
    return this.#run("DELETE FROM telegram_links WHERE chat_id = ?", chatId).changes === 1;
  }

  /** @inheritdoc */
  getLinkByChat(chatId: number): TelegramLinkRecord | undefined {
    const row = this.#one("SELECT * FROM telegram_links WHERE chat_id = ?", chatId);
    return row && toLink(row);
  }

  /** @inheritdoc */
  listLinksForMerchant(merchantId: string): TelegramLinkRecord[] {
    return this.#all(
      "SELECT * FROM telegram_links WHERE merchant_id = ? ORDER BY linked_at",
      merchantId,
    ).map(toLink);
  }

  /** @inheritdoc */
  listLinksForMerchants(merchantIds: readonly string[]): TelegramLinkRecord[] {
    if (merchantIds.length === 0) return [];
    const marks = merchantIds.map(() => "?").join(", ");
    return this.#all(
      `SELECT * FROM telegram_links WHERE merchant_id IN (${marks}) ORDER BY linked_at`,
      ...merchantIds,
    ).map(toLink);
  }

  /** @inheritdoc */
  listLinkedMerchantIds(): string[] {
    return this.#all("SELECT DISTINCT merchant_id FROM telegram_links ORDER BY merchant_id").map(
      (r) => String(r.merchant_id),
    );
  }

  /** @inheritdoc */
  latestEventSeq(): number {
    return Number(this.#one("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);
  }

  /** @inheritdoc */
  getMeta(key: string): string | undefined {
    const row = this.#one("SELECT value FROM meta WHERE key = ?", key);
    return row ? String(row.value) : undefined;
  }

  /** @inheritdoc */
  setMeta(key: string, value: string): void {
    this.#run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** @inheritdoc */
  ping(): boolean {
    return this.#one("SELECT 1 AS ok")?.ok === 1;
  }

  /** @inheritdoc */
  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

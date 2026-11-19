// The storage interface. Everything the backend remembers goes through here, so
// the embedded SQLite file can be replaced by a server database by writing one
// new class; nothing above this file knows how rows are kept.
//
// The interface is synchronous because the shipped implementation is: one
// process owns the file, and a transaction is a plain function call. A
// networked implementation would make these methods async and thread that
// through the services.
//
// What is stored, and what deliberately is not: sessions hold the public
// facts about an invoice (its commitment, kind and asset) and whatever the
// merchant chose to attach (title, memo, a display amount). No merchant key,
// payout key, salt or owner secret ever reaches this layer.

import type {
  DeliveryStatus,
  EventType,
  InvoiceKindName,
  SessionStatus,
  TokenName,
} from "../domain/enums.ts";

/** A registered merchant. */
export interface MerchantRecord {
  readonly id: string;
  readonly name: string;
  readonly webhookUrl: string | null;
  /** The signing secret, sealed under the data key. */
  readonly webhookSecretSealed: string;
  readonly createdAt: number;
}

/** One API key. Only its hash is stored. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly prefix: string;
  readonly hash: string;
  readonly label: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

/** A hosted checkout session: routing state for one invoice, not a ledger. */
export interface SessionRecord {
  /** Insertion order; the cursor for listing. */
  readonly seq: number;
  readonly id: string;
  readonly merchantId: string;
  /** Null while the session is a draft. */
  readonly commitment: string | null;
  readonly kind: InvoiceKindName;
  readonly token: TokenName;
  readonly status: SessionStatus;
  readonly title: string | null;
  readonly memo: string | null;
  /** Base units, only if the merchant chose to store it. */
  readonly amount: string | null;
  readonly clientReference: string | null;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly settledAt: number | null;
  /** Contributions the chain has shown so far. A count, never amounts. */
  readonly contributions: number;
  /** Whether the invoice has been seen on chain. */
  readonly onChain: boolean;
  /** The invoice's own expiry as read from the chain, in ms; null for none or unseen. */
  readonly chainExpiresAt: number | null;
  /** True when the settlement was first seen after the session had expired. */
  readonly late: boolean;
  /** SHA-256 of the one-time token that lets a wallet attach a commitment. */
  readonly attachTokenHash: string | null;
}

/** The fields of a session that can change after creation. */
export type SessionPatch = Partial<
  Pick<
    SessionRecord,
    | "commitment"
    | "kind"
    | "token"
    | "status"
    | "settledAt"
    | "contributions"
    | "onChain"
    | "chainExpiresAt"
    | "late"
    | "attachTokenHash"
  >
>;

/** A state change worth telling someone about. The body is what webhooks carry. */
export interface EventRecord {
  /** Monotonic; the bot's cursor. */
  readonly seq: number;
  readonly id: string;
  readonly merchantId: string;
  readonly sessionId: string | null;
  readonly type: EventType;
  /** The exact JSON text delivered, so the signature is over what was stored. */
  readonly body: string;
  readonly createdAt: number;
}

/** One webhook delivery and its progress. */
export interface DeliveryRecord {
  readonly id: string;
  readonly eventSeq: number;
  readonly merchantId: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastHttpStatus: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

/** A Telegram chat linked to a merchant. */
export interface TelegramLinkRecord {
  readonly chatId: number;
  readonly merchantId: string;
  readonly linkedAt: number;
}

/** Thrown when an insert would break a uniqueness rule. */
export class DuplicateError extends Error {
  readonly field: string;
  /**
   * Create a duplicate error.
   *
   * @param field - The field that must be unique.
   */
  constructor(field: string) {
    super(`a record with this ${field} already exists`);
    this.name = "DuplicateError";
    this.field = field;
  }
}

/** Filters for listing sessions. */
export interface SessionQuery {
  readonly status?: SessionStatus;
  readonly limit: number;
  /** Return only sessions with a `seq` below this. */
  readonly before?: number;
}

/** Everything the backend persists. */
export interface Store {
  /** Run `fn` atomically; if it throws, every write inside it is undone. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;

  /**
   * Store a new merchant.
   *
   * @param merchant - The record to store.
   */
  insertMerchant(merchant: MerchantRecord): void;
  /**
   * Look up a merchant.
   *
   * @param id - The merchant id.
   * @returns The merchant, or undefined when there is none.
   */
  getMerchant(id: string): MerchantRecord | undefined;
  /**
   * Change a merchant's name, webhook URL or sealed secret.
   *
   * @param id - The merchant id.
   * @param patch - The fields to change.
   * @returns The updated merchant, or undefined when there is none.
   */
  updateMerchant(
    id: string,
    patch: Partial<Pick<MerchantRecord, "name" | "webhookUrl" | "webhookSecretSealed">>,
  ): MerchantRecord | undefined;

  /**
   * Store a new API key record.
   *
   * @param key - The record to store; it holds a hash, never the key.
   */
  insertApiKey(key: ApiKeyRecord): void;
  /**
   * Find a key by the SHA-256 of the key itself.
   *
   * @param hash - The lowercase hex digest.
   * @returns The record, or undefined when none has that hash.
   */
  findApiKeyByHash(hash: string): ApiKeyRecord | undefined;
  /**
   * List a merchant's keys, revoked ones included, oldest first.
   *
   * @param merchantId - The owner.
   * @returns The key records.
   */
  listApiKeys(merchantId: string): ApiKeyRecord[];
  /**
   * Revoke an active key.
   *
   * @param merchantId - The owner.
   * @param keyId - The key to revoke.
   * @param at - When it was revoked, in milliseconds.
   * @returns Whether an active key was revoked.
   */
  revokeApiKey(merchantId: string, keyId: string, at: number): boolean;
  /**
   * Record that a key was used.
   *
   * @param id - The key id.
   * @param at - When it was used, in milliseconds.
   */
  touchApiKey(id: string, at: number): void;

  /** @throws {DuplicateError} When the commitment already belongs to a session. */
  insertSession(session: Omit<SessionRecord, "seq">): SessionRecord;
  /**
   * Look up a session by id.
   *
   * @param id - The session id.
   * @returns The session, or undefined when there is none.
   */
  getSession(id: string): SessionRecord | undefined;
  /**
   * Look up a session by its invoice commitment.
   *
   * @param commitment - The commitment, 64 lowercase hex characters.
   * @returns The session, or undefined when there is none.
   */
  getSessionByCommitment(commitment: string): SessionRecord | undefined;
  /**
   * List a merchant's sessions, newest first.
   *
   * @param merchantId - The owner.
   * @param query - A status filter, a page size and a cursor.
   * @returns The sessions on the page.
   */
  listSessions(merchantId: string, query: SessionQuery): SessionRecord[];
  /**
   * Change the mutable fields of a session.
   *
   * @param id - The session id.
   * @param patch - The fields to change; undefined fields are left alone.
   * @returns The updated session, or undefined when there is none.
   * @throws {DuplicateError} When the new commitment already belongs to another session.
   */
  updateSession(id: string, patch: SessionPatch): SessionRecord | undefined;
  /**
   * Count a merchant's sessions in each status.
   *
   * @param merchantId - The owner.
   * @returns A count for every status, zero where there are none.
   */
  countSessionsByStatus(merchantId: string): Record<SessionStatus, number>;
  /** Sessions the watcher still has to look at: waiting ones, and expired ones inside the late-payment window. */
  watchableSessions(now: number, lateWindowMs: number): SessionRecord[];
  /** Drafts and pending sessions past their expiry that have no commitment to look up. */
  expirableDrafts(now: number): SessionRecord[];

  /**
   * Record an event and give it its sequence number.
   *
   * @param event - The event, without its sequence number.
   * @returns The stored event.
   */
  insertEvent(event: Omit<EventRecord, "seq">): EventRecord;
  /**
   * Look up an event by sequence number.
   *
   * @param seq - The sequence number.
   * @returns The event, or undefined when there is none.
   */
  getEvent(seq: number): EventRecord | undefined;
  /** Events with a `seq` above `after`, oldest first, for the merchants given (or all when omitted). */
  listEvents(after: number, limit: number, merchantIds?: readonly string[]): EventRecord[];

  /**
   * Queue a webhook delivery.
   *
   * @param delivery - The delivery to store.
   */
  insertDelivery(delivery: DeliveryRecord): void;
  /**
   * Look up a delivery.
   *
   * @param id - The delivery id.
   * @returns The delivery, or undefined when there is none.
   */
  getDelivery(id: string): DeliveryRecord | undefined;
  /**
   * List pending deliveries whose time has come, soonest first.
   *
   * @param now - The current time in milliseconds.
   * @param limit - The most to return.
   * @returns The due deliveries.
   */
  dueDeliveries(now: number, limit: number): DeliveryRecord[];
  /**
   * Record how an attempt went.
   *
   * @param id - The delivery id.
   * @param patch - The fields to change.
   */
  updateDelivery(
    id: string,
    patch: Partial<
      Pick<
        DeliveryRecord,
        "status" | "attempts" | "nextAttemptAt" | "lastHttpStatus" | "lastError" | "deliveredAt"
      >
    >,
  ): void;
  /**
   * List a merchant's deliveries, newest first.
   *
   * @param merchantId - The owner.
   * @param limit - The most to return.
   * @returns The deliveries.
   */
  listDeliveries(merchantId: string, limit: number): DeliveryRecord[];

  /**
   * Store a Telegram link code, by its hash.
   *
   * @param hash - SHA-256 of the code.
   * @param merchantId - The merchant who asked for it.
   * @param expiresAt - When it stops working, in milliseconds.
   */
  insertLinkCode(hash: string, merchantId: string, expiresAt: number): void;
  /** Mark a code used and return its merchant, or undefined when it is unknown, used or expired. */
  consumeLinkCode(hash: string, now: number): string | undefined;
  /**
   * Link a chat to a merchant, replacing any earlier link for the chat.
   *
   * @param link - The chat, the merchant and when it was linked.
   */
  linkChat(link: TelegramLinkRecord): void;
  /**
   * Remove a chat's link.
   *
   * @param chatId - The Telegram chat id.
   * @returns Whether a link was removed.
   */
  unlinkChat(chatId: number): boolean;
  /**
   * Find the merchant a chat is linked to.
   *
   * @param chatId - The Telegram chat id.
   * @returns The link, or undefined when the chat is not linked.
   */
  getLinkByChat(chatId: number): TelegramLinkRecord | undefined;
  /**
   * List the chats linked to a merchant.
   *
   * @param merchantId - The merchant.
   * @returns The links, oldest first.
   */
  listLinksForMerchant(merchantId: string): TelegramLinkRecord[];
  /**
   * List the chats linked to any of several merchants.
   *
   * @param merchantIds - The merchants.
   * @returns The links, oldest first.
   */
  listLinksForMerchants(merchantIds: readonly string[]): TelegramLinkRecord[];
  /** Merchants with at least one linked chat. */
  listLinkedMerchantIds(): string[];
  /** The sequence number of the newest event, or 0 when there are none. */
  latestEventSeq(): number;

  /**
   * Read a small stored value.
   *
   * @param key - The name of the value.
   * @returns The value, or undefined when it was never set.
   */
  getMeta(key: string): string | undefined;
  /**
   * Store a small value, replacing any earlier one.
   *
   * @param key - The name of the value.
   * @param value - The value to keep.
   */
  setMeta(key: string, value: string): void;

  /** A cheap liveness check for /health. */
  ping(): boolean;
  /** Close the store. It cannot be used afterwards. */
  close(): void;
}

// Hosted checkout sessions.
//
// A session is routing state for one invoice: which merchant it belongs to, how
// to recognise it on chain (its commitment), what the merchant chose to call
// it, and where to send the payer afterwards. It never contains what a payer
// needs to pay. The amount, the salt and the merchant's keys live in the
// payment link's fragment, which a browser does not send to a server, and the
// API refuses any URL that carries a fragment so they cannot arrive here by
// accident.

import type { Config } from "../config.ts";
import { conflict, forbidden, notFound } from "../http/errors.ts";
import {
  DuplicateError,
  type SessionQuery,
  type SessionRecord,
  type Store,
} from "../store/store.ts";
import { generateAttachToken, newId, safeEqual, sha256Hex } from "./crypto.ts";
import { InvoiceKindName, SessionStatus, TokenName } from "./enums.ts";
import type { Clock } from "./events.ts";

/** A session as the API shows it to its merchant. */
export interface SessionView {
  readonly id: string;
  readonly status: SessionStatus;
  readonly commitment: string | null;
  readonly kind: InvoiceKindName;
  readonly asset: TokenName;
  readonly title: string | null;
  readonly memo: string | null;
  readonly amount: string | null;
  readonly clientReference: string | null;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly contributions: number;
  readonly onChain: boolean;
  readonly late: boolean;
  readonly checkoutUrl: string;
}

/** What the hosted checkout page may read without credentials. */
export interface PublicSessionView {
  readonly id: string;
  readonly status: SessionStatus;
  readonly commitment: string | null;
  readonly kind: InvoiceKindName;
  readonly asset: TokenName;
  readonly title: string | null;
  readonly memo: string | null;
  readonly amount: string | null;
  readonly merchantName: string;
  readonly expiresAt: string;
  readonly contributions: number;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly contractAddress: string;
}

/** The fields a merchant may set when creating a session. */
export interface CreateSessionInput {
  readonly commitment?: string | undefined;
  readonly kind?: InvoiceKindName | undefined;
  readonly token?: TokenName | undefined;
  readonly title?: string | undefined;
  readonly memo?: string | undefined;
  readonly amount?: string | undefined;
  readonly clientReference?: string | undefined;
  readonly successUrl?: string | undefined;
  readonly cancelUrl?: string | undefined;
  readonly ttlSeconds?: number | undefined;
}

/** A created session, plus the one-time token if it is a draft. */
export interface CreatedSession {
  readonly session: SessionRecord;
  /** Present only for a draft; shown once. */
  readonly attachToken: string | null;
}

/**
 * The status to show right now. Between a session's expiry and the next
 * watcher pass the stored status is still `pending`; showing that would offer
 * a payer a link that has already lapsed.
 *
 * @param session - The stored session.
 * @param now - Current time in milliseconds.
 * @returns The status a reader should see.
 */
export const effectiveStatus = (session: SessionRecord, now: number): SessionStatus => {
  const waiting =
    session.status === SessionStatus.DRAFT || session.status === SessionStatus.PENDING;
  const deadline = Math.min(session.expiresAt, session.chainExpiresAt ?? Number.POSITIVE_INFINITY);
  return waiting && now >= deadline ? SessionStatus.EXPIRED : session.status;
};

/** Create, attach, read and list sessions. */
export class SessionService {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #config: Pick<
    Config,
    "appUrl" | "appInvoicePath" | "sessionDefaultTtlSeconds" | "chain"
  >;

  /**
   * Create the service.
   *
   * @param store - Where sessions are kept.
   * @param clock - The source of time, in milliseconds.
   * @param config - The app address, the default lifetime and the contract address.
   */
  constructor(
    store: Store,
    clock: Clock,
    config: Pick<Config, "appUrl" | "appInvoicePath" | "sessionDefaultTtlSeconds" | "chain">,
  ) {
    this.#store = store;
    this.#clock = clock;
    this.#config = config;
  }

  /**
   * The hosted checkout URL for a session. Terms, if any, are appended by the merchant as a fragment.
   *
   * @param sessionId - The session's id.
   * @returns The address of the hosted checkout page.
   */
  checkoutUrl(sessionId: string): string {
    return `${this.#config.appUrl}/checkout?session=${sessionId}`;
  }

  /**
   * The web app address where a merchant's wallet turns a draft into an
   * invoice and attaches its commitment. The session id and the attach token
   * travel in the fragment, so they reach the merchant's browser and no server
   * log on the way. The title, memo, kind and asset prefill the form.
   *
   * @param session - The draft.
   * @param attachToken - The token returned when the draft was created.
   * @returns The address to open.
   */
  draftFormUrl(session: SessionRecord, attachToken: string): string {
    const fragment = new URLSearchParams({ session: session.id, attach: attachToken });
    if (session.title !== null) fragment.set("title", session.title);
    if (session.memo !== null) fragment.set("memo", session.memo);
    fragment.set("kind", session.kind);
    fragment.set("asset", session.token);
    return `${this.#config.appUrl}${this.#config.appInvoicePath}#${fragment.toString()}`;
  }

  /**
   * Create a session. With a commitment it is `pending` and the watcher starts
   * looking for the invoice. Without one it is a `draft`, and the response
   * carries a one-time token the merchant's wallet uses to attach the
   * commitment once the invoice exists on chain.
   *
   * @param merchantId - The owner.
   * @param input - Validated fields.
   * @returns The session and, for a draft, its attach token.
   * @throws {ApiError} 409 when the commitment already belongs to a session.
   */
  create(merchantId: string, input: CreateSessionInput): CreatedSession {
    const now = this.#clock();
    const attachToken = input.commitment === undefined ? generateAttachToken() : null;
    const session: Omit<SessionRecord, "seq"> = {
      id: newId("cs"),
      merchantId,
      commitment: input.commitment ?? null,
      kind: input.kind ?? InvoiceKindName.STANDARD,
      token: input.token ?? TokenName.KUSD,
      status: input.commitment === undefined ? SessionStatus.DRAFT : SessionStatus.PENDING,
      title: input.title ?? null,
      memo: input.memo ?? null,
      amount: input.amount ?? null,
      clientReference: input.clientReference ?? null,
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      createdAt: now,
      expiresAt: now + (input.ttlSeconds ?? this.#config.sessionDefaultTtlSeconds) * 1000,
      settledAt: null,
      contributions: 0,
      onChain: false,
      chainExpiresAt: null,
      late: false,
      attachTokenHash: attachToken === null ? null : sha256Hex(attachToken),
    };
    try {
      return { session: this.#store.insertSession(session), attachToken };
    } catch (error) {
      if (error instanceof DuplicateError) throw this.#duplicate(input.commitment, merchantId);
      throw error;
    }
  }

  #duplicate(commitment: string | undefined, merchantId: string): Error {
    const existing =
      commitment === undefined ? undefined : this.#store.getSessionByCommitment(commitment);
    // The existing session's id is only revealed to its own merchant.
    return conflict(
      "A checkout session already exists for this commitment.",
      existing?.merchantId === merchantId ? { sessionId: existing.id } : undefined,
    );
  }

  /**
   * Attach a commitment to a draft.
   *
   * @param sessionId - The draft.
   * @param credential - The attach token from creation, or the owning merchant's id when authenticated by API key.
   * @param commitment - The invoice's commitment, normalised.
   * @returns The session, now pending. Repeating the same call with the same commitment is harmless.
   * @throws {ApiError} 403 for a wrong token; 409 when it already has a different commitment or has expired.
   */
  attach(
    sessionId: string,
    credential: { attachToken: string } | { merchantId: string },
    commitment: string,
  ): SessionRecord {
    return this.#store.transaction(() => {
      const session = this.#store.getSession(sessionId);
      if (!session) throw notFound("There is no checkout session with that id.");
      if ("merchantId" in credential) {
        if (session.merchantId !== credential.merchantId)
          throw notFound("There is no checkout session with that id.");
      } else if (
        !session.attachTokenHash ||
        !safeEqual(session.attachTokenHash, sha256Hex(credential.attachToken))
      ) {
        throw forbidden("That attach token does not belong to this session.");
      }
      if (session.commitment === commitment) return session;
      if (session.commitment !== null)
        throw conflict("This session already has a different commitment.");
      if (effectiveStatus(session, this.#clock()) !== SessionStatus.DRAFT) {
        throw conflict(
          `This session is ${effectiveStatus(session, this.#clock())} and can no longer take a commitment.`,
        );
      }
      try {
        const updated = this.#store.updateSession(sessionId, {
          commitment,
          status: SessionStatus.PENDING,
        });
        if (!updated) throw notFound("There is no checkout session with that id.");
        return updated;
      } catch (error) {
        if (error instanceof DuplicateError) throw this.#duplicate(commitment, session.merchantId);
        throw error;
      }
    });
  }

  /**
   * Fetch a session for its merchant.
   *
   * @param merchantId - Who is asking.
   * @param id - The session id.
   * @returns The session.
   * @throws {ApiError} 404 for an unknown session or one that belongs to someone else.
   */
  getOwned(merchantId: string, id: string): SessionRecord {
    const session = this.#store.getSession(id);
    if (session?.merchantId !== merchantId)
      throw notFound("There is no checkout session with that id.");
    return session;
  }

  /**
   * Find a merchant's session by its id or by a commitment (or its prefix of at
   * least eight characters), for the bot.
   *
   * @param merchantId - Who is asking.
   * @param reference - A session id, a commitment, or the start of one.
   * @returns The session, or undefined.
   */
  findOwned(merchantId: string, reference: string): SessionRecord | undefined {
    const direct = reference.startsWith("cs_")
      ? this.#store.getSession(reference)
      : this.#store.getSessionByCommitment(reference.toLowerCase());
    if (direct) return direct.merchantId === merchantId ? direct : undefined;
    if (!/^[0-9a-f]{8,63}$/i.test(reference)) return undefined;
    const prefix = reference.toLowerCase();
    const matches = this.#store
      .listSessions(merchantId, { limit: 100 })
      .filter((s) => s.commitment?.startsWith(prefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * List a merchant's sessions, newest first.
   *
   * @param merchantId - The sessions' owner.
   * @param query - A status filter, a page size and a cursor.
   * @returns The page, and the cursor for the next one or null when there is none.
   */
  list(
    merchantId: string,
    query: SessionQuery,
  ): { sessions: SessionRecord[]; nextCursor: number | null } {
    const rows = this.#store.listSessions(merchantId, { ...query, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return { sessions: page, nextCursor: rows.length > query.limit && last ? last.seq : null };
  }

  /**
   * Project a session for its merchant.
   *
   * @param session - The stored session.
   * @returns The session as the API shows it, with the status as of now.
   */
  view(session: SessionRecord): SessionView {
    const now = this.#clock();
    return {
      id: session.id,
      status: effectiveStatus(session, now),
      commitment: session.commitment,
      kind: session.kind,
      asset: session.token,
      title: session.title,
      memo: session.memo,
      amount: session.amount,
      clientReference: session.clientReference,
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      settledAt: session.settledAt === null ? null : new Date(session.settledAt).toISOString(),
      contributions: session.contributions,
      onChain: session.onChain,
      late: session.late,
      checkoutUrl: this.checkoutUrl(session.id),
    };
  }

  /**
   * Project a session for the hosted checkout page. Whoever holds the id (a
   * 128-bit random value) may read it: it is what the merchant's customer was
   * sent.
   *
   * @param id - The session id.
   * @returns What the checkout page may read.
   * @throws {ApiError} 404 for an unknown session.
   */
  publicView(id: string): PublicSessionView {
    const session = this.#store.getSession(id);
    const merchant = session && this.#store.getMerchant(session.merchantId);
    if (!session || !merchant) throw notFound("There is no checkout session with that id.");
    return {
      id: session.id,
      status: effectiveStatus(session, this.#clock()),
      commitment: session.commitment,
      kind: session.kind,
      asset: session.token,
      title: session.title,
      memo: session.memo,
      amount: session.amount,
      merchantName: merchant.name,
      expiresAt: new Date(session.expiresAt).toISOString(),
      contributions: session.contributions,
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
      contractAddress: this.#config.chain.contractAddress,
    };
  }
}

// Merchant checkout sessions, served by Kinko's backend.
//
// A merchant's server creates a session; the merchant's wallet turns a draft
// session into an on-chain invoice and attaches the invoice's commitment; the
// customer opens the hosted checkout page. The backend only ever holds the
// commitment and what the merchant chose to label it with. The invoice terms
// travel in the payment link's fragment and never reach it.

import { BACKEND_URL } from "./config.ts";
import type { InvoiceKindName } from "./records.ts";

/** Statuses a checkout session can be in. */
export enum SessionStatus {
  Draft = "draft",
  Pending = "pending",
  Settled = "settled",
  Cancelled = "cancelled",
  Expired = "expired",
}

/** What the hosted checkout page may read about a session without credentials. */
export interface PublicSession {
  readonly id: string;
  readonly status: SessionStatus;
  readonly commitment: string | null;
  readonly kind: InvoiceKindName;
  readonly asset: "KUSD" | "NATIVE";
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

/** A draft the merchant's wallet is asked to turn into an invoice. */
export interface DraftRequest {
  readonly sessionId: string;
  readonly attachToken: string;
  readonly title: string;
  readonly memo: string;
  readonly kind: InvoiceKindName;
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ATTACH_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const KINDS: readonly InvoiceKindName[] = ["standard", "multipay", "donation"];

/**
 * Read a draft request from a URL fragment the backend built
 * (`#session=…&attach=…&title=…&memo=…&kind=…&asset=…`).
 *
 * @param fragment - The fragment without its leading `#`.
 * @returns The draft, or `null` when the fragment is not a draft request.
 */
export function parseDraftFragment(fragment: string): DraftRequest | null {
  const params = new URLSearchParams(fragment);
  const sessionId = params.get("session") ?? "";
  const attachToken = params.get("attach") ?? "";
  if (!SESSION_ID.test(sessionId) || !ATTACH_TOKEN.test(attachToken)) return null;
  const kindParam = params.get("kind") ?? "standard";
  const kind = KINDS.find((k) => k === kindParam) ?? "standard";
  return {
    sessionId,
    attachToken,
    title: (params.get("title") ?? "").slice(0, 80),
    memo: (params.get("memo") ?? "").slice(0, 200),
    kind,
  };
}

/**
 * Whether a string is a well-formed checkout session id.
 *
 * @param id - The candidate.
 * @returns `true` when it can be sent to the backend.
 */
export const isSessionId = (id: string): boolean => SESSION_ID.test(id);

const backend = (): string => {
  if (!BACKEND_URL) throw new Error("This build has no merchant backend configured.");
  return BACKEND_URL;
};

/**
 * Read a session's public view.
 *
 * @param id - The session id.
 * @param signal - Aborts the request.
 * @returns The public view.
 * @throws {Error} When the backend is unreachable, the session does not exist or the answer is malformed.
 */
export async function readSession(id: string, signal?: AbortSignal): Promise<PublicSession> {
  if (!isSessionId(id)) throw new Error("This checkout link has an invalid session id.");
  const res = await fetch(`${backend()}/v1/checkout/sessions/${encodeURIComponent(id)}`, {
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (res.status === 404) throw new Error("This checkout session does not exist.");
  if (!res.ok) throw new Error(`The merchant backend answered ${String(res.status)}.`);
  const body = (await res.json()) as { session?: PublicSession };
  const s = body.session;
  if (!s || typeof s.id !== "string" || !Object.values(SessionStatus).includes(s.status)) {
    throw new Error("The merchant backend sent a session this page cannot read.");
  }
  return s;
}

/**
 * Attach an on-chain invoice's commitment to a draft session. Safe to repeat.
 *
 * @param draft - The draft request the merchant opened.
 * @param commitment - The invoice commitment, 64 hex characters.
 * @throws {Error} When the backend refuses or cannot be reached.
 */
export async function attachCommitment(draft: DraftRequest, commitment: string): Promise<void> {
  const res = await fetch(
    `${backend()}/v1/checkout/sessions/${encodeURIComponent(draft.sessionId)}/commitment`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${draft.attachToken}`,
      },
      body: JSON.stringify({ commitment }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    let reason = `HTTP ${String(res.status)}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err.error?.message) reason = err.error.message;
    } catch {
      // A non-JSON error body: the status code is the best description available.
    }
    throw new Error(`The merchant backend did not accept the invoice: ${reason}`);
  }
  // Read the body to its end: an unread response is cancelled by the browser,
  // which reports the request as aborted although the attach succeeded.
  await res.arrayBuffer();
}

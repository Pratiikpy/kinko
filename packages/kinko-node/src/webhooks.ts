// Verifying and building Kinko webhooks.
//
// Every delivery carries a header of the form
//
//   Kinko-Signature: t=1767225600,v1=5257a869e7ec…
//
// where `v1` is the hex HMAC-SHA256, keyed with your webhook secret, of the
// string `<t>.<raw request body>`. To verify in any language: split the header
// on commas, recompute the HMAC over the timestamp, a dot and the exact bytes
// you received, compare in constant time, and refuse timestamps more than five
// minutes from your clock. Use the raw body, not a re-serialised one: any
// re-encoding changes the bytes.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { WebhookEvent } from "./types.ts";

/** Name of the signature header. HTTP header names are case-insensitive. */
export const SIGNATURE_HEADER = "Kinko-Signature";

/** How far a timestamp may be from your clock, in seconds, unless you say otherwise. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Why a signature was refused. */
export enum SignatureFailure {
  /** The header is missing, or is not `t=…,v1=…`. */
  MALFORMED_HEADER = "malformed_header",
  /** The timestamp is too old or too far in the future: a replay, or a wrong clock. */
  TIMESTAMP_OUTSIDE_TOLERANCE = "timestamp_outside_tolerance",
  /** No `v1` signature matches: wrong secret, or the body was altered. */
  MISMATCH = "mismatch",
}

/** Thrown by {@link constructWebhookEvent} when a delivery cannot be trusted. */
export class WebhookSignatureError extends Error {
  readonly reason: SignatureFailure;

  /**
   * Create the error.
   *
   * @param reason - Why the signature was refused.
   * @param message - A sentence saying what to check.
   */
  constructor(reason: SignatureFailure, message: string) {
    super(message);
    this.name = "WebhookSignatureError";
    this.reason = reason;
  }
}

/** Options for verification. */
export interface VerifyOptions {
  /** Seconds a timestamp may differ from `now`. Defaults to 300. */
  readonly toleranceSeconds?: number;
  /** Current time in milliseconds; injectable for tests. */
  readonly now?: () => number;
}

/** The outcome of checking a delivery. */
export type Verification =
  { readonly valid: true } | { readonly valid: false; readonly reason: SignatureFailure };

const sign = (secret: string, timestamp: number, body: string | Uint8Array): Buffer =>
  createHmac("sha256", secret)
    .update(`${String(timestamp)}.`, "utf8")
    .update(body)
    .digest();

/**
 * Check a webhook delivery.
 *
 * @param body - The exact request body, as a string or bytes.
 * @param header - The `Kinko-Signature` header value.
 * @param secret - Your webhook secret.
 * @param options - Tolerance and clock.
 * @returns Whether the delivery is authentic and fresh, and if not, why.
 */
export const verifyWebhookSignature = (
  body: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): Verification => {
  const parts = (header ?? "").split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
    return { valid: false, reason: SignatureFailure.MALFORMED_HEADER };
  }
  const nowSeconds = (options.now ?? Date.now)() / 1000;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    return { valid: false, reason: SignatureFailure.TIMESTAMP_OUTSIDE_TOLERANCE };
  }
  const expected = sign(secret, Number(timestamp), body);
  // Any one matching `v1` is enough, so a secret rotation can sign with both.
  const matches = signatures.some((candidate) => {
    const bytes = Buffer.from(candidate, "hex");
    return (
      /^[0-9a-f]{64}$/i.test(candidate) &&
      bytes.length === expected.length &&
      timingSafeEqual(bytes, expected)
    );
  });
  return matches ? { valid: true } : { valid: false, reason: SignatureFailure.MISMATCH };
};

/**
 * Verify a delivery and parse it.
 *
 * @param body - The exact request body.
 * @param header - The `Kinko-Signature` header value.
 * @param secret - Your webhook secret.
 * @param options - Tolerance and clock.
 * @returns The event.
 * @throws {WebhookSignatureError} When the delivery cannot be trusted. Parsing happens only after verification.
 */
export const constructWebhookEvent = (
  body: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): WebhookEvent => {
  const result = verifyWebhookSignature(body, header, secret, options);
  if (!result.valid) {
    const messages: Record<SignatureFailure, string> = {
      [SignatureFailure.MALFORMED_HEADER]: "The Kinko-Signature header is missing or malformed.",
      [SignatureFailure.TIMESTAMP_OUTSIDE_TOLERANCE]:
        "The signature's timestamp is outside the allowed window. Replay, or a clock that is off.",
      [SignatureFailure.MISMATCH]:
        "The signature does not match. Wrong webhook secret, or the body was altered.",
    };
    throw new WebhookSignatureError(result.reason, messages[result.reason]);
  }
  return JSON.parse(
    typeof body === "string" ? body : Buffer.from(body).toString("utf8"),
  ) as WebhookEvent;
};

/**
 * Build a signature header for a body, for tests of your own receiver.
 *
 * @param body - The body you will send.
 * @param secret - The webhook secret.
 * @param nowMs - The time to stamp it with; defaults to now.
 * @returns A value for the `Kinko-Signature` header.
 */
export const signWebhookBody = (
  body: string,
  secret: string,
  nowMs: number = Date.now(),
): string => {
  const timestamp = Math.floor(nowMs / 1000);
  return `t=${String(timestamp)},v1=${sign(secret, timestamp, body).toString("hex")}`;
};

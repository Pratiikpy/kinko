// Webhook signatures.
//
// The header carries a timestamp and an HMAC-SHA256 over `<timestamp>.<body>`:
//
//   Kinko-Signature: t=1767225600,v1=5257a869e7ec…
//
// Signing the timestamp together with the body lets a receiver refuse a
// captured request that is replayed later, which a bare HMAC over the body
// cannot do. `@kinko/node` verifies this format; the algorithm is spelled out
// in its README for receivers in other languages.

import { createHmac } from "node:crypto";

/** Name of the signature header. */
export const SIGNATURE_HEADER = "Kinko-Signature";

/**
 * Compute the `v1` signature for a payload.
 *
 * @param secret - The merchant's webhook secret.
 * @param timestamp - Unix seconds, as signed.
 * @param body - The exact request body.
 * @returns Lowercase hex HMAC-SHA256.
 */
export const computeSignature = (secret: string, timestamp: number, body: string): string =>
  createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`, "utf8")
    .digest("hex");

/**
 * Build the header value for a delivery attempt.
 *
 * @param secret - The merchant's webhook secret.
 * @param body - The exact request body.
 * @param nowMs - Current time in milliseconds.
 * @returns The `Kinko-Signature` header value.
 */
export const signHeader = (secret: string, body: string, nowMs: number): string => {
  const timestamp = Math.floor(nowMs / 1000);
  return `t=${String(timestamp)},v1=${computeSignature(secret, timestamp, body)}`;
};

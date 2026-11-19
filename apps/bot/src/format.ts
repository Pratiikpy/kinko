// How an invoice or an event reads in a chat. Plain text only: titles are
// whatever a merchant typed, and Markdown would let a stray character reshape
// the message.

import type { BotEvent, SessionView } from "./backend.ts";

/** A word for each status, in the order the summary lists them. */
export const STATUS_LABEL: Readonly<Record<string, string>> = {
  draft: "draft",
  pending: "pending",
  settled: "settled",
  cancelled: "cancelled",
  expired: "expired",
};

/**
 * The first characters of a session's commitment, or a word for a draft.
 *
 * @param session - The session.
 * @returns A short label.
 */
export const shortCommitment = (session: Pick<SessionView, "commitment">): string =>
  session.commitment ? `${session.commitment.slice(0, 8)}…` : "draft";

/**
 * One invoice in full.
 *
 * @param s - The session.
 * @returns A few lines of text, with no amount in them because the backend holds none unless the merchant chose to store one.
 */
export const describeSession = (s: SessionView): string =>
  [
    s.title ?? "(untitled invoice)",
    "",
    `status         ${s.status}${s.late ? " (paid after it expired)" : ""}`,
    `kind / asset   ${s.kind} / ${s.asset}`,
    `payments       ${String(s.contributions)}`,
    ...(s.clientReference ? [`reference      ${s.clientReference}`] : []),
    `expires        ${s.expiresAt}`,
    ...(s.settledAt ? [`settled        ${s.settledAt}`] : []),
    `commitment     ${s.commitment ?? "(draft: no invoice attached yet)"}`,
    `session        ${s.id}`,
  ].join("\n");

const NAMES: Readonly<Record<string, string>> = {
  "invoice.payment_received": "Payment received",
  "invoice.settled": "Paid",
  "invoice.cancelled": "Cancelled",
  "invoice.expired": "Expired unpaid",
};

/**
 * The message for an event.
 *
 * @param event - An event from the backend's feed.
 * @returns The text, or undefined for an event type the bot does not announce.
 */
export const describeEvent = (event: BotEvent): string | undefined => {
  const headline = NAMES[event.type];
  if (!headline) return undefined;
  const { data } = event;
  const name =
    data.title ??
    (data.commitment ? `${data.commitment.slice(0, 8)}…` : (data.sessionId ?? "an invoice"));
  const lines = [`${headline}: ${name}`];
  if (data.clientReference) lines.push(`reference ${data.clientReference}`);
  if (event.type === "invoice.payment_received") {
    const total = data.contributions ?? 0;
    const added = data.newPayments ?? 1;
    lines.push(`${String(added)} new payment${added === 1 ? "" : "s"}, ${String(total)} in all.`);
  }
  if (data.late) lines.push("This arrived after the checkout session expired.");
  if (event.type === "invoice.expired") lines.push("Nobody paid in time.");
  lines.push(
    "",
    "The amount is not in this message: it is not on the chain, and Telegram is not a place for it.",
  );
  return lines.join("\n");
};

// Merchant figures, computed from this account's own invoice records and the
// statuses read from the ledger. The chain never knew these totals; only the
// merchant's device can add them up.

import type { InvoiceRecord } from "./records.ts";

/** A merchant's totals across every invoice it issued. */
export interface MerchantStats {
  readonly received: bigint;
  readonly outstanding: bigint;
  readonly paidCount: number;
  readonly openCount: number;
  readonly invoiceCount: number;
  readonly payments: number;
}

const paymentsOf = (i: InvoiceRecord): number =>
  i.status === "cancelled" ? 0 : (i.contributions ?? 0);

/**
 * What an invoice has brought in: its amount times the payments it received.
 *
 * @param i - The invoice.
 * @returns Base units received.
 */
export const receivedBy = (i: InvoiceRecord): bigint => BigInt(i.amount) * BigInt(paymentsOf(i));

/**
 * Add up a merchant's invoices.
 *
 * @param invoices - Every invoice this account issued.
 * @returns Received and outstanding value, and counts.
 */
export function merchantStats(invoices: readonly InvoiceRecord[]): MerchantStats {
  let received = 0n;
  let outstanding = 0n;
  let paidCount = 0;
  let openCount = 0;
  let payments = 0;
  for (const i of invoices) {
    received += receivedBy(i);
    payments += paymentsOf(i);
    if (i.status === "settled") paidCount++;
    if (i.status === "open") {
      openCount++;
      if (i.kind === "standard") outstanding += BigInt(i.amount);
    }
  }
  return { received, outstanding, paidCount, openCount, invoiceCount: invoices.length, payments };
}

/** One day of the merchant timeline. */
export interface DayBucket {
  readonly day: string;
  readonly start: number;
  readonly issued: bigint;
  readonly received: bigint;
}

const DAY = 86_400_000;

/**
 * Daily totals over the last `days` days: value issued (by creation day) and
 * value received (by the day this device first saw the payment).
 *
 * @param invoices - Every invoice this account issued.
 * @param days - How many days back, today included.
 * @param now - The present, in milliseconds.
 * @returns One bucket per day, oldest first.
 */
export function timeline(
  invoices: readonly InvoiceRecord[],
  days = 30,
  now = Date.now(),
): DayBucket[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const first = today.getTime() - (days - 1) * DAY;
  const dayOf = (t: number) => Math.floor((t - first) / DAY);
  return Array.from({ length: days }, (_, k): DayBucket => {
    const start = first + k * DAY;
    let issued = 0n;
    let received = 0n;
    for (const i of invoices) {
      if (dayOf(i.createdAt) === k) issued += BigInt(i.amount);
      if (i.checkedAt !== undefined && dayOf(i.checkedAt) === k) received += receivedBy(i);
    }
    return { day: new Date(start).toISOString().slice(0, 10), start, issued, received };
  });
}

import { describe, expect, it } from "vitest";

import { merchantStats, receivedBy, timeline } from "./merchant.ts";
import type { InvoiceRecord } from "./records.ts";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 15, 15, 0, 0);

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  commitment: Math.random().toString(16).slice(2),
  title: "t",
  memo: "",
  amount: "10000000",
  kind: "standard",
  merchantKey: "",
  payout: "",
  salt: "",
  ownerSecret: "",
  expiresAt: "0",
  createdAt: now,
  link: "",
  ...over,
});

describe("merchant figures", () => {
  it("count received value per payment, including multi-payer invoices", () => {
    expect(receivedBy(inv({ status: "settled", contributions: 1 }))).toBe(10_000_000n);
    expect(receivedBy(inv({ kind: "multipay", status: "open", contributions: 3 }))).toBe(
      30_000_000n,
    );
    expect(receivedBy(inv({ status: "cancelled", contributions: 0 }))).toBe(0n);
  });

  it("add up received, outstanding and counts", () => {
    const s = merchantStats([
      inv({ status: "settled", contributions: 1 }),
      inv({ status: "open", contributions: 0, amount: "5000000" }),
      inv({ kind: "donation", status: "open", contributions: 2, amount: "1000000" }),
      inv({ status: "cancelled" }),
    ]);
    expect(s).toEqual({
      received: 12_000_000n,
      outstanding: 5_000_000n,
      paidCount: 1,
      openCount: 2,
      invoiceCount: 4,
      payments: 3,
    });
  });

  it("bucket issued and received value by day over the window", () => {
    const t = timeline(
      [
        inv({
          createdAt: now - 2 * DAY,
          status: "settled",
          contributions: 1,
          checkedAt: now - DAY,
        }),
        inv({ createdAt: now - 40 * DAY, status: "settled", contributions: 1, checkedAt: now }),
      ],
      30,
      now,
    );
    expect(t).toHaveLength(30);
    expect(t.reduce((s, d) => s + d.issued, 0n)).toBe(10_000_000n);
    expect(t.reduce((s, d) => s + d.received, 0n)).toBe(20_000_000n);
    expect(t.at(-1)?.received).toBe(10_000_000n);
    expect(t.at(-2)?.received).toBe(10_000_000n);
    expect(t.at(-3)?.issued).toBe(10_000_000n);
  });
});

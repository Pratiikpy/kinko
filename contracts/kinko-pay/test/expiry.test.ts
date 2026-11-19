// Expiry, and the unit it is measured in.
//
// `expires_at` is compared with the block's seconds since the epoch. Seconds,
// not milliseconds: an expiry written as `Date.now() + hours * 3_600_000` is a
// date tens of thousands of years away and the invoice never expires. These
// tests pin the unit from both sides, so a client that gets it wrong fails
// here rather than in production.

import { describe, expect, it } from "vitest";

import { bytes32, T0 } from "./harness.ts";
import { AMOUNT, coin, InvoiceKind, ledgerOf, openInvoice, TokenKind } from "./pay-fixtures.ts";

const HOUR = 3_600n;
const pay = (kind = InvoiceKind.STANDARD) =>
  ["settle_invoice", kind, TokenKind.NATIVE, coin(AMOUNT)] as const;

describe("invoice expiry", () => {
  it("settles one second before the expiry", async () => {
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE, T0 + HOUR);
    h.at(T0 + HOUR - 1n);
    await expect(h.call(...pay())).resolves.toHaveLength(32);
  });

  it("refuses settlement at and after the expiry", async () => {
    for (const t of [T0 + HOUR, T0 + HOUR + 1n]) {
      const { h, commitment } = await openInvoice(
        InvoiceKind.STANDARD,
        TokenKind.NATIVE,
        T0 + HOUR,
      );
      h.at(t);
      await expect(h.call(...pay())).rejects.toThrow("invoice has expired");
      expect(ledgerOf(h).invoices.lookup(commitment).contributions).toBe(0n);
    }
  });

  it("an expiry of zero never expires", async () => {
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    h.at(T0 * 40n);
    await expect(h.call(...pay())).resolves.toHaveLength(32);
  });

  it("a one-hour expiry written in milliseconds does NOT expire (why clients must use seconds)", async () => {
    const asMilliseconds = (T0 + HOUR) * 1_000n;
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE, asMilliseconds);
    h.at(T0 + 30n * 24n * HOUR);
    await expect(h.call(...pay())).resolves.toHaveLength(32);
  });

  it("refuses a multipay contribution after expiry too", async () => {
    const { h } = await openInvoice(InvoiceKind.MULTIPAY, TokenKind.NATIVE, T0 + HOUR);
    h.at(T0 + 10n).as({ payerKey: bytes32(0x44) });
    await h.call(...pay(InvoiceKind.MULTIPAY));
    h.at(T0 + 2n * HOUR).as({ payerKey: bytes32(0x55) });
    await expect(h.call(...pay(InvoiceKind.MULTIPAY))).rejects.toThrow("invoice has expired");
  });

  it("an expired invoice can still be cancelled by its merchant", async () => {
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE, T0 + HOUR);
    h.at(T0 + 2n * HOUR);
    await expect(h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE)).resolves.toEqual(
      [],
    );
  });
});

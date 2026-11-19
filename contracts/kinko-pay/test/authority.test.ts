// Who may close, cancel or refund an invoice.
//
// To pay, a payer must reproduce the invoice commitment, so the payment link
// necessarily carries the merchant key, payout key, amount and salt.
// Authorising close and cancel by the same reproduction would let anyone
// holding the link cancel or close the invoice. The per-invoice owner secret
// is what stops that; these tests pin it.

import { describe, expect, it } from "vitest";

import { ownerTagOf } from "../src/index.ts";
import { bytes32, hex } from "./harness.ts";
import {
  AMOUNT,
  coin,
  InvoiceKind,
  InvoiceStatus,
  ledgerOf,
  openInvoice,
  OWNER,
  TokenKind,
} from "./pay-fixtures.ts";

const NOT_OWNER = bytes32(0xef);

describe("authority over an invoice", () => {
  it("the merchant can cancel their own unpaid invoice", async () => {
    const { h, commitment } = await openInvoice();
    await h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE);
    expect(ledgerOf(h).invoices.lookup(commitment).status).toBe(InvoiceStatus.CANCELLED);
  });

  it("a payer who holds the full payment link cannot cancel the invoice", async () => {
    const { h, commitment } = await openInvoice();
    h.as({ payerKey: bytes32(0x99), ownerSecret: NOT_OWNER });
    // The commitment is bound to the owner tag, so without the owner secret a caller cannot even
    // reproduce the invoice's commitment: it is unknown to them, not merely forbidden.
    await expect(h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE)).rejects.toThrow(
      "unknown invoice",
    );
    expect(ledgerOf(h).invoices.lookup(commitment).status).toBe(InvoiceStatus.OPEN);
  });

  it("a payer who holds the full payment link cannot close a multipay invoice", async () => {
    const { h, commitment } = await openInvoice(InvoiceKind.MULTIPAY);
    h.as({ ownerSecret: NOT_OWNER });
    await expect(h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE)).rejects.toThrow(
      "unknown invoice",
    );
    expect(ledgerOf(h).invoices.lookup(commitment).status).toBe(InvoiceStatus.OPEN);
  });

  it("the merchant can close their multipay invoice after others have paid", async () => {
    const { h, commitment } = await openInvoice(InvoiceKind.MULTIPAY);
    h.as({ ownerSecret: NOT_OWNER, payerKey: bytes32(0x99) });
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    h.as({ ownerSecret: OWNER });
    await h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE);
    expect(ledgerOf(h).invoices.lookup(commitment).status).toBe(InvoiceStatus.SETTLED);
  });

  it("the public record carries a tag for the owner secret, never the secret itself", async () => {
    const { h, commitment } = await openInvoice();
    const tag = ledgerOf(h).invoices.lookup(commitment).owner;
    expect(hex(tag)).toBe(hex(ownerTagOf(OWNER)));
    expect(hex(tag)).not.toBe(hex(OWNER));
    expect(h.observerView()).not.toContain(hex(OWNER));
  });

  it("two invoices with different owner secrets have unlinkable tags", async () => {
    const a = await openInvoice();
    const b = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE, 0n, {
      ownerSecret: bytes32(0xe1),
      salt: bytes32(0xab),
    });
    expect(hex(ledgerOf(a.h).invoices.lookup(a.commitment).owner)).not.toBe(
      hex(ledgerOf(b.h).invoices.lookup(b.commitment).owner),
    );
  });
});

// Settlement moves real value: the right amount, in the right asset, to the
// right party.
//
// Value and colour are separate fields of a shielded coin. A check on value
// alone would let a 100 KUSD invoice be paid with 100 NIGHT, and a payout key
// supplied by the payer would let them pay themselves. Each is tested here.

import { describe, expect, it } from "vitest";

import { bytes32, hex, paidTo } from "./harness.ts";
import {
  AMOUNT,
  coin,
  colorFor,
  InvoiceKind,
  KUSD,
  ledgerOf,
  NATIVE,
  openInvoice,
  PAYOUT,
  TokenKind,
} from "./pay-fixtures.ts";

describe("the amount", () => {
  it("rejects a coin worth less, or more, than the invoice", async () => {
    for (const value of [AMOUNT - 1n, AMOUNT + 1n, 0n]) {
      const { h, commitment } = await openInvoice();
      await expect(
        h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(value)),
      ).rejects.toThrow("coin value does not match invoice");
      expect(ledgerOf(h).invoices.lookup(commitment).contributions).toBe(0n);
      expect(ledgerOf(h).spent.size()).toBe(0n);
    }
  });

  it("accepts an exact coin and forwards all of it", async () => {
    const { h } = await openInvoice();
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT));
    expect(paidTo(h.last("settle_invoice").zswapOutputs)).toEqual([
      { to: hex(PAYOUT), value: AMOUNT, color: hex(NATIVE) },
    ]);
  });
});

describe("the asset, not just the amount", () => {
  it("REFUSES a native coin for a KUSD invoice", async () => {
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.KUSD);
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNT, NATIVE)),
    ).rejects.toThrow("coin is not the invoice's asset");
  });

  it("REFUSES a KUSD coin for a native invoice", async () => {
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE);
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT, KUSD)),
    ).rejects.toThrow("coin is not the invoice's asset");
  });

  it("REFUSES an arbitrary unknown asset for either kind of invoice", async () => {
    for (const token of [TokenKind.NATIVE, TokenKind.KUSD]) {
      const { h } = await openInvoice(InvoiceKind.STANDARD, token);
      await expect(
        h.call("settle_invoice", InvoiceKind.STANDARD, token, coin(AMOUNT, bytes32(0x99))),
      ).rejects.toThrow("coin is not the invoice's asset");
    }
  });

  it("accepts KUSD for a KUSD invoice and forwards KUSD", async () => {
    const { h, commitment } = await openInvoice(InvoiceKind.STANDARD, TokenKind.KUSD);
    await h.call(
      "settle_invoice",
      InvoiceKind.STANDARD,
      TokenKind.KUSD,
      coin(AMOUNT, colorFor(TokenKind.KUSD)),
    );
    expect(await h.call("is_settled", commitment)).toBe(true);
    expect(paidTo(h.last("settle_invoice").zswapOutputs)).toEqual([
      { to: hex(PAYOUT), value: AMOUNT, color: hex(KUSD) },
    ]);
  });

  it("the native colour the contract expects is the all-zero token type", async () => {
    // The app's NATIVE_COLOR constant is checked against the contract here.
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE);
    await expect(
      h.call(
        "settle_invoice",
        InvoiceKind.STANDARD,
        TokenKind.NATIVE,
        coin(AMOUNT, new Uint8Array(32)),
      ),
    ).resolves.toHaveLength(32);
  });
});

// Refunds.
//
// A merchant returns a payment as a shielded coin moved in the same
// transaction. The cases that matter lose money or privacy: refunding a
// payment that never happened, refunding twice, refunding the wrong amount or
// asset, refunding to someone other than the payer, and a payer refunding
// themselves with the payment link.

import { describe, expect, it } from "vitest";

import { decodeRefundCode, encodeRefundCode, refundTagOf } from "../src/index.ts";
import { bytes32, first, found, hex, paidTo } from "./harness.ts";
import {
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  ledgerOf,
  openInvoice,
  OWNER,
  PAYER,
  REFUND_TO,
  TokenKind,
} from "./pay-fixtures.ts";

const BIG = 867_530_912_345_678n;

/** An invoice created and paid by PAYER. */
const paidInvoice = async (token = TokenKind.NATIVE) => {
  const { h } = await openInvoice(InvoiceKind.STANDARD, token, 0n, { amount: BIG });
  const color = token === TokenKind.KUSD ? KUSD : new Uint8Array(32);
  const receipt = await h.call("settle_invoice", InvoiceKind.STANDARD, token, coin(BIG, color));
  return { h, receipt, color };
};

describe("refund_payment", () => {
  it("the merchant refunds a real payment, once, to the payer's refund key", async () => {
    const { h, receipt } = await paidInvoice();
    const tag = await h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG));
    expect(hex(tag)).toBe(hex(refundTagOf(receipt)));
    expect(ledgerOf(h).refunded.size()).toBe(1n);
    expect(await h.call("is_refunded", receipt)).toBe(true);
    expect(paidTo(h.last("refund_payment").zswapOutputs)).toEqual([
      { to: hex(REFUND_TO), value: BIG, color: hex(new Uint8Array(32)) },
    ]);
  });

  it("REFUSES a second refund of the same payment", async () => {
    const { h } = await paidInvoice();
    await h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG));
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG)),
    ).rejects.toThrow("payment already refunded");
    expect(ledgerOf(h).refunded.size()).toBe(1n);
  });

  it("REFUSES a refund of a payment that never happened", async () => {
    const { h } = await openInvoice(InvoiceKind.STANDARD, TokenKind.NATIVE, 0n, { amount: BIG });
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG)),
    ).rejects.toThrow("no such payment");
  });

  it("REFUSES a refund for an invoice that does not exist", async () => {
    const h = await deployPay();
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG)),
    ).rejects.toThrow("unknown invoice");
  });

  it("REFUSES a refund naming the wrong payer", async () => {
    const { h } = await paidInvoice();
    h.as({ payerKey: bytes32(0x99) });
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG)),
    ).rejects.toThrow("no such payment");
  });

  it("REFUSES a refund redirected to any key but the one the payer named", async () => {
    // The refund key is inside the receipt. A merchant who swaps in their own
    // key names a payment that does not exist.
    const { h } = await paidInvoice();
    h.as({ payerRefund: { bytes: bytes32(0x12) } });
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG)),
    ).rejects.toThrow("no such payment");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES a payer who holds the payment link and no owner secret", async () => {
    const { h } = await paidInvoice();
    h.as({ ownerSecret: bytes32(0xef) });
    // Bound to the owner tag, the commitment is unknown to anyone without the owner secret.
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG)),
    ).rejects.toThrow("unknown invoice");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES a coin worth less or more than the payment", async () => {
    for (const wrong of [BIG - 1n, BIG + 1n]) {
      const { h } = await paidInvoice();
      await expect(
        h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(wrong)),
      ).rejects.toThrow("coin value does not match invoice");
      expect(ledgerOf(h).refunded.size()).toBe(0n);
    }
  });

  it("REFUSES a coin of the wrong asset, and refunds KUSD with KUSD", async () => {
    const { h } = await paidInvoice(TokenKind.KUSD);
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.KUSD, coin(BIG)),
    ).rejects.toThrow("coin is not the invoice's asset");
    await expect(
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.KUSD, coin(BIG, KUSD)),
    ).resolves.toHaveLength(32);
  });

  it("refunds each contributor of a multipay invoice separately", async () => {
    const { h } = await openInvoice(InvoiceKind.MULTIPAY, TokenKind.NATIVE, 0n, { amount: BIG });
    for (const key of [bytes32(0x41), bytes32(0x42)]) {
      h.as({ payerKey: key });
      await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(BIG));
    }
    for (const key of [bytes32(0x41), bytes32(0x42)]) {
      h.as({ payerKey: key });
      await h.call("refund_payment", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(BIG));
    }
    expect(ledgerOf(h).refunded.size()).toBe(2n);
  });

  it("publishes neither the amount, the payer key, the refund key nor the owner secret", async () => {
    const { h } = await paidInvoice();
    await h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(BIG));
    const view = h.observerView();
    expect(found(view, BIG)).toEqual([]);
    expect(view).not.toContain(hex(PAYER));
    expect(view).not.toContain(hex(OWNER));
    expect(view).not.toContain(hex(REFUND_TO));
    // Sighted: the refund tag it does publish is in the view.
    const tag = first(ledgerOf(h).refunded, "refund tag");
    expect(view).toContain(hex(tag));
  });
});

describe("refund codes", () => {
  it("round-trip the payment's secrets", () => {
    const payment = { payerKey: PAYER, refundTo: REFUND_TO, index: 3n };
    const refundEnc = new Uint8Array(32).fill(0x7e);
    const decoded = decodeRefundCode(encodeRefundCode(payment, refundEnc));
    expect(decoded && hex(decoded.payerKey)).toBe(hex(PAYER));
    expect(decoded && hex(decoded.refundTo)).toBe(hex(REFUND_TO));
    expect(decoded?.index).toBe(3n);
    expect(decoded?.refundEncryptionKey && hex(decoded.refundEncryptionKey)).toBe(hex(refundEnc));
  });

  it("still read a version 1 code, which has no refund encryption key", () => {
    const v1 = Buffer.from(
      JSON.stringify({ v: 1, k: hex(PAYER), r: hex(REFUND_TO), i: "3" }),
    ).toString("base64url");
    const decoded = decodeRefundCode(v1);
    expect(decoded?.index).toBe(3n);
    expect(decoded?.refundEncryptionKey).toBeUndefined();
  });

  it("reject junk rather than naming a payment nobody made", () => {
    const badKey = Buffer.from(
      JSON.stringify({ v: 2, k: hex(PAYER), r: hex(REFUND_TO), i: "1", x: "ab" }),
    ).toString("base64url");
    for (const junk of [
      "",
      "!!",
      "eyJ2IjozfQ",
      "eyJ2IjoxLCJrIjoiYWIiLCJyIjoiYWIiLCJpIjoiMSJ9",
      badKey,
    ]) {
      expect(decodeRefundCode(junk)).toBeUndefined();
    }
    expect(() =>
      encodeRefundCode(
        { payerKey: PAYER, refundTo: REFUND_TO, index: 1n << 32n },
        new Uint8Array(32),
      ),
    ).toThrow(/out of range/);
  });
});

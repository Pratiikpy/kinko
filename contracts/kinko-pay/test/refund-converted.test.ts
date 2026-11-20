// Refunding a payment made through conversion, in the asset the payer actually paid.
//
// A NIGHT invoice paid in KUSD (or a KUSD invoice paid in NIGHT) could not be refunded: the only
// refund circuit returns the invoice's own asset and amount, and the merchant never held that
// asset. refund_converted returns what was paid, to the refund key bound into the receipt, once.

import { describe, expect, it } from "vitest";

import { generateOracleKeypair, refundTagOf, signQuote } from "../src/index.ts";
import { bytes32, hex, paidTo, T0 } from "./harness.ts";
import {
  AMOUNT,
  base,
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  ledgerOf,
  NATIVE,
  REFUND_TO,
  TokenKind,
} from "./pay-fixtures.ts";

const CONVERTED = 91_300n;

/** An invoice in `invoiceToken`, paid in the other asset at the oracle's signed rate. */
const paidConverted = async (
  invoiceToken: (typeof TokenKind)[keyof typeof TokenKind] = TokenKind.NATIVE,
  kind: (typeof InvoiceKind)[keyof typeof InvoiceKind] = InvoiceKind.STANDARD,
) => {
  const paidToken = invoiceToken === TokenKind.NATIVE ? TokenKind.KUSD : TokenKind.NATIVE;
  const paidColor = paidToken === TokenKind.KUSD ? KUSD : NATIVE;
  const oracle = generateOracleKeypair();
  const h = await deployPay(base({ convertedAmount: CONVERTED }), oracle.publicKey);
  await h.call("create_invoice", kind, invoiceToken, 0n);
  const quote = {
    baseAmount: AMOUNT,
    convertedAmount: CONVERTED,
    fromToken: invoiceToken,
    toToken: paidToken,
    expiresAt: T0 + 3_600n,
  };
  const receipt = await h.call(
    "settle_invoice_converted",
    kind,
    invoiceToken,
    paidToken,
    coin(CONVERTED, paidColor),
    quote.expiresAt,
    signQuote(oracle, quote),
  );
  return { h, receipt, kind, invoiceToken, paidToken, paidColor };
};

describe("refund_converted", () => {
  it("returns what was paid, in the asset it was paid in, to the payer's refund key", async () => {
    const { h, receipt, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    const tag = await h.call(
      "refund_converted",
      kind,
      invoiceToken,
      paidToken,
      coin(CONVERTED, paidColor),
    );
    expect(hex(tag)).toBe(hex(refundTagOf(receipt)));
    expect(await h.call("is_refunded", receipt)).toBe(true);
    expect(ledgerOf(h).refunded.size()).toBe(1n);
    expect(paidTo(h.last("refund_converted").zswapOutputs)).toEqual([
      { to: hex(REFUND_TO), value: CONVERTED, color: hex(paidColor) },
    ]);
  });

  it("works in the other direction too: a KUSD invoice paid in NIGHT is refunded in NIGHT", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted(TokenKind.KUSD);
    await h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor));
    expect(paidTo(h.last("refund_converted").zswapOutputs)).toEqual([
      { to: hex(REFUND_TO), value: CONVERTED, color: hex(NATIVE) },
    ]);
  });

  it("REFUSES to refund the same payment twice", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    await h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor));
    await expect(
      h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor)),
    ).rejects.toThrow("payment already refunded");
    expect(ledgerOf(h).refunded.size()).toBe(1n);
  });

  it("REFUSES a refund through refund_payment once refund_converted has returned the payment", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    await h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor));
    await expect(
      h.call("refund_payment", kind, invoiceToken, coin(AMOUNT, NATIVE)),
    ).rejects.toThrow("payment already refunded");
  });

  it("REFUSES a refund through refund_converted once refund_payment has returned the payment", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    await h.call("refund_payment", kind, invoiceToken, coin(AMOUNT, NATIVE));
    await expect(
      h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor)),
    ).rejects.toThrow("payment already refunded");
  });

  it("REFUSES a same-asset refund, which refund_payment already handles in the invoice's amount", async () => {
    const { h, kind, invoiceToken } = await paidConverted();
    await expect(
      h.call("refund_converted", kind, invoiceToken, invoiceToken, coin(AMOUNT, NATIVE)),
    ).rejects.toThrow("a converted refund needs two different assets");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES a coin that is not worth what the merchant states was paid", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    await expect(
      h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED - 1n, paidColor)),
    ).rejects.toThrow("coin value does not match the amount paid");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES a coin of another asset than the one that was paid", async () => {
    const { h, kind, invoiceToken, paidToken } = await paidConverted();
    await expect(
      h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, NATIVE)),
    ).rejects.toThrow("coin is not the asset that was paid");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES anyone without the invoice's owner secret, who cannot even name the invoice", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    h.as({ ownerSecret: bytes32(0xef) });
    await expect(
      h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor)),
    ).rejects.toThrow("unknown invoice");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES a payment that never happened", async () => {
    const oracle = generateOracleKeypair();
    const h = await deployPay(base({ convertedAmount: CONVERTED }), oracle.publicKey);
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    await expect(
      h.call(
        "refund_converted",
        InvoiceKind.STANDARD,
        TokenKind.NATIVE,
        TokenKind.KUSD,
        coin(CONVERTED, KUSD),
      ),
    ).rejects.toThrow("no such payment");
  });

  it("REFUSES an amount the payer did not pay, stated high to take more", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    h.as({ convertedAmount: CONVERTED * 10n });
    await expect(
      h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED * 10n, paidColor)),
    ).rejects.toThrow("no such payment was made through conversion in that amount and asset");
    expect(ledgerOf(h).refunded.size()).toBe(0n);
  });

  it("REFUSES an amount the payer did not pay, stated low to settle for less, even nothing", async () => {
    const { h, kind, invoiceToken, paidToken, paidColor } = await paidConverted();
    for (const stated of [0n, 1n, CONVERTED - 1n]) {
      h.as({ convertedAmount: stated });
      await expect(
        h.call("refund_converted", kind, invoiceToken, paidToken, coin(stated, paidColor)),
      ).rejects.toThrow("no such payment was made through conversion in that amount and asset");
    }
    // None of those marked the payment refunded, so the right amount still goes through.
    h.as({ convertedAmount: CONVERTED });
    await h.call("refund_converted", kind, invoiceToken, paidToken, coin(CONVERTED, paidColor));
    expect(ledgerOf(h).refunded.size()).toBe(1n);
  });

  it("REFUSES a payment that was not made through conversion, which refund_payment returns in full", async () => {
    for (const [invoiceToken, paidToken] of [
      [TokenKind.KUSD, TokenKind.NATIVE],
      [TokenKind.NATIVE, TokenKind.KUSD],
    ] as const) {
      const h = await deployPay(base({ convertedAmount: AMOUNT }));
      await h.call("create_invoice", InvoiceKind.STANDARD, invoiceToken, 0n);
      await h.call(
        "settle_invoice",
        InvoiceKind.STANDARD,
        invoiceToken,
        coin(AMOUNT, invoiceToken === TokenKind.KUSD ? KUSD : NATIVE),
      );
      await expect(
        h.call(
          "refund_converted",
          InvoiceKind.STANDARD,
          invoiceToken,
          paidToken,
          coin(AMOUNT, paidToken === TokenKind.KUSD ? KUSD : NATIVE),
        ),
      ).rejects.toThrow("no such payment was made through conversion in that amount and asset");
      expect(ledgerOf(h).refunded.size()).toBe(0n);
      // The full refund of the same payment is still open to the merchant.
      await h.call(
        "refund_payment",
        InvoiceKind.STANDARD,
        invoiceToken,
        coin(AMOUNT, invoiceToken === TokenKind.KUSD ? KUSD : NATIVE),
      );
      expect(ledgerOf(h).refunded.size()).toBe(1n);
    }
  });

  it("refunds each payment of a multipay invoice by its own index, leaving the others refundable", async () => {
    const oracle = generateOracleKeypair();
    const h = await deployPay(base({ convertedAmount: CONVERTED }), oracle.publicKey);
    const kind = InvoiceKind.MULTIPAY;
    await h.call("create_invoice", kind, TokenKind.NATIVE, 0n);
    const quote = {
      baseAmount: AMOUNT,
      convertedAmount: CONVERTED,
      fromToken: TokenKind.NATIVE,
      toToken: TokenKind.KUSD,
      expiresAt: T0 + 3_600n,
    };
    const payers = [bytes32(0x61), bytes32(0x62)];
    const indices = [0n, 7n];
    const receipts: Uint8Array[] = [];
    for (const [i, payer] of payers.entries()) {
      h.as({ payerKey: payer, paymentIndex: indices[i] });
      receipts.push(
        await h.call(
          "settle_invoice_converted",
          kind,
          TokenKind.NATIVE,
          TokenKind.KUSD,
          coin(CONVERTED, KUSD),
          quote.expiresAt,
          signQuote(oracle, quote),
        ),
      );
    }
    // The second payer's payment, named with its own key and index, is refunded alone.
    h.as({ payerKey: payers[1], paymentIndex: indices[1] });
    const tag = await h.call(
      "refund_converted",
      kind,
      TokenKind.NATIVE,
      TokenKind.KUSD,
      coin(CONVERTED, KUSD),
    );
    expect(hex(tag)).toBe(hex(refundTagOf(receipts[1] ?? new Uint8Array())));
    expect(await h.call("is_refunded", receipts[0] ?? new Uint8Array())).toBe(false);
    // The first payer's key with the second's index names no payment.
    h.as({ payerKey: payers[0], paymentIndex: indices[1] });
    await expect(
      h.call("refund_converted", kind, TokenKind.NATIVE, TokenKind.KUSD, coin(CONVERTED, KUSD)),
    ).rejects.toThrow("no such payment");
    h.as({ payerKey: payers[0], paymentIndex: indices[0] });
    await h.call("refund_converted", kind, TokenKind.NATIVE, TokenKind.KUSD, coin(CONVERTED, KUSD));
    expect(ledgerOf(h).refunded.size()).toBe(2n);
  });
});

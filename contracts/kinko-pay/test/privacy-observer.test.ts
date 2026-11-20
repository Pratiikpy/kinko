// What a chain observer can and cannot read from kinko_pay.
//
// Every check searches observerView(): the public transcript and outputs of
// each call, the effects it claimed, and the whole public state in serialised
// form. The search is proven sighted before anything is claimed absent: a
// privacy test that cannot find a value it should find proves nothing.
//
// The private amount is six bytes wide on purpose. A realistic amount such as
// 42,500 encodes to two bytes, which occur by chance in a kilobyte of hash
// hex, so a small value cannot be decided either way. A wide canary can.

import { describe, expect, it } from "vitest";

import { generateOracleKeypair, ownerTagOf, signQuote } from "../src/index.ts";
import { bytes32, found, hex, T0 } from "./harness.ts";
import {
  base,
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  ledgerOf,
  MERCHANT,
  OWNER,
  PAYER,
  PAYOUT,
  REFUND_ENC,
  REFUND_TO,
  SALT,
  TokenKind,
} from "./pay-fixtures.ts";

const SECRET_AMOUNT = 867_530_912_345_678n; // private, must never be found
const SECRET_CONVERTED = 713_245_986_431_007n; // private, must never be found
const PUBLIC_EXPIRY = 1_900_000_000_999n; // public by design, must be found

/** Which of the private values occur in `view`. Empty means none leaked. */
const leaks = (view: string): string[] => [
  ...(found(view, SECRET_AMOUNT).length > 0 ? ["amount"] : []),
  ...Object.entries({
    salt: SALT,
    "merchant key": MERCHANT,
    "payout key": PAYOUT,
    "owner secret": OWNER,
    "payer key": PAYER,
    "refund key": REFUND_TO,
    "refund encryption key": REFUND_ENC,
  })
    .filter(([, secret]) => view.includes(hex(secret)))
    .map(([name]) => name),
];

const fresh = () => deployPay(base({ amount: SECRET_AMOUNT, convertedAmount: SECRET_CONVERTED }));

describe("the search can see", () => {
  it("finds a value that is public by design", async () => {
    const h = await fresh();
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, PUBLIC_EXPIRY);
    expect(found(h.observerView(), PUBLIC_EXPIRY).length).toBeGreaterThan(0);
  });

  it("finds the commitment and the sealed KUSD colour, which the contract publishes", async () => {
    const h = await fresh();
    const c = await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    expect(h.observerView()).toContain(hex(c));
    expect(h.observerView()).toContain(hex(KUSD));
  });

  it("would find each secret if it were published", async () => {
    const h = await fresh();
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    const planted = `${h.observerView()} ${SECRET_AMOUNT.toString(10)} ${hex(SALT)}`;
    expect(found(planted, SECRET_AMOUNT).length).toBeGreaterThan(0);
    expect(planted).toContain(hex(SALT));
  });
});

describe("what stays private", () => {
  it("create_invoice", async () => {
    const h = await fresh();
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, PUBLIC_EXPIRY);
    expect(leaks(h.observerView())).toEqual([]);
  });

  it("settle_invoice moves a coin worth the secret amount without publishing it", async () => {
    const h = await fresh();
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, PUBLIC_EXPIRY);
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(SECRET_AMOUNT, KUSD));
    expect(leaks(h.observerView())).toEqual([]);
  });

  it("settle_invoice_converted publishes neither amount", async () => {
    const oracle = generateOracleKeypair();
    const h = await deployPay(
      base({ amount: SECRET_AMOUNT, convertedAmount: SECRET_CONVERTED }),
      oracle.publicKey,
    );
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    const quote = {
      baseAmount: SECRET_AMOUNT,
      convertedAmount: SECRET_CONVERTED,
      fromToken: TokenKind.NATIVE,
      toToken: TokenKind.KUSD,
      expiresAt: T0 + 600n,
    };
    await h.call(
      "settle_invoice_converted",
      InvoiceKind.STANDARD,
      TokenKind.NATIVE,
      TokenKind.KUSD,
      coin(SECRET_CONVERTED, KUSD),
      quote.expiresAt,
      signQuote(oracle, quote),
    );
    const view = h.observerView();
    expect(leaks(view)).toEqual([]);
    expect(found(view, SECRET_CONVERTED)).toEqual([]);
  });

  it("settle_batch", async () => {
    const h = await fresh();
    const salts = [bytes32(0xb1), bytes32(0xb2), bytes32(0xb3), bytes32(0xb4)];
    for (const salt of salts) {
      h.as({ salt });
      await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    }
    h.as({
      salt: SALT,
      batchAmounts: [SECRET_AMOUNT, SECRET_AMOUNT, SECRET_AMOUNT, SECRET_AMOUNT],
      batchSalts: salts,
      batchOwners: [ownerTagOf(OWNER), ownerTagOf(OWNER), ownerTagOf(OWNER), ownerTagOf(OWNER)],
      batchMerchants: [MERCHANT, MERCHANT, MERCHANT, MERCHANT],
      batchPayouts: [PAYOUT, PAYOUT, PAYOUT, PAYOUT].map((bytes) => ({ bytes })),
      batchIndices: [0n, 0n, 0n, 0n],
    });
    await h.call(
      "settle_batch",
      InvoiceKind.STANDARD,
      TokenKind.KUSD,
      salts.map(() => coin(SECRET_AMOUNT, KUSD)),
    );
    const view = h.observerView();
    expect(leaks(view)).toEqual([]);
    for (const salt of salts) expect(view).not.toContain(hex(salt));
  });

  it("close_invoice, cancel_invoice and refund_payment", async () => {
    const m = await fresh();
    await m.call("create_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, 0n);
    await m.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(SECRET_AMOUNT));
    await m.call("refund_payment", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(SECRET_AMOUNT));
    await m.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE);
    expect(leaks(m.observerView())).toEqual([]);

    const c = await fresh();
    await c.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    await c.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE);
    expect(leaks(c.observerView())).toEqual([]);
  });

  it("two invoices with identical terms but fresh salts share nothing public", async () => {
    const a = await fresh();
    const b = await deployPay(
      base({ amount: SECRET_AMOUNT, salt: bytes32(0xab), ownerSecret: bytes32(0xef) }),
    );
    const ca = await a.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    const cb = await b.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    expect(hex(ca)).not.toBe(hex(cb));
    expect(b.observerView()).not.toContain(hex(ca));
  });
});

describe("what an observer CAN link", () => {
  // Measured and reported as a limitation rather than argued away: one
  // settlement is one transaction, so the invoice commitment it touches and
  // the receipt it publishes sit in the same public transcript.
  it("a settlement transcript carries both the invoice commitment and the receipt", async () => {
    const h = await fresh();
    const commitment = hex(
      await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n),
    );
    const receipt = hex(
      await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(SECRET_AMOUNT)),
    );
    const settle = h.last("settle_invoice").transcript;
    expect(settle).toContain(commitment);
    expect(settle).toContain(receipt);
  });

  it("the invoice's kind, asset, expiry and contribution count are public", async () => {
    const h = await fresh();
    const c = await h.call("create_invoice", InvoiceKind.DONATION, TokenKind.KUSD, PUBLIC_EXPIRY);
    const state = ledgerOf(h).invoices.lookup(c);
    expect([state.kind, state.token, state.expires_at, state.contributions]).toEqual([
      InvoiceKind.DONATION,
      TokenKind.KUSD,
      PUBLIC_EXPIRY,
      0n,
    ]);
  });
});

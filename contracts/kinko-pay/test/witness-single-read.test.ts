// Every witness is read at most once per circuit.
//
// A witness is a private input the prover answers each time the circuit asks for it, and nothing
// ties two answers together. A value that fed the invoice commitment and was then read a second
// time to check the coin could therefore differ between the two reads: a payer could settle an
// invoice with a commitment built from the real amount and a coin checked against a different
// one. The fix is to read each witness once and pass the value down; this suite counts the reads,
// so a circuit that asks twice again fails here, not on chain.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateOracleKeypair, payWitnesses, signQuote } from "../src/index.ts";
import { T0 } from "./harness.ts";
import {
  AMOUNT,
  base,
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  NATIVE,
  TokenKind,
} from "./pay-fixtures.ts";

type AnyWitness = (...args: never[]) => unknown;
const witnesses = payWitnesses as unknown as Record<string, AnyWitness>;
const original = { ...witnesses };
const counts = new Map<string, number>();

beforeAll(() => {
  for (const [name, fn] of Object.entries(original)) {
    witnesses[name] = (...args: never[]) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return fn(...args);
    };
  }
});

afterAll(() => {
  Object.assign(witnesses, original);
});

/** Run one circuit call and return how many times each witness was read during it. */
const readsDuring = async (call: () => Promise<unknown>): Promise<Record<string, number>> => {
  counts.clear();
  await call();
  return Object.fromEntries(counts);
};

const expectOnce = (reads: Record<string, number>): void => {
  const twice = Object.entries(reads).filter(([, n]) => n > 1);
  expect(twice, `read more than once: ${JSON.stringify(twice)}`).toEqual([]);
};

describe("witnesses are read once per circuit", () => {
  it("create_invoice, close_invoice and cancel_invoice", async () => {
    const h = await deployPay(base());
    expectOnce(
      await readsDuring(() => h.call("create_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD, 0n)),
    );
    expectOnce(
      await readsDuring(() => h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD)),
    );
    const standard = await deployPay(base());
    await standard.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    expectOnce(
      await readsDuring(() =>
        standard.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.KUSD),
      ),
    );
  });

  it("settle_invoice, whose amount and payout once fed the commitment and then the coin check", async () => {
    const h = await deployPay(base());
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    const reads = await readsDuring(() =>
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNT, KUSD)),
    );
    expectOnce(reads);
    expect(reads.invoice_amount).toBe(1);
    expect(reads.merchant_payout).toBe(1);
  });

  it("refund_payment, whose amount once fed the commitment and then the refund coin", async () => {
    const h = await deployPay(base());
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNT, KUSD));
    const reads = await readsDuring(() =>
      h.call("refund_payment", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNT, KUSD)),
    );
    expectOnce(reads);
    expect(reads.invoice_amount).toBe(1);
  });

  it("settle_invoice_converted, whose amount once fed the commitment and then the oracle's quote", async () => {
    const oracle = generateOracleKeypair();
    const converted = 91_300n;
    const h = await deployPay(base({ convertedAmount: converted }), oracle.publicKey);
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
    const quote = {
      baseAmount: AMOUNT,
      convertedAmount: converted,
      fromToken: TokenKind.NATIVE,
      toToken: TokenKind.KUSD,
      expiresAt: T0 + 3_600n,
    };
    const reads = await readsDuring(() =>
      h.call(
        "settle_invoice_converted",
        InvoiceKind.STANDARD,
        TokenKind.NATIVE,
        TokenKind.KUSD,
        coin(converted, KUSD),
        quote.expiresAt,
        signQuote(oracle, quote),
      ),
    );
    expectOnce(reads);
    expect(reads.invoice_amount).toBe(1);
    expect(reads.merchant_payout).toBe(1);
    // The native colour is unused here but keeps the import honest for the paid-in-NIGHT case.
    expect(NATIVE).toHaveLength(32);
  });
});

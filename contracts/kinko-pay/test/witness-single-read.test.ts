// Every witness is read exactly once per circuit, for every circuit.
//
// A witness is a private input the prover answers each time the circuit asks for it, and nothing
// ties two answers together. A value that fed the invoice commitment and was then read a second
// time to check the coin could therefore differ between the two reads: a payer could settle an
// invoice with a commitment built from the real amount and a coin checked against a different
// one. The fix is to read each witness once and pass the value down. This suite counts the reads
// for every exported circuit and asserts the exact table, so a circuit that asks twice, or stops
// asking, fails here and not on chain. Attestation and batch are included: their helpers are
// called four times, and a witness read inside one of them would be read four times.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateOracleKeypair, ownerTagOf, payWitnesses, signQuote } from "../src/index.ts";
import { bytes32, nth, T0 } from "./harness.ts";
import {
  AMOUNT,
  base,
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  ledgerOf,
  MERCHANT,
  NATIVE,
  OWNER,
  PAYOUT,
  REFUND_ENC,
  SALT,
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
const reads = async (call: () => Promise<unknown>): Promise<Record<string, number>> => {
  counts.clear();
  await call();
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
};

/** What building an invoice's commitment from the owner's secret reads. */
const FROM_OWNER = {
  invoice_amount: 1,
  invoice_salt: 1,
  merchant_key: 1,
  merchant_payout: 1,
  owner_secret: 1,
};
/** What building it from a payment link reads: the public owner tag instead of the secret. */
const FROM_LINK = {
  invoice_amount: 1,
  invoice_owner: 1,
  invoice_salt: 1,
  merchant_key: 1,
  merchant_payout: 1,
};
const PAYER = { payer_key: 1, payer_refund: 1, payer_refund_enc: 1, payment_index: 1 };

const colourOf = (token: (typeof TokenKind)[keyof typeof TokenKind]) =>
  token === TokenKind.KUSD ? KUSD : NATIVE;

describe("each witness is read exactly once per circuit", () => {
  it("create, settle, refund, close and cancel, for every kind and asset", async () => {
    for (const kind of [InvoiceKind.STANDARD, InvoiceKind.MULTIPAY, InvoiceKind.DONATION]) {
      for (const token of [TokenKind.NATIVE, TokenKind.KUSD]) {
        const h = await deployPay(base());
        expect(await reads(() => h.call("create_invoice", kind, token, T0 + 10_000n))).toEqual(
          FROM_OWNER,
        );
        const paid = coin(AMOUNT, colourOf(token));
        expect(await reads(() => h.call("settle_invoice", kind, token, paid))).toEqual({
          ...FROM_LINK,
          ...PAYER,
        });
        const refund = coin(AMOUNT, colourOf(token));
        expect(await reads(() => h.call("refund_payment", kind, token, refund))).toEqual({
          ...FROM_OWNER,
          ...PAYER,
        });
        // A standard invoice closes on payment, so only the other kinds have a close to read.
        const closed =
          kind === InvoiceKind.STANDARD
            ? undefined
            : await reads(() => h.call("close_invoice", kind, token));
        expect(closed).toEqual(kind === InvoiceKind.STANDARD ? undefined : FROM_OWNER);
        const unpaid = await deployPay(base());
        await unpaid.call("create_invoice", kind, token, 0n);
        expect(await reads(() => unpaid.call("cancel_invoice", kind, token))).toEqual(FROM_OWNER);
      }
    }
  });

  it("settle_invoice_converted, in both directions", async () => {
    for (const [invoiceToken, paidToken] of [
      [TokenKind.NATIVE, TokenKind.KUSD],
      [TokenKind.KUSD, TokenKind.NATIVE],
    ] as const) {
      const oracle = generateOracleKeypair();
      const converted = 91_300n;
      const h = await deployPay(base({ convertedAmount: converted }), oracle.publicKey);
      await h.call("create_invoice", InvoiceKind.MULTIPAY, invoiceToken, 0n);
      const quote = {
        baseAmount: AMOUNT,
        convertedAmount: converted,
        fromToken: invoiceToken,
        toToken: paidToken,
        expiresAt: T0 + 3_600n,
      };
      const result = await reads(() =>
        h.call(
          "settle_invoice_converted",
          InvoiceKind.MULTIPAY,
          invoiceToken,
          paidToken,
          coin(converted, colourOf(paidToken)),
          quote.expiresAt,
          signQuote(oracle, quote),
        ),
      );
      expect(result).toEqual({ ...FROM_LINK, ...PAYER, converted_amount: 1 });
    }
  });

  it("refund_converted, in both directions", async () => {
    for (const [invoiceToken, paidToken] of [
      [TokenKind.NATIVE, TokenKind.KUSD],
      [TokenKind.KUSD, TokenKind.NATIVE],
    ] as const) {
      const oracle = generateOracleKeypair();
      const converted = 91_300n;
      const h = await deployPay(base({ convertedAmount: converted }), oracle.publicKey);
      await h.call("create_invoice", InvoiceKind.MULTIPAY, invoiceToken, 0n);
      const quote = {
        baseAmount: AMOUNT,
        convertedAmount: converted,
        fromToken: invoiceToken,
        toToken: paidToken,
        expiresAt: T0 + 3_600n,
      };
      await h.call(
        "settle_invoice_converted",
        InvoiceKind.MULTIPAY,
        invoiceToken,
        paidToken,
        coin(converted, colourOf(paidToken)),
        quote.expiresAt,
        signQuote(oracle, quote),
      );
      const result = await reads(() =>
        h.call(
          "refund_converted",
          InvoiceKind.MULTIPAY,
          invoiceToken,
          paidToken,
          coin(converted, colourOf(paidToken)),
        ),
      );
      expect(result).toEqual({ ...FROM_OWNER, ...PAYER, converted_amount: 1 });
    }
  });

  it("attest_revenue_at_least, whose per-payment helper runs four times", async () => {
    const PAYERS = [bytes32(0x31), bytes32(0x32), bytes32(0x33), bytes32(0x34)];
    const REFUNDS = [bytes32(0x41), bytes32(0x42), bytes32(0x43), bytes32(0x44)];
    const h = await deployPay(base());
    await h.call("create_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, 0n);
    const receipts: Uint8Array[] = [];
    for (let i = 0; i < 4; i++) {
      h.as({ payerKey: nth(PAYERS, i), payerRefund: { bytes: nth(REFUNDS, i) } });
      receipts.push(
        await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT)),
      );
    }
    const tag = ownerTagOf(OWNER);
    h.as({
      merchantKey: MERCHANT,
      attestedAmounts: [AMOUNT, AMOUNT, AMOUNT, AMOUNT],
      attestedSalts: [SALT, SALT, SALT, SALT],
      attestedOwners: [tag, tag, tag, tag],
      attestedPayouts: [PAYOUT, PAYOUT, PAYOUT, PAYOUT],
      attestedPayers: PAYERS,
      attestedRefunds: REFUNDS,
      attestedEncs: [REFUND_ENC, REFUND_ENC, REFUND_ENC, REFUND_ENC],
      attestedIndices: [0n, 0n, 0n, 0n],
      attestedPaths: receipts.map((receipt) => {
        const path = ledgerOf(h).receipt_tree.findPathForLeaf(receipt);
        if (!path) throw new Error("receipt not found in the tree");
        return path;
      }),
    });
    const result = await reads(() =>
      h.call("attest_revenue_at_least", InvoiceKind.MULTIPAY, TokenKind.NATIVE, AMOUNT * 4n),
    );
    // The merchant key is read once and checked against all four commitments and the digest: a
    // second read could name one merchant in the commitments and another in the digest.
    expect(result).toEqual({
      attested_amounts: 1,
      attested_indices: 1,
      attested_owners: 1,
      attested_paths: 1,
      attested_payers: 1,
      attested_payouts: 1,
      attested_refunds: 1,
      attested_encs: 1,
      attested_salts: 1,
      merchant_key: 1,
    });
    // The read-only circuits take no witnesses at all.
    for (const name of [
      "invoice_exists",
      "is_settled",
      "receipt_exists",
      "is_refunded",
      "attestation_exists",
    ] as const) {
      expect(await reads(() => h.call(name, nth(receipts, 0)))).toEqual({});
    }
  });

  it("settle_batch, whose per-invoice helper runs four times", async () => {
    const MERCHANTS = [bytes32(0xa1), bytes32(0xa2), bytes32(0xa3), bytes32(0xa4)];
    const PAYOUTS = [bytes32(0xd1), bytes32(0xd2), bytes32(0xd3), bytes32(0xd4)];
    const SALTS = [bytes32(0xb1), bytes32(0xb2), bytes32(0xb3), bytes32(0xb4)];
    const OWNERS = [bytes32(0xe1), bytes32(0xe2), bytes32(0xe3), bytes32(0xe4)];
    const AMOUNTS = [1_000n, 2_000n, 3_000n, 4_000n];
    const h = await deployPay();
    for (let i = 0; i < 4; i++) {
      h.as(
        base({
          merchantKey: nth(MERCHANTS, i),
          merchantPayout: { bytes: nth(PAYOUTS, i) },
          salt: nth(SALTS, i),
          amount: nth(AMOUNTS, i),
          ownerSecret: nth(OWNERS, i),
        }),
      );
      await h.call("create_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD, 0n);
    }
    h.as(
      base({
        batchAmounts: AMOUNTS,
        batchSalts: SALTS,
        batchOwners: OWNERS.map((secret) => ownerTagOf(secret)),
        batchMerchants: MERCHANTS,
        batchPayouts: PAYOUTS.map((bytes) => ({ bytes })),
        batchIndices: [0n, 1n, 2n, 3n],
      }),
    );
    const result = await reads(() =>
      h.call(
        "settle_batch",
        InvoiceKind.MULTIPAY,
        TokenKind.KUSD,
        AMOUNTS.map((amount) => coin(amount, KUSD)),
      ),
    );
    expect(result).toEqual({
      batch_amounts: 1,
      batch_indices: 1,
      batch_merchants: 1,
      batch_owners: 1,
      batch_payouts: 1,
      batch_salts: 1,
      payer_key: 1,
      payer_refund: 1,
      payer_refund_enc: 1,
    });
  });
});

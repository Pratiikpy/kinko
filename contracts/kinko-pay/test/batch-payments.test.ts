// Batch payments: four invoices, typically four people, under one proof.
//
// The property tested hardest is atomicity. A payroll run that pays three of
// four people is worse than one that pays nobody, because the operator now
// has to work out which. Every failure case must leave the ledger exactly as
// it was, and every success must move four real coins to four payout keys.

import { describe, expect, it } from "vitest";

import { ownerTagOf, type PayPrivateState } from "../src/index.ts";
import { bytes32, hex, nth, paidTo } from "./harness.ts";
import {
  base,
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  ledgerOf,
  type PayHarness,
  TokenKind,
} from "./pay-fixtures.ts";

const MERCHANTS = [bytes32(0xa1), bytes32(0xa2), bytes32(0xa3), bytes32(0xa4)] as const;
const PAYOUTS = [bytes32(0xd1), bytes32(0xd2), bytes32(0xd3), bytes32(0xd4)] as const;
const SALTS = [bytes32(0xb1), bytes32(0xb2), bytes32(0xb3), bytes32(0xb4)] as const;
const AMOUNTS = [1_000n, 2_000n, 3_000n, 4_000n] as const;

/** Each invoice has its own owner, so an owner vector indexed wrongly names the wrong commitment. */
const OWNERS = [bytes32(0xe1), bytes32(0xe2), bytes32(0xe3), bytes32(0xe4)] as const;
const OWNER_TAGS = OWNERS.map((secret) => ownerTagOf(secret));

const batch = (over: Partial<PayPrivateState> = {}): Partial<PayPrivateState> => ({
  batchAmounts: AMOUNTS,
  batchSalts: SALTS,
  batchOwners: OWNER_TAGS,
  batchMerchants: MERCHANTS,
  batchPayouts: PAYOUTS.map((bytes) => ({ bytes })),
  batchIndices: [0n, 0n, 0n, 0n],
  ...over,
});

const coinsFor = (amounts: readonly bigint[] = AMOUNTS, color = KUSD) =>
  amounts.map((a) => coin(a, color));

/** Four KUSD invoices from four different merchants, all open, then the payer. */
async function fourOpenInvoices(kind = InvoiceKind.STANDARD): Promise<PayHarness> {
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
    await h.call("create_invoice", kind, TokenKind.KUSD, 0n);
  }
  return h.as(base(batch()));
}

describe("batch payments", () => {
  it("pays four invoices in one call, each coin to its own payout key", async () => {
    const h = await fourOpenInvoices();
    const receipts = await h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor());

    expect(receipts).toHaveLength(4);
    expect(new Set(receipts.map(hex)).size).toBe(4);
    expect(ledgerOf(h).spent.size()).toBe(4n);
    expect(ledgerOf(h).receipts.size()).toBe(4n);
    for (const r of receipts) expect(await h.call("receipt_exists", r)).toBe(true);

    expect(paidTo(h.last("settle_batch").zswapOutputs)).toEqual(
      PAYOUTS.map((p, i) => ({ to: hex(p), value: AMOUNTS[i], color: hex(KUSD) })),
    );
  });

  it("REFUSES a batch containing an unknown invoice", async () => {
    const h = await fourOpenInvoices();
    h.as(batch({ batchSalts: [SALTS[0], SALTS[1], SALTS[2], bytes32(0xff)] }));
    await expect(
      h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor()),
    ).rejects.toThrow("unknown invoice");
  });

  it("REFUSES a batch that redirects one payment to another key", async () => {
    const h = await fourOpenInvoices();
    h.as(
      batch({ batchPayouts: [...PAYOUTS.slice(0, 3), bytes32(0x77)].map((bytes) => ({ bytes })) }),
    );
    await expect(
      h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor()),
    ).rejects.toThrow("unknown invoice");
  });

  it("REFUSES a coin that does not match its invoice, in value or asset", async () => {
    const short = await fourOpenInvoices();
    await expect(
      short.call(
        "settle_batch",
        InvoiceKind.STANDARD,
        TokenKind.KUSD,
        coinsFor([1_000n, 2_000n, 3_000n, 3_999n]),
      ),
    ).rejects.toThrow("coin value does not match invoice");

    const native = await fourOpenInvoices();
    const coins = coinsFor();
    coins[2] = coin(AMOUNTS[2], new Uint8Array(32));
    await expect(
      native.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coins),
    ).rejects.toThrow("coin is not the invoice's asset");
  });

  it("REFUSES the same STANDARD invoice listed four times", async () => {
    const h = await fourOpenInvoices();
    h.as(
      batch({
        batchAmounts: [AMOUNTS[0], AMOUNTS[0], AMOUNTS[0], AMOUNTS[0]],
        batchSalts: [SALTS[0], SALTS[0], SALTS[0], SALTS[0]],
        batchOwners: [
          nth(OWNER_TAGS, 0),
          nth(OWNER_TAGS, 0),
          nth(OWNER_TAGS, 0),
          nth(OWNER_TAGS, 0),
        ],
        batchMerchants: [MERCHANTS[0], MERCHANTS[0], MERCHANTS[0], MERCHANTS[0]],
        batchPayouts: [PAYOUTS[0], PAYOUTS[0], PAYOUTS[0], PAYOUTS[0]].map((bytes) => ({
          bytes,
        })),
      }),
    );
    // The first entry closes it; the second finds it closed.
    await expect(
      h.call(
        "settle_batch",
        InvoiceKind.STANDARD,
        TokenKind.KUSD,
        coinsFor([1_000n, 1_000n, 1_000n, 1_000n]),
      ),
    ).rejects.toThrow("invoice is not open");
  });

  it("REFUSES the same multipay invoice twice under the same index", async () => {
    const h = await fourOpenInvoices(InvoiceKind.MULTIPAY);
    h.as(
      batch({
        batchAmounts: [AMOUNTS[0], AMOUNTS[0], AMOUNTS[2], AMOUNTS[3]],
        batchSalts: [SALTS[0], SALTS[0], SALTS[2], SALTS[3]],
        batchOwners: [
          nth(OWNER_TAGS, 0),
          nth(OWNER_TAGS, 0),
          nth(OWNER_TAGS, 2),
          nth(OWNER_TAGS, 3),
        ],
        batchMerchants: [MERCHANTS[0], MERCHANTS[0], MERCHANTS[2], MERCHANTS[3]],
        batchPayouts: [PAYOUTS[0], PAYOUTS[0], PAYOUTS[2], PAYOUTS[3]].map((bytes) => ({
          bytes,
        })),
      }),
    );
    await expect(
      h.call(
        "settle_batch",
        InvoiceKind.MULTIPAY,
        TokenKind.KUSD,
        coinsFor([1_000n, 1_000n, 3_000n, 4_000n]),
      ),
    ).rejects.toThrow("payment already settled");
  });

  it("REFUSES a batch containing an already-paid invoice", async () => {
    const h = await fourOpenInvoices();
    h.as(
      base({
        merchantKey: MERCHANTS[0],
        merchantPayout: { bytes: PAYOUTS[0] },
        salt: SALTS[0],
        amount: AMOUNTS[0],
        ownerSecret: OWNERS[0],
      }),
    );
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNTS[0], KUSD));
    h.as(base(batch()));
    await expect(
      h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor()),
    ).rejects.toThrow("invoice is not open");
  });

  it("is ATOMIC: a failing fourth entry leaves the first three unpaid", async () => {
    const h = await fourOpenInvoices();
    const before = h.rawState();
    h.as(batch({ batchSalts: [SALTS[0], SALTS[1], SALTS[2], bytes32(0xff)] }));
    await expect(
      h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor()),
    ).rejects.toThrow();
    expect(h.rawState()).toBe(before);
    expect(ledgerOf(h).spent.size()).toBe(0n);
    expect(ledgerOf(h).receipts.size()).toBe(0n);
  });

  it("a paid batch cannot be replayed", async () => {
    const h = await fourOpenInvoices();
    await h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor());
    await expect(
      h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor()),
    ).rejects.toThrow("invoice is not open");
  });

  it("refuses a malformed batch before any proof is attempted", async () => {
    const h = await fourOpenInvoices();
    h.as(batch({ batchAmounts: AMOUNTS.slice(0, 3) }));
    await expect(
      h.call("settle_batch", InvoiceKind.STANDARD, TokenKind.KUSD, coinsFor()),
    ).rejects.toThrow("batchAmounts must hold exactly 4 entries");
  });
});

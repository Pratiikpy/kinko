// Selective disclosure: a merchant proves a statement about their revenue that
// a third party can verify against the chain, without the revenue, the
// individual amounts, or which payments were counted becoming visible.
//
// Tested adversarially, because an attestation nobody can forge is the whole
// point. Receipts are derived from the attested amounts, and every path is
// bound to the receipt it proves, so a real path cannot vouch for an invented
// amount.

import { describe, expect, it } from "vitest";

import { attestationDigestOf, type PayPrivateState } from "../src/index.ts";
import { bytes32, first, found, hex, nth } from "./harness.ts";
import {
  base,
  coin,
  deployPay,
  InvoiceKind,
  ledgerOf,
  MERCHANT,
  type PayHarness,
  PAYOUT,
  SALT,
  TokenKind,
} from "./pay-fixtures.ts";

// Six bytes wide so a search for it in hash-heavy output is decisive.
const AMOUNT = 867_530_912_345_678n;
const PAYERS = [bytes32(0x31), bytes32(0x32), bytes32(0x33), bytes32(0x34)] as const;
const REFUNDS = [bytes32(0x41), bytes32(0x42), bytes32(0x43), bytes32(0x44)] as const;
const TOTAL = AMOUNT * 4n;

/** One multipay invoice paid by four payers: four real receipts on the tree. */
async function merchantWithFourPayments(): Promise<{ h: PayHarness; receipts: Uint8Array[] }> {
  const h = await deployPay(base({ amount: AMOUNT }));
  await h.call("create_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, 0n);
  const receipts: Uint8Array[] = [];
  for (let i = 0; i < 4; i++) {
    h.as({ payerKey: nth(PAYERS, i), payerRefund: { bytes: nth(REFUNDS, i) } });
    receipts.push(
      await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT)),
    );
  }
  return { h, receipts };
}

const pathFor = (h: PayHarness, receipt: Uint8Array) => {
  const path = ledgerOf(h).receipt_tree.findPathForLeaf(receipt);
  if (!path) throw new Error("receipt not found in the tree");
  return path;
};

/** The merchant's truthful evidence. */
const truth = (
  h: PayHarness,
  receipts: Uint8Array[],
  over: Partial<PayPrivateState> = {},
): Partial<PayPrivateState> => ({
  merchantKey: MERCHANT,
  attestedAmounts: [AMOUNT, AMOUNT, AMOUNT, AMOUNT],
  attestedSalts: [SALT, SALT, SALT, SALT],
  attestedPayouts: [PAYOUT, PAYOUT, PAYOUT, PAYOUT],
  attestedPayers: PAYERS,
  attestedRefunds: REFUNDS,
  attestedIndices: [0n, 0n, 0n, 0n],
  attestedPaths: receipts.map((r) => pathFor(h, r)),
  ...over,
});

const attest = (h: PayHarness, threshold: bigint) =>
  h.call("attest_revenue_at_least", InvoiceKind.MULTIPAY, TokenKind.NATIVE, threshold);

describe("revenue attestation", () => {
  it("four settlements produce four receipts on the Merkle tree", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    expect(ledgerOf(h).receipts.size()).toBe(4n);
    for (const r of receipts) expect(() => pathFor(h, r)).not.toThrow();
  });

  it("proves revenue is at least the true total, with a digest a verifier can recompute", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    const digest = await attest(h.as(truth(h, receipts)), TOTAL);
    expect(await h.call("attestation_exists", digest)).toBe(true);
    // The verifier is handed the merchant key, the threshold and the receipts'
    // set digest, and recomputes the published digest from them.
    expect(hex(attestationDigestOf(MERCHANT, TOTAL, receipts))).toBe(hex(digest));
  });

  it("proves a threshold below the true total", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    const digest = await attest(h.as(truth(h, receipts)), 50_000n);
    expect(await h.call("attestation_exists", digest)).toBe(true);
  });

  it("REFUSES to prove a threshold above the true total", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    await expect(attest(h.as(truth(h, receipts)), TOTAL + 1n)).rejects.toThrow(
      "revenue below threshold",
    );
  });

  it("REFUSES an inflated amount backed by a real payment", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    h.as(truth(h, receipts, { attestedAmounts: [AMOUNT * 2n, AMOUNT, AMOUNT, AMOUNT] }));
    await expect(attest(h, TOTAL + AMOUNT)).rejects.toThrow(
      "merkle path does not match the claimed payment",
    );
  });

  it("REFUSES payments that were never made", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    h.as(
      truth(h, receipts, {
        attestedPayers: [bytes32(0xd1), bytes32(0xd2), bytes32(0xd3), bytes32(0xd4)],
      }),
    );
    await expect(attest(h, TOTAL)).rejects.toThrow(
      "merkle path does not match the claimed payment",
    );
  });

  it("REFUSES a path whose leaf matches but whose root is not on the ledger", async () => {
    // A self-built path: the right leaf, a fabricated sibling chain.
    const { h, receipts } = await merchantWithFourPayments();
    const forged = receipts.map((r) => {
      const real = pathFor(h, r);
      return {
        ...real,
        path: real.path.map((e) => ({ ...e, sibling: { field: e.sibling.field + 1n } })),
      };
    });
    h.as(truth(h, receipts, { attestedPaths: forged }));
    await expect(attest(h, TOTAL)).rejects.toThrow("payment is not on the ledger");
  });

  it("REFUSES counting one payment four times", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    const one = pathFor(h, nth(receipts, 0));
    h.as(
      truth(h, receipts, {
        attestedPayers: [PAYERS[0], PAYERS[0], PAYERS[0], PAYERS[0]],
        attestedRefunds: [REFUNDS[0], REFUNDS[0], REFUNDS[0], REFUNDS[0]],
        attestedPaths: [one, one, one, one],
      }),
    );
    await expect(attest(h, TOTAL)).rejects.toThrow("attested payments must be distinct");
  });

  it("REFUSES an attestation by someone who is not the merchant", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    h.as(truth(h, receipts, { merchantKey: bytes32(0x99) }));
    await expect(attest(h, TOTAL)).rejects.toThrow(
      "merkle path does not match the claimed payment",
    );
  });

  it("REFUSES publishing the same attestation twice", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    await attest(h.as(truth(h, receipts)), 80_000n);
    await expect(attest(h, 80_000n)).rejects.toThrow("attestation already published");
  });

  it("paths stay valid after later payments, because the tree is historic", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    const evidence = truth(h, receipts);
    h.as({ payerKey: bytes32(0x5a) });
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    await expect(attest(h.as(evidence), TOTAL)).resolves.toHaveLength(32);
  });

  it("publishes the attestation but NOT the revenue, any amount, or which receipts", async () => {
    const { h, receipts } = await merchantWithFourPayments();
    const callsBefore = h.calls.length;
    await attest(h.as(truth(h, receipts)), 60_000n);
    const attestCall = h.calls
      .slice(callsBefore)
      .map((c) => c.transcript + c.effects)
      .join("\n");
    const view = h.observerView();
    const digest = first(ledgerOf(h).attestations, "attestation");
    expect(view).toContain(hex(digest));
    expect(found(view, TOTAL)).toEqual([]);
    expect(found(view, AMOUNT)).toEqual([]);
    // The attesting transaction itself names none of the counted receipts.
    for (const r of receipts) expect(attestCall).not.toContain(hex(r));
  });
});

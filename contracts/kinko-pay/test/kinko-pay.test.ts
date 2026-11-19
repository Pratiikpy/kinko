// kinko_pay behavioural suite.
//
// Weighted towards the states that cause losses (replay, wrong terms,
// cancelling out from under a payer, paying the wrong party) rather than the
// happy path. Each failure case asserts that the circuit throws, because a
// failed assert means the transaction never reaches the chain.

import { describe, expect, it } from "vitest";

import { invoiceCommitmentOf, ownerTagOf, receiptOf } from "../src/index.ts";
import { bytes32, hex, paidTo } from "./harness.ts";
import {
  AMOUNT,
  base,
  coin,
  deployPay,
  InvoiceKind,
  InvoiceStatus,
  KUSD,
  ledgerOf,
  MERCHANT,
  NATIVE,
  NO_EXPIRY,
  openInvoice,
  OWNER,
  PAYER,
  PAYOUT,
  REFUND_TO,
  SALT,
  TokenKind,
} from "./pay-fixtures.ts";

const OTHER_MERCHANT = bytes32(0x22);
const OTHER_SALT = bytes32(0xbb);
const PAYER_2 = bytes32(0x44);

describe("create_invoice", () => {
  it("creates an invoice and returns its commitment", async () => {
    const { h, commitment } = await openInvoice();
    expect(commitment).toHaveLength(32);
    const l = ledgerOf(h);
    expect(l.invoices.member(commitment)).toBe(true);
    expect(l.created).toBe(1n);
    const state = l.invoices.lookup(commitment);
    expect(state.status).toBe(InvoiceStatus.OPEN);
    expect(state.contributions).toBe(0n);
  });

  it("returns the commitment the app computes off-chain", async () => {
    const { commitment } = await openInvoice(InvoiceKind.MULTIPAY, TokenKind.KUSD);
    const offChain = invoiceCommitmentOf({
      merchantKey: MERCHANT,
      payout: PAYOUT,
      amount: AMOUNT,
      kind: InvoiceKind.MULTIPAY,
      token: TokenKind.KUSD,
      salt: SALT,
      owner: ownerTagOf(OWNER),
      expiresAt: NO_EXPIRY,
    });
    expect(hex(commitment)).toBe(hex(offChain));
  });

  it("rejects creating the same invoice twice", async () => {
    const { h } = await openInvoice();
    await expect(
      h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, NO_EXPIRY),
    ).rejects.toThrow("invoice already exists");
  });
});

describe("invoice squatting", () => {
  // The payment link carries every term of an invoice, so anyone who sees it knows them all. What
  // they do not know is the owner secret, and the commitment is bound to its public tag.
  const SQUATTER = bytes32(0x5a);

  it("someone holding the whole link cannot create the invoice it names", async () => {
    // The merchant has not published yet. The squatter publishes with every term from the link
    // and an owner secret of their own.
    const h = await deployPay(base({ ownerSecret: SQUATTER }));
    const squatted = await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);

    // What they created is a different invoice: its commitment is not the one the link names.
    const linkCommitment = invoiceCommitmentOf({
      merchantKey: MERCHANT,
      payout: PAYOUT,
      amount: AMOUNT,
      kind: InvoiceKind.STANDARD,
      token: TokenKind.KUSD,
      salt: SALT,
      owner: ownerTagOf(OWNER),
      expiresAt: NO_EXPIRY,
    });
    expect(hex(squatted)).not.toBe(hex(linkCommitment));
    expect(ledgerOf(h).invoices.member(linkCommitment)).toBe(false);

    // The merchant can still publish the invoice the link names, and it is theirs alone.
    h.as(base({ ownerSecret: OWNER }));
    const real = await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    expect(hex(real)).toBe(hex(linkCommitment));
    expect(ledgerOf(h).invoices.lookup(real).owner).toEqual(ownerTagOf(OWNER));
    await h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.KUSD);
  });

  it("a payer paying the link cannot be steered into the squatter's invoice", async () => {
    const h = await deployPay(base({ ownerSecret: SQUATTER }));
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    // The payer's private state carries the link's owner tag, which is the merchant's.
    h.as(base({ ownerSecret: new Uint8Array(32), invoiceOwner: ownerTagOf(OWNER) }));
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNT, KUSD)),
    ).rejects.toThrow("unknown invoice");
  });
});

describe("commitment binding", () => {
  const commitmentWith = async (over: Parameters<typeof base>[0], token = TokenKind.NATIVE) =>
    hex((await openInvoice(InvoiceKind.STANDARD, token, NO_EXPIRY, over)).commitment);

  it("a different amount, merchant, payout, salt or token yields a different commitment", async () => {
    const reference = await commitmentWith({});
    const variants = await Promise.all([
      commitmentWith({ amount: AMOUNT + 1n }),
      commitmentWith({ merchantKey: OTHER_MERCHANT }),
      commitmentWith({ merchantPayout: { bytes: bytes32(0x13) } }),
      commitmentWith({ salt: OTHER_SALT }),
      commitmentWith({}, TokenKind.KUSD),
    ]);
    for (const v of variants) expect(v).not.toBe(reference);
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe("settle_invoice: standard", () => {
  it("pays an open invoice, forwards the coin to the payout key and closes it", async () => {
    const { h, commitment } = await openInvoice();
    const receipt = await h.call(
      "settle_invoice",
      InvoiceKind.STANDARD,
      TokenKind.NATIVE,
      coin(AMOUNT),
    );

    expect(await h.call("is_settled", commitment)).toBe(true);
    expect(await h.call("receipt_exists", receipt)).toBe(true);
    expect(ledgerOf(h).invoices.lookup(commitment).contributions).toBe(1n);
    expect(ledgerOf(h).spent.size()).toBe(1n);

    // The coin left the contract in the same transaction, to the payout key in
    // the commitment and to nobody else.
    expect(paidTo(h.last("settle_invoice").zswapOutputs)).toEqual([
      { to: hex(PAYOUT), value: AMOUNT, color: hex(NATIVE) },
    ]);
  });

  it("returns the receipt the app computes off-chain", async () => {
    const { h, commitment } = await openInvoice();
    const receipt = await h.call(
      "settle_invoice",
      InvoiceKind.STANDARD,
      TokenKind.NATIVE,
      coin(AMOUNT),
    );
    const offChain = receiptOf(commitment, InvoiceKind.STANDARD, {
      payerKey: PAYER,
      refundTo: REFUND_TO,
      index: 9n,
    });
    expect(hex(receipt)).toBe(hex(offChain));
  });

  it("rejects a second settlement of the same invoice", async () => {
    const { h } = await openInvoice();
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT));
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("invoice is not open");
  });

  it("rejects a replay by a different payer once closed", async () => {
    const { h } = await openInvoice();
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT));
    h.as({ payerKey: PAYER_2 });
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("invoice is not open");
  });

  it("rejects settlement with the wrong amount, salt, token or payout key", async () => {
    for (const over of [
      { amount: AMOUNT + 1n },
      { salt: OTHER_SALT },
      { merchantPayout: { bytes: bytes32(0x99) } },
    ]) {
      const { h } = await openInvoice();
      h.as(over);
      await expect(
        h.call(
          "settle_invoice",
          InvoiceKind.STANDARD,
          TokenKind.NATIVE,
          coin(over.amount ?? AMOUNT),
        ),
      ).rejects.toThrow("unknown invoice");
    }
    const { h } = await openInvoice();
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, coin(AMOUNT, KUSD)),
    ).rejects.toThrow("unknown invoice");
  });

  it("a payer cannot redirect the coin to themselves", async () => {
    // The payout key is inside the commitment. A payer who swaps in their own
    // key reproduces a different commitment, which matches no invoice.
    const { h, commitment } = await openInvoice();
    h.as({ merchantPayout: { bytes: REFUND_TO } });
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("unknown invoice");
    expect(ledgerOf(h).invoices.lookup(commitment).status).toBe(InvoiceStatus.OPEN);
  });

  it("rejects settling an invoice that was never created", async () => {
    const h = await deployPay();
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("unknown invoice");
  });

  it("pins the payment index for STANDARD so one payer cannot mint nullifiers", async () => {
    const { h } = await openInvoice();
    await h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT));
    h.as({ paymentIndex: 7n });
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("invoice is not open");
    expect(ledgerOf(h).spent.size()).toBe(1n);
  });
});

describe("settle_invoice: multipay and donation", () => {
  it("accepts many distinct payers and stays open", async () => {
    const { h, commitment } = await openInvoice(InvoiceKind.MULTIPAY);
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    h.as({ payerKey: PAYER_2 });
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));

    expect(ledgerOf(h).invoices.lookup(commitment).contributions).toBe(2n);
    expect(await h.call("is_settled", commitment)).toBe(false);
    expect(ledgerOf(h).spent.size()).toBe(2n);
  });

  it("rejects the same payer paying twice under the same index", async () => {
    const { h } = await openInvoice(InvoiceKind.MULTIPAY);
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    await expect(
      h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("payment already settled");
  });

  it("a changed refund key does not make a replay look new", async () => {
    // The nullifier covers payer and index, not the refund key, so the same
    // payment cannot be replayed by naming a different refund destination.
    const { h } = await openInvoice(InvoiceKind.MULTIPAY);
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    h.as({ payerRefund: { bytes: bytes32(0x35) } });
    await expect(
      h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("payment already settled");
  });

  it("allows the same payer to contribute again under a new index", async () => {
    const { h, commitment } = await openInvoice(InvoiceKind.DONATION);
    await h.call("settle_invoice", InvoiceKind.DONATION, TokenKind.NATIVE, coin(AMOUNT));
    h.as({ paymentIndex: 1n });
    await h.call("settle_invoice", InvoiceKind.DONATION, TokenKind.NATIVE, coin(AMOUNT));
    expect(ledgerOf(h).invoices.lookup(commitment).contributions).toBe(2n);
  });
});

describe("close_invoice", () => {
  it("lets the merchant close a multipay invoice", async () => {
    const { h, commitment } = await openInvoice(InvoiceKind.MULTIPAY);
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    await h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE);
    expect(await h.call("is_settled", commitment)).toBe(true);
  });

  it("refuses to close a STANDARD invoice by hand", async () => {
    // Closing would flip it to SETTLED with nobody having paid.
    const { h, commitment } = await openInvoice(InvoiceKind.STANDARD);
    await expect(h.call("close_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE)).rejects.toThrow(
      "standard invoices close on payment",
    );
    expect(await h.call("is_settled", commitment)).toBe(false);
  });

  it("refuses a caller who does not know the invoice terms", async () => {
    const { h } = await openInvoice(InvoiceKind.MULTIPAY);
    h.as({ merchantKey: OTHER_MERCHANT });
    await expect(h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE)).rejects.toThrow(
      "unknown invoice",
    );
  });

  it("refuses to close an already-closed invoice", async () => {
    const { h } = await openInvoice(InvoiceKind.MULTIPAY);
    await h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE);
    await expect(h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE)).rejects.toThrow(
      "invoice is not open",
    );
  });

  it("refuses settlement once closed", async () => {
    const { h } = await openInvoice(InvoiceKind.DONATION);
    await h.call("close_invoice", InvoiceKind.DONATION, TokenKind.NATIVE);
    await expect(
      h.call("settle_invoice", InvoiceKind.DONATION, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("invoice is not open");
  });
});

describe("cancel_invoice", () => {
  it("cancels an unpaid invoice", async () => {
    const { h, commitment } = await openInvoice();
    await h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE);
    expect(await h.call("is_settled", commitment)).toBe(false);
    expect(ledgerOf(h).invoices.lookup(commitment).status).toBe(InvoiceStatus.CANCELLED);
  });

  it("refuses to cancel once someone has paid", async () => {
    const { h } = await openInvoice(InvoiceKind.MULTIPAY);
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE, coin(AMOUNT));
    await expect(h.call("cancel_invoice", InvoiceKind.MULTIPAY, TokenKind.NATIVE)).rejects.toThrow(
      "invoice has contributions",
    );
  });

  it("refuses to cancel twice, and refuses settlement of a cancelled invoice", async () => {
    const { h } = await openInvoice();
    await h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE);
    await expect(h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE)).rejects.toThrow(
      "invoice is not open",
    );
    await expect(
      h.call("settle_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, coin(AMOUNT)),
    ).rejects.toThrow("invoice is not open");
  });

  it("refuses a caller without the invoice terms", async () => {
    const { h } = await openInvoice();
    h.as({ merchantKey: OTHER_MERCHANT });
    await expect(h.call("cancel_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE)).rejects.toThrow(
      "unknown invoice",
    );
  });
});

describe("public read paths", () => {
  it("report non-existence without revealing anything", async () => {
    const h = await deployPay();
    const unknown = bytes32(0x99);
    expect(await h.call("invoice_exists", unknown)).toBe(false);
    expect(await h.call("is_settled", unknown)).toBe(false);
    expect(await h.call("receipt_exists", unknown)).toBe(false);
    expect(await h.call("is_refunded", unknown)).toBe(false);
    expect(await h.call("attestation_exists", unknown)).toBe(false);
  });

  it("a receipt proves payment and is distinct from the commitment", async () => {
    const { h, commitment } = await openInvoice();
    expect(await h.call("invoice_exists", commitment)).toBe(true);
    const receipt = await h.call(
      "settle_invoice",
      InvoiceKind.STANDARD,
      TokenKind.NATIVE,
      coin(AMOUNT),
    );
    expect(await h.call("receipt_exists", receipt)).toBe(true);
    expect(hex(receipt)).not.toBe(hex(commitment));
  });
});

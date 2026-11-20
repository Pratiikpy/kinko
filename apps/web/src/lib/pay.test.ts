import "../polyfills.ts";

import {
  invoiceCommitmentOf,
  KinkoPay,
  newInvoiceSecrets,
  ownerTagOf,
  receiptOf,
} from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { toHex } from "./format.ts";
import {
  KIND_NAME,
  KIND_OF,
  parsePaymentLink,
  parseShieldedAddress,
  paymentUrl,
  receiptFrom,
  shieldedAddressOf,
  termsOfRecord,
} from "./pay.ts";
import { claimedBy, decodeReceiptProof, encodeReceiptProof } from "./receipts.ts";

const PAY = "5a".repeat(32);
const ORIGIN = "https://pay.test";
const ENC = new Uint8Array(32).fill(9);
/** The owner secret behind the invoices these tests build; only its public tag is in the terms. */
const OWNER_SECRET = new Uint8Array(32).fill(0x77);

const terms = () => {
  const { salt } = newInvoiceSecrets();
  return {
    merchantKey: new Uint8Array(32).fill(1),
    payout: new Uint8Array(32).fill(2),
    amount: 1_250_000_000n,
    kind: KinkoPay.InvoiceKind.MULTIPAY,
    token: KinkoPay.TokenKind.KUSD,
    salt,
    owner: ownerTagOf(OWNER_SECRET),
    expiresAt: 1_800_000_000n,
  };
};

describe("payment links", () => {
  it("round-trip terms and the title and note", () => {
    const t = terms();
    const url = paymentUrl(
      "/pay",
      t,
      PAY,
      { title: "Logo, final", memo: "Thanks — 感謝" },
      ENC,
      ORIGIN,
    );
    expect(url.startsWith(`${ORIGIN}/pay#`)).toBe(true);
    const parsed = parsePaymentLink(url);
    expect(parsed?.contractAddress).toBe(PAY);
    expect(parsed?.meta).toEqual({ title: "Logo, final", memo: "Thanks — 感謝" });
    if (!parsed) throw new Error("the link did not parse");
    expect(toHex(invoiceCommitmentOf(parsed.terms))).toBe(toHex(invoiceCommitmentOf(t)));
    expect(parsed.payoutEncryptionKey && toHex(parsed.payoutEncryptionKey)).toBe(toHex(ENC));
  });

  it("work without a title, from a bare fragment", () => {
    const t = terms();
    const url = paymentUrl("/checkout", t, PAY, {}, ENC, ORIGIN);
    expect(url).not.toContain("~");
    const fragment = url.slice(url.indexOf("#") + 1);
    expect(parsePaymentLink(fragment)?.terms.amount).toBe(t.amount);
  });

  it("refuse altered or foreign text", () => {
    const url = paymentUrl("/pay", terms(), PAY, { title: "x" }, ENC, ORIGIN);
    expect(parsePaymentLink(url.replace("#", "#zz"))).toBeNull();
    expect(parsePaymentLink("@alice")).toBeNull();
    expect(parsePaymentLink("")).toBeNull();
  });

  it("ignore a malformed note instead of rejecting a valid invoice", () => {
    const url = paymentUrl("/pay", terms(), PAY, {}, ENC, ORIGIN);
    expect(parsePaymentLink(`${url}~!!!`)?.meta).toEqual({ title: undefined, memo: undefined });
  });
});

describe("invoice records", () => {
  it("rebuild the exact terms the commitment was made from", () => {
    const t = terms();
    const record = {
      merchantKey: toHex(t.merchantKey),
      payout: toHex(t.payout),
      amount: t.amount.toString(),
      kind: KIND_NAME(t.kind),
      salt: toHex(t.salt),
      ownerSecret: toHex(OWNER_SECRET),
      expiresAt: t.expiresAt.toString(),
    };
    expect(toHex(invoiceCommitmentOf(termsOfRecord(record)))).toBe(toHex(invoiceCommitmentOf(t)));
  });

  it("map kinds both ways", () => {
    for (const name of ["standard", "multipay", "donation"] as const)
      expect(KIND_NAME(KIND_OF[name])).toBe(name);
  });
});

describe("receipts", () => {
  it("recompute with the compiled circuit, the same way the contract does", () => {
    const t = terms();
    const c = invoiceCommitmentOf(t);
    const payerKey = new Uint8Array(32).fill(9);
    const refundTo = new Uint8Array(32).fill(8);
    const refundEnc = new Uint8Array(32).fill(7);
    const expected = toHex(receiptOf(c, t.kind, { payerKey, refundTo, refundEnc, index: 3n }));
    expect(
      receiptFrom(toHex(c), "multipay", toHex(payerKey), toHex(refundTo), toHex(refundEnc), 3n),
    ).toBe(expected);
  });

  it("travel as a proof that round-trips and checks to the same receipt", () => {
    const t = terms();
    const proof = {
      contract: PAY,
      terms: t,
      payerKey: "09".repeat(32),
      refundTo: "08".repeat(32),
      refundEnc: "07".repeat(32),
      index: 0n,
      title: "Logo",
    };
    const decoded = decodeReceiptProof(`${ORIGIN}/verify#${encodeReceiptProof(proof)}`);
    if (!decoded) throw new Error("the proof did not decode");
    expect(claimedBy(decoded)).toEqual(claimedBy(proof));
    expect(decoded.title).toBe("Logo");
  });

  it("refuse a proof with a field changed", () => {
    expect(decodeReceiptProof("not-a-proof")).toBeNull();
    const enc = encodeReceiptProof({
      contract: PAY,
      terms: terms(),
      payerKey: "09".repeat(32),
      refundTo: "zz".repeat(32),
      refundEnc: "07".repeat(32),
      index: 0n,
    });
    expect(decodeReceiptProof(enc)).toBeNull();
  });

  it("change when the amount in a proof is changed", () => {
    const t = terms();
    const a = claimedBy({
      contract: PAY,
      terms: t,
      payerKey: "09".repeat(32),
      refundTo: "08".repeat(32),
      refundEnc: "07".repeat(32),
      index: 0n,
    });
    const b = claimedBy({
      contract: PAY,
      terms: { ...t, amount: t.amount + 1n },
      payerKey: "09".repeat(32),
      refundTo: "08".repeat(32),
      refundEnc: "07".repeat(32),
      index: 0n,
    });
    expect(a.receipt).not.toBe(b.receipt);
    expect(a.commitment).not.toBe(b.commitment);
  });
});

describe("shielded addresses", () => {
  it("encode receiving keys for this network and read them back", () => {
    const cpk = new Uint8Array(32).fill(0x11);
    const epk = new Uint8Array(32).fill(0x22);
    const address = shieldedAddressOf(cpk, epk);
    expect(address.startsWith("mn_shield-addr_undeployed1")).toBe(true);
    expect(parseShieldedAddress(address)).toEqual({
      coinPublicKey: toHex(cpk),
      encryptionPublicKey: toHex(epk),
    });
  });

  it("refuse text that is not one", () => {
    expect(parseShieldedAddress("mn_shield-addr_undeployed1qqqq")).toBeNull();
    expect(parseShieldedAddress("@alice")).toBeNull();
  });
});

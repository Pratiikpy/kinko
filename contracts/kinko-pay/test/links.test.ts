// Payment links and the off-chain helpers around them.
//
// A payment link is how terms reach a payer, so it must round-trip exactly,
// refuse anything malformed instead of producing terms that match no invoice,
// and never carry the merchant's owner secret.

import { describe, expect, it } from "vitest";

import {
  assertInvoiceTerms,
  decodePaymentLink,
  encodePaymentLink,
  fromHex,
  invoiceCommitmentOf,
  type InvoiceTerms,
  newInvoiceSecrets,
  newPaymentSecrets,
  nullifierOf,
  pad32,
  randomBytes,
  toHex,
} from "../src/index.ts";
import { bytes32, fail, hex } from "./harness.ts";
import {
  AMOUNT,
  base,
  coin,
  InvoiceKind,
  KUSD,
  ledgerOf,
  MERCHANT,
  openInvoice,
  OWNER,
  PAYOUT,
  SALT,
  TokenKind,
} from "./pay-fixtures.ts";

const ADDRESS = "ab".repeat(32);
const PAYOUT_ENC = bytes32(0x5e);
const TERMS: InvoiceTerms = {
  merchantKey: MERCHANT,
  payout: PAYOUT,
  amount: AMOUNT,
  kind: InvoiceKind.MULTIPAY,
  token: TokenKind.KUSD,
  salt: SALT,
  expiresAt: 1_900_000_000n,
};

describe("payment links", () => {
  it("round-trip the terms and the contract address, from a bare payload or a full link", () => {
    const encoded = encodePaymentLink(TERMS, `0x${ADDRESS.toUpperCase()}`, PAYOUT_ENC);
    for (const link of [encoded, `https://kinko.example/pay#${encoded}`]) {
      const decoded = decodePaymentLink(link);
      expect(decoded?.contractAddress).toBe(ADDRESS);
      expect(decoded && hex(invoiceCommitmentOf(decoded.terms))).toBe(
        hex(invoiceCommitmentOf(TERMS)),
      );
      expect(decoded?.terms.amount).toBe(AMOUNT);
      expect(decoded?.terms.expiresAt).toBe(TERMS.expiresAt);
      expect(decoded?.payoutEncryptionKey && hex(decoded.payoutEncryptionKey)).toBe(
        hex(PAYOUT_ENC),
      );
    }
  });

  it("still read a version 1 link, which has no payout encryption key", () => {
    const v2 = JSON.parse(
      Buffer.from(encodePaymentLink(TERMS, ADDRESS, PAYOUT_ENC), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const { x: _x, ...rest } = v2;
    const v1 = Buffer.from(JSON.stringify({ ...rest, v: 1 })).toString("base64url");
    const decoded = decodePaymentLink(v1) ?? fail("version 1 link did not decode");
    expect(hex(invoiceCommitmentOf(decoded.terms))).toBe(hex(invoiceCommitmentOf(TERMS)));
    expect(decoded.payoutEncryptionKey).toBeUndefined();
  });

  it("refuse to encode a link without a valid payout encryption key", () => {
    expect(() => encodePaymentLink(TERMS, ADDRESS, new Uint8Array(31))).toThrow(
      /payoutEncryptionKey must be 32 bytes/,
    );
  });

  it("decode to terms a payer can actually pay with", async () => {
    const { h, commitment } = await openInvoice(
      InvoiceKind.MULTIPAY,
      TokenKind.KUSD,
      TERMS.expiresAt,
    );
    const decoded =
      decodePaymentLink(encodePaymentLink(TERMS, ADDRESS, PAYOUT_ENC)) ??
      fail("link did not decode");
    expect(hex(invoiceCommitmentOf(decoded.terms))).toBe(hex(commitment));
    // A payer with nothing but the link and their own keys.
    const payment = newPaymentSecrets(bytes32(0x61));
    h.privateState = {
      ...base(),
      merchantKey: decoded.terms.merchantKey,
      merchantPayout: { bytes: decoded.terms.payout },
      amount: decoded.terms.amount,
      salt: decoded.terms.salt,
      ownerSecret: new Uint8Array(32),
      payerKey: payment.payerKey,
      payerRefund: { bytes: payment.refundTo },
    };
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD, coin(AMOUNT, KUSD));
    expect(ledgerOf(h).spent.member(nullifierOf(commitment, InvoiceKind.MULTIPAY, payment))).toBe(
      true,
    );
  });

  it("never carry the owner secret", () => {
    const encoded = encodePaymentLink(TERMS, ADDRESS, PAYOUT_ENC);
    const json = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    expect(json).not.toContain(hex(OWNER));
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual([
      "a",
      "e",
      "k",
      "m",
      "n",
      "p",
      "s",
      "t",
      "v",
      "x",
    ]);
  });

  it("refuse malformed links rather than yielding terms that match no invoice", () => {
    const good = JSON.parse(
      Buffer.from(
        encodePaymentLink(TERMS, ADDRESS, PAYOUT_ENC).replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const broken of [
      { ...good, v: 3 },
      { ...good, x: "ab" },
      { ...good, x: undefined },
      { ...good, n: "-1" },
      { ...good, n: (1n << 64n).toString() },
      { ...good, k: 7 },
      { ...good, t: 2 },
      { ...good, s: "ab" },
      { ...good, a: "xyz" },
      { ...good, e: "1.5" },
    ]) {
      expect({ broken, decoded: decodePaymentLink(encode(broken)) }).toEqual({
        broken,
        decoded: undefined,
      });
    }
    for (const junk of ["", "#", "!!!", "e30"]) expect(decodePaymentLink(junk)).toBeUndefined();
  });
});

describe("input validation before a call", () => {
  it("names the malformed field", () => {
    expect(() => {
      assertInvoiceTerms({ ...TERMS, amount: -1n });
    }).toThrow(/amount is out of range/);
    expect(() => {
      assertInvoiceTerms({ ...TERMS, amount: 1n << 64n });
    }).toThrow(/amount is out of range/);
    expect(() => {
      assertInvoiceTerms({ ...TERMS, salt: new Uint8Array(31) });
    }).toThrow(/salt must be 32 bytes/);
    expect(() => {
      assertInvoiceTerms({ ...TERMS, kind: 9 as never });
    }).toThrow(/unknown invoice kind/);
    expect(() => {
      assertInvoiceTerms({ ...TERMS, token: 9 as never });
    }).toThrow(/unknown token/);
    expect(() => newPaymentSecrets(bytes32(1), 1n << 32n)).toThrow(/index is out of range/);
  });

  it("draws fresh, independent secrets", () => {
    const a = newInvoiceSecrets();
    const b = newInvoiceSecrets();
    expect(new Set([a.salt, a.ownerSecret, b.salt, b.ownerSecret].map(hex)).size).toBe(4);
    expect(randomBytes(20)).toHaveLength(20);
  });

  it("converts bytes exactly", () => {
    expect(toHex(fromHex("0x00ff10", 3))).toBe("00ff10");
    expect(() => fromHex("abc", 2)).toThrow(/not a hex string/);
    expect(() => fromHex("abcd", 3)).toThrow(/expected 3 bytes/);
    expect(
      hex(pad32("kinko:invoice:v1")).startsWith(Buffer.from("kinko:invoice:v1").toString("hex")),
    ).toBe(true);
    expect(() => pad32("x".repeat(33))).toThrow(/does not fit/);
  });
});

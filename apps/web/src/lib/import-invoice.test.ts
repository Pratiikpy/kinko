import "../polyfills.ts";

import { invoiceCommitmentOf, KinkoPay, newInvoiceSecrets, ownerTagOf } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { toHex } from "./format.ts";
import { parseInvoiceFile } from "./import-invoice.ts";
import { paymentUrl } from "./pay.ts";

const PAY = "5a".repeat(32);
const ENC = new Uint8Array(32).fill(9);

/**
 * An invoice file exactly as the Node SDK's saveInvoiceSecrets writes one.
 *
 * @param overrides - Fields to replace, to make a broken file.
 * @returns The file's text, its fields and the terms it was made from.
 */
function file(overrides: Record<string, unknown> = {}) {
  const { salt, ownerSecret } = newInvoiceSecrets();
  const terms = {
    merchantKey: new Uint8Array(32).fill(1),
    payout: new Uint8Array(32).fill(2),
    amount: 25_500_000n,
    kind: KinkoPay.InvoiceKind.MULTIPAY,
    token: KinkoPay.TokenKind.KUSD,
    salt,
    owner: ownerTagOf(ownerSecret),
    expiresAt: 1_900_000_000n,
  };
  const body = {
    commitment: toHex(invoiceCommitmentOf(terms)),
    createdAt: "2026-11-15T00:00:00.000Z",
    kind: "multipay",
    asset: "KUSD",
    amount: "25500000",
    expiresAt: 1_900_000_000,
    merchantKey: toHex(terms.merchantKey),
    payoutKey: toHex(terms.payout),
    payoutAddress: "mn_shield-addr_undeployed1…",
    salt: toHex(salt),
    ownerSecret: toHex(ownerSecret),
    paymentLink: paymentUrl(
      "/pay",
      terms,
      PAY,
      { title: "Consulting, May" },
      ENC,
      "https://k.test",
    ),
    ...overrides,
  };
  return { text: JSON.stringify(body), body, terms };
}

describe("parseInvoiceFile", () => {
  it("reads a file the SDK saved and rebuilds terms that hash to its commitment", () => {
    const { text, body, terms } = file();
    const inv = parseInvoiceFile(text);
    expect(inv.commitment).toBe(body.commitment);
    expect(toHex(invoiceCommitmentOf(inv.terms))).toBe(toHex(invoiceCommitmentOf(terms)));
    expect(inv.kind).toBe("multipay");
    expect(inv.title).toBe("Consulting, May");
    expect(toHex(inv.ownerSecret)).toBe(body.ownerSecret);
  });

  it("refuses a file whose terms were edited after it was made", () => {
    const { text } = file();
    const edited = text.replace('"amount":"25500000"', '"amount":"1"');
    expect(() => parseInvoiceFile(edited)).toThrow(/do not match its commitment/);
  });

  it("refuses a file whose link is for another invoice", () => {
    const other = file();
    const { text } = file({ paymentLink: other.body.paymentLink });
    expect(() => parseInvoiceFile(text)).toThrow(/payment link is for a different invoice/);
  });

  it.each([
    ["not json", "{", /not JSON/],
    ["an array", "[]", /not an invoice file/],
    [
      "no owner secret",
      JSON.stringify({ ...file().body, ownerSecret: undefined }),
      /no ownerSecret/,
    ],
    ["a short key", JSON.stringify({ ...file().body, salt: "ab" }), /salt is not 64 hex/],
    ["an unknown kind", JSON.stringify({ ...file().body, kind: "weekly" }), /kind is not/],
    ["an unknown asset", JSON.stringify({ ...file().body, asset: "BTC" }), /asset is not/],
    ["a zero amount", JSON.stringify({ ...file().body, amount: "0" }), /amount is not/],
    ["a fractional expiry", JSON.stringify({ ...file().body, expiresAt: 1.5 }), /expiry/],
  ])("names the problem with %s", (_label, text, message) => {
    expect(() => parseInvoiceFile(text)).toThrow(message);
  });
});

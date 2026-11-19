// Publishing an invoice that was built somewhere else: by the merchant SDK, the
// CLI or the assistant's MCP server. Those build the terms and secrets on the
// merchant's own machine and save them to a file; the invoice exists only once
// a wallet calls create_invoice with them, which is what this does.
//
// The file is checked before anything is signed: the terms must hash to the
// commitment the file names, and the payment link must name the same invoice.
// A file edited by hand, or mixed from two invoices, is refused rather than
// published as an invoice nobody's link points to.

import { invoiceCommitmentOf, type InvoiceTerms, KinkoPay } from "@kinko/kinko-pay";

import { fromHex, toHex } from "./format.ts";
import { parsePaymentLink } from "./pay.ts";
import type { InvoiceKindName } from "./records.ts";

/** An invoice file, read and checked. */
export interface ImportedInvoice {
  readonly commitment: string;
  readonly terms: InvoiceTerms;
  readonly ownerSecret: Uint8Array;
  readonly kind: InvoiceKindName;
  readonly link: string;
  readonly title: string;
  readonly memo: string;
}

const KINDS: Record<string, { kind: KinkoPay.InvoiceKind; name: InvoiceKindName }> = {
  standard: { kind: KinkoPay.InvoiceKind.STANDARD, name: "standard" },
  multipay: { kind: KinkoPay.InvoiceKind.MULTIPAY, name: "multipay" },
  donation: { kind: KinkoPay.InvoiceKind.DONATION, name: "donation" },
};

const ASSETS: Record<string, KinkoPay.TokenKind> = {
  KUSD: KinkoPay.TokenKind.KUSD,
  NATIVE: KinkoPay.TokenKind.NATIVE,
};

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

/** Why a file could not be imported, in words for the merchant. */
export class InvoiceFileError extends Error {
  /**
   * Create the error.
   *
   * @param message - What is wrong with the file, for the merchant.
   */
  constructor(message: string) {
    super(message);
    this.name = "InvoiceFileError";
  }
}

function field(raw: Record<string, unknown>, name: string): string {
  const v = raw[name];
  if (typeof v !== "string" || v.trim() === "")
    throw new InvoiceFileError(`The file has no ${name}.`);
  return v.trim();
}

function hex32(raw: Record<string, unknown>, name: string): Uint8Array {
  const v = field(raw, name);
  if (!HEX64.test(v)) throw new InvoiceFileError(`The file's ${name} is not 64 hex characters.`);
  return fromHex(v.replace(/^0x/i, ""));
}

/**
 * Read an invoice file saved by the SDK, the CLI or the MCP server.
 *
 * @param text - The file's contents.
 * @returns The checked invoice.
 * @throws {InvoiceFileError} When the file is not an invoice file, or does not hold together.
 */
export function parseInvoiceFile(text: string): ImportedInvoice {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InvoiceFileError("That is not an invoice file: it is not JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new InvoiceFileError("That is not an invoice file.");
  const r = raw as Record<string, unknown>;

  const kind = KINDS[field(r, "kind")];
  if (!kind) throw new InvoiceFileError("The file's kind is not standard, multipay or donation.");
  const token = ASSETS[field(r, "asset")];
  if (token === undefined) throw new InvoiceFileError("The file's asset is not KUSD or NATIVE.");
  const amountText = field(r, "amount");
  if (!/^[0-9]+$/.test(amountText) || BigInt(amountText) === 0n || BigInt(amountText) >= 1n << 64n)
    throw new InvoiceFileError("The file's amount is not a positive whole number of base units.");
  const expiresAt = r.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt) || expiresAt < 0)
    throw new InvoiceFileError("The file's expiry is not a whole number of seconds.");

  const terms: InvoiceTerms = {
    merchantKey: hex32(r, "merchantKey"),
    payout: hex32(r, "payoutKey"),
    amount: BigInt(amountText),
    kind: kind.kind,
    token,
    salt: hex32(r, "salt"),
    expiresAt: BigInt(expiresAt),
  };
  const ownerSecret = hex32(r, "ownerSecret");
  const commitment = toHex(invoiceCommitmentOf(terms));
  if (commitment !== field(r, "commitment").replace(/^0x/i, "").toLowerCase())
    throw new InvoiceFileError(
      "The file's terms do not match its commitment. It was changed after it was made; publish the original file.",
    );

  const link = field(r, "paymentLink");
  const parsed = parsePaymentLink(link);
  if (!parsed || toHex(invoiceCommitmentOf(parsed.terms)) !== commitment)
    throw new InvoiceFileError("The file's payment link is for a different invoice.");

  return {
    commitment,
    terms,
    ownerSecret,
    kind: kind.name,
    link,
    title: parsed.meta.title ?? "",
    memo: parsed.meta.memo ?? "",
  };
}

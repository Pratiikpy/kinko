// Private receipts: proving one payment to one person, and nothing else.
//
// A receipt on chain is a digest. Alone it says nothing. The payer can hand a
// verifier a proof bundle: the invoice terms (what was owed, to whom) and the
// payer's own per-payment secrets. The verifier recomputes the invoice
// commitment and the receipt with the contract's compiled circuits and checks
// the receipt is on the ledger. Nothing else about the payer is revealed:
// every payment draws fresh secrets, so one bundle links to no other payment.

import {
  decodeLinkPayload,
  encodeLinkPayload,
  invoiceCommitmentOf,
  type InvoiceTerms,
} from "@kinko/kinko-pay";

import { fromHex, toHex } from "./format.ts";
import { KIND_NAME, receiptFrom } from "./pay.ts";

/** Everything a verifier needs to check one payment against the chain. */
export interface ReceiptProof {
  readonly contract: string;
  readonly terms: InvoiceTerms;
  readonly payerKey: string;
  readonly refundTo: string;
  readonly refundEnc: string;
  readonly index: bigint;
  readonly title?: string;
}

interface Wire {
  v: 3;
  c: string;
  m: string;
  p: string;
  n: string;
  k: number;
  t: number;
  s: string;
  /** The invoice's public owner tag, part of its commitment. */
  o: string;
  e: string;
  pk: string;
  r: string;
  /** The encryption key a refund is encrypted to, bound into the receipt. */
  re: string;
  i: string;
  ti?: string;
}

const HEX32 = /^[0-9a-f]{64}$/;
const DIGITS = /^\d+$/;

const isHex32 = (v: unknown): v is string => typeof v === "string" && HEX32.test(v);
const isDigits = (v: unknown): v is string => typeof v === "string" && DIGITS.test(v);

/**
 * Encode a proof for a link fragment.
 *
 * @param p - The proof.
 * @returns The fragment text.
 */
export function encodeReceiptProof(p: ReceiptProof): string {
  const w: Wire = {
    v: 3,
    c: p.contract,
    m: toHex(p.terms.merchantKey),
    p: toHex(p.terms.payout),
    n: p.terms.amount.toString(),
    k: p.terms.kind,
    t: p.terms.token,
    s: toHex(p.terms.salt),
    o: toHex(p.terms.owner),
    e: p.terms.expiresAt.toString(),
    pk: p.payerKey,
    r: p.refundTo,
    re: p.refundEnc,
    i: p.index.toString(),
    ti: p.title,
  };
  return encodeLinkPayload(w);
}

/**
 * Decode a proof from a link or a bare fragment.
 *
 * @param text - The link or fragment.
 * @returns The proof, or null when any field is missing or malformed.
 */
export function decodeReceiptProof(text: string): ReceiptProof | null {
  const w = decodeLinkPayload(
    text.includes("#") ? text.slice(text.indexOf("#") + 1) : text.trim(),
  ) as Partial<Wire> | undefined;
  // Earlier proofs carry no owner tag or no refund encryption key, so they name receipts the
  // contract no longer knows.
  if (w?.v !== 3) return null;
  const { c, m, p, s, o, pk, r, re, n, e, i, k, t, ti } = w;
  if (
    !isHex32(c) ||
    !isHex32(m) ||
    !isHex32(p) ||
    !isHex32(s) ||
    !isHex32(o) ||
    !isHex32(pk) ||
    !isHex32(r) ||
    !isHex32(re)
  )
    return null;
  if (!isDigits(n) || !isDigits(e) || !isDigits(i)) return null;
  if (typeof k !== "number" || typeof t !== "number") return null;
  return {
    contract: c,
    terms: {
      merchantKey: fromHex(m),
      payout: fromHex(p),
      amount: BigInt(n),
      kind: k,
      token: t,
      salt: fromHex(s),
      owner: fromHex(o),
      expiresAt: BigInt(e),
    },
    payerKey: pk,
    refundTo: r,
    refundEnc: re,
    index: BigInt(i),
    title: typeof ti === "string" ? ti.slice(0, 80) : undefined,
  };
}

/**
 * The commitment and receipt a proof claims, recomputed with the compiled circuits.
 *
 * @param p - The proof.
 * @returns The invoice commitment and the receipt digest, as hex.
 */
export function claimedBy(p: ReceiptProof): { commitment: string; receipt: string } {
  const commitment = toHex(invoiceCommitmentOf(p.terms));
  return {
    commitment,
    receipt: receiptFrom(
      commitment,
      KIND_NAME(p.terms.kind),
      p.payerKey,
      p.refundTo,
      p.refundEnc,
      p.index,
    ),
  };
}

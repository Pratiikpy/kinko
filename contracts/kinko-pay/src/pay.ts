// Off-chain helpers for kinko_pay: fresh invoice secrets, payment links,
// refund codes, and the public digests the app recomputes.
//
// Every digest comes from the compiled pure circuit of the same name, so a
// commitment the app computes is the commitment the contract computes. What
// lives here is only what a circuit cannot do: draw randomness, validate input
// before a call, and move values in and out of links.

import {
  BYTES32,
  decodeLinkPayload,
  encodeLinkPayload,
  fromHex,
  randomBytes,
  toHex,
} from "./bytes.ts";
import { InvoiceKind, pureCircuits, TokenKind } from "./managed/kinko_pay/contract/index.js";

const UINT32_MAX = 0xffff_ffffn;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

/** The terms a payer needs to reproduce an invoice commitment and pay it. */
export interface InvoiceTerms {
  readonly merchantKey: Uint8Array;
  /** The merchant's zswap coin public key, where the coin is forwarded. */
  readonly payout: Uint8Array;
  /** Base units of the invoice's asset. */
  readonly amount: bigint;
  readonly kind: InvoiceKind;
  readonly token: TokenKind;
  readonly salt: Uint8Array;
  /**
   * The invoice's public owner tag, the hash of the merchant's owner secret. It is part of the
   * commitment, so only the holder of that secret can create the invoice the link names.
   */
  readonly owner: Uint8Array;
  /** Block time in seconds after which settlement is refused; 0 never expires. */
  readonly expiresAt: bigint;
}

/** The secrets a merchant draws for one new invoice. */
export interface InvoiceSecrets {
  /** Goes into the payment link. */
  readonly salt: Uint8Array;
  /** Stays with the merchant; authorises close, cancel and refund. */
  readonly ownerSecret: Uint8Array;
}

/** What a payer keeps for one payment, and hands the merchant to ask for a refund. */
export interface PaymentSecrets {
  readonly payerKey: Uint8Array;
  /** The payer's coin public key, where a refund goes. */
  readonly refundTo: Uint8Array;
  /**
   * The payer's encryption public key, which a refund coin is encrypted to. Bound into the receipt
   * with `refundTo`, so a refund can only be encrypted to a key the payer can read it with.
   */
  readonly refundEnc: Uint8Array;
  readonly index: bigint;
}

const checkBytes32 = (value: Uint8Array, name: string): void => {
  if (value.length !== BYTES32) {
    throw new Error(`${name} must be 32 bytes, got ${String(value.length)}`);
  }
};

const checkUint = (value: bigint, max: bigint, name: string): void => {
  if (value < 0n || value > max) throw new Error(`${name} is out of range: ${value.toString()}`);
};

const INVOICE_KINDS: readonly unknown[] = Object.values(InvoiceKind);
const TOKEN_KINDS: readonly unknown[] = Object.values(TokenKind);

/**
 * Validate invoice terms before they reach a circuit or a link. Amounts are
 * Uint<64> in the contract, so a value outside it would otherwise fail deep
 * inside proof construction.
 *
 * @param terms - The terms to check.
 * @throws {Error} Naming the first field that is malformed.
 */
export const assertInvoiceTerms = (terms: InvoiceTerms): void => {
  checkBytes32(terms.merchantKey, "merchantKey");
  checkBytes32(terms.payout, "payout");
  checkBytes32(terms.salt, "salt");
  checkBytes32(terms.owner, "owner");
  checkUint(terms.amount, UINT64_MAX, "amount");
  checkUint(terms.expiresAt, UINT64_MAX, "expiresAt");
  // Enum values arrive from links and forms as plain numbers, so membership is
  // checked against the numeric members only.
  if (typeof (terms.kind as unknown) !== "number" || !INVOICE_KINDS.includes(terms.kind)) {
    throw new Error(`unknown invoice kind ${String(terms.kind)}`);
  }
  if (typeof (terms.token as unknown) !== "number" || !TOKEN_KINDS.includes(terms.token)) {
    throw new Error(`unknown token ${String(terms.token)}`);
  }
};

/**
 * Draw the secrets for a new invoice. Both are fresh: a reused salt makes
 * equal invoices linkable, and a reused owner secret links a merchant's
 * invoices through their public owner tags.
 *
 * @returns A new salt and owner secret.
 */
export const newInvoiceSecrets = (): InvoiceSecrets => ({
  salt: randomBytes(),
  ownerSecret: randomBytes(),
});

/**
 * Draw the payer secret for a new payment.
 *
 * @param refundTo - The payer's coin public key, where a refund would go.
 * @param refundEnc - The payer's encryption public key, which a refund is encrypted to.
 * @param index - The contribution index; 0 for a STANDARD invoice.
 * @returns The payment's secrets.
 */
export const newPaymentSecrets = (
  refundTo: Uint8Array,
  refundEnc: Uint8Array,
  index = 0n,
): PaymentSecrets => {
  checkBytes32(refundTo, "refundTo");
  checkBytes32(refundEnc, "refundEnc");
  checkUint(index, UINT32_MAX, "index");
  return { payerKey: randomBytes(), refundTo, refundEnc, index };
};

/**
 * The invoice's public identifier, from the compiled circuit.
 *
 * @param terms - The invoice terms.
 * @returns The commitment the ledger keys the invoice by.
 */
export const invoiceCommitmentOf = (terms: InvoiceTerms): Uint8Array => {
  assertInvoiceTerms(terms);
  return pureCircuits.invoice_commitment(
    terms.merchantKey,
    terms.payout,
    terms.amount,
    terms.kind,
    terms.token,
    terms.salt,
    terms.owner,
  );
};

/**
 * The index the contract actually uses: STANDARD invoices pin it to 0.
 *
 * @param kind - The invoice kind.
 * @param index - The index the payer chose.
 * @returns The index the nullifier and receipt are built with.
 */
const effectiveIndex = (kind: InvoiceKind, index: bigint): bigint =>
  pureCircuits.pinned_index(kind, index);

/**
 * The receipt a payment publishes, from the compiled circuit.
 *
 * @param commitment - The invoice commitment.
 * @param kind - The invoice kind, which decides whether the index is pinned.
 * @param payment - The payment's secrets.
 * @returns The receipt digest.
 */
export const receiptOf = (
  commitment: Uint8Array,
  kind: InvoiceKind,
  payment: PaymentSecrets,
): Uint8Array =>
  pureCircuits.receipt_digest(
    commitment,
    payment.payerKey,
    payment.refundTo,
    payment.refundEnc,
    effectiveIndex(kind, payment.index),
  );

/**
 * The nullifier a payment spends, from the compiled circuit. Lets a wallet
 * check `spent` before proving, instead of finding out from a failed proof.
 *
 * @param commitment - The invoice commitment.
 * @param kind - The invoice kind.
 * @param payment - The payment's secrets.
 * @returns The settlement nullifier.
 */
export const nullifierOf = (
  commitment: Uint8Array,
  kind: InvoiceKind,
  payment: PaymentSecrets,
): Uint8Array =>
  pureCircuits.settle_nullifier(commitment, payment.payerKey, effectiveIndex(kind, payment.index));

/**
 * The owner tag stored for an owner secret.
 *
 * @param ownerSecret - The merchant's per-invoice ownership secret.
 * @returns The tag the invoice record carries.
 */
export const ownerTagOf = (ownerSecret: Uint8Array): Uint8Array =>
  pureCircuits.owner_tag(ownerSecret);

/**
 * The refund tag recorded when `receipt` is refunded.
 *
 * @param receipt - The refunded payment's receipt.
 * @returns The tag the refunded set holds.
 */
export const refundTagOf = (receipt: Uint8Array): Uint8Array => pureCircuits.refund_tag(receipt);

/**
 * The digest a revenue attestation publishes, so a verifier handed the merchant
 * key, the threshold and the receipt-set digest can check attestation_exists.
 *
 * @param merchantKey - The merchant's identity key.
 * @param threshold - The attested minimum revenue.
 * @param receipts - The four receipts the merchant counted.
 * @returns The attestation digest.
 * @throws {Error} When `receipts` does not hold exactly four receipts.
 */
export const attestationDigestOf = (
  merchantKey: Uint8Array,
  threshold: bigint,
  receipts: readonly Uint8Array[],
): Uint8Array => {
  return pureCircuits.attestation_digest(merchantKey, threshold, receiptSetDigestOf(receipts));
};

/**
 * The digest of the four counted receipts, which is all a verifier needs of them.
 *
 * @param receipts - The four receipts, in the order they were attested.
 * @returns The receipt-set digest.
 * @throws {Error} When `receipts` does not hold exactly four receipts.
 */
export const receiptSetDigestOf = (receipts: readonly Uint8Array[]): Uint8Array => {
  if (receipts.length !== 4) {
    throw new Error(`an attestation counts exactly 4 receipts, got ${String(receipts.length)}`);
  }
  return pureCircuits.receipt_set_digest([...receipts]);
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

interface PaymentLinkPayload {
  v: 1 | 2 | 3;
  a: string;
  m: string;
  p: string;
  n: string;
  k: number;
  t: number;
  s: string;
  /** The invoice's public owner tag (version 3). */
  o?: string;
  e: string;
  /** The payout key's encryption public key (versions 2 and 3). */
  x?: string;
}

/** A payment link read back. */
export interface DecodedPaymentLink {
  readonly terms: InvoiceTerms;
  readonly contractAddress: string;
  /**
   * The encryption public key that belongs to the payout key. A payer needs it
   * to encrypt the forwarded coin to the merchant; version 1 links lack it and
   * cannot be paid.
   */
  readonly payoutEncryptionKey?: Uint8Array;
}

/**
 * Encode invoice terms for a payment link. The terms are everything a payer
 * needs and nothing more: the owner secret is never in a link. The payout
 * key's encryption key travels with them because the settlement forwards a
 * coin to the payout key, and the payer's wallet must encrypt that coin to its
 * owner. It is not part of the commitment. Put the result in a URL fragment,
 * which browsers never send to a server.
 *
 * @param terms - The invoice terms.
 * @param contractAddress - The kinko_pay contract address, hex.
 * @param payoutEncryptionKey - The encryption public key of the payout key's wallet.
 * @returns The link payload.
 */
export const encodePaymentLink = (
  terms: InvoiceTerms,
  contractAddress: string,
  payoutEncryptionKey: Uint8Array,
): string => {
  assertInvoiceTerms(terms);
  fromHex(contractAddress);
  checkBytes32(payoutEncryptionKey, "payoutEncryptionKey");
  const payload: PaymentLinkPayload = {
    v: 3,
    a: contractAddress.replace(/^0x/i, "").toLowerCase(),
    m: toHex(terms.merchantKey),
    p: toHex(terms.payout),
    n: terms.amount.toString(10),
    k: terms.kind,
    t: terms.token,
    s: toHex(terms.salt),
    o: toHex(terms.owner),
    e: terms.expiresAt.toString(10),
    x: toHex(payoutEncryptionKey),
  };
  return encodeLinkPayload(payload);
};

/**
 * Decode a payment link produced by {@link encodePaymentLink}.
 *
 * @param link - The payload, or a full link carrying it in its fragment.
 * @returns The terms, contract address and payout encryption key, or `undefined` when malformed or
 *   made for an earlier contract.
 */
export const decodePaymentLink = (link: string): DecodedPaymentLink | undefined => {
  const raw = decodeLinkPayload(link) as Partial<PaymentLinkPayload> | undefined;
  // Earlier links (versions 1 and 2) carry no owner tag, so they name commitments the contract no
  // longer recognises and cannot be paid; they are refused rather than half read.
  if (raw?.v !== 3) return undefined;
  try {
    if (!/^\d+$/.test(raw.n ?? "") || !/^\d+$/.test(raw.e ?? "")) return undefined;
    const terms: InvoiceTerms = {
      merchantKey: fromHex(raw.m ?? ""),
      payout: fromHex(raw.p ?? ""),
      amount: BigInt(raw.n ?? ""),
      kind: raw.k as InvoiceKind,
      token: raw.t as TokenKind,
      salt: fromHex(raw.s ?? ""),
      owner: fromHex(raw.o ?? ""),
      expiresAt: BigInt(raw.e ?? ""),
    };
    assertInvoiceTerms(terms);
    fromHex(raw.a ?? "");
    const payoutEncryptionKey = fromHex(raw.x ?? "");
    checkBytes32(payoutEncryptionKey, "payoutEncryptionKey");
    return { terms, contractAddress: raw.a ?? "", payoutEncryptionKey };
  } catch {
    return undefined;
  }
};

interface RefundCodePayload {
  v: 4;
  k: string;
  r: string;
  /** The refund key's encryption public key. */
  x: string;
  i: string;
  /** What the payer paid, in the smallest unit of the asset they paid. */
  a: string;
}

/** A refund code read back: the payment's secrets and what was paid. */
export interface DecodedRefundCode extends PaymentSecrets {
  /**
   * What the payer paid, in the asset they paid. An invoice priced in one asset and paid in the
   * other is refunded in this amount, which the merchant cannot work out alone.
   */
  readonly paidAmount: bigint;
}

/**
 * Encode what a payer hands the merchant to ask for a refund. It names the
 * payment privately; the merchant still needs the owner secret to act on it.
 *
 * @param payment - The payment's secrets, including the key a refund is encrypted to.
 * @param paidAmount - What the payer paid, in the asset they paid.
 * @returns The refund code.
 */
export const encodeRefundCode = (payment: PaymentSecrets, paidAmount: bigint): string => {
  checkBytes32(payment.payerKey, "payerKey");
  checkBytes32(payment.refundTo, "refundTo");
  checkBytes32(payment.refundEnc, "refundEnc");
  checkUint(payment.index, UINT32_MAX, "index");
  checkUint(paidAmount, UINT64_MAX, "paidAmount");
  const payload: RefundCodePayload = {
    v: 4,
    k: toHex(payment.payerKey),
    r: toHex(payment.refundTo),
    x: toHex(payment.refundEnc),
    i: payment.index.toString(10),
    a: paidAmount.toString(10),
  };
  return encodeLinkPayload(payload);
};

/**
 * Decode a refund code produced by {@link encodeRefundCode}. Codes from before the receipt
 * bound the encryption key name a payment this contract does not hold, so they are refused.
 *
 * @param code - The refund code.
 * @returns The payment's secrets and what was paid, or `undefined` when malformed.
 */
export const decodeRefundCode = (code: string): DecodedRefundCode | undefined => {
  const raw = decodeLinkPayload(code) as Partial<RefundCodePayload> | undefined;
  if (raw?.v !== 4 || !/^\d+$/.test(raw.i ?? "") || !/^\d+$/.test(raw.a ?? "")) return undefined;
  try {
    const index = BigInt(raw.i ?? "");
    checkUint(index, UINT32_MAX, "index");
    const paidAmount = BigInt(raw.a ?? "");
    checkUint(paidAmount, UINT64_MAX, "paidAmount");
    const payment = {
      payerKey: fromHex(raw.k ?? ""),
      refundTo: fromHex(raw.r ?? ""),
      refundEnc: fromHex(raw.x ?? ""),
      index,
    };
    checkBytes32(payment.payerKey, "payerKey");
    checkBytes32(payment.refundTo, "refundTo");
    checkBytes32(payment.refundEnc, "refundEnc");
    return { ...payment, paidAmount };
  } catch {
    return undefined;
  }
};

// The payments layer: invoices, payment links, tags and plain private
// transfers, on top of the kinko_pay and kinko_tags contracts.
//
// Every commitment, nullifier, receipt and tag check comes from the contracts'
// own compiled pure circuits, exported by @kinko/kinko-pay. Nothing here
// re-implements a hash in TypeScript.

import {
  decodeLinkPayload,
  decodePaymentLink,
  emptyPayPrivateState,
  encodeLinkPayload,
  encodePaymentLink,
  type InvoiceTerms,
  KinkoPay,
  KinkoTags,
  newInvoiceSecrets,
  newPaymentSecrets,
  normaliseTag,
  ownerTagOf,
  type PaymentSecrets,
  receiptOf,
  type ResolvedTag,
  resolveTag,
} from "@kinko/kinko-pay";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";

import { NETWORK_ID } from "./config.ts";
import { fromHex, toHex } from "./format.ts";
import { callCircuit, type CallResult, type CallStage } from "./midnight/contracts.ts";
import { type Account, queryContractData } from "./midnight/providers.ts";
import type { PaymentQuote } from "./quote.ts";
import type { InvoiceKindName } from "./records.ts";

/** The contract's invoice kind for each kind name. */
export const KIND_OF: Record<InvoiceKindName, KinkoPay.InvoiceKind> = {
  standard: KinkoPay.InvoiceKind.STANDARD,
  multipay: KinkoPay.InvoiceKind.MULTIPAY,
  donation: KinkoPay.InvoiceKind.DONATION,
};

/**
 * The name of a contract invoice kind.
 *
 * @param k - The contract's invoice kind.
 * @returns Its name.
 */
export const KIND_NAME = (k: KinkoPay.InvoiceKind): InvoiceKindName => {
  if (k === KinkoPay.InvoiceKind.MULTIPAY) return "multipay";
  if (k === KinkoPay.InvoiceKind.DONATION) return "donation";
  return "standard";
};

/** Words a payer sees with a link: a title and a note. Never part of the commitment. */
export interface LinkMeta {
  readonly title?: string;
  readonly memo?: string;
}

const TITLE_MAX = 80;
const MEMO_MAX = 200;

const trimmedOrUndefined = (text: string | undefined, max: number): string | undefined => {
  const t = text?.slice(0, max);
  return t === "" ? undefined : t;
};

/**
 * A full payment link, with the terms in the fragment, which browsers never send to a server.
 *
 * @param path - The page the link opens: the in-app payer or the hosted checkout.
 * @param terms - The invoice terms.
 * @param payAddress - The kinko_pay contract address.
 * @param meta - The title and note shown to the payer.
 * @param payoutEncryptionKey - The payout wallet's encryption public key, which
 *   the payer's wallet encrypts the forwarded coin to.
 * @param origin - The site the link points at; this one by default.
 * @returns The link.
 */
export function paymentUrl(
  path: "/pay" | "/checkout",
  terms: InvoiceTerms,
  payAddress: string,
  meta: LinkMeta,
  payoutEncryptionKey: Uint8Array,
  origin = window.location.origin,
): string {
  const cleanMeta = {
    t: trimmedOrUndefined(meta.title, TITLE_MAX),
    m: trimmedOrUndefined(meta.memo, MEMO_MAX),
  };
  const metaPart =
    cleanMeta.t !== undefined || cleanMeta.m !== undefined
      ? `~${encodeLinkPayload(cleanMeta)}`
      : "";
  return `${origin}${path}#${encodePaymentLink(terms, payAddress, payoutEncryptionKey)}${metaPart}`;
}

/** A payment link read back: its terms, contract and words for the payer. */
export interface ParsedLink {
  readonly terms: InvoiceTerms;
  readonly contractAddress: string;
  readonly meta: LinkMeta;
  /** Absent on links made before links carried it; such a link cannot be paid. */
  readonly payoutEncryptionKey?: Uint8Array;
}

/**
 * Read a payment link, a bare fragment, or a pasted URL.
 *
 * @param text - The link or fragment.
 * @returns The link's contents, or null when it is not a valid payment link.
 */
export function parsePaymentLink(text: string): ParsedLink | null {
  const fragment = text.includes("#") ? text.slice(text.indexOf("#") + 1) : text.trim();
  const [termsPart = "", metaPart] = fragment.split("~");
  const decoded = decodePaymentLink(termsPart);
  if (!decoded) return null;
  const rawMeta = metaPart
    ? (decodeLinkPayload(metaPart) as { t?: unknown; m?: unknown } | undefined)
    : undefined;
  const meta: LinkMeta = {
    title: typeof rawMeta?.t === "string" ? trimmedOrUndefined(rawMeta.t, TITLE_MAX) : undefined,
    memo: typeof rawMeta?.m === "string" ? trimmedOrUndefined(rawMeta.m, MEMO_MAX) : undefined,
  };
  return { ...decoded, meta };
}

/**
 * The bech32m shielded address for a pair of receiving keys on this network.
 *
 * @param coinPublicKey - The zswap coin public key.
 * @param encryptionPublicKey - The matching encryption public key.
 * @returns The address.
 */
export function shieldedAddressOf(
  coinPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
): string {
  const address = new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(coinPublicKey)),
    new ShieldedEncryptionPublicKey(Buffer.from(encryptionPublicKey)),
  );
  return MidnightBech32m.encode(NETWORK_ID, address).asString();
}

/**
 * Read a typed shielded address, checking it belongs to this network.
 *
 * @param text - What the person typed.
 * @returns Its keys as hex, or null when it is not a shielded address on this network.
 */
export function parseShieldedAddress(
  text: string,
): { coinPublicKey: string; encryptionPublicKey: string } | null {
  try {
    const address = MidnightBech32m.parse(text.trim()).decode(ShieldedAddress, NETWORK_ID);
    return {
      coinPublicKey: address.coinPublicKeyString(),
      encryptionPublicKey: address.encryptionPublicKeyString(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------

async function contractData(pdp: PublicDataProvider, address: string) {
  const data = await queryContractData(pdp, address);
  if (!data) throw new Error("The contract was not found on this network. Is its address right?");
  return data;
}

/**
 * Read kinko_pay's public ledger.
 *
 * @param pdp - Where to read the chain.
 * @param address - The contract address.
 * @returns The decoded ledger.
 * @throws {Error} When no contract exists at the address.
 */
export async function readPayLedger(
  pdp: PublicDataProvider,
  address: string,
): Promise<KinkoPay.Ledger> {
  return KinkoPay.ledger(await contractData(pdp, address));
}

/**
 * Read the tag registry's public ledger.
 *
 * @param pdp - Where to read the chain.
 * @param address - The contract address.
 * @returns The decoded ledger.
 * @throws {Error} When no contract exists at the address.
 */
export async function readTagsLedger(
  pdp: PublicDataProvider,
  address: string,
): Promise<KinkoTags.Ledger> {
  return KinkoTags.ledger(await contractData(pdp, address));
}

/** An invoice's public status, in words. */
export type InvoiceStatusName = "open" | "settled" | "cancelled" | "unknown";

/** Everything the ledger says about one invoice. Never an amount or a party. */
export interface InvoiceView {
  readonly status: InvoiceStatusName;
  readonly contributions: number;
  readonly expiresAt: bigint;
  readonly kind: InvoiceKindName;
}

const STATUS_NAME: Record<number, InvoiceStatusName> = {
  [KinkoPay.InvoiceStatus.OPEN]: "open",
  [KinkoPay.InvoiceStatus.SETTLED]: "settled",
  [KinkoPay.InvoiceStatus.CANCELLED]: "cancelled",
};

/**
 * The public state of one invoice.
 *
 * @param ledger - kinko_pay's ledger.
 * @param commitmentHex - The invoice's commitment.
 * @returns Its state, or null when no invoice has that commitment.
 */
export function invoiceView(ledger: KinkoPay.Ledger, commitmentHex: string): InvoiceView | null {
  const key = fromHex(commitmentHex);
  if (!ledger.invoices.member(key)) return null;
  const s = ledger.invoices.lookup(key);
  return {
    status: STATUS_NAME[s.status] ?? "unknown",
    contributions: Number(s.contributions),
    expiresAt: s.expires_at,
    kind: KIND_NAME(s.kind),
  };
}

/**
 * Whether an invoice on the ledger is the one a merchant's file describes: the same owner tag, which
 * the commitment already binds, and the same expiry, which it does not. A different owner cannot
 * reach the same commitment, so what this can still catch is an invoice published with another
 * expiry than the file records.
 *
 * @param ledger - kinko_pay's ledger.
 * @param commitmentHex - The invoice's commitment.
 * @param ownerSecret - The owner secret the merchant holds for it.
 * @param expiresAt - The expiry the merchant's terms name, in seconds.
 * @returns "absent" when nothing is published, "own" when it is the merchant's, else "taken".
 */
export function invoiceOwnership(
  ledger: KinkoPay.Ledger,
  commitmentHex: string,
  ownerSecret: Uint8Array,
  expiresAt: bigint,
): "absent" | "own" | "taken" {
  const key = fromHex(commitmentHex);
  if (!ledger.invoices.member(key)) return "absent";
  const state = ledger.invoices.lookup(key);
  const tag = KinkoPay.pureCircuits.owner_tag(ownerSecret);
  const sameOwner = toHex(state.owner) === toHex(tag);
  return sameOwner && state.expires_at === expiresAt ? "own" : "taken";
}

/**
 * Whether a receipt is on the ledger.
 *
 * @param ledger - kinko_pay's ledger.
 * @param receiptHex - The receipt digest.
 * @returns True when the payment it names happened.
 */
export const receiptExists = (ledger: KinkoPay.Ledger, receiptHex: string): boolean =>
  ledger.receipts.member(fromHex(receiptHex));

/**
 * Whether a payment was refunded.
 *
 * @param ledger - kinko_pay's ledger.
 * @param refundTagHex - The payment's refund tag.
 * @returns True when it was refunded.
 */
export const receiptRefunded = (ledger: KinkoPay.Ledger, refundTagHex: string): boolean =>
  ledger.refunded.member(fromHex(refundTagHex));

/**
 * Resolve a typed tag against the registry.
 *
 * @param pdp - Where to read the chain.
 * @param tagsAddress - The tag registry's address.
 * @param input - The typed name, with or without "@".
 * @returns The tag's receiving keys, or null when it is invalid or unregistered.
 */
export async function lookupTag(
  pdp: PublicDataProvider,
  tagsAddress: string,
  input: string,
): Promise<ResolvedTag | null> {
  if (!normaliseTag(input).ok) return null;
  return resolveTag(await readTagsLedger(pdp, tagsAddress), input) ?? null;
}

// ---------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------

/** What a merchant asks for in a new invoice. */
export interface InvoiceRequest {
  readonly account: Account;
  readonly payAddress: string;
  readonly merchantKey: Uint8Array;
  readonly amount: bigint;
  readonly kind: InvoiceKindName;
  readonly expiresAt: bigint;
  readonly onStage?: (s: CallStage) => void;
}

/** A created invoice: its terms, the owner secret that controls it, and where it landed. */
export interface NewInvoice {
  readonly terms: InvoiceTerms;
  readonly ownerSecret: Uint8Array;
  readonly commitment: string;
  readonly txId: string;
}

/**
 * Create an invoice payable to the connected account, in KUSD.
 *
 * @param p - The account, the contract and the invoice's terms.
 * @returns The terms, the fresh owner secret and the commitment now on chain.
 */
export async function createInvoice(p: InvoiceRequest): Promise<NewInvoice> {
  const { salt, ownerSecret } = newInvoiceSecrets();
  const terms: InvoiceTerms = {
    merchantKey: p.merchantKey,
    payout: fromHex(p.account.coinPublicKey),
    amount: p.amount,
    kind: KIND_OF[p.kind],
    token: KinkoPay.TokenKind.KUSD,
    salt,
    owner: ownerTagOf(ownerSecret),
    expiresAt: p.expiresAt,
  };
  const { commitment, txId } = await publishInvoice({
    account: p.account,
    payAddress: p.payAddress,
    terms,
    ownerSecret,
    onStage: p.onStage,
  });
  return { terms, ownerSecret, commitment, txId };
}

/** What publishing an invoice whose terms already exist needs. */
export interface PublishRequest {
  readonly account: Account;
  readonly payAddress: string;
  readonly terms: InvoiceTerms;
  readonly ownerSecret: Uint8Array;
  readonly onStage?: (s: CallStage) => void;
}

/**
 * Put an invoice on chain from its terms and owner secret: the step every
 * invoice needs, whether this app drew the secrets or the SDK, the CLI or the
 * MCP server did.
 *
 * @param p - The account that signs, the contract, the terms and the owner secret.
 * @returns The commitment now on chain and the transaction.
 */
export async function publishInvoice(
  p: PublishRequest,
): Promise<{ commitment: string; txId: string }> {
  const state = {
    ...emptyPayPrivateState(),
    merchantKey: p.terms.merchantKey,
    merchantPayout: { bytes: p.terms.payout },
    salt: p.terms.salt,
    amount: p.terms.amount,
    ownerSecret: p.ownerSecret,
  };
  const { txId, result } = await callCircuit<Uint8Array>(
    p.account,
    "pay",
    p.payAddress,
    state,
    "create_invoice",
    [p.terms.kind, p.terms.token, p.terms.expiresAt],
    p.onStage,
  );
  return { commitment: toHex(result), txId };
}

/**
 * The sealed KUSD colour a payment's coin must carry, read from kinko_pay.
 *
 * @param ledger - kinko_pay's ledger.
 * @returns The colour.
 */
export const kusdColorOf = (ledger: KinkoPay.Ledger): Uint8Array => ledger.kusd_color;

/** The least time a NIGHT price must have left when a payment starts. */
const QUOTE_MARGIN_SECONDS = 300n;

/** What paying an invoice needs. */
export interface PaymentRequest {
  readonly account: Account;
  readonly payAddress: string;
  readonly terms: InvoiceTerms;
  /** The payout wallet's encryption public key, from the payment link. */
  readonly payoutEncryptionKey: Uint8Array;
  readonly kusdColor: Uint8Array;
  /** For an invoice priced in NIGHT: the oracle's signed KUSD price, fetched just before paying. */
  readonly quote?: PaymentQuote;
  readonly index?: bigint;
  readonly onStage?: (s: CallStage) => void;
}

/** A paid invoice: the public receipt and the payer's secrets for proving or refunding it. */
export interface PaidInvoice {
  readonly receipt: string;
  readonly payerKey: string;
  readonly refundTo: string;
  /** The encryption key a refund of this payment is encrypted to, bound into the receipt. */
  readonly refundEnc: string;
  readonly index: bigint;
  readonly txId: string;
  /** KUSD handed over: the invoice amount, or its converted price for a NIGHT invoice. */
  readonly paid: bigint;
}

/**
 * Pay an invoice from the connected account's KUSD.
 *
 * @param p - The account, the contract, the terms and the sealed KUSD colour.
 * @returns The receipt and the payer's per-payment secrets.
 */
export async function payInvoice(p: PaymentRequest): Promise<PaidInvoice> {
  const payment = newPaymentSecrets(
    fromHex(p.account.coinPublicKey),
    fromHex(p.account.encryptionPublicKey),
    p.index ?? 0n,
  );
  const state = {
    ...emptyPayPrivateState(),
    merchantKey: p.terms.merchantKey,
    merchantPayout: { bytes: p.terms.payout },
    salt: p.terms.salt,
    amount: p.terms.amount,
    // The commitment is bound to the invoice's public owner tag, which the link carries.
    invoiceOwner: p.terms.owner,
    payerKey: payment.payerKey,
    payerRefund: { bytes: payment.refundTo },
    payerRefundEnc: payment.refundEnc,
    paymentIndex: payment.index,
  };
  // An invoice priced in NIGHT is paid in KUSD at the oracle's signed rate: no shielded NIGHT
  // coin exists to pay it in its own asset.
  const converted = p.terms.token === KinkoPay.TokenKind.NATIVE;
  if (converted && !p.quote)
    throw new Error("This invoice is priced in NIGHT and needs a fresh price.");
  // Proving takes minutes on a slow device, and the contract refuses a quote that has lapsed by
  // the time the payment lands, after the fee is spent. Start only with time to spare.
  if (
    converted &&
    p.quote &&
    p.quote.expiresAt - BigInt(Math.floor(Date.now() / 1000)) < QUOTE_MARGIN_SECONDS
  ) {
    throw new Error("The NIGHT price is about to expire. Pay again for a fresh price.");
  }
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: p.kusdColor,
    value: converted && p.quote ? p.quote.convertedAmount : p.terms.amount,
  };
  const encryption = new Map([[toHex(p.terms.payout), toHex(p.payoutEncryptionKey)]]);
  const { txId, result } =
    converted && p.quote
      ? await callCircuit<Uint8Array>(
          p.account,
          "pay",
          p.payAddress,
          { ...state, convertedAmount: p.quote.convertedAmount },
          "settle_invoice_converted",
          [
            p.terms.kind,
            KinkoPay.TokenKind.NATIVE,
            KinkoPay.TokenKind.KUSD,
            coin,
            p.quote.expiresAt,
            p.quote.signature,
          ],
          p.onStage,
          encryption,
        )
      : await callCircuit<Uint8Array>(
          p.account,
          "pay",
          p.payAddress,
          state,
          "settle_invoice",
          [p.terms.kind, p.terms.token, coin],
          p.onStage,
          encryption,
        );
  return {
    receipt: toHex(result),
    payerKey: toHex(payment.payerKey),
    refundTo: toHex(payment.refundTo),
    refundEnc: toHex(payment.refundEnc),
    index: payment.index,
    txId,
    paid: coin.value,
  };
}

const ownerState = (terms: InvoiceTerms, ownerSecret: Uint8Array) => ({
  ...emptyPayPrivateState(),
  merchantKey: terms.merchantKey,
  merchantPayout: { bytes: terms.payout },
  salt: terms.salt,
  amount: terms.amount,
  ownerSecret,
});

/** What an invoice owner's actions need. */
export interface OwnerAction {
  readonly account: Account;
  readonly payAddress: string;
  readonly terms: InvoiceTerms;
  readonly ownerSecret: Uint8Array;
  readonly onStage?: (s: CallStage) => void;
}

/**
 * Cancel an invoice nobody has paid.
 *
 * @param p - The account, the contract, the terms and the owner secret.
 * @returns The confirmed call.
 */
export async function cancelInvoice(p: OwnerAction): Promise<CallResult> {
  return callCircuit(
    p.account,
    "pay",
    p.payAddress,
    ownerState(p.terms, p.ownerSecret),
    "cancel_invoice",
    [p.terms.kind, p.terms.token],
    p.onStage,
  );
}

/**
 * Close a multi-payer or donation invoice to new payments.
 *
 * @param p - The account, the contract, the terms and the owner secret.
 * @returns The confirmed call.
 */
export async function closeInvoice(p: OwnerAction): Promise<CallResult> {
  return callCircuit(
    p.account,
    "pay",
    p.payAddress,
    ownerState(p.terms, p.ownerSecret),
    "close_invoice",
    [p.terms.kind, p.terms.token],
    p.onStage,
  );
}

/** What refunding one payment needs, on top of the owner's secret. */
export interface RefundRequest extends OwnerAction {
  readonly payment: PaymentSecrets;
  readonly kusdColor: Uint8Array;
}

/**
 * Refund one payment, named by the payer's refund code. The coin goes to the payer's refund key.
 *
 * @param p - The owner action plus the payment's secrets and the KUSD colour.
 * @returns The confirmed call, whose result is the refund tag.
 */
export async function refundPayment(p: RefundRequest): Promise<CallResult<Uint8Array>> {
  const state = {
    ...ownerState(p.terms, p.ownerSecret),
    payerKey: p.payment.payerKey,
    payerRefund: { bytes: p.payment.refundTo },
    payerRefundEnc: p.payment.refundEnc,
    paymentIndex: p.payment.index,
  };
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: p.kusdColor,
    value: p.terms.amount,
  };
  return callCircuit<Uint8Array>(
    p.account,
    "pay",
    p.payAddress,
    state,
    "refund_payment",
    [p.terms.kind, p.terms.token, coin],
    p.onStage,
    new Map([[toHex(p.payment.refundTo), toHex(p.payment.refundEnc)]]),
  );
}

/** What refunding a converted payment needs, on top of the owner's secret. */
export interface ConvertedRefundRequest extends RefundRequest {
  /** What the payer paid, from the refund code, in the asset they paid. */
  readonly paidAmount: bigint;
}

/**
 * Refund a payment an invoice priced in NIGHT received in KUSD, in the KUSD that was paid. The
 * invoice's own asset was never held, so the plain refund cannot return it.
 *
 * @param p - The owner action, the payment's secrets and what was paid.
 * @returns The confirmed call, whose result is the refund tag.
 */
export async function refundConvertedPayment(
  p: ConvertedRefundRequest,
): Promise<CallResult<Uint8Array>> {
  const state = {
    ...ownerState(p.terms, p.ownerSecret),
    payerKey: p.payment.payerKey,
    payerRefund: { bytes: p.payment.refundTo },
    payerRefundEnc: p.payment.refundEnc,
    paymentIndex: p.payment.index,
    convertedAmount: p.paidAmount,
  };
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: p.kusdColor,
    value: p.paidAmount,
  };
  return callCircuit<Uint8Array>(
    p.account,
    "pay",
    p.payAddress,
    state,
    "refund_converted",
    [p.terms.kind, p.terms.token, KinkoPay.TokenKind.KUSD, coin],
    p.onStage,
    new Map([[toHex(p.payment.refundTo), toHex(p.payment.refundEnc)]]),
  );
}

/** The stored fields an invoice's terms are rebuilt from. */
export interface StoredTerms {
  readonly merchantKey: string;
  readonly payout: string;
  readonly amount: string;
  readonly kind: InvoiceKindName;
  readonly token?: "KUSD" | "NATIVE";
  readonly salt: string;
  /** The invoice's owner secret, from which its public owner tag is derived. */
  readonly ownerSecret: string;
  readonly expiresAt: string;
}

/**
 * The contract-side terms of an invoice this account issued.
 *
 * @param r - The invoice as stored in the records.
 * @returns Its terms.
 */
export const termsOfRecord = (r: StoredTerms): InvoiceTerms => ({
  merchantKey: fromHex(r.merchantKey),
  payout: fromHex(r.payout),
  amount: BigInt(r.amount),
  kind: KIND_OF[r.kind],
  token: r.token === "NATIVE" ? KinkoPay.TokenKind.NATIVE : KinkoPay.TokenKind.KUSD,
  salt: fromHex(r.salt),
  owner: ownerTagOf(fromHex(r.ownerSecret)),
  expiresAt: BigInt(r.expiresAt),
});

/**
 * Recompute a receipt from what its holder kept, with the compiled circuit.
 *
 * @param commitmentHex - The invoice commitment.
 * @param kind - The invoice kind.
 * @param payerKeyHex - The payer's per-payment key.
 * @param refundToHex - The payer's refund key.
 * @param refundEncHex - The encryption key a refund is encrypted to.
 * @param index - The payment index.
 * @returns The receipt digest.
 */
export function receiptFrom(
  commitmentHex: string,
  kind: InvoiceKindName,
  payerKeyHex: string,
  refundToHex: string,
  refundEncHex: string,
  index: bigint,
): string {
  return toHex(
    receiptOf(fromHex(commitmentHex), KIND_OF[kind], {
      payerKey: fromHex(payerKeyHex),
      refundTo: fromHex(refundToHex),
      refundEnc: fromHex(refundEncHex),
      index,
    }),
  );
}

/**
 * Send KUSD privately in one transaction, with one output per payee. The wallet builds, proves and signs it.
 *
 * @param account - Who pays.
 * @param kusdTokenType - KUSD's token type.
 * @param outputs - Each recipient's shielded address and amount.
 * @throws {Error} When there is nobody to pay, or the wallet refuses.
 */
export async function sendShielded(
  account: Account,
  kusdTokenType: string,
  outputs: readonly { recipient: string; value: bigint }[],
): Promise<void> {
  if (outputs.length === 0) throw new Error("There is nobody to pay.");
  const { tx } = await account.api.makeTransfer(
    outputs.map((o) => ({
      kind: "shielded" as const,
      type: kusdTokenType,
      value: o.value,
      recipient: o.recipient,
    })),
  );
  await account.api.submitTransaction(tx);
}

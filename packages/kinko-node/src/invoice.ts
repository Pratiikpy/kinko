// Building an invoice, entirely on the merchant's own machine.
//
// An invoice's amount, salt and keys are what the chain is built to keep
// private, so none of this talks to a server. The commitment and the payment
// link come from the same compiled circuits the contract uses; an invoice built
// here is the invoice the contract will recognise when the merchant's wallet
// publishes it.

import {
  decodePaymentLink,
  encodePaymentLink,
  fromHex,
  invoiceCommitmentOf,
  type InvoiceTerms,
  KinkoPay,
  newInvoiceSecrets,
  ownerTagOf,
  shieldedKeysOf,
  toHex,
} from "@kinko/kinko-pay";

import { Asset, InvoiceKind } from "./types.ts";

const KIND: Readonly<Record<InvoiceKind, KinkoPay.InvoiceKind>> = {
  [InvoiceKind.STANDARD]: KinkoPay.InvoiceKind.STANDARD,
  [InvoiceKind.MULTIPAY]: KinkoPay.InvoiceKind.MULTIPAY,
  [InvoiceKind.DONATION]: KinkoPay.InvoiceKind.DONATION,
};

const TOKEN: Readonly<Record<Asset, KinkoPay.TokenKind>> = {
  [Asset.NATIVE]: KinkoPay.TokenKind.NATIVE,
  [Asset.KUSD]: KinkoPay.TokenKind.KUSD,
};

/** The merchant's own keys. They never leave the process that holds them. */
export interface MerchantKeys {
  /** The merchant's identity key, 64 hex characters. */
  readonly merchantKey: string;
  /**
   * The shielded address the merchant is paid at (`mn_shield-addr_…`). It
   * carries the coin public key the invoice pays out to and the encryption key
   * the payer's wallet encrypts that coin to.
   */
  readonly payoutAddress: string;
}

/** What a merchant chooses for an invoice. */
export interface InvoiceParams {
  /** Base units of the asset, as a bigint or a string of digits. See `parseAmount` for decimals. */
  readonly amount: bigint | string;
  readonly kind?: InvoiceKind;
  readonly asset?: Asset;
  /** Seconds from now after which the contract refuses payment. Omit for no expiry. */
  readonly expiresInSeconds?: number;
}

/** An invoice built locally. Keep `ownerSecret` and `salt` private. */
export interface Invoice {
  /** The invoice's public identifier on the ledger. */
  readonly commitment: string;
  readonly kind: InvoiceKind;
  readonly asset: Asset;
  /** Base units, as a decimal string. */
  readonly amount: string;
  /** Block time in seconds after which settlement is refused; 0 means never. */
  readonly expiresAt: number;
  /** A payment link a payer opens to pay this invoice. The terms are in its fragment. */
  readonly paymentLink: string;
  /** Just the fragment payload, to append to another URL after `#`. */
  readonly linkPayload: string;
  /** Authorises closing, cancelling and refunding. Never put it in a link or send it anywhere. */
  readonly ownerSecret: string;
  readonly salt: string;
  readonly merchantKey: string;
  /** The payout coin public key, hex, read from the payout address. */
  readonly payoutKey: string;
  readonly payoutAddress: string;
}

/** What building a link needs to know about the deployment. */
export interface LinkContext {
  readonly contractAddress: string;
  /** When given, the network the payout address must be on. */
  readonly networkId?: string;
  /** The web app's address, without a trailing slash. */
  readonly appUrl: string;
  readonly payPath?: string;
}

const checkHex32 = (value: string, name: string): Uint8Array => {
  try {
    return fromHex(value);
  } catch (cause) {
    throw new TypeError(`${name} must be 64 hex characters`, { cause });
  }
};

/**
 * Build an invoice.
 *
 * @param keys - The merchant's keys.
 * @param params - The merchant's choices.
 * @param context - The contract and web app addresses.
 * @param nowSeconds - Current time in seconds; injectable for tests.
 * @returns The invoice, its commitment and its payment link.
 * @throws {TypeError} When the merchant key is not 64 hex characters, or the payout address is not
 *   a shielded address (on the context's network, when it names one).
 * @throws {RangeError} When the amount or expiry is out of range.
 */
export const buildInvoice = (
  keys: MerchantKeys,
  params: InvoiceParams,
  context: LinkContext,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Invoice => {
  const kind = params.kind ?? InvoiceKind.STANDARD;
  const asset = params.asset ?? Asset.KUSD;
  const amount =
    typeof params.amount === "bigint"
      ? params.amount
      : /^[0-9]+$/.test(params.amount)
        ? BigInt(params.amount)
        : -1n;
  if (amount <= 0n)
    throw new RangeError(
      "amount must be a positive whole number of base units. Use parseAmount() to convert a decimal.",
    );
  if (
    params.expiresInSeconds !== undefined &&
    (!Number.isInteger(params.expiresInSeconds) || params.expiresInSeconds < 60)
  ) {
    throw new RangeError("expiresInSeconds must be a whole number of at least 60.");
  }
  let payout;
  try {
    payout = shieldedKeysOf(keys.payoutAddress, context.networkId);
  } catch (cause) {
    throw new TypeError(
      `payoutAddress must be your wallet's shielded address: ${(cause as Error).message}`,
      { cause },
    );
  }
  const secrets = newInvoiceSecrets();
  const terms: InvoiceTerms = {
    merchantKey: checkHex32(keys.merchantKey, "merchantKey"),
    payout: payout.coinPublicKey,
    amount,
    kind: KIND[kind],
    token: TOKEN[asset],
    salt: secrets.salt,
    owner: ownerTagOf(secrets.ownerSecret),
    expiresAt:
      params.expiresInSeconds === undefined ? 0n : BigInt(nowSeconds + params.expiresInSeconds),
  };
  // Throws RangeError-style errors for an amount that does not fit in 64 bits.
  const commitment = toHex(invoiceCommitmentOf(terms));
  const linkPayload = encodePaymentLink(terms, context.contractAddress, payout.encryptionPublicKey);
  return {
    commitment,
    kind,
    asset,
    amount: amount.toString(),
    expiresAt: Number(terms.expiresAt),
    paymentLink: `${context.appUrl}${context.payPath ?? "/pay"}#${linkPayload}`,
    linkPayload,
    ownerSecret: toHex(secrets.ownerSecret),
    salt: toHex(secrets.salt),
    merchantKey: keys.merchantKey.replace(/^0x/i, "").toLowerCase(),
    payoutKey: toHex(payout.coinPublicKey),
    payoutAddress: keys.payoutAddress.trim(),
  };
};

/** What anyone holding a payment link can read from it. */
export interface DecodedLink {
  readonly contractAddress: string;
  readonly commitment: string;
  readonly kind: InvoiceKind;
  readonly asset: Asset;
  /** Base units, as a decimal string. */
  readonly amount: string;
  readonly expiresAt: number;
}

const KIND_BY_VALUE = new Map<KinkoPay.InvoiceKind, InvoiceKind>(
  Object.entries(KIND).map(([name, value]) => [value, name as InvoiceKind]),
);
const ASSET_BY_VALUE = new Map<KinkoPay.TokenKind, Asset>(
  Object.entries(TOKEN).map(([name, value]) => [value, name as Asset]),
);

/**
 * Read a payment link. Everything in it is what the payer is given, so nothing
 * secret can come out: the owner secret is never in a link.
 *
 * @param link - A full link or just its fragment payload.
 * @returns The link's public facts, or undefined when it is malformed.
 */
export const decodeInvoiceLink = (link: string): DecodedLink | undefined => {
  const decoded = decodePaymentLink(link);
  if (!decoded) return undefined;
  const kind = KIND_BY_VALUE.get(decoded.terms.kind);
  const asset = ASSET_BY_VALUE.get(decoded.terms.token);
  if (kind === undefined || asset === undefined) return undefined;
  return {
    contractAddress: decoded.contractAddress,
    commitment: toHex(invoiceCommitmentOf(decoded.terms)),
    kind,
    asset,
    amount: decoded.terms.amount.toString(),
    expiresAt: Number(decoded.terms.expiresAt),
  };
};

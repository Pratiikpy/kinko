// Gift card keys and hand-over.
//
// A card is a 32-byte secret. The secret is the entropy of a 24-word recovery
// phrase, and the card is the Midnight wallet that phrase opens: the coin is
// sent to that wallet's shielded address, so holding the secret is holding the
// money, with no contract in the middle and nothing on chain to watch. The
// derivation itself lives in @kinko/card, which every issuer, holder and test
// shares; if two of them disagreed, cards would be issued to keys nobody can
// open.

import { deriveCardKeys, walletSeed } from "@kinko/card";
import type { ZswapSecretKeys } from "@midnightntwrk/ledger-v9";

import { isBirth } from "./birth.ts";
import { decodeLinkPayload, encodeLinkPayload, fromHex, randomBytes, toHex } from "./bytes.ts";
import { pureCircuits, TokenKind } from "./managed/kinko_gift/contract/index.js";

/** A gift card as its issuer prepares it. */
export interface GiftCard {
  /** The card. Whoever holds this can spend it. Hex. */
  readonly secret: string;
  /** The asset of the coin sent to the card. */
  readonly token: TokenKind;
  /** Where the coin is sent: the coin public key derived from the secret. Hex. */
  readonly coinPublicKey: string;
  /** The encryption key the coin's output is encrypted to. Hex. */
  readonly encryptionPublicKey: string;
  /** The issuer's public id, which recipients verify the card against. Hex. */
  readonly issuerId: string;
  /** The registry commitment. Hex. */
  readonly commitment: string;
}

const keyHex = (key: unknown): string => (typeof key === "string" ? key : toHex(key as Uint8Array));

/**
 * Rebuild the spending keys for a card: the shielded keys of the wallet its
 * recovery phrase opens. Shielded keys do not depend on the network.
 *
 * @param secret - The card secret, 32 bytes of hex.
 * @returns The zswap secret keys the card's coin is spendable with.
 * @throws {Error} When the secret is not 32 bytes of hex, so no coin is ever
 *   sent to a key derived from junk.
 */
export const keysForCard = (secret: string): ZswapSecretKeys => {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("A card secret is 32 bytes of hex.");
  return deriveCardKeys(walletSeed(fromHex(secret)), "undeployed").shieldedSecretKeys;
};

/**
 * The coin public key a card's coin is sent to.
 *
 * @param secret - The card secret, hex.
 * @returns The key, hex.
 */
export const coinPublicKeyForCard = (secret: string): string =>
  keyHex(keysForCard(secret).coinPublicKey);

/**
 * The encryption public key a card's coin output is encrypted to.
 *
 * @param secret - The card secret, hex.
 * @returns The key, hex.
 */
export const encryptionPublicKeyForCard = (secret: string): string =>
  keyHex(keysForCard(secret).encryptionPublicKey);

/**
 * The issuer's public id for an issuer secret, from the compiled circuit.
 *
 * @param issuerSecret - The issuer's secret.
 * @returns The id recipients verify cards against.
 */
export const issuerIdOf = (issuerSecret: Uint8Array): Uint8Array =>
  pureCircuits.issuer_id(issuerSecret);

/**
 * The registry commitment for a card, from the compiled circuit. A recipient
 * recomputes it from the card and checks card_issued.
 *
 * @param issuerId - The issuer's public id.
 * @param token - The card's asset.
 * @param secret - The card secret, hex.
 * @returns The commitment.
 */
export const giftCommitmentOf = (
  issuerId: Uint8Array,
  token: TokenKind,
  secret: string,
): Uint8Array => pureCircuits.card_commitment(issuerId, token, fromHex(secret));

/**
 * Prepare a new card: draw its secret and derive everything the issuer needs
 * to fund and register it.
 *
 * @param issuerSecret - The issuer's secret.
 * @param token - The asset the card will hold. KUSD unless stated otherwise.
 * @returns The card.
 */
export const createGiftCard = (
  issuerSecret: Uint8Array,
  token: TokenKind = TokenKind.KUSD,
): GiftCard => {
  const secret = toHex(randomBytes());
  const issuerId = issuerIdOf(issuerSecret);
  return {
    secret,
    token,
    coinPublicKey: coinPublicKeyForCard(secret),
    encryptionPublicKey: encryptionPublicKeyForCard(secret),
    issuerId: toHex(issuerId),
    commitment: toHex(giftCommitmentOf(issuerId, token, secret)),
  };
};

/** What a recipient receives: enough to verify and redeem, nothing else. */
export interface ReceivedCard {
  readonly secret: string;
  readonly token: TokenKind;
  readonly issuerId: string;
  readonly contractAddress?: string;
  /** Where on the chain the card was made, when its issuer stamped it. */
  readonly birth?: string;
}

/**
 * Encode a card for handing over: a link, a QR code, a printed slip.
 *
 * The secret is the value, so this string is cash. It belongs in a URL
 * fragment, which browsers never transmit to a server.
 *
 * @param card - The card.
 * @param contractAddress - The kinko_gift contract address, hex.
 * @param birth - Where on the chain the card was made, from the snapshot service.
 * @returns The card payload.
 * @throws {Error} When the birth is not well-formed.
 */
export const encodeGiftCard = (
  card: Pick<GiftCard, "secret" | "token" | "issuerId">,
  contractAddress?: string,
  birth?: string,
): string => {
  if (birth !== undefined && !isBirth(birth)) throw new Error("A card's birth is malformed.");
  return encodeLinkPayload({
    v: 2,
    s: card.secret,
    t: card.token,
    i: card.issuerId,
    a: contractAddress,
    b: birth,
  });
};

/**
 * Decode a card produced by {@link encodeGiftCard}.
 *
 * @param encoded - The payload, or a full link carrying it in its fragment.
 * @returns The card, or `undefined` when malformed.
 */
export const decodeGiftCard = (encoded: string): ReceivedCard | undefined => {
  const raw = decodeLinkPayload(encoded) as
    { v?: number; s?: unknown; t?: unknown; i?: unknown; a?: unknown; b?: unknown } | undefined;
  // Version 1 cards seeded their keys directly from the secret; they are not wallets and no
  // longer open.
  if (raw?.v !== 2) return undefined;
  const hex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  if (!hex32(raw.s) || !hex32(raw.i)) return undefined;
  if (raw.t !== TokenKind.NATIVE && raw.t !== TokenKind.KUSD) return undefined;
  if (raw.a !== undefined && !hex32(raw.a)) return undefined;
  // A birth that is not well-formed is dropped, not refused: the card still opens, from the start.
  return {
    secret: raw.s,
    token: raw.t,
    issuerId: raw.i,
    contractAddress: raw.a,
    ...(isBirth(raw.b) ? { birth: raw.b } : {}),
  };
};

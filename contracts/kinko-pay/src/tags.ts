// Off-chain helpers for kinko_tags: turning what a person types into the
// 32-byte tag the contract stores, and resolving a tag from ledger state.
//
// Normalisation (dropping "@", lowercasing, padding) is string handling, which
// a circuit cannot do. Whether the result is acceptable is decided by the
// compiled tag_is_canonical circuit, the same check register_tag enforces, so
// the app can never accept a name the contract would refuse or the reverse.

import { BYTES32, toHex } from "./bytes.ts";
import { type Ledger, pureCircuits, type TagRecord } from "./managed/kinko_tags/contract/index.js";

/** Shortest tag the contract accepts, in characters. */
export const TAG_MIN_LENGTH = 3;

/** Longest tag the contract accepts, in characters. */
export const TAG_MAX_LENGTH = 20;

/** Why a typed name was refused. */
export type TagError = "empty" | "invalid";

/** A normalised tag, or why the input cannot be one. */
export type NormalisedTag =
  | { readonly ok: true; readonly name: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: TagError };

/**
 * Normalise what a person typed into a tag.
 *
 * Surrounding whitespace and one leading "@" are dropped and letters are
 * lowercased. Anything else outside a-z, 0-9 and underscore, or a length
 * outside 3 to 20, is refused rather than silently rewritten, so "@Al ice"
 * never quietly becomes somebody else's "alice".
 *
 * @param input - The typed name, with or without "@".
 * @returns The canonical name and its 32 bytes, or the reason it was refused.
 */
export const normaliseTag = (input: string): NormalisedTag => {
  const name = input.trim().replace(/^@/, "").toLowerCase();
  if (name.length === 0) return { ok: false, error: "empty" };
  // ASCII only: a non-ASCII letter would encode to several bytes the circuit
  // then refuses, and lowercasing it could change its length first.
  if (!/^[\x20-\x7e]*$/.test(name) || name.length > BYTES32) return { ok: false, error: "invalid" };
  const bytes = new Uint8Array(BYTES32);
  bytes.set(new TextEncoder().encode(name));
  if (!pureCircuits.tag_is_canonical(bytes)) return { ok: false, error: "invalid" };
  return { ok: true, name, bytes };
};

/**
 * Normalise a tag, throwing on refusal. For call sites that have already
 * validated the input in the UI.
 *
 * @param input - The typed name.
 * @returns The tag's 32 bytes.
 * @throws {Error} When the name is not a valid tag.
 */
export const tagBytes = (input: string): Uint8Array => {
  const tag = normaliseTag(input);
  if (!tag.ok) throw new Error(`"${input}" is not a valid tag (${tag.error})`);
  return tag.bytes;
};

/**
 * The display form of stored tag bytes, without the "@".
 *
 * @param bytes - The 32 stored bytes.
 * @returns The name with its zero padding removed.
 */
export const tagName = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/**
 * The owner record for a tag under a secret, from the compiled circuit. A new
 * owner computes this with their own secret and hands it to the current owner
 * for transfer_tag.
 *
 * @param tag - The tag's 32 bytes.
 * @param secret - The owner secret.
 * @returns The owner record the ledger stores.
 */
export const tagOwnerOf = (tag: Uint8Array, secret: Uint8Array): Uint8Array =>
  pureCircuits.tag_owner(tag, secret);

/** Where to pay a tag. */
export interface ResolvedTag {
  readonly name: string;
  /** The zswap coin public key a shielded coin is sent to. */
  readonly coinPublicKey: Uint8Array;
  /** The encryption public key the recipient's wallet uses to find the coin. */
  readonly encryptionPublicKey: Uint8Array;
}

/**
 * Resolve a tag against kinko_tags ledger state, as read from the indexer.
 * A read only: resolving costs no transaction and leaves nothing on chain.
 *
 * @param ledger - The contract's ledger, from the generated `ledger()` accessor.
 * @param input - The typed name, with or without "@".
 * @returns The receiving keys, or `undefined` when the name is invalid or unregistered.
 */
export const resolveTag = (ledger: Ledger, input: string): ResolvedTag | undefined => {
  const tag = normaliseTag(input);
  if (!tag.ok || !ledger.tags.member(tag.bytes)) return undefined;
  const record: TagRecord = ledger.tags.lookup(tag.bytes);
  return {
    name: tag.name,
    coinPublicKey: record.coin_pk.bytes,
    encryptionPublicKey: record.enc_pk,
  };
};

/**
 * Whether `secret` owns a registered tag, so the app can show the owner
 * controls before the owner spends a proof on them.
 *
 * @param ledger - The contract's ledger.
 * @param tag - The tag's 32 bytes.
 * @param secret - The candidate owner secret.
 * @returns Whether the stored owner record matches.
 */
export const ownsTag = (ledger: Ledger, tag: Uint8Array, secret: Uint8Array): boolean =>
  ledger.tags.member(tag) &&
  toHex(ledger.tags.lookup(tag).owner) === toHex(tagOwnerOf(tag, secret));

// SPDX-License-Identifier: Apache-2.0
//
// Off-chain cryptography for Kinko examiner disclosure.
//
// Every curve operation and every hash goes through the contract's exported pure circuits, so the
// maths here is the maths the circuits run, bit for bit. What lives only here is scalar arithmetic
// modulo the Jubjub subgroup order (Shamir sharing and Lagrange coefficients), field arithmetic
// modulo the BLS12-381 scalar field (adding and removing masks), and the text codec.

import type { JubjubPoint } from "@midnight-ntwrk/compact-runtime";

import {
  type CipherRecord,
  type CipherShare,
  type LedgerPoint,
  pureCircuits,
  type Statement,
} from "./managed/kinko_disclosure/contract/index.js";

/** Order of the Jubjub prime-order subgroup. Scalars live modulo this. */
export const JUBJUB_ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

/** BLS12-381 scalar field modulus: the Compact `Field`. */
export const FIELD_MODULUS = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

/** Mask construction this code understands; equal to the contract's `cipherVersion()`. */
export const CIPHER_VERSION = pureCircuits.cipherVersion();

/** Number of sealed slots in a record. */
export const RECORD_SLOTS = 7;

/** Largest number of records one case can name. */
export const MAX_SCOPE = 4;

/** Bytes of UTF-8 text one field carries. */
export const TEXT_FIELD_BYTES = 31;

const UINT64_MAX = (1n << 64n) - 1n;
const PACKED_LIMIT = 1n << 136n;

/** Raised when a sealed value was produced with a mask construction this code does not know. */
export class CipherVersionError extends Error {
  /**
   * @param found - The version carried by the sealed value.
   */
  constructor(readonly found: bigint) {
    super(
      `sealed value uses cipher version ${String(found)}; this code understands ${String(CIPHER_VERSION)}`,
    );
    this.name = "CipherVersionError";
  }
}

/**
 * Reduces modulo the field.
 *
 * @param x - Any integer.
 * @returns `x mod p`, in [0, p).
 */
export const modP = (x: bigint): bigint => ((x % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;

/**
 * Reduces modulo the subgroup order.
 *
 * @param x - Any integer.
 * @returns `x mod ℓ`, in [0, ℓ).
 */
export const modL = (x: bigint): bigint => ((x % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;

/**
 * Inverse modulo the subgroup order, by the extended Euclidean algorithm.
 *
 * @param a - A scalar that is non-zero modulo ℓ.
 * @returns `a⁻¹ mod ℓ`.
 * @throws {Error} When `a` is zero modulo ℓ.
 */
export function invL(a: bigint): bigint {
  let [r0, r1] = [modL(a), JUBJUB_ORDER];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error("scalar is not invertible");
  return modL(s0);
}

const bigintOf = (bytes: Uint8Array): bigint =>
  bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);

/**
 * Draws 32 bytes from the platform CSPRNG.
 *
 * @returns Fresh random bytes.
 */
export const randomBytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/**
 * Draws a uniform non-zero scalar.
 *
 * @returns A scalar in [1, ℓ).
 */
export function randomScalar(): bigint {
  for (;;) {
    const x = bigintOf(randomBytes32()) & ((1n << 252n) - 1n);
    if (x > 0n && x < JUBJUB_ORDER) return x;
  }
}

/**
 * Draws a uniform field element.
 *
 * @returns A field element in [0, p).
 */
export function randomField(): bigint {
  for (;;) {
    const x = bigintOf(randomBytes32()) & ((1n << 255n) - 1n);
    if (x < FIELD_MODULUS) return x;
  }
}

/**
 * Compares two curve points.
 *
 * @param a - First point.
 * @param b - Second point.
 * @returns Whether both coordinates are equal.
 */
export const samePoint = (a: JubjubPoint, b: JubjubPoint): boolean => a.x === b.x && a.y === b.y;

/**
 * Turns a point as stored on the ledger back into a curve point.
 *
 * @param p - The stored coordinates.
 * @returns The curve point.
 */
export const pointOf = (p: LedgerPoint): JubjubPoint => pureCircuits.pointOf(p);

/**
 * Tests for the curve identity.
 *
 * @param p - A curve point.
 * @returns Whether it is the identity.
 */
export const isIdentity = (p: JubjubPoint): boolean => samePoint(p, pureCircuits.identityPoint());

/**
 * Lagrange coefficients for interpolation at zero over the given evaluation points.
 *
 * @param xs - Distinct Shamir evaluation points (1, 2 or 3 for Kinko keyholders).
 * @returns One coefficient per point, in the same order, reduced modulo ℓ.
 * @throws {Error} When the points are not distinct.
 */
export function lagrangeAtZero(xs: readonly bigint[]): bigint[] {
  if (new Set(xs).size !== xs.length) throw new Error("Lagrange points must be distinct");
  return xs.map((xi) =>
    xs.filter((xj) => xj !== xi).reduce((acc, xj) => modL(acc * xj * invL(xj - xi)), 1n),
  );
}

// ------------------------------------------------------------------------------------------------
// Statement codec

/** A payment statement in the terms an account holder uses. */
export interface PaymentStatement {
  /** Amount in micro-dollars (six decimals). */
  readonly amount: bigint;
  /** Payment time, Unix seconds. */
  readonly time: bigint;
  readonly direction: "sent" | "received";
  /** The counterparty's account tag, as the filer knows it. */
  readonly counterparty: bigint;
  /** Invoice or receipt reference, at most 31 bytes of UTF-8. */
  readonly reference: string;
  /** Free-text memo, at most 62 bytes of UTF-8. */
  readonly memo: string;
}

function encodeTextBytes(bytes: Uint8Array, what: string): bigint {
  if (bytes.length > TEXT_FIELD_BYTES) {
    throw new Error(
      `${what} is ${String(bytes.length)} bytes; one field holds ${String(TEXT_FIELD_BYTES)}`,
    );
  }
  if (bytes.includes(0)) throw new Error(`${what} contains a NUL byte`);
  return bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

function fieldBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(TEXT_FIELD_BYTES * 8))
    throw new Error("field does not hold encoded text");
  const out: number[] = [];
  for (let rest = value; rest > 0n; rest >>= 8n) out.push(Number(rest & 0xffn));
  return Uint8Array.from(out);
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes up to 31 bytes of UTF-8 text as one field element, little-endian.
 *
 * @param text - The text.
 * @returns The field element.
 * @throws {Error} When the text is longer than 31 bytes or contains NUL, which cannot round-trip.
 */
export const encodeText = (text: string): bigint =>
  encodeTextBytes(new TextEncoder().encode(text), "text");

/**
 * Decodes a field element produced by {@link encodeText}.
 *
 * @param value - The field element.
 * @returns The text.
 * @throws {Error} When the value is not encoded UTF-8 text.
 */
export const decodeText = (value: bigint): string => strictDecoder.decode(fieldBytes(value));

/**
 * Splits a memo across two fields.
 *
 * @param memo - At most 62 bytes of UTF-8.
 * @returns The two fields.
 * @throws {Error} When the memo is too long or contains NUL.
 */
export function encodeMemo(memo: string): [bigint, bigint] {
  const bytes = new TextEncoder().encode(memo);
  if (bytes.length > 2 * TEXT_FIELD_BYTES) {
    throw new Error(
      `memo is ${String(bytes.length)} bytes; a statement holds ${String(2 * TEXT_FIELD_BYTES)}`,
    );
  }
  return [
    encodeTextBytes(bytes.subarray(0, TEXT_FIELD_BYTES), "memo"),
    encodeTextBytes(bytes.subarray(TEXT_FIELD_BYTES), "memo"),
  ];
}

/**
 * Joins and decodes the two memo fields.
 *
 * @param memo - The two fields from {@link encodeMemo}.
 * @returns The memo.
 * @throws {Error} When the fields are not an encoded memo.
 */
export function decodeMemo(memo: readonly bigint[]): string {
  const [a, b] = [memo[0] ?? 0n, memo[1] ?? 0n];
  const head = fieldBytes(a);
  if (b !== 0n && head.length !== TEXT_FIELD_BYTES)
    throw new Error("memo continues after a short first field");
  return strictDecoder.decode(Uint8Array.from([...head, ...fieldBytes(b)]));
}

const requireUint64 = (name: string, value: bigint): bigint => {
  if (value < 0n || value > UINT64_MAX)
    throw new Error(`${name} does not fit Uint<64>: ${String(value)}`);
  return value;
};

/**
 * Turns a payment statement into the contract's `Statement`, drawing a fresh salt.
 *
 * @param p - The statement.
 * @param salt - Anchor salt; drawn uniformly when omitted. Supply one only to reproduce a record.
 * @returns The contract-level statement.
 * @throws {Error} When a value does not fit its slot.
 */
export function toStatement(p: PaymentStatement, salt: bigint = randomField()): Statement {
  return {
    amount: requireUint64("amount", p.amount),
    time: requireUint64("time", p.time),
    direction: p.direction === "sent" ? 0n : 1n,
    counterparty: modP(p.counterparty),
    reference: encodeText(p.reference),
    memo: encodeMemo(p.memo),
    salt: modP(salt),
  };
}

/**
 * The inverse of {@link toStatement}, for an opened record.
 *
 * @param s - The contract-level statement.
 * @returns The payment statement.
 * @throws {Error} When any slot does not decode.
 */
export function fromStatement(s: Statement): PaymentStatement {
  if (s.direction !== 0n && s.direction !== 1n) {
    throw new Error(`direction ${String(s.direction)} is neither sent nor received`);
  }
  return {
    amount: requireUint64("amount", s.amount),
    time: requireUint64("time", s.time),
    direction: s.direction === 0n ? "sent" : "received",
    counterparty: s.counterparty,
    reference: decodeText(s.reference),
    memo: decodeMemo(s.memo),
  };
}

/**
 * Inverse of the `packAmountTime` pure circuit.
 *
 * @param packed - `amount·2^72 + time·2^8 + direction`.
 * @returns The three parts.
 * @throws {Error} When the value is not a packed triple.
 */
export function unpackAmountTime(packed: bigint): {
  amount: bigint;
  time: bigint;
  direction: bigint;
} {
  if (packed < 0n || packed >= PACKED_LIMIT) throw new Error("packed amount/time is out of range");
  return { amount: packed >> 72n, time: (packed >> 8n) & UINT64_MAX, direction: packed & 0xffn };
}

// ------------------------------------------------------------------------------------------------
// Sealing and opening records

/**
 * The seven plaintext slots of a record, in slot order.
 *
 * @param filerId - The filer id, as `filerIdOf` derives it.
 * @param s - The statement.
 * @returns `[filerId, pack(amount, time, direction), counterparty, reference, memo0, memo1, salt]`.
 */
export function recordFields(filerId: bigint, s: Statement): bigint[] {
  return [
    filerId,
    pureCircuits.packAmountTime(s.amount, s.time, s.direction),
    s.counterparty,
    s.reference,
    s.memo[0] ?? 0n,
    s.memo[1] ?? 0n,
    s.salt,
  ];
}

/**
 * Adds the masks of a shared point to plaintext slots.
 *
 * @param fields - Plaintext slots.
 * @param S - The shared point.
 * @param offset - Mask index of the first slot.
 * @returns The ciphertext slots.
 */
export const sealFields = (fields: readonly bigint[], S: JubjubPoint, offset = 0): bigint[] =>
  fields.map((f, j) => modP(f + pureCircuits.maskOf(S, BigInt(j + offset))));

/**
 * Removes the masks of a shared point from ciphertext slots.
 *
 * @param ct - Ciphertext slots.
 * @param S - The shared point.
 * @param offset - Mask index of the first slot.
 * @returns The plaintext slots, or noise if `S` is the wrong point.
 */
export const openFields = (ct: readonly bigint[], S: JubjubPoint, offset = 0): bigint[] =>
  ct.map((c, j) => modP(c - pureCircuits.maskOf(S, BigInt(j + offset))));

/** Inputs that fully determine a record, exactly as `file_record` consumes them. */
export interface SealInput {
  readonly filerSecret: Uint8Array;
  readonly statement: Statement;
  readonly disclosurePk: JubjubPoint;
  /** Sealing scalar in [1, ℓ). */
  readonly ephemeral: bigint;
  /** 32-byte record nonce. */
  readonly nonce: Uint8Array;
}

/**
 * Seals a statement off chain, exactly as `file_record` does in circuit. Given the same inputs,
 * the result is the record the contract stores, under the same record id.
 *
 * @param input - Filer secret, statement, disclosure key, sealing scalar and nonce.
 * @returns The record id and the sealed record.
 */
export function sealStatement(input: SealInput): { recordId: Uint8Array; record: CipherRecord } {
  const filerId = pureCircuits.filerIdOf(input.filerSecret);
  const E = pureCircuits.pubKeyOf(input.ephemeral);
  const S = pureCircuits.mulPoint(input.disclosurePk, input.ephemeral);
  return {
    recordId: pureCircuits.recordIdOf(input.nonce, E),
    record: {
      version: CIPHER_VERSION,
      E: pureCircuits.storedPoint(E),
      ct: sealFields(recordFields(filerId, input.statement), S),
      anchor: pureCircuits.anchorOf(filerId, input.statement, E),
    },
  };
}

/** What opening a record yields, before it is checked against the anchor. */
export interface OpenedRecord {
  readonly filerId: bigint;
  readonly statement: Statement;
}

const checkVersion = (version: bigint): void => {
  if (version !== CIPHER_VERSION) throw new CipherVersionError(version);
};

/**
 * Opens a sealed record with the recovered shared point S = sk·E. Opening with any other point
 * yields field noise rather than an error; {@link verifyAnchor} is what tells the two apart.
 *
 * @param record - The sealed record.
 * @param S - The shared point.
 * @returns The filer id and statement slots, unvalidated. A packed slot that is out of range is
 *   carried whole in `amount`, where it can never match an anchor.
 * @throws {CipherVersionError} When the record uses an unknown mask construction.
 * @throws {Error} When the record does not have seven slots.
 */
export function openRecord(
  record: Pick<CipherRecord, "version" | "ct">,
  S: JubjubPoint,
): OpenedRecord {
  checkVersion(record.version);
  if (record.ct.length !== RECORD_SLOTS) {
    throw new Error(
      `a sealed record has ${String(RECORD_SLOTS)} slots, got ${String(record.ct.length)}`,
    );
  }
  const [
    filerId = 0n,
    packed = 0n,
    counterparty = 0n,
    reference = 0n,
    memo0 = 0n,
    memo1 = 0n,
    salt = 0n,
  ] = openFields(record.ct, S);
  const parts =
    packed < PACKED_LIMIT ? unpackAmountTime(packed) : { amount: packed, time: 0n, direction: 0n };
  return { filerId, statement: { ...parts, counterparty, reference, memo: [memo0, memo1], salt } };
}

/**
 * Checks an opened record against its on-chain anchor. The circuit computed the anchor from the
 * same plaintext and `E`, so a match proves this is the statement that was filed, unaltered.
 * Noise from a wrong key does not even fit the statement's types, and is reported as a mismatch.
 *
 * @param opened - The opened record.
 * @param record - The sealed record it came from.
 * @returns Whether the plaintext rehashes to the anchor.
 */
export function verifyAnchor(
  opened: OpenedRecord,
  record: Pick<CipherRecord, "E" | "anchor">,
): boolean {
  try {
    const anchor = pureCircuits.anchorOf(opened.filerId, opened.statement, pointOf(record.E));
    return anchor.length === record.anchor.length && anchor.every((b, i) => b === record.anchor[i]);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Decryption shares

/**
 * Unseals one keyholder's share for one slot of a case with the examiner scalar.
 *
 * @param share - The sealed share.
 * @param examinerScalar - The examiner's secret scalar.
 * @param slot - The scope slot (0 to 3); slot j is masked at indices 2j and 2j+1.
 * @returns The decryption share point X_i, or noise for the wrong scalar or slot.
 * @throws {CipherVersionError} When the share uses an unknown mask construction.
 */
export function openShare(share: CipherShare, examinerScalar: bigint, slot: number): JubjubPoint {
  checkVersion(share.version);
  const S2 = pureCircuits.mulPoint(pointOf(share.E2), examinerScalar);
  const [x = 0n, y = 0n] = openFields(share.ct, S2, slot * 2);
  return { x, y };
}

/** One keyholder's contribution: its Shamir evaluation point and its share point. */
export interface DecryptionShare {
  /** 1, 2 or 3. */
  readonly x: bigint;
  readonly X: JubjubPoint;
}

/**
 * Lagrange-combines decryption shares into the shared point S = Σ λ_i·X_i. Two shares of the same
 * case give S = sk·E; anything else gives an unrelated point.
 *
 * @param shares - At least one share, with distinct evaluation points.
 * @returns The combined point.
 * @throws {Error} When there are no shares, the points repeat, or a share is not on the curve.
 */
export function combineShares(shares: readonly DecryptionShare[]): JubjubPoint {
  if (shares.length === 0) throw new Error("no decryption shares to combine");
  const lambdas = lagrangeAtZero(shares.map((s) => s.x));
  return shares
    .map((s, k) => pureCircuits.mulPoint(s.X, lambdas[k] ?? 0n))
    .reduce((acc, P) => pureCircuits.addPoints(acc, P));
}

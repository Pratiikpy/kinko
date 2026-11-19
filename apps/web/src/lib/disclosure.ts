// The examiner side of Kinko: reading the disclosure contract and opening the
// records a case names. All cryptography is the disclosure package's own; this
// module only reads the ledger and shapes results for the page.

import {
  approversOf,
  type CaseDisclosure,
  decodeText,
  discloseCase,
  type DisclosureCase,
  encodeText,
  JUBJUB_ORDER,
  type Ledger,
  ledger as readLedger,
  type LogEntry,
  LogKind,
  pureCircuits,
  readLog,
  type Statement,
  toStatement,
  verifyDeployment,
} from "@kinko/kinko-disclosure";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";

import { toHex } from "./format.ts";
import { queryContractData } from "./midnight/providers.ts";

export { approversOf, discloseCase, LogKind, readLog, verifyDeployment };
export type { CaseDisclosure, DisclosureCase, LogEntry };

/**
 * Read the disclosure contract's public ledger.
 *
 * @param pdp - Where to read the chain.
 * @param address - The disclosure contract's address.
 * @returns The decoded ledger.
 * @throws {Error} When no contract exists at the address.
 */
export async function readDisclosure(pdp: PublicDataProvider, address: string): Promise<Ledger> {
  const data = await queryContractData(pdp, address);
  if (!data) throw new Error("The disclosure contract was not found on this network.");
  return readLedger(data);
}

/**
 * Every case on the ledger, in the ledger's own order.
 *
 * @param l - The disclosure ledger.
 * @returns Each case with its id as hex.
 */
export function listCases(l: Ledger): { id: string; c: DisclosureCase }[] {
  const out: { id: string; c: DisclosureCase }[] = [];
  for (const [id, c] of l.cases) out.push({ id: toHex(id), c });
  return out;
}

/**
 * Parse a scalar typed as decimal or hex (with or without 0x). Refuses zero
 * and anything outside the curve's scalar field rather than reducing it.
 *
 * @param text - What the person typed.
 * @returns The scalar, or null when the text is not one.
 */
export function parseScalar(text: string): bigint | null {
  const t = text.trim();
  if (!t) return null;
  let v: bigint | null = null;
  if (/^0x[0-9a-f]+$/i.test(t)) v = BigInt(t);
  else if (/^[0-9a-f]{64}$/i.test(t)) v = BigInt(`0x${t}`);
  else if (/^\d+$/.test(t)) v = BigInt(t);
  if (v === null || v <= 0n || v >= JUBJUB_ORDER) return null;
  return v;
}

/**
 * A scalar as 64 hex digits with a 0x prefix, the form keys are saved in.
 *
 * @param s - The scalar.
 * @returns Its hex form.
 */
export const scalarHex = (s: bigint): string => `0x${s.toString(16).padStart(64, "0")}`;

/**
 * The examiner id a scalar's public key registers under.
 *
 * @param s - The examiner scalar.
 * @returns The examiner id as hex.
 */
export const examinerIdForScalar = (s: bigint): string =>
  toHex(pureCircuits.examinerIdOf(pureCircuits.pubKeyOf(s)));

/** Plain words for each kind of disclosure log entry. */
export const LOG_TEXT: Record<number, string> = {
  [LogKind.EXAMINER_REGISTERED]: "Examiner registered",
  [LogKind.EXAMINER_REVOKED]: "Examiner revoked",
  [LogKind.CASE_OPENED]: "Case opened",
  [LogKind.CASE_APPROVED]: "Case approved",
};

/**
 * Best-effort text of an encoded field; the raw number when it is not text.
 *
 * @param v - The field element.
 * @returns Its text, or "#" and its hex when it does not decode.
 */
export function fieldText(v: bigint): string {
  if (v === 0n) return "";
  try {
    return decodeText(v);
  } catch {
    return `#${v.toString(16)}`;
  }
}

/** What a holder writes down about one payment before sealing it. */
export interface StatementInput {
  readonly amount: bigint;
  readonly time: bigint;
  readonly direction: "sent" | "received";
  readonly counterparty: string;
  readonly reference: string;
  readonly memo: string;
}

/**
 * Build the statement a holder files for one payment.
 *
 * @param p - The payment, in the holder's own terms.
 * @returns The statement the contract seals.
 */
export function statementFor(p: StatementInput): Statement {
  return toStatement({
    amount: p.amount,
    time: p.time,
    direction: p.direction,
    counterparty: p.counterparty ? encodeText(p.counterparty) : 0n,
    reference: p.reference,
    memo: p.memo,
  });
}

/**
 * The UTF-8 length of text, which is what the statement codec limits.
 *
 * @param s - The text.
 * @returns Its length in bytes.
 */
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

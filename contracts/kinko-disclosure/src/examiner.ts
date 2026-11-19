// SPDX-License-Identifier: Apache-2.0
//
// The examiner's side of a disclosure: read a case from the public ledger, unseal the two
// approving keyholders' shares, combine them, open every record in scope and check each one
// against its anchor. A record counts as disclosed only when that check passes.

import {
  combineShares,
  type DecryptionShare,
  fromStatement,
  type OpenedRecord,
  openRecord,
  openShare,
  type PaymentStatement,
  verifyAnchor,
} from "./crypto.js";
import {
  type DisclosureCase,
  type Ledger,
  type LogEntry,
  LogKind,
  pureCircuits,
} from "./managed/kinko_disclosure/contract/index.js";

/** The outcome for one record of a case. */
export type RecordDisclosure =
  | {
      readonly status: "disclosed";
      readonly recordId: Uint8Array;
      readonly filerId: bigint;
      readonly statement: PaymentStatement;
      readonly raw: OpenedRecord;
    }
  /** Fewer than two keyholders have approved; the record stays sealed. */
  | { readonly status: "sealed"; readonly recordId: Uint8Array }
  /** The shares did not open the record to its anchor: wrong key, or a share from elsewhere. */
  | { readonly status: "failed"; readonly recordId: Uint8Array; readonly reason: string };

/** What an examiner learns from one case. */
export interface CaseDisclosure {
  readonly caseId: Uint8Array;
  readonly case: DisclosureCase;
  /** Keyholder slots whose shares were used. */
  readonly approvers: readonly number[];
  readonly records: readonly RecordDisclosure[];
}

const reasonOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/**
 * Keyholder slots that approved a case, in slot order.
 *
 * @param c - The case.
 * @returns The approving slots.
 */
export const approversOf = (c: DisclosureCase): number[] =>
  c.approvals.flatMap((approved, i) => (approved ? [i] : []));

/**
 * Unseals the decryption shares that keyholder slots posted for one slot of a case.
 *
 * @param l - The ledger view.
 * @param caseId - The case.
 * @param slot - The scope slot.
 * @param keyholders - The keyholder slots to read.
 * @param examinerScalar - The examiner scalar.
 * @returns One decryption share per keyholder.
 */
export function sharesFor(
  l: Ledger,
  caseId: Uint8Array,
  slot: number,
  keyholders: readonly number[],
  examinerScalar: bigint,
): DecryptionShare[] {
  return keyholders.map((i) => ({
    x: BigInt(i + 1),
    X: openShare(
      l.shares.lookup(pureCircuits.shareKeyOf(caseId, BigInt(i), BigInt(slot))),
      examinerScalar,
      slot,
    ),
  }));
}

/**
 * Opens one record with a set of decryption shares and checks it against its anchor.
 *
 * @param l - The ledger view.
 * @param recordId - The record to open.
 * @param shares - Decryption shares for that record.
 * @returns The outcome for that record.
 */
export function openWithShares(
  l: Ledger,
  recordId: Uint8Array,
  shares: readonly DecryptionShare[],
): RecordDisclosure {
  const record = l.records.lookup(recordId);
  let opened: OpenedRecord;
  try {
    opened = openRecord(record, combineShares(shares));
  } catch (error) {
    return { status: "failed", recordId, reason: reasonOf(error, "shares do not combine") };
  }
  if (!verifyAnchor(opened, record)) {
    return { status: "failed", recordId, reason: "plaintext does not match the record anchor" };
  }
  try {
    const statement = fromStatement(opened.statement);
    return { status: "disclosed", recordId, filerId: opened.filerId, statement, raw: opened };
  } catch (error) {
    return { status: "failed", recordId, reason: reasonOf(error, "statement does not decode") };
  }
}

/**
 * Opens every record of a case the examiner holds two approvals for.
 *
 * @param l - The ledger view.
 * @param caseId - The case.
 * @param examinerScalar - The examiner scalar for the case's examiner key.
 * @returns Per-record outcomes, in scope order.
 * @throws {Error} When the case does not exist.
 */
export function discloseCase(
  l: Ledger,
  caseId: Uint8Array,
  examinerScalar: bigint,
): CaseDisclosure {
  if (!l.cases.member(caseId)) throw new Error("no such case");
  const c = l.cases.lookup(caseId);
  const approvers = approversOf(c).slice(0, 2);
  const scope = c.recordIds.slice(0, Number(c.count));
  const records = scope.map((recordId, slot): RecordDisclosure => {
    if (approvers.length < 2) return { status: "sealed", recordId };
    try {
      return openWithShares(l, recordId, sharesFor(l, caseId, slot, approvers, examinerScalar));
    } catch (error) {
      return { status: "failed", recordId, reason: reasonOf(error, "shares do not unseal") };
    }
  });
  return { caseId, case: c, approvers, records };
}

/**
 * Reads the whole public disclosure log.
 *
 * @param l - The ledger view.
 * @returns Every entry, oldest first.
 */
export function readLog(l: Ledger): LogEntry[] {
  const entries: LogEntry[] = [];
  for (let n = 0n; n < l.logLength; n++) entries.push(l.disclosureLog.lookup(n));
  return entries;
}

export { LogKind };

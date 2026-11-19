// SPDX-License-Identifier: Apache-2.0
//
// The end-to-end story: a ceremony, three filed statements, a case for two of them, two keyholder
// approvals, and an examiner that reads exactly those two, each proven against its anchor, while
// the third stays sealed. Then every way the same examiner could try to read more.

import { describe, expect, it } from "vitest";

import {
  combineShares,
  discloseCase,
  type KeyholderIndex,
  LogKind,
  openRecord,
  openShare,
  openWithShares,
  pureCircuits,
  randomBytes32,
  readLog,
  type RecordDisclosure,
  sharesFor,
  verifyAnchor,
  verifyDeployment,
} from "../src/index.ts";
import { at, DAY, Deployment, newExaminer, refusal, statementOf, T0, ZERO32 } from "./harness.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Narrows an outcome to a disclosure, failing the test with the outcome otherwise. */
function disclosed(
  r: RecordDisclosure | undefined,
): Extract<RecordDisclosure, { status: "disclosed" }> {
  if (r?.status !== "disclosed")
    throw new Error(`expected a disclosed record, got ${r?.status ?? "nothing"}`);
  return r;
}

/** Three statements from two different filers, a registered examiner, and the deployment. */
async function setup() {
  const d = await Deployment.create();
  const merchant = randomBytes32();
  const customer = randomBytes32();
  const statements = [
    statementOf({ amount: 250_000_000n, reference: "INV-1001", memo: "September retainer" }),
    statementOf({
      amount: 99_990_000n,
      direction: "received",
      reference: "RCPT-77",
      memo: "Refund, order 5521",
    }),
    statementOf({ amount: 7_500_000_000n, reference: "INV-1002", memo: "Equipment lease, Q4" }),
  ] as const;
  const filed = [
    await d.file(merchant, statements[0]),
    await d.file(customer, statements[1]),
    await d.file(merchant, statements[2]),
  ] as const;
  const examiner = newExaminer();
  await d.registerExaminer(examiner.publicKey);
  return { d, merchant, customer, statements, ids: filed.map((f) => f.recordId), examiner };
}

describe("full disclosure scenario", () => {
  it("opens exactly the two records in scope, each matching its anchor, and leaves the third sealed", async () => {
    const { d, merchant, customer, statements, ids, examiner } = await setup();
    expect(verifyDeployment(d.ledger()).ok).toBe(true);

    const scope = [at(ids, 0), at(ids, 1)];
    const { caseId } = await d.openCase(examiner, scope);

    // Before any approval the case is public and nothing opens.
    expect(discloseCase(d.ledger(), caseId, examiner.scalar).records.map((r) => r.status)).toEqual([
      "sealed",
      "sealed",
    ]);

    await d.approve(0, caseId);
    await d.approve(2, caseId);

    const result = discloseCase(d.ledger(), caseId, examiner.scalar);
    expect(result.approvers).toEqual([0, 2]);
    expect(result.records).toHaveLength(2);
    const first = disclosed(result.records[0]);
    const second = disclosed(result.records[1]);
    expect(first.statement).toEqual(statements[0]);
    expect(first.filerId).toBe(pureCircuits.filerIdOf(merchant));
    expect(second.statement).toEqual(statements[1]);
    expect(second.filerId).toBe(pureCircuits.filerIdOf(customer));
    expect(verifyAnchor(first.raw, d.ledger().records.lookup(first.recordId))).toBe(true);
    expect(verifyAnchor(second.raw, d.ledger().records.lookup(second.recordId))).toBe(true);

    // The third record was never in scope: it is in no case and no share for it exists.
    const outside = hex(at(ids, 2));
    expect(result.records.map((r) => hex(r.recordId))).not.toContain(outside);
    expect(d.ledger().shares.size()).toBe(4n);

    // The log carries every step, in order, with case id, scope hash, keyholder slot and time.
    const log = readLog(d.ledger());
    expect(log.map((e) => e.kind)).toEqual([
      LogKind.EXAMINER_REGISTERED,
      LogKind.CASE_OPENED,
      LogKind.CASE_APPROVED,
      LogKind.CASE_APPROVED,
    ]);
    const c = d.ledger().cases.lookup(caseId);
    expect(hex(c.scopeHash)).toBe(hex(pureCircuits.scopeHashOf(2n, [...scope, ZERO32, ZERO32])));
    const caseEntries = log.slice(1);
    expect(
      caseEntries.map((e) => [hex(e.caseId), hex(e.scopeHash), hex(e.examinerId), e.at]),
    ).toEqual(Array(3).fill([hex(caseId), hex(c.scopeHash), hex(examiner.id), T0]));
    expect(caseEntries.map((e) => e.keyholder)).toEqual([255n, 0n, 2n]);
  });

  const pairs: (readonly [KeyholderIndex, KeyholderIndex])[] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (const [i, j] of pairs) {
    it(`keyholders ${String(i)} and ${String(j)} together open the case`, async () => {
      const { d, statements, ids, examiner } = await setup();
      const { caseId } = await d.openCase(examiner, [at(ids, 2)]);
      await d.approve(i, caseId);
      await d.approve(j, caseId);
      expect(
        disclosed(discloseCase(d.ledger(), caseId, examiner.scalar).records[0]).statement,
      ).toEqual(statements[2]);
    });
  }

  it("a case of four opens all four on two approvals", async () => {
    const { d, ids, examiner, merchant } = await setup();
    const fourth = await d.file(merchant, statementOf({ reference: "INV-1003", memo: "" }));
    const { caseId } = await d.openCase(examiner, [...ids, fourth.recordId]);
    await d.approve(1, caseId);
    await d.approve(2, caseId);
    const statuses = discloseCase(d.ledger(), caseId, examiner.scalar).records.map((r) => r.status);
    expect(statuses).toEqual(["disclosed", "disclosed", "disclosed", "disclosed"]);
  });
});

describe("negative controls", () => {
  it("one share alone opens nothing", async () => {
    const { d, ids, examiner } = await setup();
    const scope = [at(ids, 0), at(ids, 1)];
    const { caseId } = await d.openCase(examiner, scope);
    await d.approve(1, caseId);

    expect(discloseCase(d.ledger(), caseId, examiner.scalar).records.map((r) => r.status)).toEqual([
      "sealed",
      "sealed",
    ]);
    // Forcing the issue: interpolating from one share is just that share, and it does not open.
    const forced = scope.map((recordId, slot) =>
      openWithShares(
        d.ledger(),
        recordId,
        sharesFor(d.ledger(), caseId, slot, [1], examiner.scalar),
      ),
    );
    expect(forced.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("the wrong examiner key opens nothing", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [at(ids, 0)]);
    await d.approve(0, caseId);
    await d.approve(1, caseId);

    const intruder = newExaminer();
    expect(at(discloseCase(d.ledger(), caseId, intruder.scalar).records, 0).status).toBe("failed");
    expect(at(discloseCase(d.ledger(), caseId, examiner.scalar).records, 0).status).toBe(
      "disclosed",
    );
  });

  it("shares for a record in scope decrypt nothing when applied to a record outside it", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [at(ids, 0)]);
    await d.approve(0, caseId);
    await d.approve(2, caseId);

    const shares = sharesFor(d.ledger(), caseId, 0, [0, 2], examiner.scalar);
    const outside = d.ledger().records.lookup(at(ids, 2));
    expect(verifyAnchor(openRecord(outside, combineShares(shares)), outside)).toBe(false);
    expect(openWithShares(d.ledger(), at(ids, 2), shares).status).toBe("failed");
    // The same shares do open the record they were posted for.
    expect(openWithShares(d.ledger(), at(ids, 0), shares).status).toBe("disclosed");
  });

  it("one approval in each of two cases on the same record does not add up to a disclosure", async () => {
    // Without the case binding, s_a·E from case A and s_b·E from case B would interpolate to the
    // record's key: two half-approved cases would leak what no case approved.
    const { d, ids, examiner } = await setup();
    const recordId = at(ids, 0);
    const a = await d.openCase(examiner, [recordId]);
    const b = await d.openCase(examiner, [recordId]);
    await d.approve(0, a.caseId);
    await d.approve(1, b.caseId);

    const mixed = [
      ...sharesFor(d.ledger(), a.caseId, 0, [0], examiner.scalar),
      ...sharesFor(d.ledger(), b.caseId, 0, [1], examiner.scalar),
    ];
    expect(openWithShares(d.ledger(), recordId, mixed).status).toBe("failed");
    expect(at(discloseCase(d.ledger(), a.caseId, examiner.scalar).records, 0).status).toBe(
      "sealed",
    );
    expect(at(discloseCase(d.ledger(), b.caseId, examiner.scalar).records, 0).status).toBe(
      "sealed",
    );
  });

  it("an expired case collects no approval, so a half-approved case stays closed for good", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [at(ids, 0)], { expiry: T0 + DAY });
    await d.approve(0, caseId);
    d.now = T0 + DAY;
    await expect(d.approve(1, caseId)).rejects.toThrow(refusal("CASE_EXPIRED"));
    expect(at(discloseCase(d.ledger(), caseId, examiner.scalar).records, 0).status).toBe("sealed");
  });

  it("revoking the examiner stops the case collecting its second approval", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [at(ids, 1)]);
    await d.approve(2, caseId);
    await d.revokeExaminer(examiner.id);
    await expect(d.approve(0, caseId)).rejects.toThrow(refusal("EXAMINER_REVOKED"));
    expect(at(discloseCase(d.ledger(), caseId, examiner.scalar).records, 0).status).toBe("sealed");
  });

  it("a share unsealed at the wrong slot is noise", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [at(ids, 0), at(ids, 1)]);
    await d.approve(0, caseId);
    await d.approve(1, caseId);
    const sealedShare = d.ledger().shares.lookup(pureCircuits.shareKeyOf(caseId, 0n, 1n));
    expect(openShare(sealedShare, examiner.scalar, 1)).not.toEqual(
      openShare(sealedShare, examiner.scalar, 0),
    );
  });
});

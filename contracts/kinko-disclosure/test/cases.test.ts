// SPDX-License-Identifier: Apache-2.0
//
// Opening and approving cases: who may, what a scope may name, and every refusal.

import { describe, expect, it } from "vitest";

import {
  discloseCase,
  modL,
  pointOf,
  pureCircuits,
  randomBytes32,
  randomScalar,
} from "../src/index.ts";
import { at, DAY, Deployment, newExaminer, refusal, statementOf, T0, ZERO32 } from "./harness.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** A deployment with three filed records and one registered examiner. */
async function setup() {
  const d = await Deployment.create();
  const filer = randomBytes32();
  const a = await d.file(filer, statementOf({ reference: "A" }));
  const b = await d.file(filer, statementOf({ reference: "B" }));
  const c = await d.file(filer, statementOf({ reference: "C" }));
  const examiner = newExaminer();
  await d.registerExaminer(examiner.publicKey);
  return { d, ids: [a.recordId, b.recordId, c.recordId] as const, examiner };
}

describe("open_case", () => {
  it("records the examiner, the scope, its hash and the expiry, under H(examiner, nonce)", async () => {
    const { d, ids, examiner } = await setup();
    const nonce = randomBytes32();
    const expiry = T0 + 14n * DAY;
    const { caseId } = await d.openCase(examiner, [ids[2], ids[0]], { nonce, expiry });
    expect(hex(caseId)).toBe(hex(pureCircuits.caseIdOf(examiner.id, nonce)));
    const c = d.ledger().cases.lookup(caseId);
    expect(c.count).toBe(2n);
    expect(c.recordIds.map(hex)).toEqual([hex(ids[2]), hex(ids[0]), hex(ZERO32), hex(ZERO32)]);
    expect(hex(c.scopeHash)).toBe(
      hex(pureCircuits.scopeHashOf(2n, [ids[2], ids[0], ZERO32, ZERO32])),
    );
    expect(c.expiry).toBe(expiry);
    expect(c.approvals).toEqual([false, false, false]);
    expect(c.approvalCount).toBe(0n);
    expect(pointOf(c.examinerPk)).toEqual(examiner.publicKey);
  });

  it("NOT_EXAMINER: a caller without the examiner scalar", async () => {
    const { d, ids, examiner } = await setup();
    const forged = d.openCase(examiner, [ids[0]], { scalar: randomScalar() });
    await expect(forged).rejects.toThrow(refusal("NOT_EXAMINER"));
  });

  it("NOT_EXAMINER: a real key pair that was never registered", async () => {
    const { d, ids } = await setup();
    await expect(d.openCase(newExaminer(), [ids[0]])).rejects.toThrow(refusal("NOT_EXAMINER"));
  });

  it("BAD_EXPIRY: an expiry at or before the current time", async () => {
    const { d, ids, examiner } = await setup();
    await expect(d.openCase(examiner, [ids[0]], { expiry: T0 })).rejects.toThrow(
      refusal("BAD_EXPIRY"),
    );
    await expect(d.openCase(examiner, [ids[0]], { expiry: T0 - DAY })).rejects.toThrow(
      refusal("BAD_EXPIRY"),
    );
  });

  it("BAD_SCOPE: zero records, more than four, a zero id inside the scope, or an id outside it", async () => {
    const { d, ids, examiner } = await setup();
    const scopes: [readonly Uint8Array[], bigint][] = [
      [[], 0n],
      [[ids[0], ids[1], ids[2], randomBytes32()], 5n],
      [[ids[0], ZERO32], 2n],
      // A record hidden past `count` would sit in the case without being in its count.
      [[ids[0], ids[1]], 1n],
    ];
    for (const [recordIds, count] of scopes) {
      await expect(d.openCase(examiner, recordIds, { count })).rejects.toThrow(
        refusal("BAD_SCOPE"),
      );
    }
  });

  it("NO_SUCH_RECORD: a scope naming a record that was never filed", async () => {
    const { d, ids, examiner } = await setup();
    await expect(d.openCase(examiner, [ids[0], randomBytes32()])).rejects.toThrow(
      refusal("NO_SUCH_RECORD"),
    );
  });

  it("DUPLICATE_IN_SCOPE: one record named twice", async () => {
    const { d, ids, examiner } = await setup();
    await expect(d.openCase(examiner, [ids[0], ids[1], ids[0]])).rejects.toThrow(
      refusal("DUPLICATE_IN_SCOPE"),
    );
    const lastTwo = d.openCase(examiner, [ids[2], ids[1], ids[0], ids[1]]);
    await expect(lastTwo).rejects.toThrow(refusal("DUPLICATE_IN_SCOPE"));
  });

  it("DUPLICATE_CASE: the same examiner reusing a nonce", async () => {
    const { d, ids, examiner } = await setup();
    const nonce = randomBytes32();
    await d.openCase(examiner, [ids[0]], { nonce });
    await expect(d.openCase(examiner, [ids[1]], { nonce })).rejects.toThrow(
      refusal("DUPLICATE_CASE"),
    );
  });

  it("a guessable nonce gives a stranger nothing: case ids are namespaced by examiner", async () => {
    const { d, ids, examiner } = await setup();
    const other = newExaminer();
    await d.registerExaminer(other.publicKey);
    const nonce = new Uint8Array(32).fill(1);
    const mine = await d.openCase(examiner, [ids[0]], { nonce });
    const theirs = await d.openCase(other, [ids[0]], { nonce });
    expect(hex(mine.caseId)).not.toBe(hex(theirs.caseId));
  });
});

describe("approve_case", () => {
  it("records the approval and posts one share per record in scope, and none beyond it", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0], ids[1], ids[2]]);
    await d.approve(1, caseId);
    const c = d.ledger().cases.lookup(caseId);
    expect(c.approvals).toEqual([false, true, false]);
    expect(c.approvalCount).toBe(1n);
    const posted = [0n, 1n, 2n, 3n].map((slot) =>
      d.ledger().shares.member(pureCircuits.shareKeyOf(caseId, 1n, slot)),
    );
    expect(posted).toEqual([true, true, true, false]);
  });

  it("NOT_KEYHOLDER: a slot index outside 0..2", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    await expect(d.approve(0, caseId, { slotIndex: 3n })).rejects.toThrow(refusal("NOT_KEYHOLDER"));
  });

  it("NOT_KEYHOLDER: a real keyholder claiming another keyholder's slot", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    await expect(d.approve(0, caseId, { ps: d.keyholder(1) })).rejects.toThrow(
      refusal("NOT_KEYHOLDER"),
    );
  });

  it("NOT_KEYHOLDER: the right share with the wrong binding scalar", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    const ps = {
      ...d.keyholder(2),
      bindingScalar: modL(d.ceremony.keyholders[2].bindingScalar + 1n),
    };
    await expect(d.approve(2, caseId, { ps })).rejects.toThrow(refusal("NOT_KEYHOLDER"));
  });

  it("NOT_KEYHOLDER: the examiner trying to approve its own case", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    const ps = { scalar: examiner.scalar, bindingScalar: d.ceremony.keyholders[0].bindingScalar };
    await expect(d.approve(0, caseId, { ps })).rejects.toThrow(refusal("NOT_KEYHOLDER"));
  });

  it("NO_SUCH_CASE: an id no examiner opened", async () => {
    const { d } = await setup();
    await expect(d.approve(0, randomBytes32())).rejects.toThrow(refusal("NO_SUCH_CASE"));
  });

  it("CASE_EXPIRED: an approval at or after the expiry", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]], { expiry: T0 + DAY });
    d.now = T0 + DAY - 1n;
    await d.approve(0, caseId);
    d.now = T0 + DAY;
    await expect(d.approve(1, caseId)).rejects.toThrow(refusal("CASE_EXPIRED"));
  });

  it("EXAMINER_REVOKED: an approval for a case whose examiner has been revoked", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    await d.revokeExaminer(examiner.id);
    await expect(d.approve(0, caseId)).rejects.toThrow(refusal("EXAMINER_REVOKED"));
  });

  it("ALREADY_APPROVED: one keyholder approving twice", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    await d.approve(2, caseId);
    await expect(d.approve(2, caseId)).rejects.toThrow(refusal("ALREADY_APPROVED"));
    expect(d.ledger().cases.lookup(caseId).approvalCount).toBe(1n);
  });

  it("THRESHOLD_REACHED: a third keyholder after two have approved", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0], ids[1]]);
    await d.approve(0, caseId);
    await d.approve(1, caseId);
    await expect(d.approve(2, caseId)).rejects.toThrow(refusal("THRESHOLD_REACHED"));
    expect(d.ledger().shares.size()).toBe(4n);
    expect(d.ledger().cases.lookup(caseId).approvals).toEqual([true, true, false]);
  });

  it("BAD_EPHEMERAL and EPHEMERAL_REUSED apply to the share seal too", async () => {
    const { d, ids, examiner } = await setup();
    const a = await d.openCase(examiner, [ids[0]]);
    const b = await d.openCase(examiner, [ids[1]]);
    const zero = d.approve(0, a.caseId, { ps: { ...d.keyholder(0), ephemeral: 0n } });
    await expect(zero).rejects.toThrow(refusal("BAD_EPHEMERAL"));
    const ephemeral = randomScalar();
    await d.approve(0, a.caseId, { ps: { ...d.keyholder(0), ephemeral } });
    const reused = d.approve(0, b.caseId, { ps: { ...d.keyholder(0), ephemeral } });
    await expect(reused).rejects.toThrow(refusal("EPHEMERAL_REUSED"));
  });

  it("BAD_TIMESTAMP: an approval logged with a time ahead of the block", async () => {
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    await expect(d.approve(0, caseId, { at: T0 + 5n })).rejects.toThrow(refusal("BAD_TIMESTAMP"));
  });

  it("the posted share is pinned to the keyholder's real keys, so two honest approvals always open", async () => {
    // The circuit derives X_i from the scalar it has just checked against keyholderPks[i] and the
    // binding scalar it has checked against bindingPk: a keyholder cannot post a share that looks
    // valid but is not.
    const { d, ids, examiner } = await setup();
    const { caseId } = await d.openCase(examiner, [ids[0]]);
    await d.approve(0, caseId);
    await d.approve(1, caseId);
    expect(at(discloseCase(d.ledger(), caseId, examiner.scalar).records, 0).status).toBe(
      "disclosed",
    );
  });
});

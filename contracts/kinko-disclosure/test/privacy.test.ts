// SPDX-License-Identifier: Apache-2.0
//
// What reaches the public: every value cell of every call's transcript, and every value in the
// ledger afterwards. No statement field, filer secret, nonce, sealing scalar, keyholder scalar,
// binding scalar, examiner scalar or decryption share may appear in either.
//
// Each check is paired with a positive control on a value that must be public, so the scanner is
// shown to see the encoding it is looking for. The one-bit direction field is not scanned: a 0 or
// a 1 is indistinguishable from any other small value in the transcript.

import { describe, expect, it } from "vitest";

import { pointOf, pureCircuits, randomBytes32, randomScalar } from "../src/index.ts";
import {
  at,
  bytesHex,
  collectValues,
  Deployment,
  ledgerSnapshot,
  leHex,
  newExaminer,
  statementOf,
  transcriptCells,
} from "./harness.ts";

/** Distinctive plaintext: every value is large enough that a chance collision is negligible. */
const PAYMENT = statementOf({
  amount: 987_654_321_123n,
  counterparty: 0x7a11_ce5e_cc0d_e1f0_9988_7766_5544n,
  reference: "INV-PRIV-8842-ZQ",
  memo: "Confidential settlement, matter 2026-117, do not publish",
});

/** The names of the values whose encoding appears among the cells. */
const leaked = (cells: Set<string>, values: Record<string, string>): string[] =>
  Object.entries(values)
    .filter(([, encoded]) => encoded.length === 0 || cells.has(encoded))
    .map(([name]) => name);

describe("file_record transcript", () => {
  it("publishes the record id, E, the ciphertext and the anchor, and no plaintext or secret", async () => {
    const d = await Deployment.create();
    const filer = randomBytes32();
    const nonce = randomBytes32();
    const ephemeral = randomScalar();
    const { recordId, res, statement } = await d.file(filer, PAYMENT, {
      ephemeral,
      recordNonce: nonce,
    });
    const cells = transcriptCells(res);
    const record = d.ledger().records.lookup(recordId);

    // Positive controls: these are public by design.
    expect(cells.has(bytesHex(recordId))).toBe(true);
    expect(cells.has(bytesHex(record.anchor))).toBe(true);
    expect(cells.has(leHex(record.E.x))).toBe(true);
    expect(cells.has(leHex(at(record.ct, 1)))).toBe(true);

    const S = pureCircuits.mulPoint(d.ceremony.config.disclosurePk, ephemeral);
    const secrets = {
      amount: leHex(statement.amount),
      time: leHex(statement.time),
      packed: leHex(
        pureCircuits.packAmountTime(statement.amount, statement.time, statement.direction),
      ),
      counterparty: leHex(statement.counterparty),
      reference: leHex(statement.reference),
      memo0: leHex(at(statement.memo, 0)),
      memo1: leHex(at(statement.memo, 1)),
      salt: leHex(statement.salt),
      filerId: leHex(pureCircuits.filerIdOf(filer)),
      filerSecret: bytesHex(filer),
      nonce: bytesHex(nonce),
      ephemeral: leHex(ephemeral),
      sharedX: leHex(S.x),
      sharedY: leHex(S.y),
    };
    expect(leaked(cells, secrets)).toEqual([]);
  });
});

describe("open_case and approve_case transcripts", () => {
  it("publish the case and the sealed shares, never a scalar or a decryption share", async () => {
    const d = await Deployment.create();
    const { recordId } = await d.file(randomBytes32(), PAYMENT);
    const examiner = newExaminer();
    await d.registerExaminer(examiner.publicKey);
    const opened = await d.openCase(examiner, [recordId]);
    const openCells = transcriptCells(opened.res);
    expect(openCells.has(bytesHex(opened.caseId))).toBe(true);
    expect(openCells.has(bytesHex(recordId))).toBe(true);
    expect(leaked(openCells, { examinerScalar: leHex(examiner.scalar) })).toEqual([]);

    const ephemeral = randomScalar();
    const res = await d.approve(1, opened.caseId, { ps: { ...d.keyholder(1), ephemeral } });
    const cells = transcriptCells(res);
    const share = d.ledger().shares.lookup(pureCircuits.shareKeyOf(opened.caseId, 1n, 0n));
    expect(cells.has(leHex(share.E2.x))).toBe(true);
    expect(cells.has(leHex(at(share.ct, 0)))).toBe(true);

    const { scalar, bindingScalar } = d.ceremony.keyholders[1];
    const E = pointOf(d.ledger().records.lookup(recordId).E);
    const h = pureCircuits.bindScalarOf(opened.caseId, recordId);
    const X = pureCircuits.decryptionShareOf(E, scalar, bindingScalar, h, 2n);
    const S2 = pureCircuits.mulPoint(examiner.publicKey, ephemeral);
    const secrets = {
      keyholderScalar: leHex(scalar),
      bindingScalar: leHex(bindingScalar),
      shareX: leHex(X.x),
      shareY: leHex(X.y),
      sealX: leHex(S2.x),
      sealY: leHex(S2.y),
      ephemeral: leHex(ephemeral),
    };
    expect(leaked(cells, secrets)).toEqual([]);
  });
});

describe("public state", () => {
  it("after a full disclosure, the ledger holds no plaintext field and no secret", async () => {
    const d = await Deployment.create();
    const filer = randomBytes32();
    const nonce = randomBytes32();
    const { recordId, statement } = await d.file(filer, PAYMENT, { recordNonce: nonce });
    const examiner = newExaminer();
    await d.registerExaminer(examiner.publicKey);
    const { caseId } = await d.openCase(examiner, [recordId]);
    await d.approve(0, caseId);
    await d.approve(2, caseId);

    const { ints, bytes } = collectValues(ledgerSnapshot(d.ledger()));
    // Positive controls.
    expect(bytes.has(Buffer.from(recordId).toString("hex"))).toBe(true);
    expect(ints.has(at(d.ledger().records.lookup(recordId).ct, 0))).toBe(true);

    const [k0, k1, k2] = d.ceremony.keyholders;
    const secretInts: Record<string, bigint> = {
      amount: statement.amount,
      time: statement.time,
      counterparty: statement.counterparty,
      reference: statement.reference,
      memo0: at(statement.memo, 0),
      memo1: at(statement.memo, 1),
      salt: statement.salt,
      filerId: pureCircuits.filerIdOf(filer),
      examinerScalar: examiner.scalar,
      keyholder0: k0.scalar,
      keyholder1: k1.scalar,
      keyholder2: k2.scalar,
      bindingScalar: k0.bindingScalar,
    };
    expect(Object.keys(secretInts).filter((name) => ints.has(secretInts[name] ?? 0n))).toEqual([]);
    const secretBytes = { filer, nonce, operator: d.ceremony.operatorSecret };
    expect(
      Object.entries(secretBytes).filter(([, v]) => bytes.has(Buffer.from(v).toString("hex"))),
    ).toEqual([]);
  });
});

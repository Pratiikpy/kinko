// SPDX-License-Identifier: Apache-2.0
//
// Filing: the circuit seals exactly what the off-chain codec seals, the anchor pins the plaintext,
// record ids say nothing about their filer, and a sealing scalar is never usable twice.

import { describe, expect, it } from "vitest";

import {
  CIPHER_VERSION,
  fromStatement,
  openRecord,
  pointOf,
  pureCircuits,
  randomBytes32,
  randomScalar,
  sealStatement,
  toStatement,
  verifyAnchor,
} from "../src/index.ts";
import { Deployment, refusal, statementOf } from "./harness.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("file_record", () => {
  it("stores exactly the record the off-chain codec produces from the same inputs", async () => {
    const d = await Deployment.create();
    const filer = randomBytes32();
    const statement = toStatement(statementOf());
    const ephemeral = randomScalar();
    const nonce = randomBytes32();
    const { recordId } = await d.file(filer, statement, { ephemeral, recordNonce: nonce });

    const expected = sealStatement({
      filerSecret: filer,
      statement,
      disclosurePk: d.ceremony.config.disclosurePk,
      ephemeral,
      nonce,
    });
    expect(hex(recordId)).toBe(hex(expected.recordId));
    const stored = d.ledger().records.lookup(recordId);
    expect(stored).toEqual(expected.record);
    expect(stored.version).toBe(CIPHER_VERSION);
    expect(stored.ct).toHaveLength(7);
  });

  it("the filer, who knows its sealing scalar, can re-open its own record against the anchor", async () => {
    const d = await Deployment.create();
    const filer = randomBytes32();
    const ephemeral = randomScalar();
    const payment = statementOf({
      direction: "received",
      reference: "RCPT-9",
      memo: "Deposit, flat 4B — paid in full",
    });
    const { recordId } = await d.file(filer, payment, { ephemeral });
    const record = d.ledger().records.lookup(recordId);
    const opened = openRecord(
      record,
      pureCircuits.mulPoint(d.ceremony.config.disclosurePk, ephemeral),
    );
    expect(verifyAnchor(opened, record)).toBe(true);
    expect(opened.filerId).toBe(pureCircuits.filerIdOf(filer));
    expect(fromStatement(opened.statement)).toEqual(payment);
  });

  it("the anchor catches any altered slot, and cannot be moved to another E", async () => {
    const d = await Deployment.create();
    const ephemeral = randomScalar();
    const { recordId } = await d.file(randomBytes32(), statementOf(), { ephemeral });
    const record = d.ledger().records.lookup(recordId);
    const S = pureCircuits.mulPoint(d.ceremony.config.disclosurePk, ephemeral);
    const altered = record.ct.map((_, slot) => record.ct.map((c, j) => (j === slot ? c + 1n : c)));
    expect(altered.map((ct) => verifyAnchor(openRecord({ ...record, ct }, S), record))).toEqual(
      Array(7).fill(false),
    );
    const otherE = pureCircuits.storedPoint(pureCircuits.pubKeyOf(randomScalar()));
    expect(verifyAnchor(openRecord(record, S), { ...record, E: otherE })).toBe(false);
  });

  it("two records by one filer have unrelated ids, and neither carries the filer id in the clear", async () => {
    const d = await Deployment.create();
    const filer = randomBytes32();
    const a = await d.file(filer, statementOf());
    const b = await d.file(filer, statementOf());
    expect(hex(a.recordId)).not.toBe(hex(b.recordId));
    const filerId = pureCircuits.filerIdOf(filer);
    for (const { recordId } of [a, b]) {
      const r = d.ledger().records.lookup(recordId);
      expect(r.ct).not.toContain(filerId);
      expect(pointOf(r.E)).not.toEqual(pureCircuits.identityPoint());
    }
  });

  it("BAD_DIRECTION: a direction other than sent (0) or received (1)", async () => {
    const d = await Deployment.create();
    const s = { ...toStatement(statementOf()), direction: 2n };
    await expect(d.file(randomBytes32(), s)).rejects.toThrow(refusal("BAD_DIRECTION"));
  });

  it("BAD_EPHEMERAL: a zero sealing scalar, which would seal under the identity", async () => {
    const d = await Deployment.create();
    await expect(d.file(randomBytes32(), statementOf(), { ephemeral: 0n })).rejects.toThrow(
      refusal("BAD_EPHEMERAL"),
    );
  });

  it("EPHEMERAL_REUSED: a sealing scalar used for a second record", async () => {
    // Reusing e would let anyone subtract the two ciphertexts and read which fields two records
    // share; the contract refuses it outright.
    const d = await Deployment.create();
    const filer = randomBytes32();
    const ephemeral = randomScalar();
    await d.file(filer, statementOf(), { ephemeral });
    const second = d.file(filer, statementOf({ amount: 1n }), {
      ephemeral,
      recordNonce: randomBytes32(),
    });
    await expect(second).rejects.toThrow(refusal("EPHEMERAL_REUSED"));
    expect(d.ledger().records.size()).toBe(1n);
  });

  it("a witness without a statement is refused before anything is written", async () => {
    const d = await Deployment.create();
    await expect(d.call("file_record", { secretKey: randomBytes32() })).rejects.toThrow(
      /no statement/,
    );
    expect(d.ledger().records.size()).toBe(0n);
  });
});

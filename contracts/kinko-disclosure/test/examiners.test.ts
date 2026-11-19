// SPDX-License-Identifier: Apache-2.0
//
// Examiner registration and revocation: operator-gated, logged, permanent.

import { describe, expect, it } from "vitest";

import { LogKind, pointOf, pureCircuits, randomBytes32, readLog } from "../src/index.ts";
import { at, Deployment, newExaminer, refusal, statementOf, T0 } from "./harness.ts";

const TOLERANCE = pureCircuits.timeTolerance();
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("register_examiner", () => {
  it("stores the key, marks it active and logs the registration", async () => {
    const d = await Deployment.create();
    const x = newExaminer();
    await d.registerExaminer(x.publicKey);
    const stored = d.ledger().examiners.lookup(x.id);
    expect(stored.active).toBe(true);
    expect(pointOf(stored.pk)).toEqual(x.publicKey);
    const entry = at(readLog(d.ledger()), 0);
    expect(entry.kind).toBe(LogKind.EXAMINER_REGISTERED);
    expect(hex(entry.examinerId)).toBe(hex(x.id));
    expect(entry.at).toBe(T0);
  });

  it("NOT_OPERATOR: anyone without the operator secret", async () => {
    const d = await Deployment.create();
    const stranger = { secretKey: randomBytes32() };
    await expect(d.registerExaminer(newExaminer().publicKey, stranger)).rejects.toThrow(
      refusal("NOT_OPERATOR"),
    );
  });

  it("BAD_EXAMINER_KEY: the identity, the disclosure key, the binding key or a keyholder key", async () => {
    const d = await Deployment.create();
    const { disclosurePk, bindingPk, keyholderPks } = d.ceremony.config;
    for (const pk of [pureCircuits.identityPoint(), disclosurePk, bindingPk, ...keyholderPks]) {
      await expect(d.registerExaminer(pk)).rejects.toThrow(refusal("BAD_EXAMINER_KEY"));
    }
  });

  it("EXAMINER_EXISTS: registering a key twice, or re-registering a revoked one", async () => {
    const d = await Deployment.create();
    const x = newExaminer();
    await d.registerExaminer(x.publicKey);
    await expect(d.registerExaminer(x.publicKey)).rejects.toThrow(refusal("EXAMINER_EXISTS"));
    await d.revokeExaminer(x.id);
    await expect(d.registerExaminer(x.publicKey)).rejects.toThrow(refusal("EXAMINER_EXISTS"));
  });

  it("BAD_TIMESTAMP: a logged time in the future, or older than the tolerance", async () => {
    const d = await Deployment.create();
    const future = d.registerExaminer(newExaminer().publicKey, d.operator, T0 + 1n);
    await expect(future).rejects.toThrow(refusal("BAD_TIMESTAMP"));
    const stale = d.registerExaminer(newExaminer().publicKey, d.operator, T0 - TOLERANCE);
    await expect(stale).rejects.toThrow(refusal("BAD_TIMESTAMP"));
    await d.registerExaminer(newExaminer().publicKey, d.operator, T0 - TOLERANCE + 1n);
    expect(d.ledger().logLength).toBe(1n);
  });
});

describe("revoke_examiner", () => {
  it("marks the examiner revoked and logs it", async () => {
    const d = await Deployment.create();
    const x = newExaminer();
    await d.registerExaminer(x.publicKey);
    d.now = T0 + 60n;
    await d.revokeExaminer(x.id);
    expect(d.ledger().examiners.lookup(x.id).active).toBe(false);
    const log = readLog(d.ledger());
    expect(log.map((e) => e.kind)).toEqual([LogKind.EXAMINER_REGISTERED, LogKind.EXAMINER_REVOKED]);
    expect(at(log, 1).at).toBe(T0 + 60n);
  });

  it("NOT_OPERATOR, NO_SUCH_EXAMINER and EXAMINER_REVOKED", async () => {
    const d = await Deployment.create();
    const x = newExaminer();
    await d.registerExaminer(x.publicKey);
    await expect(d.revokeExaminer(x.id, { secretKey: randomBytes32() })).rejects.toThrow(
      refusal("NOT_OPERATOR"),
    );
    await expect(d.revokeExaminer(newExaminer().id)).rejects.toThrow(refusal("NO_SUCH_EXAMINER"));
    await d.revokeExaminer(x.id);
    await expect(d.revokeExaminer(x.id)).rejects.toThrow(refusal("EXAMINER_REVOKED"));
  });

  it("a revoked examiner can open no case", async () => {
    const d = await Deployment.create();
    const x = newExaminer();
    await d.registerExaminer(x.publicKey);
    const { recordId } = await d.file(randomBytes32(), statementOf());
    await d.revokeExaminer(x.id);
    await expect(d.openCase(x, [recordId])).rejects.toThrow(refusal("EXAMINER_REVOKED"));
  });
});

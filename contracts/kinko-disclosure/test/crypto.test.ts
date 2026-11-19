// SPDX-License-Identifier: Apache-2.0
//
// The off-chain maths on its own: codec round trips and limits, Lagrange coefficients, and the
// case-binding algebra the contract's shares rely on.

import { describe, expect, it } from "vitest";

import {
  combineShares,
  decodeMemo,
  decodeText,
  encodeMemo,
  encodeText,
  fromStatement,
  JUBJUB_ORDER,
  lagrangeAtZero,
  modL,
  pureCircuits,
  randomScalar,
  toStatement,
  unpackAmountTime,
} from "../src/index.ts";
import { statementOf } from "./harness.ts";

describe("statement codec", () => {
  it("round-trips text up to 31 bytes, including multi-byte characters", () => {
    const samples = ["", "INV-1", "Ünïcödé €40", "x".repeat(31), "日本語のメモ十字"];
    expect(samples.map((s) => decodeText(encodeText(s)))).toEqual(samples);
  });

  it("refuses text that does not fit one field, or that contains NUL", () => {
    expect(() => encodeText("x".repeat(32))).toThrow(/one field holds 31/);
    expect(() => encodeText("a\u0000b")).toThrow(/NUL/);
  });

  it("splits a 62-byte memo across two fields, even through a multi-byte character", () => {
    const memo = `${"a".repeat(30)}€${"b".repeat(29)}`;
    expect(new TextEncoder().encode(memo).length).toBe(62);
    expect(decodeMemo(encodeMemo(memo))).toBe(memo);
    expect(() => encodeMemo(`${memo}c`)).toThrow(/holds 62/);
  });

  it("packs amount, time and direction losslessly, at the extremes too", () => {
    const max = (1n << 64n) - 1n;
    const triples = [
      { amount: 0n, time: 0n, direction: 0n },
      { amount: max, time: max, direction: 1n },
      { amount: 1_234_567n, time: 1_800_000_000n, direction: 1n },
    ];
    expect(
      triples.map((t) =>
        unpackAmountTime(pureCircuits.packAmountTime(t.amount, t.time, t.direction)),
      ),
    ).toEqual(triples);
  });

  it("a payment statement survives the trip to the contract's Statement and back", () => {
    const p = statementOf({ direction: "received" });
    expect(fromStatement(toStatement(p))).toEqual(p);
    expect(() => toStatement({ ...p, amount: 1n << 64n })).toThrow(/Uint<64>/);
  });

  it("every statement gets a fresh salt", () => {
    const p = statementOf();
    expect(toStatement(p).salt).not.toBe(toStatement(p).salt);
  });
});

describe("Lagrange coefficients", () => {
  const combine = (xs: readonly bigint[], f: (x: bigint) => bigint): bigint => {
    const l = lagrangeAtZero(xs);
    return modL(xs.reduce((acc, x, k) => acc + (l[k] ?? 0n) * f(x), 0n));
  };

  it("interpolate any line at zero from any two of its points", () => {
    const [sk, a] = [randomScalar(), randomScalar()];
    const pairs = [
      [1n, 2n],
      [1n, 3n],
      [2n, 3n],
    ];
    expect(pairs.map((p) => combine(p, (x) => modL(sk + a * x)))).toEqual([sk, sk, sk]);
    // The same coefficients send the line x ↦ x to zero: why the case binding cancels.
    expect(pairs.map((p) => combine(p, (x) => x))).toEqual([0n, 0n, 0n]);
  });

  it("refuses repeated points", () => {
    expect(() => lagrangeAtZero([2n, 2n])).toThrow(/distinct/);
  });
});

describe("case binding", () => {
  const sk = randomScalar();
  const a = randomScalar();
  const k = randomScalar();
  const E = pureCircuits.pubKeyOf(randomScalar());
  const S = pureCircuits.mulPoint(E, sk);
  const share = (x: bigint, h: bigint) => ({
    x,
    X: pureCircuits.decryptionShareOf(E, modL(sk + a * x), k, h, x),
  });

  it("two shares with one binding interpolate to sk·E", () => {
    const h = randomScalar();
    expect(combineShares([share(1n, h), share(3n, h)])).toEqual(S);
    expect(combineShares([share(2n, h), share(3n, h)])).toEqual(S);
  });

  it("two shares with different bindings do not", () => {
    expect(combineShares([share(1n, randomScalar()), share(2n, randomScalar())])).not.toEqual(S);
  });

  it("without a binding, shares from anywhere would combine: the leak the binding closes", () => {
    expect(combineShares([share(1n, 0n), share(2n, 0n)])).toEqual(S);
  });

  it("binding scalars are distinct per case and per record, and inside the scalar field", () => {
    const [c1, c2, r1, r2] = [1, 2, 3, 4].map((v) => new Uint8Array(32).fill(v)) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    const hs = [
      pureCircuits.bindScalarOf(c1, r1),
      pureCircuits.bindScalarOf(c1, r2),
      pureCircuits.bindScalarOf(c2, r1),
    ];
    expect(new Set(hs).size).toBe(3);
    expect(hs.every((h) => h < JUBJUB_ORDER)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { describeTransaction, deserializeBound, SponsorError } from "../src/sponsor-protocol.ts";

const txWith = (...actions: object[]) => ({ intents: new Map([[1, { actions }]]) });
const name = (s: string) => new TextEncoder().encode(s);

describe("describeTransaction", () => {
  it("reads each call's contract and circuit", () => {
    const d = describeTransaction(
      txWith(
        { address: "aa", entryPoint: name("settle_invoice") },
        { address: "aa", entryPoint: "create_invoice" },
      ),
    );
    expect(d.circuits).toEqual(["settle_invoice", "create_invoice"]);
    expect(d.contracts).toEqual(["aa"]);
    expect(d.hasAdministrativeAction).toBe(false);
  });

  it("flags deploys and maintenance updates", () => {
    expect(
      describeTransaction(txWith({ address: "aa", initialState: {} })).hasAdministrativeAction,
    ).toBe(true);
    expect(
      describeTransaction(txWith({ address: "aa", updates: [] })).hasAdministrativeAction,
    ).toBe(true);
  });

  it("shows an unreadable entry point as hex rather than dropping it", () => {
    const d = describeTransaction(txWith({ address: "aa", entryPoint: new Uint8Array([1, 2]) }));
    expect(d.circuits).toEqual(["0x0102"]);
  });

  it("finds no calls in a transaction with none", () => {
    expect(describeTransaction({}).actions).toEqual([]);
    expect(describeTransaction(txWith()).circuits).toEqual([]);
  });
});

describe("deserializeBound", () => {
  it("refuses text that is not hex, and hex that is not a bound transaction", () => {
    for (const bad of ["", "zz", "abc"]) {
      expect(() => deserializeBound(bad)).toThrow(SponsorError);
    }
    expect(() => deserializeBound("00ff00ff")).toThrow(/bound transaction/);
  });
});

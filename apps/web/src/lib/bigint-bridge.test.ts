import { describe, expect, it } from "vitest";

import { decodeBigints, encodeBigints } from "../../e2e/live/bridge.ts";

describe("the live suite's wallet bridge encoding", () => {
  it("round-trips bigints nested in objects and arrays through JSON", () => {
    const value = { balances: { a: 12_500_000n, b: 0n }, list: [1n, "x", null], n: 3 };
    const back = decodeBigints(JSON.parse(JSON.stringify(encodeBigints(value))));
    expect(back).toEqual(value);
  });

  it("leaves an ordinary object with a $bigint key and other keys alone", () => {
    const value = { $bigint: "1", other: true };
    expect(decodeBigints(encodeBigints(value))).toEqual(value);
  });
});

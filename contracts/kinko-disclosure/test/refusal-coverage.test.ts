// SPDX-License-Identifier: Apache-2.0
//
// Every refusal code in the contract has a test that trips it. This reads the contract source,
// collects every assert message, and checks each one is the expected refusal of a
// `rejects.toThrow(refusal("CODE"))` somewhere in the suite.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const source = readFileSync(join(here, "..", "src", "kinko_disclosure.compact"), "utf8");
const codes = [
  ...new Set([...source.matchAll(/assert\([^;]*?"([A-Z_]+)"\);/gs)].map((m) => m[1] ?? "")),
].sort();

const suite = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts") && f !== "refusal-coverage.test.ts")
  .map((f) => readFileSync(join(here, f), "utf8"))
  .join("\n");

describe("refusal coverage", () => {
  it("finds the contract's refusal codes", () => {
    expect(codes).toHaveLength(25);
  });

  it.each(codes)("%s is tripped by a test", (code) => {
    // Prettier may wrap the call, so whitespace and a trailing comma are allowed inside it.
    const tripped = new RegExp(`\\.rejects\\.toThrow\\(\\s*refusal\\("${code}"\\),?\\s*\\)`);
    expect(tripped.test(suite), `no test expects a ${code} refusal`).toBe(true);
  });
});

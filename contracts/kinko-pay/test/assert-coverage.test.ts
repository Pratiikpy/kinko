// Every assert in every contract is tripped by at least one test.
//
// An assert nobody has seen fail is an assert nobody knows works: it could be
// unreachable, or guard the wrong value. This suite reads every assert
// message out of the Compact sources and requires each to appear as the
// expected error of a `toThrow(...)` somewhere in the test suites, so adding
// an assert without a test that trips it fails the build.

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const srcDir = new URL("../src/", import.meta.url);
const testDir = new URL("./", import.meta.url);

const contracts = readdirSync(srcDir).filter((f) => f.endsWith(".compact"));

/** Every assert message in a Compact source, in order. */
const assertMessages = (source: string): string[] =>
  [...source.matchAll(/assert\s*\(([\s\S]*?),\s*"([^"]+)"\s*\)\s*;/g)].map((m) => m[2] ?? "");

/** Every message a test expects a call to throw. */
const expectedThrows = (): Set<string> => {
  const out = new Set<string>();
  for (const file of readdirSync(testDir).filter((f) => f.endsWith(".test.ts"))) {
    const source = readFileSync(new URL(file, testDir), "utf8");
    for (const m of source.matchAll(/toThrow\(\s*"([^"]+)"\s*,?\s*\)/g)) out.add(m[1] ?? "");
  }
  return out;
};

describe("assert coverage", () => {
  it("finds the three contracts and their asserts", () => {
    expect(contracts.sort()).toEqual([
      "kinko_gift.compact",
      "kinko_pay.compact",
      "kinko_tags.compact",
    ]);
    for (const c of contracts) {
      expect({
        contract: c,
        asserts: assertMessages(readFileSync(new URL(c, srcDir), "utf8")).length > 0,
      }).toEqual({ contract: c, asserts: true });
    }
  });

  const tripped = expectedThrows();
  for (const contract of contracts) {
    const messages = [...new Set(assertMessages(readFileSync(new URL(contract, srcDir), "utf8")))];
    for (const message of messages) {
      it(`${contract}: "${message}" is tripped by a test`, () => {
        expect(tripped.has(message)).toBe(true);
      });
    }
  }
});

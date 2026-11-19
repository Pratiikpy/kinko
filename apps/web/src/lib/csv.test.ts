import { describe, expect, it } from "vitest";

import { BATCH_TEMPLATE, classifyRecipient, MAX_BATCH_ROWS, parseBatch, splitCsv } from "./csv.ts";

const ADDRESS = "mn_shield-addr_undeployed1" + "q".repeat(40) + "p".repeat(40);

describe("splitCsv", () => {
  it("handles quotes, escaped quotes, CRLF and a byte-order mark", () => {
    expect(splitCsv('﻿a,"b, c","say ""hi"""\r\nd,e,f')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["d", "e", "f"],
    ]);
  });

  it("keeps a last line with no newline", () => {
    expect(splitCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("classifyRecipient", () => {
  it("tells tags from shielded addresses and refuses the rest", () => {
    expect(classifyRecipient("@alice")).toBe("tag");
    expect(classifyRecipient("bob_designs")).toBe("tag");
    expect(classifyRecipient(ADDRESS)).toBe("address");
    expect(classifyRecipient("0x" + "1".repeat(40))).toBeNull();
    expect(classifyRecipient("@al")).toBeNull();
    expect(classifyRecipient("@alice smith")).toBeNull();
  });
});

describe("parseBatch", () => {
  it("parses the downloadable template exactly", () => {
    const b = parseBatch(BATCH_TEMPLATE);
    expect(b.issues).toEqual([]);
    expect(b.rows.map((r) => [r.recipient, r.amount, r.memo])).toEqual([
      ["@alice", 1_250_000_000n, "November retainer"],
      ["@bob_designs", 480_000_000n, "Logo revisions"],
    ]);
    expect(b.total).toBe(1_730_000_000n);
  });

  it("works without a header, normalises tags and keeps quoted notes with commas", () => {
    const b = parseBatch(`@Alice,10\n${ADDRESS},2.5,"rent, March"\n\n`);
    expect(b.rows.map((r) => r.recipient)).toEqual(["@alice", ADDRESS]);
    expect(b.rows[1]?.memo).toBe("rent, March");
    expect(b.rows[1]?.recipientKind).toBe("address");
  });

  it("names the line of each problem and leaves good lines usable", () => {
    const b = parseBatch(
      `recipient,amount\n@alice,10\n0x${"ab".repeat(20)},5\n@bob,-1\n@carol,0.0000001\n@dave,`,
    );
    expect(b.rows.map((r) => r.line)).toEqual([2]);
    expect(b.issues.map((i) => i.line)).toEqual([3, 4, 5, 6]);
    expect(b.issues[0]?.message).toMatch(/not a @tag/);
    expect(b.issues[2]?.message).toMatch(/decimal places/);
    expect(b.issues[3]?.message).toMatch(/Enter an amount/);
  });

  it("refuses more than the maximum batch and says so", () => {
    const text = Array.from({ length: MAX_BATCH_ROWS + 5 }, (_, i) => `@user_${String(i)},1`).join(
      "\n",
    );
    const b = parseBatch(text);
    expect(b.rows).toHaveLength(MAX_BATCH_ROWS);
    expect(b.issues.at(-1)?.message).toMatch(/at most 200/);
    expect(b.total).toBe(BigInt(MAX_BATCH_ROWS) * 1_000_000n);
  });
});

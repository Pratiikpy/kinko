import { fromStatement, JUBJUB_ORDER } from "@kinko/kinko-disclosure";
import { describe, expect, it } from "vitest";

import {
  examinerIdForScalar,
  fieldText,
  parseScalar,
  scalarHex,
  statementFor,
  utf8Length,
} from "./disclosure.ts";

describe("scalars", () => {
  it("parse decimal, 0x hex and bare 64-hex forms", () => {
    expect(parseScalar("12345")).toBe(12345n);
    expect(parseScalar("0xff")).toBe(255n);
    expect(parseScalar("0".repeat(62) + "ff")).toBe(255n);
    expect(parseScalar(scalarHex(987654321n))).toBe(987654321n);
  });

  it("refuse zero, out-of-field values and junk rather than reduce them", () => {
    expect(parseScalar("0")).toBeNull();
    expect(parseScalar(JUBJUB_ORDER.toString())).toBeNull();
    expect(parseScalar("-1")).toBeNull();
    expect(parseScalar("hello")).toBeNull();
    expect(parseScalar("")).toBeNull();
  });

  it("give each examiner key its own id", () => {
    expect(examinerIdForScalar(5n)).toMatch(/^[0-9a-f]{64}$/);
    expect(examinerIdForScalar(5n)).not.toBe(examinerIdForScalar(6n));
  });
});

describe("statements", () => {
  it("encode what a holder files and decode to the same payment", () => {
    const s = statementFor({
      amount: 40_000_000n,
      time: 1_794_700_000n,
      direction: "sent",
      counterparty: "@aiko_design",
      reference: "INV-114",
      memo: "November retainer",
    });
    const back = fromStatement(s);
    expect(back.amount).toBe(40_000_000n);
    expect(back.direction).toBe("sent");
    expect(back.reference).toBe("INV-114");
    expect(back.memo).toBe("November retainer");
    expect(fieldText(back.counterparty)).toBe("@aiko_design");
  });

  it("count bytes the way the codec limits them", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("金庫")).toBe(6);
  });

  it("show an empty counterparty as empty", () => {
    expect(fieldText(0n)).toBe("");
  });
});

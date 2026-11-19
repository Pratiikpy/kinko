import { describe, expect, it } from "vitest";

import {
  formatAmount,
  formatDuration,
  fromHex,
  isEvmAddress,
  parseAmount,
  relativeTime,
  shortHex,
  toHex,
} from "./format.ts";

describe("parseAmount", () => {
  it("reads whole dollars, cents and grouped thousands into six-decimal base units", () => {
    expect(parseAmount("25")).toEqual({ ok: true, value: 25_000_000n });
    expect(parseAmount("12.5")).toEqual({ ok: true, value: 12_500_000n });
    expect(parseAmount(".5")).toEqual({ ok: true, value: 500_000n });
    expect(parseAmount("1,250.00")).toEqual({ ok: true, value: 1_250_000_000n });
    expect(parseAmount("  0.000001 ")).toEqual({ ok: true, value: 1n });
  });

  it("refuses what a person did not mean as a positive amount, naming why", () => {
    expect(parseAmount("")).toEqual({ ok: false, error: "empty" });
    expect(parseAmount("   ")).toEqual({ ok: false, error: "empty" });
    expect(parseAmount("-5")).toEqual({ ok: false, error: "format" });
    expect(parseAmount("1e3")).toEqual({ ok: false, error: "format" });
    expect(parseAmount("1.2.3")).toEqual({ ok: false, error: "format" });
    expect(parseAmount(".")).toEqual({ ok: false, error: "format" });
    expect(parseAmount("abc")).toEqual({ ok: false, error: "format" });
    expect(parseAmount("0.0000001")).toEqual({ ok: false, error: "precision" });
    expect(parseAmount("0")).toEqual({ ok: false, error: "zero" });
    expect(parseAmount("0.00")).toEqual({ ok: false, error: "zero" });
    expect(parseAmount("18446744073709.551616")).toEqual({ ok: false, error: "range" });
  });

  it("accepts the largest amount a Uint<64> carries", () => {
    expect(parseAmount("18446744073709.551615")).toEqual({
      ok: true,
      value: 0xffff_ffff_ffff_ffffn,
    });
  });
});

describe("formatAmount", () => {
  it("groups thousands and keeps at least two decimals without float rounding", () => {
    expect(formatAmount(1_250_000_000n)).toBe("1,250.00");
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(10_500_000n)).toBe("10.50");
    expect(formatAmount(0n)).toBe("0.00");
    expect(formatAmount(123_456_789_000_000n, { symbol: true })).toBe("$123,456,789.00");
    expect(formatAmount(-2_000_000n)).toBe("−2.00");
  });

  it("round-trips with parseAmount", () => {
    for (const v of [1n, 999_999n, 1_000_000n, 42_420_000n, 0xffff_ffff_ffff_ffffn]) {
      const parsed = parseAmount(formatAmount(v));
      expect(parsed).toEqual({ ok: true, value: v });
    }
  });
});

describe("hex helpers", () => {
  it("encodes and decodes bytes", () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(toHex(bytes)).toBe("0001feff");
    expect(fromHex("0x0001FEFF")).toEqual(bytes);
  });

  it("refuses odd-length and non-hex input", () => {
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
  });

  it("shortens long values only", () => {
    expect(shortHex("0x" + "a".repeat(40))).toBe("0xaaaaaa…aaaaaa");
    expect(shortHex("abcdef")).toBe("abcdef");
  });

  it("recognises Ethereum addresses", () => {
    expect(isEvmAddress("0x" + "1".repeat(40))).toBe(true);
    expect(isEvmAddress("0x" + "1".repeat(39))).toBe(false);
    expect(isEvmAddress("1".repeat(40))).toBe(false);
  });
});

describe("time helpers", () => {
  const now = Date.UTC(2026, 10, 15, 12, 0, 0);
  it("says how long ago in words", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
  });

  it("formats durations", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(190)).toBe("3 min 10 s");
    expect(formatDuration(-5)).toBe("0 s");
  });
});

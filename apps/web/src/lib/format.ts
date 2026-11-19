// Money and identifier formatting.
//
// Amounts are bigint base units everywhere; text is produced and parsed only
// at the edge. A float never touches a balance: 0.1 + 0.2 is not a number a
// payments product may show.

import { USDC_DECIMALS } from "./config.ts";

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

/** Why a typed amount was refused. */
export type AmountError = "empty" | "format" | "precision" | "zero" | "range";

/** A typed amount in base units, or why it was refused. */
export type ParsedAmount = { ok: true; value: bigint } | { ok: false; error: AmountError };

/** Plain-language text for each refusal, for form hints. */
export const AMOUNT_ERROR_TEXT: Record<AmountError, string> = {
  empty: "Enter an amount.",
  format:
    "Use digits and a decimal point, like 25 or 12.50. Commas only group thousands, as in 1,250.00.",
  precision: `Dollars have at most ${String(USDC_DECIMALS)} decimal places.`,
  zero: "The amount must be more than zero.",
  range: "That amount is larger than the contracts can carry.",
};

/**
 * Parse a typed dollar amount into base units.
 *
 * Accepts "25", "25.5", ".5", "1,250.00". Refuses signs, exponents and more
 * decimals than the token has, rather than rounding a payment someone typed.
 *
 * @param text - What the user typed.
 * @param decimals - The token's decimals.
 * @returns The base units, or why the text was refused.
 */
export function parseAmount(text: string, decimals: number = USDC_DECIMALS): ParsedAmount {
  const typed = text.trim();
  if (typed === "") return { ok: false, error: "empty" };
  // A comma is only a thousands separator when it groups three digits after a first group that
  // does not start with zero ("1,250.00"). Anywhere else it is a decimal comma ("12,50", "0,125"),
  // which would be read as a hundred or a thousand times the amount typed.
  if (typed.includes(",") && !/^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/.test(typed)) {
    return { ok: false, error: "format" };
  }
  const raw = typed.replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(raw) || raw === ".") return { ok: false, error: "format" };
  const [whole = "", fraction = ""] = raw.split(".");
  if (fraction.length > decimals) return { ok: false, error: "precision" };
  const value = BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
  if (value === 0n) return { ok: false, error: "zero" };
  if (value > UINT64_MAX) return { ok: false, error: "range" };
  return { ok: true, value };
}

/** How {@link formatAmount} writes an amount. */
export interface FormatOptions {
  /** The token's decimals; USDC's six by default. */
  readonly decimals?: number;
  /** Fraction digits always shown; two by default. */
  readonly minFraction?: number;
  /** Prefix a dollar sign. */
  readonly symbol?: boolean;
}

/**
 * Format base units as dollars.
 *
 * @param value - Base units.
 * @param options - Decimals, minimum fraction digits and whether to add "$".
 * @returns Text such as "1,250.00".
 */
export function formatAmount(value: bigint, options: FormatOptions = {}): string {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const minFraction = options.minFraction ?? 2;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
  const text = fraction ? `${whole}.${fraction}` : whole;
  return `${negative ? "−" : ""}${options.symbol ? "$" : ""}${text}`;
}

/**
 * Shorten a long hex value for display, keeping its ends.
 *
 * @param value - The value, with or without 0x.
 * @param head - Characters kept at the start.
 * @param tail - Characters kept at the end.
 * @returns Text such as `a1b2c3…d4e5f6`, or the value itself when it is short.
 */
export function shortHex(value: string, head = 6, tail = 6): string {
  const v = value.trim();
  const prefix = v.startsWith("0x") ? "0x" : "";
  const body = prefix ? v.slice(2) : v;
  if (body.length <= head + tail + 1) return v;
  return `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/**
 * Lowercase hex of bytes, without a prefix.
 *
 * @param bytes - The bytes.
 * @returns Their hex.
 */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Decode hex, optionally 0x-prefixed, into bytes.
 *
 * @param hex - The hex text.
 * @returns The bytes.
 * @throws {Error} When the text is not hex or has an odd length.
 */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) throw new Error("not a hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether text is a 0x-prefixed 20-byte Ethereum address.
 *
 * @param text - The text.
 * @returns True when it is one.
 */
export const isEvmAddress = (text: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(text.trim());

const plural = (n: number, unit: string): string => `${String(n)} ${unit}${n === 1 ? "" : "s"} ago`;

/**
 * How long ago something happened, in words.
 *
 * @param at - When it happened, in milliseconds.
 * @param now - The present, in milliseconds.
 * @returns "just now", "3 minutes ago", or a date for anything older than a week.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return plural(days, "day");
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A duration in words.
 *
 * @param seconds - The duration.
 * @returns Text such as "45 s" or "3 min 10 s".
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${String(m)} min ${String(rest)} s` : `${String(m)} min`;
}

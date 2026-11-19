// Durations the way people type them: 90, 90s, 15m, 2h, 7d.

import { UsageError } from "./io.ts";

const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/**
 * Parse a duration into seconds.
 *
 * @param text - A whole number with an optional unit; bare numbers are seconds.
 * @param flag - The flag it came from, for the error message.
 * @returns The length in seconds.
 * @throws {UsageError} For anything else, or zero.
 */
export const parseDuration = (text: string, flag: string): number => {
  const match = /^(\d+)([smhd]?)$/.exec(text.trim());
  if (!match?.[1])
    throw new UsageError(`${flag} must be a duration such as 90, 15m, 2h or 7d; got "${text}".`);
  const unit = match[2];
  const seconds =
    Number(match[1]) * (UNIT_SECONDS[unit === undefined || unit === "" ? "s" : unit] ?? 1);
  if (seconds <= 0) throw new UsageError(`${flag} must be greater than zero.`);
  return seconds;
};

// Amounts. Everything on the wire and in the contract is whole base units; a
// person writes "25.50". These convert between the two without floating point.

/** KUSD and NIGHT both have six decimal places. */
export const DECIMALS = 6;

const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Turn a decimal string into base units.
 *
 * @param text - Digits with an optional fractional part, such as `"25.50"`.
 * @param decimals - How many decimal places the asset has. Defaults to six.
 * @returns The amount in base units.
 * @throws {RangeError} For anything that is not a positive decimal with no more places than the asset has, or that does not fit in 64 bits.
 */
export const parseAmount = (text: string, decimals: number = DECIMALS): bigint => {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text.trim());
  if (!match?.[1])
    throw new RangeError(
      `"${text}" is not an amount. Write it as digits with an optional fraction, such as 25.50.`,
    );
  const fraction = match[2] ?? "";
  if (fraction.length > decimals)
    throw new RangeError(`"${text}" has more than ${String(decimals)} decimal places.`);
  const value =
    BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value <= 0n) throw new RangeError("An amount must be greater than zero.");
  if (value > U64_MAX) throw new RangeError("That amount is larger than the contract can hold.");
  return value;
};

/**
 * Turn base units into a decimal string, without trailing zeros past two places.
 *
 * @param units - The amount in base units.
 * @param decimals - How many decimal places the asset has. Defaults to six.
 * @returns For example `"25.5"` becomes `"25.50"`; whole numbers keep two places.
 */
export const formatAmount = (units: bigint, decimals: number = DECIMALS): string => {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const fraction = (units % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${whole.toString()}.${fraction}`;
};

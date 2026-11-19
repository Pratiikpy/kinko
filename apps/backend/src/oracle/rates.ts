// Where the oracle gets the NIGHT to KUSD rate.
//
// The signer is only as honest as the number it is given, so the source is an
// explicit, replaceable part: the operator either states a rate or points at a
// JSON price feed, and the oracle refuses to quote when it has neither or when
// a feed has gone quiet. It never invents a rate.
//
// Rates are held as integers: base units of KUSD per base unit of NIGHT,
// multiplied by 10^9. Both assets have six decimals, so this is simply the
// price of one NIGHT in dollars, scaled.

import type { RateSourceConfig } from "../config.ts";
import { notConfigured } from "../http/errors.ts";

/** Every rate is scaled by this. */
export const RATE_SCALE = 1_000_000_000n;

/** Supplies the current rate. */
export interface RateSource {
  /** KUSD base units per NIGHT base unit, times {@link RATE_SCALE}. */
  kusdPerNight(): Promise<bigint>;
}

/**
 * Parse a decimal string into a scaled integer without going through floating
 * point.
 *
 * @param text - Digits with an optional fractional part of at most nine places.
 * @returns The value times {@link RATE_SCALE}.
 * @throws {Error} When the text is not such a decimal or is zero.
 */
export const parseScaledDecimal = (text: string): bigint => {
  const match = /^([0-9]+)(?:\.([0-9]{1,9}))?$/.exec(text.trim());
  if (!match?.[1]) throw new Error(`"${text}" is not a decimal with at most nine places`);
  const fraction = (match[2] ?? "").padEnd(9, "0");
  const value = BigInt(match[1]) * RATE_SCALE + BigInt(fraction);
  if (value <= 0n) throw new Error("a rate must be greater than zero");
  return value;
};

/** A rate the operator stated in configuration. */
export class StaticRateSource implements RateSource {
  readonly #rate: bigint;

  /**
   * Create a source that always answers with one rate.
   *
   * @param kusdPerNight - KUSD per NIGHT as a decimal with at most nine places.
   * @throws {Error} When the text is not such a decimal or is zero.
   */
  constructor(kusdPerNight: string) {
    this.#rate = parseScaledDecimal(kusdPerNight);
  }

  kusdPerNight(): Promise<bigint> {
    return Promise.resolve(this.#rate);
  }
}

/** Options for {@link HttpRateSource}. */
export interface HttpRateOptions {
  readonly url: string;
  /** Dot path to the price in the JSON response, e.g. `data.night.usd` or `rates.0.price`. */
  readonly path: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** How long a fetched rate is reused. */
  readonly ttlMs?: number;
  /** How old a rate may be before the source refuses to answer rather than serve a stale one. */
  readonly maxStaleMs?: number;
}

const pick = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, value);

/** A rate read from a JSON price feed, cached briefly and refused when stale. */
export class HttpRateSource implements RateSource {
  readonly #o: Required<HttpRateOptions>;
  #last: { rate: bigint; at: number } | undefined;

  /**
   * Create a source that reads a JSON price feed.
   *
   * @param options - The feed address, the path to the price, and the cache and staleness limits.
   */
  constructor(options: HttpRateOptions) {
    this.#o = {
      fetchImpl: fetch,
      now: Date.now,
      ttlMs: 30_000,
      maxStaleMs: 300_000,
      ...options,
    };
  }

  async kusdPerNight(): Promise<bigint> {
    const now = this.#o.now();
    if (this.#last && now - this.#last.at < this.#o.ttlMs) return this.#last.rate;
    try {
      const response = await this.#o.fetchImpl(this.#o.url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`the feed answered ${String(response.status)}`);
      const raw = pick(await response.json(), this.#o.path);
      const text =
        typeof raw === "number" && Number.isFinite(raw)
          ? raw.toFixed(9)
          : typeof raw === "string"
            ? raw
            : undefined;
      if (text === undefined) throw new Error(`the feed has no number at "${this.#o.path}"`);
      const rate = parseScaledDecimal(text);
      this.#last = { rate, at: now };
      return rate;
    } catch (error) {
      if (this.#last && now - this.#last.at < this.#o.maxStaleMs) return this.#last.rate;
      throw notConfigured(
        `The rate feed is unavailable and no recent rate is held: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
  }
}

/**
 * Build the rate source the configuration asks for.
 *
 * @param config - The parsed rate settings.
 * @returns The source, or undefined when none is configured.
 */
export const createRateSource = (config: RateSourceConfig): RateSource | undefined => {
  if (config.kind === "static") return new StaticRateSource(config.kusdPerNight);
  if (config.kind === "http") return new HttpRateSource({ url: config.url, path: config.path });
  return undefined;
};

// Fixed-window rate limiting, held in memory.
//
// One process serves the API, so a counter per (class, caller) in a Map is the
// whole mechanism. Counters are dropped when their window ends, and the map is
// swept when it grows, so a flood of distinct callers cannot grow it without
// bound.

import type { Clock } from "../domain/events.ts";

/** The verdict for one request. */
export interface RateVerdict {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Milliseconds since the epoch at which the window resets. */
  readonly resetAt: number;
}

/** A limit: `max` requests per `windowMs`. */
export interface RateRule {
  readonly max: number;
  readonly windowMs: number;
}

const SWEEP_ABOVE = 10_000;

/** Counts requests per key within a window. */
export class RateLimiter {
  readonly #rule: RateRule;
  readonly #clock: Clock;
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  /**
   * Create a limiter for one rule.
   *
   * @param rule - How many requests are allowed per window.
   * @param clock - The source of time, in milliseconds.
   */
  constructor(rule: RateRule, clock: Clock) {
    this.#rule = rule;
    this.#clock = clock;
  }

  /**
   * Count one request.
   *
   * @param key - Who is asking: an address or a merchant id.
   * @returns Whether it is allowed, and the state of the window.
   */
  hit(key: string): RateVerdict {
    const now = this.#clock();
    if (this.#windows.size > SWEEP_ABOVE) {
      for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
    }
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.#rule.windowMs };
      this.#windows.set(key, window);
    }
    window.count++;
    return {
      allowed: window.count <= this.#rule.max,
      limit: this.#rule.max,
      remaining: Math.max(0, this.#rule.max - window.count),
      resetAt: window.resetAt,
    };
  }
}

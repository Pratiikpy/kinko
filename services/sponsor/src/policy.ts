// What the sponsor is willing to pay for, and how often.
//
// A fee sponsor is a wallet that spends money when a stranger asks it to. The only things
// standing between it and an empty balance are the rules in this file, so they are written as
// pure functions over data a caller cannot influence: the decision is made from the transaction
// the sponsor deserialized itself, never from a label the request carried.
//
// Four limits, in the order they bind:
//
//   contracts   the transaction must touch only contracts we operate, and nothing else
//   circuits    every entry point in it must be on the allowlist
//   fee         the DUST it would cost must be under a per-transaction cap
//   rate        and the caller must not have asked too often, or spent too much in total
//
// Nothing here does any I/O, so every rule is testable without a chain, a wallet or a clock.
import type { SponsorRefusalCode, TransactionDescription } from "@kinko/card";

/**
 * Circuits Kinko's sponsor pays for by default.
 *
 * A card paying an invoice: priced in KUSD, or priced in NIGHT and paid in KUSD at the oracle's
 * signed rate. A card holds KUSD and no NIGHT, so it cannot pay a fee, and
 * paying a checkout with a card is the case where the holder has no wallet at all. Everything
 * else a holder does from their own account, which pays its own fees.
 *
 * Deliberately absent:
 *   create_invoice, cancel_invoice   a merchant's calls; a merchant has a wallet
 *   refund_payment                   the merchant pays to refund
 *   moving a card's balance          the holder's own wallet pays, through the connector
 *
 * Extend it with SPONSOR_CIRCUITS rather than editing this list, so what a running sponsor will
 * pay for is visible in its own configuration.
 */
export const DEFAULT_SPONSORED_CIRCUITS: readonly string[] = [
  "settle_invoice",
  "settle_invoice_converted",
];

/**
 *
 */
export interface RateLimitConfig {
  /** Sponsored transactions one caller may land per window. */
  maxRequests: number;
  windowMs: number;
}

/**
 *
 */
export interface SponsorPolicy {
  /** Contract addresses this sponsor pays for. An empty list refuses every request. */
  contracts: readonly string[];
  /** Entry points it pays for. An empty list refuses every request. */
  circuits: readonly string[];
  /** Most DUST, in SPECK, it will pay for one transaction. */
  maxFeeSpeck: bigint;
  /** Most DUST, in SPECK, it will pay in total before refusing everything. */
  budgetSpeck: bigint;
  rateLimit: RateLimitConfig;
  /** How many contract actions one transaction may carry. One call is the normal case. */
  maxActionsPerTransaction: number;
}

/** Five sponsored transactions per minute per client unless configured otherwise. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { maxRequests: 5, windowMs: 60_000 };

/**
 *
 */
export interface PolicyDecision {
  allowed: boolean;
  code?: SponsorRefusalCode;
  reason?: string;
  /** Entry points that were matched, for the log line. */
  circuits: readonly string[];
  contractAddress?: string;
}

const list = (values: readonly string[]): string =>
  values.length === 0 ? "(none)" : values.join(", ");

/**
 * Decides whether a transaction is sponsorable, from the transaction itself.
 *
 * `claimed` is what the caller said it was doing. It is checked *against* the derived entry
 * points rather than trusted: a mismatch is a refusal, because it means either a confused client
 * or someone probing what the allowlist actually keys on.
 *
 * @param policy - What this sponsor pays for.
 * @param description - The calls read out of the transaction itself.
 * @param claimed - The circuit the request named, if any.
 * @returns The decision, with the matched entry points for the log.
 */
export function checkTransaction(
  policy: SponsorPolicy,
  description: TransactionDescription,
  claimed?: string,
): PolicyDecision {
  const circuits = description.circuits;
  const contractAddress = description.contracts[0];

  if (description.hasAdministrativeAction) {
    return {
      allowed: false,
      code: "NOT_A_CONTRACT_CALL",
      reason:
        "the transaction contains a contract deployment or a maintenance update. A sponsor pays " +
        "for user calls to a registry it already knows, never for creating or re-keying one.",
      circuits,
      contractAddress,
    };
  }
  if (description.actions.length === 0 || circuits.length === 0) {
    return {
      allowed: false,
      code: "NOT_A_CONTRACT_CALL",
      reason: "the transaction contains no contract call, so there is nothing to authorise.",
      circuits,
      contractAddress,
    };
  }
  if (description.actions.length > policy.maxActionsPerTransaction) {
    return {
      allowed: false,
      code: "NOT_A_CONTRACT_CALL",
      reason:
        `the transaction carries ${String(description.actions.length)} contract actions; this sponsor pays ` +
        `for at most ${String(policy.maxActionsPerTransaction)}.`,
      circuits,
      contractAddress,
    };
  }

  const strangers = description.contracts.filter((address) => !policy.contracts.includes(address));
  if (strangers.length > 0 || description.contracts.length === 0) {
    return {
      allowed: false,
      code: "CONTRACT_NOT_ALLOWED",
      reason:
        `this sponsor pays only for calls to ${list(policy.contracts)}; the transaction calls ` +
        `${list(description.contracts)}.`,
      circuits,
      contractAddress,
    };
  }

  const refused = circuits.filter((circuit) => !policy.circuits.includes(circuit));
  if (refused.length > 0) {
    return {
      allowed: false,
      code: "CIRCUIT_NOT_ALLOWED",
      reason: `${list(refused)} is not on this sponsor's allowlist (${list(policy.circuits)}).`,
      circuits,
      contractAddress,
    };
  }

  if (claimed !== undefined && claimed !== "" && !circuits.includes(claimed)) {
    return {
      allowed: false,
      code: "CIRCUIT_MISMATCH",
      reason: `the request says "${claimed}" but the transaction calls ${list(circuits)}.`,
      circuits,
      contractAddress,
    };
  }

  return { allowed: true, circuits, contractAddress };
}

/**
 * Whether a fee is within the per-transaction cap and the remaining budget.
 *
 * @param policy - The cap and the budget.
 * @param feeSpeck - What this transaction would cost.
 * @param spentSpeck - What is already spent or reserved.
 * @returns The decision.
 */
export function checkFee(
  policy: SponsorPolicy,
  feeSpeck: bigint,
  spentSpeck: bigint,
): { allowed: boolean; code?: SponsorRefusalCode; reason?: string } {
  if (feeSpeck > policy.maxFeeSpeck) {
    return {
      allowed: false,
      code: "FEE_TOO_LARGE",
      reason: `the transaction would cost ${String(feeSpeck)} SPECK; this sponsor pays at most ${String(policy.maxFeeSpeck)}.`,
    };
  }
  if (spentSpeck + feeSpeck > policy.budgetSpeck) {
    return {
      allowed: false,
      code: "SPONSOR_OUT_OF_DUST",
      reason:
        `this sponsor's budget is ${String(policy.budgetSpeck)} SPECK and it has already paid ${String(spentSpeck)}; ` +
        `${String(feeSpeck)} more would exceed it.`,
    };
  }
  return { allowed: true };
}

// ------------------------------------------------------------------------------- rate limiting

/** Whether one request is within its caller's rate limit. */
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * A fixed-window counter per caller.
 *
 * Fixed rather than sliding on purpose: the failure mode of a fixed window is that a caller can
 * land 2N requests across a window boundary, which for a fee sponsor is a rounding error, and
 * in exchange the state is one integer and one timestamp per caller and the behaviour is
 * obvious from the log. The clock is injected so a test does not have to wait a minute.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  /**
   * @param config - Requests per window.
   * @param now - The clock, injected so tests need not wait.
   */
  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records a request against `caller` and says whether it is allowed.
   *
   * @param caller - The rate-limit bucket.
   * @returns The decision.
   */
  take(caller: string): RateLimitDecision {
    const at = this.now();
    const window = this.windows.get(caller);
    if (window === undefined || at - window.startedAt >= this.config.windowMs) {
      this.windows.set(caller, { startedAt: at, count: 1 });
      return { allowed: true, remaining: this.config.maxRequests - 1, retryAfterSeconds: 0 };
    }
    if (window.count >= this.config.maxRequests) {
      const waitMs = this.config.windowMs - (at - window.startedAt);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    window.count += 1;
    return {
      allowed: true,
      remaining: this.config.maxRequests - window.count,
      retryAfterSeconds: 0,
    };
  }

  /**
   * Gives a request back, for a call that was refused before any DUST was spent.
   *
   * @param caller - The rate-limit bucket.
   */
  refund(caller: string): void {
    const window = this.windows.get(caller);
    if (window && window.count > 0) window.count -= 1;
  }

  /** Drops windows that have expired, so a long-running process does not grow without bound. */
  prune(): void {
    const at = this.now();
    for (const [caller, window] of this.windows) {
      if (at - window.startedAt >= this.config.windowMs) this.windows.delete(caller);
    }
  }

  /** @returns How many callers have an open window. */
  get size(): number {
    return this.windows.size;
  }
}

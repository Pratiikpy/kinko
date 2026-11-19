// The sponsor's configuration, read from the environment and the repository's
// deployment record. Nothing that spends is defaulted: the seed and the budget
// must be stated, because a fee sponsor that inherits either from a constant in
// source is an open faucet waiting for a deploy.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RATE_LIMIT, DEFAULT_SPONSORED_CIRCUITS, type SponsorPolicy } from "./policy.ts";

/**
 * The most one sponsored transaction may cost unless configured: 2 DUST. A card paying an
 * invoice measured 0.73 DUST on a local chain (whose fee overhead is deliberately high), so this
 * leaves headroom for proof size without letting one request take a large bite of the budget.
 */
export const DEFAULT_MAX_FEE_SPECK = 2_000_000_000_000_000n;

/** Everything the entry point needs besides the wallet. */
export interface SponsorConfig {
  readonly policy: SponsorPolicy;
  readonly seed: string;
  readonly port: number;
  readonly host: string;
  readonly allowedOrigins: readonly string[];
  readonly trustedProxies: readonly string[];
  readonly logPath: string;
  readonly debug: boolean;
}

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/**
 * The sponsor's seed: `KINKO_SPONSOR_SEED`, or the file `yarn fund` writes.
 *
 * @param env - The environment.
 * @param secretsDir - The network's secrets directory.
 * @returns The seed, hex or mnemonic.
 * @throws {Error} When neither is present.
 */
export function sponsorSeed(env: Record<string, string | undefined>, secretsDir: string): string {
  const fromEnv = env.KINKO_SPONSOR_SEED?.trim();
  if (fromEnv) return fromEnv;
  const file = join(secretsDir, "sponsor.json");
  if (existsSync(file)) {
    const { seed } = JSON.parse(readFileSync(file, "utf8")) as { seed?: string };
    if (seed) return seed;
  }
  throw new Error(
    `No sponsor wallet: set KINKO_SPONSOR_SEED, or run "yarn workspace @kinko/sponsor fund" to create and fund one at ${file}.`,
  );
}

/**
 * The Kinko pay contract on this network, from the deployment record.
 *
 * @param root - The repository root.
 * @param networkId - The network.
 * @returns Its address, or undefined when Kinko is not deployed there.
 */
export function deployedPayContract(root: string, networkId: string): string | undefined {
  const file = join(root, "deployments", `${networkId}.json`);
  if (!existsSync(file)) return undefined;
  const record = JSON.parse(readFileSync(file, "utf8")) as { pay?: { contractAddress?: string } };
  return record.pay?.contractAddress;
}

/**
 * A positive integer amount from the environment, as a bigint, or the default when unset.
 *
 * @param env - The environment.
 * @param name - The variable.
 * @param fallback - The value when it is unset.
 * @returns The amount.
 * @throws {Error} When the variable is set to anything but plain digits above zero.
 */
function positiveBigInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: bigint,
): bigint {
  const text = env[name]?.trim();
  if (text === undefined || text === "") return fallback;
  if (!/^[0-9]+$/.test(text) || BigInt(text) <= 0n) {
    throw new Error(`${name} must be a positive whole number, got "${text}".`);
  }
  return BigInt(text);
}

/**
 * A limit from the environment: a whole number or the default, never NaN. A bare `Number()` turned
 * `SPONSOR_RATE_MAX=5/min` into NaN, and every comparison against NaN is false, so the limit
 * switched itself off.
 *
 * @param env - The environment.
 * @param name - The variable.
 * @param fallback - The value when it is unset.
 * @param min - The smallest value allowed.
 * @returns The number.
 * @throws {Error} When the variable is set to anything but a whole number of at least `min`.
 */
function wholeNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min = 1,
): number {
  const text = env[name]?.trim();
  if (text === undefined || text === "") return fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${String(min)}, got "${text}".`);
  }
  return value;
}

/**
 * Read the configuration.
 *
 * @param env - The environment.
 * @param root - The repository root, for the deployment record and secrets.
 * @param networkId - The network the sponsor serves.
 * @returns The configuration.
 * @throws {Error} When the budget is missing or not positive, or no contract can be allowlisted.
 */
export function readConfig(
  env: Record<string, string | undefined>,
  root: string,
  networkId: string,
): SponsorConfig {
  const secretsDir = join(env.KINKO_SECRETS_DIR ?? join(root, ".secrets"), networkId);
  const contracts = csv(env.SPONSOR_CONTRACTS);
  if (contracts.length === 0) {
    const pay = deployedPayContract(root, networkId);
    if (pay) contracts.push(pay);
  }
  if (contracts.length === 0) {
    throw new Error(
      `No contract to sponsor: Kinko is not deployed on ${networkId} and SPONSOR_CONTRACTS is empty. ` +
        "A sponsor with no contract allowlist would pay for anything anyone sends it.",
    );
  }
  const budgetText = env.SPONSOR_BUDGET_SPECK?.trim();
  if (!budgetText || !/^[0-9]+$/.test(budgetText) || BigInt(budgetText) <= 0n) {
    throw new Error(
      "SPONSOR_BUDGET_SPECK is required: the total DUST, in SPECK (1 DUST = 10^15 SPECK), this " +
        "process may ever spend. Refusing to start without one.",
    );
  }
  const circuits = csv(env.SPONSOR_CIRCUITS);
  return {
    policy: {
      contracts,
      circuits: circuits.length > 0 ? circuits : [...DEFAULT_SPONSORED_CIRCUITS],
      maxFeeSpeck: positiveBigInt(env, "SPONSOR_MAX_FEE_SPECK", DEFAULT_MAX_FEE_SPECK),
      budgetSpeck: BigInt(budgetText),
      rateLimit: {
        maxRequests: wholeNumber(env, "SPONSOR_RATE_MAX", DEFAULT_RATE_LIMIT.maxRequests),
        windowMs: wholeNumber(env, "SPONSOR_RATE_WINDOW_MS", DEFAULT_RATE_LIMIT.windowMs),
      },
      maxActionsPerTransaction: wholeNumber(env, "SPONSOR_MAX_ACTIONS", 1),
    },
    seed: sponsorSeed(env, secretsDir),
    port: wholeNumber(env, "SPONSOR_PORT", 3300, 0),
    host: env.SPONSOR_HOST ?? "127.0.0.1",
    allowedOrigins: csv(env.SPONSOR_ALLOWED_ORIGINS ?? "*"),
    trustedProxies: csv(env.SPONSOR_TRUSTED_PROXIES),
    logPath: env.SPONSOR_LOG ?? join(secretsDir, "sponsor-ledger.jsonl"),
    debug: env.SPONSOR_DEBUG === "1",
  };
}

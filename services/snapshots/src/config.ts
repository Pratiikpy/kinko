// The snapshot service's configuration, read from the environment. Everything has a default that
// is safe to run with: it spends nothing and serves public data.

import { join } from "node:path";

/** Everything the entry point needs besides the chain. */
export interface SnapshotsConfig {
  readonly port: number;
  readonly host: string;
  readonly allowedOrigins: readonly string[];
  /** How often to take a snapshot, ms. */
  readonly intervalMs: number;
  /** Where the published snapshots are kept. */
  readonly storePath: string;
  /** Where the keeper wallet's secret is kept. Only this process reads it. */
  readonly seedPath: string;
  /** A synced, coin-free wallet's cache or snapshot to start the first snapshot from, if any. */
  readonly bootstrapPath: string | undefined;
}

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/**
 * Read the configuration.
 *
 * @param env - The environment.
 * @param root - The repository root, for the secrets directory.
 * @param networkId - The network the service follows.
 * @returns The configuration.
 * @throws {Error} When the interval is not a positive number of milliseconds.
 */
export function readConfig(
  env: Record<string, string | undefined>,
  root: string,
  networkId: string,
): SnapshotsConfig {
  const dir = join(env.KINKO_SECRETS_DIR ?? join(root, ".secrets"), networkId);
  const intervalMs = Number(env.SNAPSHOTS_INTERVAL_MS ?? 120_000);
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("SNAPSHOTS_INTERVAL_MS must be a positive whole number of milliseconds.");
  }
  return {
    port: Number(env.SNAPSHOTS_PORT ?? 3400),
    host: env.SNAPSHOTS_HOST ?? "127.0.0.1",
    allowedOrigins: csv(env.SNAPSHOTS_ALLOWED_ORIGINS ?? "*"),
    intervalMs,
    storePath: env.SNAPSHOTS_STORE ?? join(dir, "card-snapshots.json"),
    seedPath: env.SNAPSHOTS_SEED_FILE ?? join(dir, "card-snapshots-seed"),
    bootstrapPath: csv(env.SNAPSHOTS_BOOTSTRAP)[0],
  };
}

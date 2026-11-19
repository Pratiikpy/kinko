// Starting the first snapshot from a wallet that has already synced, instead of replaying the whole
// chain: a new deployment on a public network would otherwise wait most of an hour, and spend a
// hosted indexer's request allowance on it, before its first card could open fast.
//
// Any shielded wallet that holds no coin will do: another service's wallet cache, or a snapshot a
// wallet wrote. Its tree is public data and its keys are swapped out, so nothing of that wallet
// is kept. A snapshot that carries a coin, or is for another network, is refused.

import { readFileSync, statSync } from "node:fs";

import { snapshotOffset, snapshotProblem } from "@kinko/card";

import type { StoredSnapshot } from "./store.ts";

/**
 * Read a snapshot to start from.
 *
 * @param path - A wallet cache file (as the wallet SDK writes it, with the shielded snapshot under
 *   `snapshots.shielded`) or a bare shielded snapshot.
 * @param networkId - The network the service follows.
 * @returns The snapshot, ready to publish.
 * @throws {Error} When the file cannot be read, holds no shielded snapshot, or holds one a card
 *   cannot start from.
 */
export function loadBootstrap(path: string, networkId: string): StoredSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read a snapshot from ${path}.`);
  }
  const cache = parsed as { snapshots?: { shielded?: unknown }; savedAt?: unknown } | null;
  const embedded = cache?.snapshots?.shielded;
  const snapshot = typeof embedded === "string" ? embedded : JSON.stringify(parsed);
  const problem = snapshotProblem(snapshot, networkId);
  if (problem !== undefined) throw new Error(`${path}: ${problem}`);
  const saved = typeof cache?.savedAt === "string" ? Date.parse(cache.savedAt) : Number.NaN;
  return {
    offset: snapshotOffset(snapshot),
    takenAt: Number.isNaN(saved) ? statSync(path).mtimeMs : saved,
    snapshot,
  };
}

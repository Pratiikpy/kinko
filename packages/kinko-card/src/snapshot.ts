// Starting a card's shielded wallet from a published snapshot instead of the
// chain's first event.
//
// A wallet that has never synced replays every shielded event the chain has
// recorded, which on a public network is millions of them: a quarter of an hour
// in Chromium and over an hour in Firefox. A card is a new wallet, and nothing
// can have been paid to it before it was made. So a card made at event N needs
// no event before N: it can start from the chain's commitment tree as it stood
// at N, which holds no coin of the card's and is the same public data for every
// card.
//
// That tree is what a synced shielded wallet that holds no coins serializes: its
// snapshot names the keys it was written for and carries the tree as of its
// last applied event. Swapping the keys for the card's is the whole conversion.
// The snapshot is not trusted with anything: a tree that differs from the
// chain's makes the card's proofs fail on the network, which refuses them, so
// the worst a bad snapshot does is leave a card unable to pay until it is
// opened again without one.

import type { CardAddresses } from "./keys.ts";

/** The shielded snapshot format this reads and writes. */
const SNAPSHOT_VERSION = "v1";

/** The fields of a shielded wallet's snapshot this reads. The rest is carried along untouched. */
interface ShieldedSnapshot {
  readonly version?: unknown;
  readonly networkId?: unknown;
  readonly offset?: unknown;
  readonly coinHashes?: unknown;
  readonly publicKeys?: unknown;
}

function parse(snapshot: string): ShieldedSnapshot & Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    throw new Error("The snapshot is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The snapshot is not a wallet snapshot.");
  }
  return parsed as ShieldedSnapshot & Record<string, unknown>;
}

/**
 * The event a snapshot was taken at.
 *
 * @param snapshot - A shielded wallet snapshot, as the wallet serializes it.
 * @returns The id of the last event the snapshot applied, or 0n for a wallet that applied none.
 * @throws {Error} When this is not a snapshot.
 */
export function snapshotOffset(snapshot: string): bigint {
  const { offset } = parse(snapshot);
  if (offset === undefined) return 0n;
  if (typeof offset === "string" || typeof offset === "number") {
    try {
      return BigInt(offset);
    } catch {
      throw new Error("The snapshot's event id is not a number.");
    }
  }
  throw new Error("The snapshot's event id is not a number.");
}

/**
 * Why a snapshot cannot be used to start a card, if it cannot.
 *
 * @param snapshot - A shielded wallet snapshot, as the wallet serializes it.
 * @param networkId - The network the card is on.
 * @returns The reason, or undefined when a card can start from it.
 */
export function snapshotProblem(snapshot: string, networkId: string): string | undefined {
  let parsed: ShieldedSnapshot;
  try {
    parsed = parse(snapshot);
    snapshotOffset(snapshot);
  } catch (error) {
    return error instanceof Error ? error.message : "The snapshot cannot be read.";
  }
  if (parsed.version !== SNAPSHOT_VERSION)
    return "The snapshot is in a format this card cannot read.";
  if (parsed.networkId !== networkId) return "The snapshot is for another network.";
  const hashes = parsed.coinHashes;
  if (typeof hashes !== "object" || hashes === null || Object.keys(hashes).length > 0) {
    return "The snapshot carries coins, so a card cannot start from it.";
  }
  return undefined;
}

/**
 * Turn a coin-free shielded snapshot into a card's own, to start the card's wallet from.
 *
 * @param base - A shielded wallet snapshot taken at some event, of a wallet that held no coin.
 * @param addresses - The card's receiving keys.
 * @param networkId - The network the card is on.
 * @returns The snapshot for the card's wallet, to restore it from.
 * @throws {Error} When the snapshot is not one this can use: another format or network, or one
 *   that carries coins, which would hand the card another wallet's.
 */
export function cardSnapshot(base: string, addresses: CardAddresses, networkId: string): string {
  const problem = snapshotProblem(base, networkId);
  if (problem !== undefined) throw new Error(problem);
  return JSON.stringify({
    ...parse(base),
    publicKeys: {
      coinPublicKey: addresses.coinPublicKey,
      encryptionPublicKey: addresses.encryptionPublicKey,
    },
  });
}

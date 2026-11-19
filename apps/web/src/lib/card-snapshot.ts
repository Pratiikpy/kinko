// A card's start, from Kinko's snapshot service.
//
// A card that has never been opened replays every shielded event the chain has recorded before it
// shows a balance, which on a public network takes a quarter of an hour or more. A card made now
// can hold nothing from before it was made, so it can start from the chain's commitment tree as it
// stood at its birth. The service publishes that tree, and a card carries its birth in its link.
//
// Neither call may stand between a person and their card. Both give up quickly and say nothing
// when the service is absent, slow or wrong; the card then opens the slow way, as it always could.

import { snapshotProblem } from "@kinko/card/snapshot";
import { isBirth } from "@kinko/kinko-pay";

import { NETWORK_ID, SNAPSHOTS_URL } from "./config.ts";

/** How long a card being made waits for its birth. It is a convenience, never a requirement. */
const BIRTH_TIMEOUT_MS = 4_000;
/** How long a card being opened waits for its snapshot before replaying the chain instead. */
const SNAPSHOT_TIMEOUT_MS = 10_000;

async function getJson(path: string, timeoutMs: number): Promise<unknown> {
  if (!SNAPSHOTS_URL) return undefined;
  try {
    const response = await fetch(`${SNAPSHOTS_URL}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? ((await response.json()) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The birth to stamp on a card being made: where the published tree stands now.
 *
 * @returns The birth, or undefined when there is no service or it has nothing yet. A card made
 *   without one opens by replaying the chain.
 */
export async function latestBirth(): Promise<string | undefined> {
  const body = (await getJson("/v1/card-snapshot/latest", BIRTH_TIMEOUT_MS)) as
    { birth?: unknown } | undefined;
  return isBirth(body?.birth) ? body.birth : undefined;
}

/**
 * The snapshot a card made at a birth starts from.
 *
 * @param birth - The card's birth, from its link or the record of its making.
 * @returns The snapshot, or undefined when the card has no birth, the service has none for it, or
 *   what it sent is not usable. The card then replays the chain.
 */
export async function snapshotFor(birth: string | undefined): Promise<string | undefined> {
  if (!isBirth(birth)) return undefined;
  const body = (await getJson(
    `/v1/card-snapshot?birth=${encodeURIComponent(birth)}`,
    SNAPSHOT_TIMEOUT_MS,
  )) as { snapshot?: unknown } | undefined;
  const snapshot = body?.snapshot;
  if (typeof snapshot !== "string") return undefined;
  return snapshotProblem(snapshot, NETWORK_ID) === undefined ? snapshot : undefined;
}

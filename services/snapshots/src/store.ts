// The published snapshots: the chain's shielded commitment tree at a series of events, newest
// last, kept in memory and on disk.
//
// A card made at event N starts from the newest snapshot taken at or before N, so a snapshot is
// never stale for it, only further back than it could be. Retention therefore keeps recent
// snapshots densely, where new cards are made, and older ones thinly, up to a month back. A card
// opened later than that finds none (the newest is always kept) and opens the slow way.
//
// A snapshot is a tree of one chain. A development chain that is reset starts its events again
// from zero, and a snapshot from the old chain would hand a card a tree the new chain never had,
// so the file names the chain it was taken from and is discarded when that is not the chain now.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One published snapshot. */
export interface StoredSnapshot {
  /** The id of the last event the snapshot applied. */
  readonly offset: bigint;
  /** When it was taken, ms since the epoch. */
  readonly takenAt: number;
  /** The shielded wallet snapshot, as the wallet serialized it. */
  readonly snapshot: string;
}

/** How many snapshots to keep, and for how long. */
export interface Retention {
  /** The newest snapshots, all kept. */
  readonly recent: number;
  /** Beyond those, one per this many ms, the latest of each. */
  readonly bucketMs: number;
  /** Anything older than this is dropped, except the newest snapshot, which is always kept. */
  readonly maxAgeMs: number;
}

/** Sixty recent snapshots, then one an hour for thirty days. */
export const DEFAULT_RETENTION: Retention = {
  recent: 60,
  bucketMs: 60 * 60 * 1000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};

interface FileShape {
  readonly chain: string;
  readonly entries: readonly { offset: string; takenAt: number; snapshot: string }[];
}

/** The snapshots of one chain. */
export class SnapshotStore {
  private entries: StoredSnapshot[] = [];

  private constructor(
    private readonly path: string,
    readonly chain: string,
    private readonly retention: Retention,
  ) {}

  /**
   * Open the store, with what the file holds when it was written for this chain.
   *
   * @param path - The store's file.
   * @param chain - The identity of the chain now: its first block's hash.
   * @param retention - How many snapshots to keep.
   * @returns The store. Empty when the file is missing, unreadable, or from another chain.
   */
  static open(
    path: string,
    chain: string,
    retention: Retention = DEFAULT_RETENTION,
  ): SnapshotStore {
    const store = new SnapshotStore(path, chain, retention);
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as FileShape;
      if (file.chain === chain && Array.isArray(file.entries)) {
        const stored: FileShape["entries"] = file.entries;
        store.entries = stored
          .map((e) => ({ offset: BigInt(e.offset), takenAt: e.takenAt, snapshot: e.snapshot }))
          .sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
      }
    } catch {
      // No file, or one that cannot be read: start empty, and the next save replaces it.
    }
    return store;
  }

  /** @returns How many snapshots are held. */
  get size(): number {
    return this.entries.length;
  }

  /** @returns The newest snapshot, or undefined when none is held. */
  latest(): StoredSnapshot | undefined {
    return this.entries.at(-1);
  }

  /**
   * The snapshot a card made at an event starts from.
   *
   * @param upTo - The id of the last event before the card was made.
   * @returns The newest snapshot taken at or before it, or undefined when none is.
   */
  pick(upTo: bigint): StoredSnapshot | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry !== undefined && entry.offset <= upTo) return entry;
    }
    return undefined;
  }

  /**
   * Add a snapshot, if it is further along than the newest, thin the older ones, and write the file.
   *
   * @param entry - The snapshot.
   * @returns True when it was added.
   */
  add(entry: StoredSnapshot): boolean {
    const newest = this.latest();
    if (newest !== undefined && entry.offset <= newest.offset) return false;
    this.entries.push(entry);
    this.thin(entry.takenAt);
    this.save();
    return true;
  }

  private thin(now: number): void {
    const { recent, bucketMs, maxAgeMs } = this.retention;
    const older = this.entries.slice(0, Math.max(0, this.entries.length - recent));
    const kept = new Map<number, StoredSnapshot>();
    for (const entry of older) {
      if (now - entry.takenAt > maxAgeMs) continue;
      kept.set(Math.floor(entry.takenAt / bucketMs), entry);
    }
    this.entries = [
      ...[...kept.values()].sort((a, b) => (a.offset < b.offset ? -1 : 1)),
      ...this.entries.slice(older.length),
    ];
  }

  private save(): void {
    const file: FileShape = {
      chain: this.chain,
      entries: this.entries.map((e) => ({
        offset: e.offset.toString(),
        takenAt: e.takenAt,
        snapshot: e.snapshot,
      })),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

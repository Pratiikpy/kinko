// Takes a snapshot of a wallet that holds no coin, on a timer, and publishes it.
//
// The wallet is a card nobody can pay: its secret is drawn here, kept in a file only this process
// reads, and never shown, so no coin can ever be sent to it and every snapshot it makes is a bare
// commitment tree. A snapshot that nonetheless carries a coin is refused rather than published,
// and the refusal is logged: it would hand every card another wallet's coin.

import { snapshotOffset, snapshotProblem } from "@kinko/card";

import type { SnapshotStore } from "./store.ts";

/** What the keeper needs of its wallet. */
export interface TreeSource {
  /** @returns The wallet's shielded snapshot as of its last applied event. */
  snapshot(): Promise<string>;
}

/** Where the keeper's timer and clock come from, so tests can drive it. */
export interface KeeperOptions {
  readonly store: SnapshotStore;
  readonly source: TreeSource;
  readonly networkId: string;
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** How soon to try again while nothing has been published yet, ms. */
const WARM_UP_MS = 5_000;

/** Publishes the wallet's snapshots as it syncs. */
export class Keeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private active = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  /**
   * @param options - The store to publish to, the wallet to snapshot, and how often.
   */
  constructor(private readonly options: KeeperOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Take one snapshot and publish it if the wallet has moved on.
   *
   * @returns True when a new snapshot was published.
   */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const snapshot = await this.options.source.snapshot();
      const problem = snapshotProblem(snapshot, this.options.networkId);
      if (problem !== undefined) {
        this.log(`REFUSED a snapshot, not publishing it: ${problem}`);
        return false;
      }
      const offset = snapshotOffset(snapshot);
      // Nothing applied yet: this is the start every card already has, and a birth of zero would
      // hand every card made while the wallet catches up the whole chain to replay.
      if (offset === 0n) return false;
      const added = this.options.store.add({ offset, takenAt: this.now(), snapshot });
      if (added) this.log(`published the tree at event ${offset.toString()}`);
      return added;
    } catch (error) {
      this.log(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * Start taking snapshots every interval, the first one now. Until the first is published it
   * tries again every few seconds, so a service that has just started is useful as soon as its
   * wallet has applied its first events.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    const loop = (): void => {
      void this.tick().finally(() => {
        if (!this.active) return;
        const wait =
          this.options.store.size === 0
            ? Math.min(WARM_UP_MS, this.options.intervalMs)
            : this.options.intervalMs;
        this.timer = setTimeout(loop, wait);
        this.timer.unref();
      });
    };
    loop();
  }

  /** Stop taking snapshots. */
  stop(): void {
    this.active = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

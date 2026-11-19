// The chain watcher.
//
// The backend learns that an invoice was paid the way anyone else does: by
// reading `kinko_pay`'s public ledger. It is not told by the payer, who might
// lie, or by the merchant, who might too, because a payer claiming success and
// a merchant claiming failure are exactly the dispute this removes.
//
// Each pass reads the contract once (one indexer request however many sessions
// are waiting), compares every watched session with what the ledger shows, and
// records any difference as events in the same transaction that updates the
// session. Events become webhooks and bot messages; see events.ts.
//
// What the ledger exposes about an invoice is its status, kind, asset, expiry
// and a count of contributions. That is all a session ever learns. In
// particular the watcher cannot say what a payment was worth, and the events it
// emits carry no amount.

import type { ChainInvoice, ChainReader } from "./chain/reader.ts";
import { ChainInvoiceStatus, EventType, SessionStatus } from "./domain/enums.ts";
import { type Clock, type EventRecorder, sessionEventData } from "./domain/events.ts";
import type { Logger } from "./log.ts";
import type { SessionPatch, SessionRecord, Store } from "./store/store.ts";

/** An event the watcher wants recorded, before it has an id. */
export interface PlannedEvent {
  readonly type: EventType;
  /** Extra fields for the payload's `data`. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** What one session's comparison with the chain concluded. */
export interface Decision {
  readonly patch: SessionPatch;
  readonly events: readonly PlannedEvent[];
}

const NO_CHANGE: Decision = { patch: {}, events: [] };

/**
 * Compare a session with the chain and say what changed. Pure: it reads
 * nothing and writes nothing, so every rule below is tested directly.
 *
 * The rules, in the order they apply:
 *  1. An invoice the chain does not know yet leaves a pending session alone,
 *     unless the session has run out of time.
 *  2. More contributions than the session has recorded is a payment, and is
 *     announced once per pass with the new total.
 *  3. A settled or cancelled invoice ends the session. A settled invoice found
 *     after the session expired is still settled: money arrived, so the
 *     merchant is told, flagged `late`.
 *  4. An invoice still open past its deadline (the earlier of the session's and
 *     the invoice's own) expires the session.
 *
 * @param session - The stored session.
 * @param chain - The ledger's view of its invoice, or undefined when absent.
 * @param now - Current time in milliseconds.
 * @returns The patch to apply and the events to record.
 */
export const decide = (
  session: SessionRecord,
  chain: ChainInvoice | undefined,
  now: number,
): Decision => {
  const wasExpired = session.status === SessionStatus.EXPIRED;
  if (!chain) {
    if (session.status === SessionStatus.PENDING && now >= session.expiresAt) {
      return {
        patch: { status: SessionStatus.EXPIRED },
        events: [{ type: EventType.EXPIRED, extra: {} }],
      };
    }
    return NO_CHANGE;
  }

  const patch: { -readonly [K in keyof SessionPatch]: SessionPatch[K] } = {};
  const events: PlannedEvent[] = [];
  if (!session.onChain) patch.onChain = true;
  if (session.kind !== chain.kind) patch.kind = chain.kind;
  if (session.token !== chain.token) patch.token = chain.token;
  if (session.chainExpiresAt !== chain.expiresAt) patch.chainExpiresAt = chain.expiresAt;

  if (chain.contributions > session.contributions) {
    patch.contributions = chain.contributions;
    events.push({
      type: EventType.PAYMENT_RECEIVED,
      extra: {
        contributions: chain.contributions,
        newPayments: chain.contributions - session.contributions,
        ...(wasExpired ? { late: true } : {}),
      },
    });
  }

  if (chain.status === ChainInvoiceStatus.SETTLED) {
    patch.status = SessionStatus.SETTLED;
    patch.settledAt = now;
    patch.late = wasExpired;
    events.push({ type: EventType.SETTLED, extra: { late: wasExpired } });
  } else if (chain.status === ChainInvoiceStatus.CANCELLED) {
    // A cancellation after the session lapsed changes nothing the merchant needs to hear.
    if (!wasExpired) {
      patch.status = SessionStatus.CANCELLED;
      events.push({ type: EventType.CANCELLED, extra: {} });
    }
  } else if (session.status === SessionStatus.PENDING) {
    const deadline = Math.min(session.expiresAt, chain.expiresAt ?? Number.POSITIVE_INFINITY);
    if (now >= deadline) {
      patch.status = SessionStatus.EXPIRED;
      events.push({ type: EventType.EXPIRED, extra: {} });
    }
  }
  return { patch, events };
};

/** Counters and timestamps for /health. */
export interface WatcherStats {
  passes: number;
  lastPassAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  payments: number;
  settled: number;
  cancelled: number;
  expired: number;
}

/** Options for {@link Watcher}. */
export interface WatcherOptions {
  readonly store: Store;
  readonly reader: ChainReader;
  readonly events: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  readonly pollMs: number;
  /** How long past expiry a session is still watched for a late payment. */
  readonly lateSettlementMs: number;
}

/** Polls the chain and moves sessions through their states. */
export class Watcher {
  readonly stats: WatcherStats = {
    passes: 0,
    lastPassAt: null,
    lastSuccessAt: null,
    lastError: null,
    payments: 0,
    settled: 0,
    cancelled: 0,
    expired: 0,
  };
  readonly #o: WatcherOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  /**
   * Create a watcher.
   *
   * @param options - The store, the chain reader, the event recorder and the timings.
   */
  constructor(options: WatcherOptions) {
    this.#o = options;
  }

  /** Begin polling. The first pass runs immediately. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const loop = (): void => {
      this.#running = this.tick()
        .catch((error: unknown) => {
          this.#o.log.error("watcher pass failed", { error });
        })
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, this.#o.pollMs);
        });
    };
    loop();
  }

  /** Stop polling and wait for a pass in progress to finish. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /**
   * One pass over everything waiting. An unreachable chain is recorded and
   * retried next pass; it never throws, so the loop cannot die of it.
   */
  async tick(): Promise<void> {
    const { store, reader, clock, log } = this.#o;
    const now = clock();
    this.stats.passes++;
    this.stats.lastPassAt = now;

    for (const draft of store.expirableDrafts(now))
      this.#apply(draft, {
        patch: { status: SessionStatus.EXPIRED },
        events: [{ type: EventType.EXPIRED, extra: {} }],
      });

    const watched = store.watchableSessions(now, this.#o.lateSettlementMs);
    if (watched.length === 0) {
      this.stats.lastSuccessAt = now;
      return;
    }
    let snapshot;
    try {
      snapshot = await reader.snapshot({ fresh: true });
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      log.warn("the chain could not be read; will retry", { error });
      return;
    }
    for (const session of watched) {
      try {
        // `commitment` is non-null for everything `watchableSessions` returns.
        const chain =
          session.commitment === null ? undefined : snapshot.invoice(session.commitment);
        this.#apply(session, decide(session, chain, now));
      } catch (error) {
        log.error("a session could not be updated", { session: session.id, error });
      }
    }
    this.stats.lastSuccessAt = now;
    this.stats.lastError = null;
  }

  #apply(session: SessionRecord, decision: Decision): void {
    if (Object.keys(decision.patch).length === 0 && decision.events.length === 0) return;
    const { store, events, log } = this.#o;
    store.transaction(() => {
      const updated = store.updateSession(session.id, decision.patch);
      if (!updated) return;
      for (const planned of decision.events) {
        events.record(
          session.merchantId,
          session.id,
          planned.type,
          sessionEventData(updated, planned.extra),
        );
        this.#count(planned.type);
        log.info("session changed", {
          session: session.id,
          event: planned.type,
          status: updated.status,
        });
      }
    });
  }

  #count(type: EventType): void {
    if (type === EventType.PAYMENT_RECEIVED) this.stats.payments++;
    else if (type === EventType.SETTLED) this.stats.settled++;
    else if (type === EventType.CANCELLED) this.stats.cancelled++;
    else if (type === EventType.EXPIRED) this.stats.expired++;
  }
}

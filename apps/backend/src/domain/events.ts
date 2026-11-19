// Recording what happened.
//
// An event is written in the same transaction as the state change it
// announces, together with its webhook delivery row. That is the outbox
// pattern: the change and the promise to tell the merchant about it commit
// together or not at all, so a crash can never leave a settled session whose
// webhook was never queued, and a retry can never queue it twice.

import type { EventRecord, SessionRecord, Store } from "../store/store.ts";
import { newId } from "./crypto.ts";
import { DeliveryStatus, type EventType } from "./enums.ts";

/** Milliseconds since the epoch. Injectable so tests control time. */
export type Clock = () => number;

/** The JSON a webhook delivers and the bot reads. */
export interface EventPayload {
  readonly id: string;
  readonly type: EventType;
  readonly createdAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * What an event says about a session. Titles and references are what the
 * merchant chose to attach; there is deliberately no amount.
 *
 * @param session - The session after the change.
 * @param extra - Event-specific fields.
 * @returns The `data` object of the payload.
 */
export const sessionEventData = (
  session: SessionRecord,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  sessionId: session.id,
  commitment: session.commitment,
  status: session.status,
  kind: session.kind,
  asset: session.token,
  title: session.title,
  clientReference: session.clientReference,
  contributions: session.contributions,
  late: session.late,
  ...extra,
});

/** Writes events and queues their deliveries. */
export class EventRecorder {
  readonly #store: Store;
  readonly #clock: Clock;

  /**
   * Create a recorder.
   *
   * @param store - Where events and deliveries are written.
   * @param clock - The source of time, in milliseconds.
   */
  constructor(store: Store, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  /**
   * Record an event for a merchant and, if they have a webhook URL, queue its
   * delivery. Call inside the transaction that changes the state it describes.
   *
   * @param merchantId - Whose event it is.
   * @param sessionId - The session it concerns, if any.
   * @param type - What happened.
   * @param data - The payload's `data` object.
   * @returns The stored event.
   */
  record(
    merchantId: string,
    sessionId: string | null,
    type: EventType,
    data: Readonly<Record<string, unknown>>,
  ): EventRecord {
    const now = this.#clock();
    const id = newId("evt");
    const payload: EventPayload = { id, type, createdAt: new Date(now).toISOString(), data };
    const event = this.#store.insertEvent({
      id,
      merchantId,
      sessionId,
      type,
      body: JSON.stringify(payload),
      createdAt: now,
    });
    if (this.#store.getMerchant(merchantId)?.webhookUrl) {
      this.#store.insertDelivery({
        id: newId("dlv"),
        eventSeq: event.seq,
        merchantId,
        status: DeliveryStatus.PENDING,
        attempts: 0,
        nextAttemptAt: now,
        lastHttpStatus: null,
        lastError: null,
        createdAt: now,
        deliveredAt: null,
      });
    }
    return event;
  }
}

// Delivers queued webhooks, signed, with retries.
//
// Delivery is at least once: a receiver that answers slowly or not at all will
// see the same event again, so it carries a stable id (`Kinko-Event-Id`) for
// deduplication. Each attempt is signed afresh with the current timestamp so a
// receiver's replay window applies to the attempt, not to the original event.

import type { Vault } from "../domain/crypto.ts";
import { DeliveryStatus } from "../domain/enums.ts";
import type { Clock } from "../domain/events.ts";
import { SIGNATURE_HEADER, signHeader } from "../domain/signing.ts";
import type { Logger } from "../log.ts";
import type { DeliveryRecord, EventRecord, MerchantRecord, Store } from "../store/store.ts";
import type { Deliverer } from "./http-deliverer.ts";
import { checkWebhookUrl } from "./url-policy.ts";

/** Wait before each retry, after the first attempt fails: ten attempts over about 23 hours. */
export const RETRY_DELAYS_MS: readonly number[] = [
  10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000,
];

/** Total attempts before a delivery is given up on. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** How many deliveries one pass picks up. */
const BATCH = 25;

/** Options for {@link WebhookDispatcher}. */
export interface DispatcherOptions {
  readonly store: Store;
  readonly vault: Vault;
  readonly deliverer: Deliverer;
  readonly clock: Clock;
  readonly log: Logger;
  readonly timeoutMs: number;
  readonly allowPrivateTargets: boolean;
  /** How often the background loop looks for due deliveries. */
  readonly intervalMs?: number;
}

/** The result of one attempt. */
export interface AttemptOutcome {
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly error: string | null;
}

/** Counters for /health. */
export interface DispatcherStats {
  attempts: number;
  delivered: number;
  failedPermanently: number;
}

/** Sends webhooks and records how each attempt went. */
export class WebhookDispatcher {
  readonly stats: DispatcherStats = { attempts: 0, delivered: 0, failedPermanently: 0 };
  readonly #o: DispatcherOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  /**
   * Create a dispatcher.
   *
   * @param options - The store, the vault, the deliverer and the timings.
   */
  constructor(options: DispatcherOptions) {
    this.#o = options;
  }

  /** Begin the background loop. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const loop = (): void => {
      this.#running = this.tick()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#o.log.error("webhook pass failed", { error });
        })
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, this.#o.intervalMs ?? 2_000);
        });
    };
    loop();
  }

  /** Stop the loop and wait for a pass in progress to finish. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /**
   * One pass: attempt every delivery that is due.
   *
   * @returns How many deliveries were attempted.
   */
  async tick(): Promise<number> {
    const due = this.#o.store.dueDeliveries(this.#o.clock(), BATCH);
    for (const delivery of due) {
      try {
        await this.#attempt(delivery);
      } catch (error) {
        this.#o.log.error("webhook attempt crashed", { delivery: delivery.id, error });
      }
    }
    return due.length;
  }

  /**
   * Send one event to a merchant's endpoint immediately, without queueing or
   * retrying. Used by the "send a test event" route so a merchant sees the
   * outcome of their configuration at once.
   *
   * @param merchant - The merchant whose endpoint to call.
   * @param event - The event to send.
   * @returns How the attempt went.
   */
  sendNow(merchant: MerchantRecord, event: EventRecord): Promise<AttemptOutcome> {
    return this.#send(merchant, event, 1);
  }

  async #attempt(delivery: DeliveryRecord): Promise<void> {
    const { store, clock } = this.#o;
    const event = store.getEvent(delivery.eventSeq);
    const merchant = store.getMerchant(delivery.merchantId);
    const attempts = delivery.attempts + 1;
    if (!event || !merchant) {
      store.updateDelivery(delivery.id, {
        status: DeliveryStatus.FAILED,
        attempts,
        lastError: "event or merchant no longer exists",
      });
      return;
    }
    const outcome = await this.#send(merchant, event, attempts);
    this.stats.attempts++;
    if (outcome.ok) {
      this.stats.delivered++;
      store.updateDelivery(delivery.id, {
        status: DeliveryStatus.DELIVERED,
        attempts,
        lastHttpStatus: outcome.httpStatus,
        lastError: null,
        deliveredAt: clock(),
      });
      return;
    }
    const delay = RETRY_DELAYS_MS[attempts - 1];
    if (delay === undefined) {
      this.stats.failedPermanently++;
      this.#o.log.warn("webhook gave up", {
        delivery: delivery.id,
        merchant: merchant.id,
        attempts,
      });
    }
    store.updateDelivery(delivery.id, {
      status: delay === undefined ? DeliveryStatus.FAILED : DeliveryStatus.PENDING,
      attempts,
      nextAttemptAt: delay === undefined ? delivery.nextAttemptAt : clock() + delay,
      lastHttpStatus: outcome.httpStatus,
      lastError: outcome.error,
    });
  }

  async #send(
    merchant: MerchantRecord,
    event: EventRecord,
    attempt: number,
  ): Promise<AttemptOutcome> {
    const { vault, deliverer, clock, timeoutMs, allowPrivateTargets } = this.#o;
    if (!merchant.webhookUrl)
      return { ok: false, httpStatus: null, error: "no webhook URL is configured" };
    const refused = checkWebhookUrl(merchant.webhookUrl, { allowPrivateTargets });
    if (refused) return { ok: false, httpStatus: null, error: `webhook URL ${refused}` };
    let secret: string;
    try {
      secret = vault.open(merchant.webhookSecretSealed);
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        error: error instanceof Error ? error.message : "the signing secret could not be opened",
      };
    }
    try {
      const response = await deliverer.deliver({
        url: merchant.webhookUrl,
        timeoutMs,
        body: event.body,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Kinko-Webhooks/1",
          [SIGNATURE_HEADER]: signHeader(secret, event.body, clock()),
          "Kinko-Event-Id": event.id,
          "Kinko-Event-Type": event.type,
          "Kinko-Delivery-Attempt": String(attempt),
        },
      });
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        httpStatus: response.status,
        error: ok ? null : `the receiver answered ${String(response.status)}`,
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        error: error instanceof Error ? error.message : "delivery failed",
      };
    }
  }
}

// Telling a merchant their invoice was paid.
//
// The backend records every settlement, cancellation and expiry as an event and
// says which chats to tell. The bot reads that feed from a cursor it has saved,
// sends each message, and only then moves the cursor on, so a restart repeats
// at worst the last message and never skips one.
//
// A chat that has blocked the bot is unlinked, so the backend stops queueing
// for it. A failure that may pass (Telegram's rate limit, a network blip)
// stops the pass where it is and is retried whole on the next one.

import { type Backend, BackendError, type BotEvent } from "./backend.ts";
import { describeEvent } from "./format.ts";
import type { CursorStore } from "./state.ts";
import { type TelegramApi, TelegramError } from "./telegram.ts";

/** Counters, so a quiet bot can be told from a broken one. */
export interface NotifierStats {
  passes: number;
  sent: number;
  unlinked: number;
  failures: number;
}

/** Options for {@link Notifier}. */
export interface NotifierOptions {
  readonly backend: Backend;
  readonly telegram: TelegramApi;
  readonly cursor: CursorStore;
  readonly intervalMs: number;
  readonly log?: (message: string) => void;
}

/** Reads the event feed and sends messages. */
export class Notifier {
  readonly stats: NotifierStats = { passes: 0, sent: 0, unlinked: 0, failures: 0 };
  readonly #o: NotifierOptions;
  #cursor: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;
  #pauseUntil = 0;

  /**
   * Create a notifier.
   *
   * @param options - The backend, Telegram, the saved cursor and the poll interval.
   */
  constructor(options: NotifierOptions) {
    this.#o = options;
  }

  /** Begin polling. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const loop = (): void => {
      this.#running = this.tick()
        .then(() => undefined)
        .catch((error: unknown) =>
          this.#o.log?.(
            `notification pass failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, this.#o.intervalMs);
        });
    };
    loop();
  }

  /** Stop polling and wait for a pass in progress. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /**
   * One pass over the feed.
   *
   * @param now - Current time in milliseconds; injectable for tests.
   * @returns How many events were handled.
   */
  async tick(now: number = Date.now()): Promise<number> {
    this.stats.passes++;
    if (now < this.#pauseUntil) return 0;
    const { backend, cursor } = this.#o;
    try {
      let position = this.#cursor;
      if (position === undefined) {
        // Without a saved cursor, start at the newest event: history from before
        // the bot ran must never be replayed into a chat.
        const saved = await cursor.load();
        position = saved ?? (await backend.cursor());
        if (saved === undefined) await cursor.save(position);
      }
      const feed = await backend.events(position, 100);
      let handled = 0;
      for (const event of feed.data) {
        await this.#notify(event, now);
        // Moved on only after every chat for this event has been dealt with.
        position = event.seq;
        this.#cursor = position;
        await cursor.save(position);
        handled++;
      }
      if (feed.data.length === 0 && feed.nextAfter > position) {
        this.#cursor = feed.nextAfter;
        await cursor.save(feed.nextAfter);
      } else {
        this.#cursor = position;
      }
      return handled;
    } catch (error) {
      this.stats.failures++;
      if (error instanceof BackendError || error instanceof TelegramError) {
        this.#o.log?.(`could not finish a notification pass: ${error.message}`);
        return 0;
      }
      throw error;
    }
  }

  async #notify(event: BotEvent, now: number): Promise<void> {
    const text = describeEvent(event);
    if (text === undefined) return;
    const { backend, telegram } = this.#o;
    for (const chatId of event.chatIds) {
      try {
        await telegram.sendMessage(chatId, text);
        this.stats.sent++;
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        if (error.code === 403 || (error.code === 400 && /chat not found/i.test(error.message))) {
          // The chat blocked the bot or no longer exists: stop queueing for it.
          await backend.unlink(chatId);
          this.stats.unlinked++;
          this.#o.log?.(`chat ${String(chatId)} is unreachable; unlinked it`);
          continue;
        }
        if (error.code === 429) this.#pauseUntil = now + (error.retryAfter ?? 5) * 1000;
        throw error;
      }
    }
  }
}

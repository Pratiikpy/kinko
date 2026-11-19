// The update loop: read what people send, answer it.

import type { Backend } from "./backend.ts";
import { COMMANDS, handleMessage, type Reply } from "./commands.ts";
import { type TelegramApi, TelegramError, type TelegramUpdate } from "./telegram.ts";

/** Options for {@link KinkoBot}. */
export interface BotOptions {
  readonly telegram: TelegramApi;
  readonly backend: Backend;
  readonly pollSeconds: number;
  readonly log?: (message: string) => void;
  /** Pause between failed polls; injectable so tests do not wait. */
  readonly retryDelayMs?: number;
}

/** Answers messages. */
export class KinkoBot {
  readonly #o: BotOptions;
  #username = "";
  #offset = 0;
  #running = false;

  #active(): boolean {
    return this.#running;
  }

  /**
   * Create the bot.
   *
   * @param options - Telegram, the backend and the poll length.
   */
  constructor(options: BotOptions) {
    this.#o = options;
  }

  /**
   * Connect to Telegram and publish the command menu.
   *
   * @returns The bot's username.
   * @throws {TelegramError} When the token is refused.
   */
  async init(): Promise<string> {
    const me = await this.#o.telegram.getMe();
    this.#username = me.username;
    await this.#o.telegram.setMyCommands(COMMANDS);
    return this.#username;
  }

  /**
   * Handle a batch of updates.
   *
   * @param updates - From `getUpdates`.
   */
  async processUpdates(updates: readonly TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      this.#offset = Math.max(this.#offset, update.update_id + 1);
      const message = update.message ?? update.edited_message;
      if (!message) continue;
      let reply: Reply | undefined;
      try {
        reply = await handleMessage(message, {
          backend: this.#o.backend,
          username: this.#username,
        });
      } catch (error) {
        // One bad message must not end the process; the person is told something went wrong.
        this.#o.log?.(`handling failed: ${error instanceof Error ? error.message : String(error)}`);
        reply = { text: "Something went wrong on my side. Try again in a moment." };
      }
      if (reply) await this.#send(message.chat.id, reply);
    }
  }

  async #send(chatId: number, reply: Reply): Promise<void> {
    const { telegram, log } = this.#o;
    try {
      await telegram.sendMessage(chatId, reply.text, reply.buttons);
    } catch (error) {
      // Telegram refuses buttons whose URL it does not accept, such as a local
      // http address. The links are still wanted, so they go in the text.
      if (
        error instanceof TelegramError &&
        error.code === 400 &&
        reply.buttons &&
        reply.buttons.length > 0
      ) {
        const links = reply.buttons.map((b) => `${b.text}: ${b.url}`).join("\n");
        await telegram
          .sendMessage(chatId, `${reply.text}\n\n${links}`)
          .catch((e: unknown) =>
            log?.(`reply failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        return;
      }
      log?.(`reply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Poll until `stop` is called. */
  async run(): Promise<void> {
    this.#running = true;
    while (this.#active()) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.#o.telegram.getUpdates(this.#offset, this.#o.pollSeconds);
      } catch (error) {
        this.#o.log?.(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, this.#o.retryDelayMs ?? 3_000));
        continue;
      }
      await this.processUpdates(updates);
    }
  }

  /** Ask the loop to end after the current poll. */
  stop(): void {
    this.#running = false;
  }
}

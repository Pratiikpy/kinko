// A minimal Telegram Bot API client.
//
// Written against `fetch` rather than a bot framework: the surface used is five
// methods, and a dependency that ships its own HTTP stack, event emitter and
// polling loop is a poor trade for that. Long polling rather than webhooks, so
// the bot runs from anywhere, including behind a laptop's NAT.

/** A Telegram message, with only the fields the bot reads. */
export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number; readonly type: string };
  readonly text?: string;
  readonly from?: { readonly id: number; readonly is_bot: boolean; readonly username?: string };
}

/** One update from `getUpdates`. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
}

/** An inline button that opens a URL. */
export interface InlineButton {
  readonly text: string;
  readonly url: string;
}

/** A failure reported by Telegram. */
export class TelegramError extends Error {
  readonly code: number;
  /** Seconds Telegram asks us to wait, on a 429. */
  readonly retryAfter: number | undefined;

  /**
   * Create the error.
   *
   * @param method - The Telegram method that failed.
   * @param code - Telegram's error code, or 0 for a network failure.
   * @param description - Telegram's description of the failure.
   * @param retryAfter - Seconds Telegram asks us to wait, on a 429.
   */
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`${method} failed (${String(code)}): ${description}`);
    this.name = "TelegramError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** What the bot needs from Telegram. A fake implements this in tests. */
export interface TelegramApi {
  /**
   * Ask Telegram who this bot is.
   *
   * @returns The bot's id and username.
   */
  getMe(): Promise<{ readonly id: number; readonly username: string }>;
  /**
   * Wait for updates.
   *
   * @param offset - The first update id to return.
   * @param timeoutSeconds - How long Telegram may hold the request open.
   * @returns The updates, possibly none.
   */
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  /**
   * Send a message.
   *
   * @param chatId - The chat to send to.
   * @param text - The message, as plain text.
   * @param buttons - Buttons that open links.
   */
  sendMessage(chatId: number, text: string, buttons?: readonly InlineButton[]): Promise<void>;
  /**
   * Publish the command menu.
   *
   * @param commands - Each command and a line describing it.
   */
  setMyCommands(
    commands: readonly { readonly command: string; readonly description: string }[],
  ): Promise<void>;
}

/** The real client. */
export class TelegramClient implements TelegramApi {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  /**
   * Create the client.
   *
   * @param token - The bot token.
   * @param fetchImpl - The fetch to use; injectable for tests.
   * @throws {Error} When the token is empty.
   */
  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    if (!token) throw new Error("A bot token is required.");
    this.#base = `https://api.telegram.org/bot${token}`;
    this.#fetch = fetchImpl;
  }

  async #call<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // A long poll holds the connection open on purpose, so the timeout exceeds the poll window.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The URL contains the token, so the error's own message must never be passed on.
      throw new TelegramError(
        method,
        0,
        error instanceof Error && error.name === "TimeoutError"
          ? "no answer in time"
          : "network error",
      );
    }
    const payload = (await response.json().catch(() => ({ ok: false }))) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (!payload.ok) {
      throw new TelegramError(
        method,
        payload.error_code ?? response.status,
        payload.description ?? "unknown error",
        payload.parameters?.retry_after,
      );
    }
    return payload.result as T;
  }

  /** @inheritdoc */
  getMe(): Promise<{ id: number; username: string }> {
    return this.#call("getMe", {}, 20_000);
  }

  /** @inheritdoc */
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.#call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      (timeoutSeconds + 15) * 1000,
    );
  }

  /** @inheritdoc */
  async sendMessage(
    chatId: number,
    text: string,
    buttons?: readonly InlineButton[],
  ): Promise<void> {
    await this.#call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        // A preview of a payment or checkout link would render its contents into the chat.
        link_preview_options: { is_disabled: true },
        ...(buttons && buttons.length > 0
          ? {
              reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) },
            }
          : {}),
      },
      20_000,
    );
  }

  /** @inheritdoc */
  async setMyCommands(
    commands: readonly { command: string; description: string }[],
  ): Promise<void> {
    await this.#call("setMyCommands", { commands }, 20_000);
  }
}

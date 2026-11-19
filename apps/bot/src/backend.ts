// The bot's connection to the Kinko backend.
//
// The bot holds no merchant key. It presents one service token, names a chat,
// and the backend decides which merchant that chat is linked to. A chat that
// was never linked can do nothing.

/** A checkout session as the backend shows it to the bot. */
export interface SessionView {
  readonly id: string;
  readonly status: string;
  readonly commitment: string | null;
  readonly kind: string;
  readonly asset: string;
  readonly title: string | null;
  readonly clientReference: string | null;
  readonly contributions: number;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly late: boolean;
  readonly checkoutUrl: string;
}

/** The merchant a chat is linked to, with a count of their sessions by status. */
export interface Account {
  readonly merchant: { readonly id: string; readonly name: string };
  readonly sessions: Readonly<Record<string, number>>;
}

/** One event from the feed. It never carries an amount. */
export interface BotEvent {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly merchant: { readonly id: string; readonly name: string };
  /** The chats to tell. */
  readonly chatIds: readonly number[];
  readonly data: {
    readonly sessionId?: string;
    readonly commitment?: string | null;
    readonly title?: string | null;
    readonly clientReference?: string | null;
    readonly contributions?: number;
    readonly newPayments?: number;
    readonly late?: boolean;
    readonly kind?: string;
    readonly asset?: string;
  };
}

/** What the bot asks of the backend. A fake implements this in tests. */
export interface Backend {
  /**
   * Link a chat to a merchant with a code from them.
   *
   * @param code - The code the merchant was given.
   * @param chatId - The Telegram chat to link.
   * @returns The merchant now linked to the chat.
   * @throws {BackendError} When the code is not valid.
   */
  link(code: string, chatId: number): Promise<{ readonly id: string; readonly name: string }>;
  /**
   * Unlink a chat.
   *
   * @param chatId - The Telegram chat.
   * @returns Whether the chat had been linked.
   */
  unlink(chatId: number): Promise<boolean>;
  /** The chat's account, or null when it is not linked. */
  account(chatId: number): Promise<Account | null>;
  /**
   * List the linked merchant's recent invoices, newest first.
   *
   * @param chatId - The Telegram chat.
   * @param query - An optional status filter and a page size.
   * @param query.status - Only invoices in this state.
   * @param query.limit - The most to return.
   * @returns The invoices.
   */
  listSessions(
    chatId: number,
    query: { readonly status?: string; readonly limit: number },
  ): Promise<readonly SessionView[]>;
  /** One session by id, commitment or at least eight characters of one; null when none matches. */
  findSession(chatId: number, reference: string): Promise<SessionView | null>;
  /**
   * Start an invoice the merchant's wallet will finish.
   *
   * @param chatId - The Telegram chat.
   * @param draft - An optional title and kind.
   * @param draft.title - A name for the invoice.
   * @param draft.kind - standard, multipay or donation.
   * @returns The draft and the web app address that finishes it.
   */
  createDraft(
    chatId: number,
    draft: { readonly title?: string; readonly kind?: string },
  ): Promise<{ readonly session: SessionView; readonly formUrl: string }>;
  /** The newest event's sequence number: where to start listening. */
  cursor(): Promise<number>;
  /**
   * Read events after a position.
   *
   * @param after - The sequence number of the last event already handled.
   * @param limit - The most to return.
   * @returns The events, oldest first, and where to read from next.
   */
  events(
    after: number,
    limit: number,
  ): Promise<{ readonly data: readonly BotEvent[]; readonly nextAfter: number }>;
  /** The web app's address, for links back to it. */
  appUrl(): Promise<string>;
}

/** The backend answered with an error, or could not be reached. */
export class BackendError extends Error {
  readonly status: number;
  readonly code: string;

  /**
   * Create the error.
   *
   * @param status - The HTTP status, or 0 when the backend could not be reached.
   * @param code - The backend's machine-readable code.
   * @param message - The backend's own words.
   */
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

/** The real connection. */
export class HttpBackend implements Backend {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  #appUrl: Promise<string> | undefined;

  /**
   * Create a connection.
   *
   * @param baseUrl - The backend's address.
   * @param serviceToken - The token the backend knows this bot by.
   * @param fetchImpl - The fetch to use; injectable for tests.
   */
  constructor(baseUrl: string, serviceToken: string, fetchImpl: typeof fetch = fetch) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#token = serviceToken;
    this.#fetch = fetchImpl;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    authenticated = true,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(authenticated ? { Authorization: `Bearer ${this.#token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new BackendError(
        0,
        "network_error",
        `Could not reach the Kinko backend: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    const parsed = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; message?: string } } | undefined;
    if (!response.ok) {
      throw new BackendError(
        response.status,
        parsed?.error?.code ?? "http_error",
        parsed?.error?.message ?? `The backend answered ${String(response.status)}.`,
      );
    }
    return parsed as T;
  }

  /** @inheritdoc */
  async link(code: string, chatId: number): Promise<{ id: string; name: string }> {
    return (
      await this.#request<{ merchant: { id: string; name: string } }>("POST", "/v1/bot/link", {
        code,
        chatId,
      })
    ).merchant;
  }

  /** @inheritdoc */
  async unlink(chatId: number): Promise<boolean> {
    return (
      await this.#request<{ unlinked: boolean }>("POST", `/v1/bot/chats/${String(chatId)}/unlink`)
    ).unlinked;
  }

  async account(chatId: number): Promise<Account | null> {
    try {
      return await this.#request<Account>("GET", `/v1/bot/chats/${String(chatId)}`);
    } catch (error) {
      if (error instanceof BackendError && error.status === 404) return null;
      throw error;
    }
  }

  /** @inheritdoc */
  async listSessions(
    chatId: number,
    query: { status?: string; limit: number },
  ): Promise<SessionView[]> {
    const params = new URLSearchParams({
      limit: String(query.limit),
      ...(query.status ? { status: query.status } : {}),
    });
    return (
      await this.#request<{ data: SessionView[] }>(
        "GET",
        `/v1/bot/chats/${String(chatId)}/sessions?${params.toString()}`,
      )
    ).data;
  }

  async findSession(chatId: number, reference: string): Promise<SessionView | null> {
    try {
      return (
        await this.#request<{ session: SessionView }>(
          "GET",
          `/v1/bot/chats/${String(chatId)}/sessions/${encodeURIComponent(reference)}`,
        )
      ).session;
    } catch (error) {
      if (error instanceof BackendError && error.status === 404) return null;
      throw error;
    }
  }

  /** @inheritdoc */
  createDraft(
    chatId: number,
    draft: { title?: string; kind?: string },
  ): Promise<{ session: SessionView; formUrl: string }> {
    return this.#request("POST", `/v1/bot/chats/${String(chatId)}/sessions`, draft);
  }

  async cursor(): Promise<number> {
    return (await this.#request<{ seq: number }>("GET", "/v1/bot/cursor")).seq;
  }

  /** @inheritdoc */
  events(after: number, limit: number): Promise<{ data: BotEvent[]; nextAfter: number }> {
    return this.#request("GET", `/v1/bot/events?after=${String(after)}&limit=${String(limit)}`);
  }

  appUrl(): Promise<string> {
    this.#appUrl ??= this.#request<{ appUrl: string }>("GET", "/v1/config", undefined, false)
      .then((c) => c.appUrl.replace(/\/+$/, ""))
      .catch((error: unknown) => {
        this.#appUrl = undefined;
        throw error;
      });
    return this.#appUrl;
  }
}

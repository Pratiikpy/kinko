// The SDK's HTTP layer: one request function, one error type.

/** Thrown when the backend answers with an error, or cannot be reached. */
export class KinkoApiError extends Error {
  /** The HTTP status, or 0 when no answer was received. */
  readonly status: number;
  /** The backend's machine-readable code, such as `invalid_request`; `network_error` or `timeout` for local failures. */
  readonly code: string;
  /** Structured detail, such as which fields failed validation. */
  readonly details: unknown;
  /** Quote this when asking for help. */
  readonly requestId: string | undefined;

  /**
   * Create the error.
   *
   * @param status - The HTTP status, or 0 when no answer was received.
   * @param code - The backend's machine-readable code, or `network_error` or `timeout`.
   * @param message - A sentence that says what to change.
   * @param details - Structured detail, such as which fields failed validation.
   * @param requestId - The backend's request id, to quote when asking for help.
   * @param options - Standard error options.
   * @param options.cause - The underlying failure.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "KinkoApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/** How the transport behaves. */
export interface TransportOptions {
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer`. Omit for public routes. */
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** How many times an idempotent read is retried after a network error or a 502 to 504. */
  readonly retries?: number | undefined;
}

/** One request. */
export interface RequestSpec {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** Send the API key even on a route that does not require it, so the owner sees their full record. */
  readonly authenticated?: boolean;
  /** Override the credential for this request, such as a draft's attach token. */
  readonly bearer?: string;
  /** Extra headers, such as the operator's registration token. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
}

const RETRYABLE = new Set([502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Talks to the Kinko backend. */
export class Transport {
  readonly #base: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retries: number;

  /**
   * Create a transport.
   *
   * @param options - The backend address, the API key, and the timeout and retry settings.
   * @throws {TypeError} When the base URL is not an absolute http(s) URL.
   */
  constructor(options: TransportOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch (cause) {
      throw new TypeError(
        `baseUrl must be an absolute URL such as https://api.kinko.example; got "${options.baseUrl}"`,
        { cause },
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new TypeError("baseUrl must be an http(s) URL");
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#retries = options.retries ?? 2;
  }

  /**
   * Make a request and return the parsed JSON body.
   *
   * @param spec - What to send.
   * @returns The response body, `undefined` for 204.
   * @throws {KinkoApiError} For any failure.
   */
  async request<T>(spec: RequestSpec): Promise<T> {
    const url = new URL(`${this.#base}${spec.path}`);
    for (const [key, value] of Object.entries(spec.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: "application/json", ...spec.headers };
    const bearer = spec.bearer ?? (spec.authenticated === false ? undefined : this.#apiKey);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    const attempts = spec.method === "GET" ? this.#retries + 1 : 1;

    let last: KinkoApiError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      try {
        const signals = [
          AbortSignal.timeout(this.#timeoutMs),
          ...(spec.signal ? [spec.signal] : []),
        ];
        const response = await this.#fetch(url, {
          method: spec.method,
          headers,
          ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
          signal: AbortSignal.any(signals),
        });
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        if (response.ok) return parsed as T;
        const failure = errorFrom(response.status, parsed, text);
        if (RETRYABLE.has(response.status) && attempt + 1 < attempts) {
          last = failure;
          continue;
        }
        throw failure;
      } catch (error) {
        if (error instanceof KinkoApiError) throw error;
        if (spec.signal?.aborted) throw error;
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        last = new KinkoApiError(
          0,
          timedOut ? "timeout" : "network_error",
          timedOut
            ? `The Kinko backend did not answer within ${String(this.#timeoutMs)} ms.`
            : `Could not reach the Kinko backend at ${this.#base}: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          undefined,
          { cause: error },
        );
      }
    }
    throw last ?? new KinkoApiError(0, "network_error", "The request failed.");
  }
}

const errorFrom = (status: number, parsed: unknown, text: string): KinkoApiError => {
  const body = parsed as
    | { error?: { code?: string; message?: string; details?: unknown }; requestId?: string }
    | undefined;
  return new KinkoApiError(
    status,
    body?.error?.code ?? "http_error",
    body?.error?.message ?? (text.slice(0, 200) || `The backend answered ${String(status)}.`),
    body?.error?.details,
    body?.requestId,
  );
};

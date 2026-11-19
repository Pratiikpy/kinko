// The merchant client.
//
// What happens where: invoices are built here, on the merchant's machine, with
// the merchant's keys, because the amount and the keys are what the chain keeps
// private. The backend is told only what the merchant chooses to tell it: the
// invoice's commitment (a hash), a title, a memo, a reference, where to send
// the payer, and, if the merchant opts in, a display amount. Publishing the
// invoice on chain and paying it happen in a wallet; this client never signs,
// proves or moves funds.

import { Transport, type TransportOptions } from "./http.ts";
import {
  buildInvoice,
  type Invoice,
  type InvoiceParams,
  type LinkContext,
  type MerchantKeys,
} from "./invoice.ts";
import type { WebhookEvent } from "./types.ts";
import {
  type Asset,
  type CheckoutSession,
  type ConversionQuote,
  type InvoiceKind,
  type InvoiceStatusReport,
  type PublicCheckoutSession,
  type PublicConfig,
  type Registration,
  type SessionPage,
  SessionStatus,
} from "./types.ts";
import {
  constructWebhookEvent,
  type Verification,
  type VerifyOptions,
  verifyWebhookSignature,
} from "./webhooks.ts";

/** Constructor options. */
export interface KinkoOptions {
  /** Your API key, from registration or `POST /v1/merchant/api-keys`. */
  readonly apiKey: string;
  /** The backend's address, such as `https://api.kinko.example`. */
  readonly baseUrl: string;
  /** Needed to build invoices. Held in memory only, never sent to the backend. */
  readonly merchant?: MerchantKeys;
  /** Your webhook secret, used by `webhooks.verify`. */
  readonly webhookSecret?: string;
  /** Skip asking the backend for these; useful offline and in tests. */
  readonly contractAddress?: string;
  readonly appUrl?: string;
  readonly fetch?: typeof fetch;
  /** The clock, in milliseconds since the epoch. Invoice expiries are measured from it. Defaults to the system clock. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Retries for reads after a network error or 502 to 504. Defaults to 2. */
  readonly retries?: number;
}

/** Fields for a checkout session. */
export interface SessionParams {
  /** The invoice's commitment; omit to create a draft that a wallet attaches one to. */
  readonly commitment?: string;
  readonly kind?: InvoiceKind;
  readonly asset?: Asset;
  readonly title?: string;
  readonly memo?: string;
  /** Your own reference, echoed in webhooks. Not shown to the payer. */
  readonly clientReference?: string;
  /** Where the payer goes after paying or backing out. Must not contain a `#`. */
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  /** How long the hosted checkout stays open: 60 to 2,592,000 seconds. Defaults to the backend's setting. */
  readonly ttlSeconds?: number;
  /** A display amount in base units. Sent only if you pass it; the backend never needs it. */
  readonly displayAmount?: bigint | string;
}

/** Everything `checkout.create` makes. */
export interface Checkout {
  /** The invoice, with its secrets. Keep it; publish it with your wallet from the Kinko app's Invoices page. */
  readonly invoice: Invoice;
  readonly session: CheckoutSession;
  /** The hosted checkout page with the invoice's terms in its fragment: give this to the payer. */
  readonly checkoutUrl: string;
  /** A direct payment link, with no hosted page. */
  readonly paymentLink: string;
}

/** Options for waiting. */
export interface WaitOptions {
  /** How long to wait in total. Defaults to ten minutes. */
  readonly timeoutMs?: number;
  /** How often to look. Defaults to two seconds. */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  /** Called with each reading, for progress output. */
  readonly onPoll?: (session: CheckoutSession) => void;
}

/** Thrown by `waitForSettlement` when the time runs out. */
export class WaitTimeoutError extends Error {
  /** The last reading before giving up. */
  readonly session: CheckoutSession;
  /**
   * Create the error.
   *
   * @param session - The last reading before giving up.
   * @param timeoutMs - How long was waited, in milliseconds.
   */
  constructor(session: CheckoutSession, timeoutMs: number) {
    super(`Session ${session.id} was still ${session.status} after ${String(timeoutMs)} ms.`);
    this.name = "WaitTimeoutError";
    this.session = session;
  }
}

/** The states a session does not leave. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  SessionStatus.SETTLED,
  SessionStatus.CANCELLED,
  SessionStatus.EXPIRED,
];

/** The merchant client. */
export class Kinko {
  readonly #transport: Transport;
  readonly #options: KinkoOptions;
  #config: Promise<PublicConfig> | undefined;
  readonly #now: () => number;

  /**
   * Create a client.
   *
   * @param options - The API key, the backend address, and optionally the merchant's keys and webhook secret.
   * @throws {TypeError} When the API key or the base URL is malformed.
   */
  constructor(options: KinkoOptions) {
    if (!options.apiKey.startsWith("kk_"))
      throw new TypeError("apiKey does not look like a Kinko API key (it starts with kk_).");
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#transport = new Transport(transportOptions(options));
  }

  /**
   * Register a merchant. Needs no API key; the key you receive is shown once.
   *
   * @param params - The backend address and the merchant's details.
   * @param params.baseUrl - The backend's address.
   * @param params.name - The merchant's display name.
   * @param params.webhookUrl - Where to send webhooks, if anywhere.
   * @param params.registrationToken - The operator's token, when registration is restricted.
   * @param params.fetch - The fetch to use; injectable for tests.
   * @returns The merchant, the first API key and the webhook secret.
   */
  static async register(params: {
    readonly baseUrl: string;
    readonly name: string;
    readonly webhookUrl?: string;
    /** Required when the operator restricts registration. */
    readonly registrationToken?: string;
    readonly fetch?: typeof fetch;
  }): Promise<Registration> {
    const transport = new Transport({ baseUrl: params.baseUrl, fetchImpl: params.fetch });
    return transport.request<Registration>({
      method: "POST",
      path: "/v1/merchants",
      body: {
        name: params.name,
        ...(params.webhookUrl === undefined ? {} : { webhookUrl: params.webhookUrl }),
      },
      ...(params.registrationToken === undefined
        ? {}
        : { headers: { "X-Registration-Token": params.registrationToken } }),
    });
  }

  /**
   * What the backend publishes for building links. Fetched once, unless you passed it in.
   *
   * @returns The contract address, the web app address and the link paths.
   */
  config(): Promise<PublicConfig> {
    this.#config ??=
      this.#options.contractAddress && this.#options.appUrl
        ? Promise.resolve({
            contractAddress: this.#options.contractAddress,
            appUrl: this.#options.appUrl,
            payPath: "/pay",
            checkoutPath: "/checkout",
            oracle: false,
            assistant: false,
          })
        : this.#transport
            .request<PublicConfig>({ method: "GET", path: "/v1/config", authenticated: false })
            .catch((error: unknown) => {
              this.#config = undefined;
              throw error;
            });
    return this.#config;
  }

  async #linkContext(): Promise<LinkContext> {
    const config = await this.config();
    return {
      contractAddress: this.#options.contractAddress ?? config.contractAddress,
      appUrl: (this.#options.appUrl ?? config.appUrl).replace(/\/+$/, ""),
      payPath: config.payPath,
    };
  }

  /** Build invoices on your own machine. */
  readonly invoices = {
    /**
     * Build an invoice and its payment link. Sends nothing anywhere.
     *
     * @param params - Amount in base units, kind, asset and expiry.
     * @returns The invoice. Publish it on chain with your wallet.
     * @throws {TypeError} When no merchant keys were given to the client.
     */
    create: async (params: InvoiceParams): Promise<Invoice> => {
      if (!this.#options.merchant) {
        throw new TypeError(
          "Pass `merchant: { merchantKey, payoutAddress }` to the client to build invoices.",
        );
      }
      return buildInvoice(
        this.#options.merchant,
        params,
        await this.#linkContext(),
        Math.floor(this.#now() / 1000),
      );
    },
  };

  /** Hosted checkout sessions. */
  readonly checkout = {
    /**
     * Build an invoice and register a hosted checkout for it, in one step.
     *
     * @param params - The invoice and the session fields.
     * @returns The invoice, the session, and the links to give a payer.
     */
    create: async (
      params: InvoiceParams &
        Omit<SessionParams, "commitment" | "kind" | "asset" | "displayAmount"> & {
          readonly storeAmount?: boolean;
        },
    ): Promise<Checkout> => {
      const invoice = await this.invoices.create(params);
      const lifetime =
        params.ttlSeconds ??
        (invoice.expiresAt === 0
          ? undefined
          : Math.max(60, Math.min(2_592_000, invoice.expiresAt - Math.floor(this.#now() / 1000))));
      const session = await this.checkout.sessions.create({
        commitment: invoice.commitment,
        kind: invoice.kind,
        asset: invoice.asset,
        ...pick(params, ["title", "memo", "clientReference", "successUrl", "cancelUrl"]),
        ...(lifetime === undefined ? {} : { ttlSeconds: lifetime }),
        ...(params.storeAmount ? { displayAmount: invoice.amount } : {}),
      });
      return {
        invoice,
        session,
        checkoutUrl: `${session.checkoutUrl}#${invoice.linkPayload}`,
        paymentLink: invoice.paymentLink,
      };
    },

    drafts: {
      /**
       * Start a checkout whose invoice the merchant's wallet will create. The
       * session is a draft until the web app attaches the invoice's commitment,
       * so no invoice secret ever passes through this client or the backend.
       *
       * @param params - What to prefill and how long the draft lives.
       * @returns The draft, its one-time attach token, and the web app address to open to finish it.
       */
      create: async (
        params: Omit<SessionParams, "commitment" | "displayAmount"> = {},
      ): Promise<{ session: CheckoutSession; attachToken: string; formUrl: string }> => {
        const draft = await this.checkout.sessions.create(params);
        if (draft.attachToken === undefined || draft.formUrl === undefined)
          throw new Error("the backend did not return a draft; it may be an older version");
        const { attachToken, formUrl, ...session } = draft;
        return { session, attachToken, formUrl };
      },
    },

    sessions: {
      /**
       * Register a checkout session with the backend.
       *
       * @param params - Session fields. With no commitment the result is a draft.
       * @returns The session, and for a draft the one-time attach token.
       */
      create: async (
        params: SessionParams = {},
      ): Promise<
        CheckoutSession & { readonly attachToken?: string; readonly formUrl?: string }
      > => {
        const { session, attachToken, formUrl } = await this.#transport.request<{
          session: CheckoutSession;
          attachToken: string | null;
          formUrl?: string;
        }>({
          method: "POST",
          path: "/v1/checkout/sessions",
          body: {
            ...(params.commitment === undefined ? {} : { commitment: params.commitment }),
            ...(params.kind === undefined ? {} : { kind: params.kind }),
            ...(params.asset === undefined ? {} : { token: params.asset }),
            ...pick(params, [
              "title",
              "memo",
              "clientReference",
              "successUrl",
              "cancelUrl",
              "ttlSeconds",
            ]),
            ...(params.displayAmount === undefined
              ? {}
              : { amount: params.displayAmount.toString() }),
          },
        });
        return attachToken === null
          ? session
          : { ...session, attachToken, ...(formUrl === undefined ? {} : { formUrl }) };
      },

      /**
       * Read one of your sessions.
       *
       * @param id - The session id.
       * @returns The session.
       */
      retrieve: async (id: string): Promise<CheckoutSession> =>
        (
          await this.#transport.request<{ session: CheckoutSession }>({
            method: "GET",
            path: `/v1/checkout/sessions/${encodeURIComponent(id)}`,
          })
        ).session,

      /**
       * List your sessions, newest first.
       *
       * @param query - A status filter, a page size and a cursor.
       * @param query.status - Only sessions in this state.
       * @param query.limit - The page size.
       * @param query.before - The cursor from the previous page.
       * @returns A page, with the cursor for the next.
       */
      list: (
        query: {
          readonly status?: SessionStatus;
          readonly limit?: number;
          readonly before?: string;
        } = {},
      ): Promise<SessionPage> =>
        this.#transport.request<SessionPage>({
          method: "GET",
          path: "/v1/checkout/sessions",
          query,
        }),

      /**
       * Attach an invoice's commitment to a draft.
       *
       * @param id - The draft's id.
       * @param commitment - The invoice's commitment.
       * @returns The session, now pending.
       */
      attach: async (id: string, commitment: string): Promise<CheckoutSession> =>
        (
          await this.#transport.request<{ session: CheckoutSession }>({
            method: "POST",
            path: `/v1/checkout/sessions/${encodeURIComponent(id)}/commitment`,
            body: { commitment },
          })
        ).session,

      /**
       * What the public checkout page sees, without your credentials.
       *
       * @param id - The session id.
       * @returns The public view.
       */
      publicView: async (id: string): Promise<PublicCheckoutSession> =>
        (
          await this.#transport.request<{ session: PublicCheckoutSession }>({
            method: "GET",
            path: `/v1/checkout/sessions/${encodeURIComponent(id)}`,
            authenticated: false,
          })
        ).session,

      /**
       * Wait until a session settles, is cancelled or expires.
       *
       * @param id - The session id.
       * @param options - How long, how often, and a way to stop.
       * @returns The session in its final state.
       * @throws {WaitTimeoutError} When the time runs out first.
       */
      waitForSettlement: async (
        id: string,
        options: WaitOptions = {},
      ): Promise<CheckoutSession> => {
        const timeoutMs = options.timeoutMs ?? 600_000;
        const intervalMs = options.intervalMs ?? 2_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          options.signal?.throwIfAborted();
          const session = await this.checkout.sessions.retrieve(id);
          options.onPoll?.(session);
          if (TERMINAL_STATUSES.includes(session.status)) return session;
          if (Date.now() + intervalMs > deadline) throw new WaitTimeoutError(session, timeoutMs);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, intervalMs);
            options.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const reason: unknown = options.signal?.reason;
                reject(reason instanceof Error ? reason : new Error("The wait was aborted."));
              },
              { once: true },
            );
          });
        }
      },
    },
  };

  /** Linking Telegram chats, so the Kinko bot can tell you when an invoice is paid. */
  readonly telegram = {
    /**
     * Ask for a code to send the Kinko bot as `/link <code>`. A code works once and expires after fifteen minutes.
     *
     * @returns The code and when it stops working.
     */
    linkCode: (): Promise<{ readonly code: string; readonly expiresAt: string }> =>
      this.#transport.request({ method: "POST", path: "/v1/merchant/telegram/link-codes" }),

    /**
     * The chats linked to your account.
     *
     * @returns Each chat's id and when it was linked.
     */
    chats: async (): Promise<readonly { readonly chatId: number; readonly linkedAt: string }[]> =>
      (
        await this.#transport.request<{
          chats: { readonly chatId: number; readonly linkedAt: string }[];
        }>({ method: "GET", path: "/v1/merchant/telegram" })
      ).chats,

    /**
     * Stop sending a chat messages about your invoices.
     *
     * @param chatId - The Telegram chat id.
     */
    unlink: async (chatId: number): Promise<void> => {
      await this.#transport.request({
        method: "DELETE",
        path: `/v1/merchant/telegram/${String(chatId)}`,
      });
    },
  };

  /** Public chain reads. */
  readonly chain = {
    /**
     * What the ledger says about an invoice. There is never an amount in it.
     *
     * @param commitment - The invoice's commitment.
     * @returns Its status, kind, asset, expiry and contribution count; `unknown` when the chain has not seen it.
     */
    invoiceStatus: (commitment: string): Promise<InvoiceStatusReport> =>
      this.#transport.request<InvoiceStatusReport>({
        method: "GET",
        path: `/v1/chain/invoices/${encodeURIComponent(commitment)}`,
        authenticated: false,
      }),
  };

  /** The conversion oracle, for paying an invoice in the other asset. */
  readonly oracle = {
    /**
     * Ask for a signed quote.
     *
     * @param params - The invoice amount in base units and the two assets.
     * @param params.baseAmount - The invoice amount in base units.
     * @param params.from - The invoice's asset.
     * @param params.to - The asset the payer will hand over.
     * @returns A quote to present to the contract with the payment.
     */
    quote: async (params: {
      readonly baseAmount: bigint | string;
      readonly from: Asset;
      readonly to: Asset;
    }): Promise<ConversionQuote> =>
      (
        await this.#transport.request<{ quote: ConversionQuote }>({
          method: "POST",
          path: "/v1/oracle/quote",
          authenticated: false,
          body: {
            baseAmount: params.baseAmount.toString(),
            fromToken: params.from,
            toToken: params.to,
          },
        })
      ).quote,
  };

  /** Webhook verification, with your secret already applied. */
  readonly webhooks = {
    /**
     * Check a delivery's signature.
     *
     * @param body - The exact request body.
     * @param header - The `Kinko-Signature` header value.
     * @param options - Tolerance and clock; `secret` overrides the client's.
     * @returns Whether it is authentic, and if not, why.
     */
    verify: (
      body: string | Uint8Array,
      header: string | null | undefined,
      options: VerifyOptions & { readonly secret?: string } = {},
    ): Verification => verifyWebhookSignature(body, header, this.#secret(options.secret), options),

    /**
     * Verify a delivery and parse it. Throws unless it is authentic.
     *
     * @param body - The exact request body.
     * @param header - The `Kinko-Signature` header value.
     * @param options - Tolerance and clock; `secret` overrides the client's.
     * @returns The event.
     */
    constructEvent: (
      body: string | Uint8Array,
      header: string | null | undefined,
      options: VerifyOptions & { readonly secret?: string } = {},
    ): WebhookEvent => constructWebhookEvent(body, header, this.#secret(options.secret), options),
  };

  #secret(override: string | undefined): string {
    const secret = override ?? this.#options.webhookSecret;
    if (!secret)
      throw new TypeError(
        "No webhook secret. Pass `webhookSecret` to the client or `secret` to this call.",
      );
    return secret;
  }
}

const transportOptions = (o: KinkoOptions): TransportOptions => ({
  baseUrl: o.baseUrl,
  apiKey: o.apiKey,
  fetchImpl: o.fetch,
  timeoutMs: o.timeoutMs,
  retries: o.retries,
});

const pick = <T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<Pick<T, K>> => {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
};

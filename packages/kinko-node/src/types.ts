// Public types and the fixed sets the SDK names. String values are the wire
// format shared with the backend and its webhooks.

/** Whether an invoice settles once or takes many payments. */
export enum InvoiceKind {
  /** Settles on the first payment. */
  STANDARD = "standard",
  /** Takes many payments until the merchant closes it. */
  MULTIPAY = "multipay",
  /** A multipay invoice with no expected total. */
  DONATION = "donation",
}

/** The asset an invoice is paid in. */
export enum Asset {
  /** Midnight's native token, NIGHT. */
  NATIVE = "NATIVE",
  /** Kinko's shielded dollar, backed one to one by USDC. */
  KUSD = "KUSD",
}

/** Where a checkout session stands. */
export enum SessionStatus {
  DRAFT = "draft",
  PENDING = "pending",
  SETTLED = "settled",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

/** The state of an invoice on chain. `UNKNOWN` means the chain has not seen it yet. */
export enum ChainStatus {
  OPEN = "open",
  SETTLED = "settled",
  CANCELLED = "cancelled",
  UNKNOWN = "unknown",
}

/** What a webhook announces. */
export enum WebhookEventType {
  PAYMENT_RECEIVED = "invoice.payment_received",
  SETTLED = "invoice.settled",
  CANCELLED = "invoice.cancelled",
  EXPIRED = "invoice.expired",
  WEBHOOK_TEST = "webhook.test",
}

/** A checkout session as the backend shows it to its merchant. */
export interface CheckoutSession {
  readonly id: string;
  readonly status: SessionStatus;
  readonly commitment: string | null;
  readonly kind: InvoiceKind;
  readonly asset: Asset;
  readonly title: string | null;
  readonly memo: string | null;
  /** Base units, present only if the merchant chose to store it. */
  readonly amount: string | null;
  readonly clientReference: string | null;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly contributions: number;
  readonly onChain: boolean;
  /** True when the payment was first seen after the session had expired. */
  readonly late: boolean;
  /** The hosted checkout page. Append `#<payload>` for the payer to pay from it. */
  readonly checkoutUrl: string;
}

/** What the public checkout page may read about a session. */
export interface PublicCheckoutSession {
  readonly id: string;
  readonly status: SessionStatus;
  readonly commitment: string | null;
  readonly kind: InvoiceKind;
  readonly asset: Asset;
  readonly title: string | null;
  readonly memo: string | null;
  readonly amount: string | null;
  readonly merchantName: string;
  readonly expiresAt: string;
  readonly contributions: number;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly contractAddress: string;
}

/** A page of sessions. */
export interface SessionPage {
  readonly data: readonly CheckoutSession[];
  /** Pass as `before` to get the next page; null when there is none. */
  readonly nextCursor: string | null;
}

/** The ledger's view of one invoice. */
export interface InvoiceStatusReport {
  readonly commitment: string;
  readonly found: boolean;
  readonly status: ChainStatus;
  readonly kind: InvoiceKind | null;
  readonly asset: Asset | null;
  readonly expiresAt: string | null;
  readonly contributions: number;
}

/** The body of a webhook delivery. It never carries an amount. */
export interface WebhookEvent {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly createdAt: string;
  readonly data: {
    readonly sessionId?: string;
    readonly commitment?: string | null;
    readonly status?: SessionStatus;
    readonly kind?: InvoiceKind;
    readonly asset?: Asset;
    readonly title?: string | null;
    readonly clientReference?: string | null;
    readonly contributions?: number;
    readonly newPayments?: number;
    readonly late?: boolean;
    readonly message?: string;
  };
}

/** A conversion quote signed by the oracle, to hand to `settle_invoice_converted`. */
export interface ConversionQuote {
  readonly baseAmount: string;
  readonly convertedAmount: string;
  readonly fromToken: Asset;
  readonly toToken: Asset;
  /** Seconds since the epoch; the contract compares it with block time. */
  readonly expiresAt: string;
  readonly signature: {
    readonly announcement: { readonly x: string; readonly y: string };
    readonly response: string;
  };
  readonly publicKey: { readonly x: string; readonly y: string };
}

/** What a client needs to build links, as the backend publishes it. */
export interface PublicConfig {
  readonly contractAddress: string;
  readonly appUrl: string;
  readonly payPath: string;
  readonly checkoutPath: string;
  readonly oracle: boolean;
  readonly assistant: boolean;
}

/** The result of registering a merchant. The key and secret are shown once. */
export interface Registration {
  readonly merchant: {
    readonly id: string;
    readonly name: string;
    readonly webhookUrl: string | null;
  };
  readonly apiKey: { readonly id: string; readonly key: string };
  readonly webhookSecret: string;
}

// Every fixed set the backend names, in one place. The string values are the
// wire format: merchants see them in API responses and webhook payloads, so
// they are part of the public contract and are never renamed casually.

/** Where a checkout session stands. */
export enum SessionStatus {
  /** Created without a commitment; waiting for the merchant's wallet to attach one. */
  DRAFT = "draft",
  /** A commitment is attached; waiting for the invoice to be paid on chain. */
  PENDING = "pending",
  /** The chain shows the invoice settled. */
  SETTLED = "settled",
  /** The merchant withdrew the invoice on chain before anyone paid. */
  CANCELLED = "cancelled",
  /** The session or the invoice ran out of time without a payment. */
  EXPIRED = "expired",
}

/** What a webhook or a bot message can announce. */
export enum EventType {
  /** A contribution landed on the invoice. Fires for every contribution to a multipay invoice. */
  PAYMENT_RECEIVED = "invoice.payment_received",
  /** The invoice is closed and paid. */
  SETTLED = "invoice.settled",
  /** The merchant cancelled the invoice on chain. */
  CANCELLED = "invoice.cancelled",
  /** The invoice expired unpaid. */
  EXPIRED = "invoice.expired",
  /** A test event the merchant asked for. */
  WEBHOOK_TEST = "webhook.test",
}

/** Progress of one webhook delivery. */
export enum DeliveryStatus {
  /** Not delivered yet; the dispatcher will try at `nextAttemptAt`. */
  PENDING = "pending",
  /** The receiver answered with a 2xx. */
  DELIVERED = "delivered",
  /** Every attempt failed. */
  FAILED = "failed",
}

/** Invoice kinds, named as the API names them. Values mirror the contract's `InvoiceKind`. */
export enum InvoiceKindName {
  STANDARD = "standard",
  MULTIPAY = "multipay",
  DONATION = "donation",
}

/** Settlement assets, named as the API names them. Values mirror the contract's `TokenKind`. */
export enum TokenName {
  NATIVE = "NATIVE",
  KUSD = "KUSD",
}

/** Invoice status as the chain reports it. Mirrors the contract's `InvoiceStatus`. */
export enum ChainInvoiceStatus {
  OPEN = "open",
  SETTLED = "settled",
  CANCELLED = "cancelled",
}

/** Machine-readable error codes returned in every error body. */
export enum ErrorCode {
  INVALID_REQUEST = "invalid_request",
  UNAUTHORIZED = "unauthorized",
  FORBIDDEN = "forbidden",
  NOT_FOUND = "not_found",
  METHOD_NOT_ALLOWED = "method_not_allowed",
  CONFLICT = "conflict",
  PAYLOAD_TOO_LARGE = "payload_too_large",
  UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type",
  RATE_LIMITED = "rate_limited",
  NOT_CONFIGURED = "not_configured",
  UPSTREAM_FAILED = "upstream_failed",
  INTERNAL = "internal_error",
}

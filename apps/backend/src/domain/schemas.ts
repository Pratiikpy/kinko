// Request validation. Every body, query string and path parameter that reaches
// a handler passes through one of these schemas first, and every schema is
// strict: an unknown field is an error, because a typo in an optional field
// would otherwise be accepted and silently ignored.

import { z } from "zod";

import { badRequest } from "../http/errors.ts";
import { InvoiceKindName, SessionStatus, TokenName } from "./enums.ts";

const U64_MAX = 18_446_744_073_709_551_615n;
const NEWLINE = 10;
const DELETE = 127;

/**
 * Whether text holds a control character. Checked by code point, because a
 * character class of control characters is the pattern linters rightly distrust.
 *
 * @param value - The text to check.
 * @param allowNewline - Whether a line feed is permitted, as in a memo.
 * @returns True when a control character is present.
 */
const hasControl = (value: string, allowNewline: boolean): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && !(allowNewline && code === NEWLINE)) || code === DELETE) return true;
  }
  return false;
};

/** Longest a session may live: thirty days. */
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Shortest a session may live: one minute. */
export const MIN_TTL_SECONDS = 60;

/** 64 hex characters, with or without `0x`, normalised to lowercase without it. */
export const hex32 = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be 64 hex characters")
  .transform((v) => v.replace(/^0x/i, "").toLowerCase());

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} must not be empty`)
    .max(max, `${what} must be at most ${String(max)} characters`)
    .refine((v) => !hasControl(v, false), `${what} must not contain control characters`);

const multiline = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} must not be empty`)
    .max(max, `${what} must be at most ${String(max)} characters`)
    .refine((v) => !hasControl(v, true), `${what} must not contain control characters`);

/**
 * Parse an absolute http(s) URL with no credentials and no fragment. A
 * fragment is refused on purpose: an invoice's terms travel in the fragment of
 * a payment link, so a URL that carries one would hand the backend an amount.
 *
 * @param value - The candidate URL.
 * @returns The parsed URL, or the reason it was refused.
 */
export const parseUrl = (value: string): { url: URL } | { reason: string } => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: "must be an absolute URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { reason: "must use http or https" };
  if (url.username || url.password) return { reason: "must not contain credentials" };
  if (url.hash || value.includes("#")) {
    return {
      reason:
        "must not contain a fragment: the terms of a payment link live there and must not reach this server",
    };
  }
  return { url };
};

const urlField = (what: string) =>
  z
    .string()
    .trim()
    .max(2048, `${what} must be at most 2048 characters`)
    .superRefine((value, ctx) => {
      const parsed = parseUrl(value);
      if ("reason" in parsed) ctx.addIssue({ code: "custom", message: `${what} ${parsed.reason}` });
    });

const baseUnits = z
  .string()
  .regex(/^[0-9]{1,20}$/, "must be a whole number of base units, as digits")
  // A refinement still runs after the regex fails, so it must tolerate non-digits.
  .refine(
    (v) => !/^[0-9]{1,20}$/.test(v) || (BigInt(v) > 0n && BigInt(v) <= U64_MAX),
    "must be between 1 and 2^64 - 1",
  )
  .transform((v) => (/^[0-9]{1,20}$/.test(v) ? BigInt(v).toString() : v));

const kind = z.nativeEnum(InvoiceKindName);
const token = z.nativeEnum(TokenName);
const ttlSeconds = z.number().int().min(MIN_TTL_SECONDS).max(MAX_TTL_SECONDS);

/** `POST /v1/merchants` */
export const createMerchantBody = z
  .object({ name: text(80, "name"), webhookUrl: urlField("webhookUrl").nullish() })
  .strict();

/** `PATCH /v1/merchant` */
export const updateMerchantBody = z
  .object({
    name: text(80, "name").optional(),
    webhookUrl: urlField("webhookUrl").nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.webhookUrl !== undefined,
    "send at least one of name or webhookUrl",
  );

/** `POST /v1/merchant/api-keys` */
export const createApiKeyBody = z.object({ label: text(60, "label").optional() }).strict();

/** `POST /v1/checkout/sessions` */
export const createSessionBody = z
  .object({
    commitment: hex32.optional(),
    kind: kind.optional(),
    token: token.optional(),
    title: text(120, "title").optional(),
    memo: multiline(500, "memo").optional(),
    amount: baseUnits.optional(),
    clientReference: text(200, "clientReference").optional(),
    successUrl: urlField("successUrl").optional(),
    cancelUrl: urlField("cancelUrl").optional(),
    ttlSeconds: ttlSeconds.optional(),
  })
  .strict();

/** `POST /v1/checkout/sessions/:id/commitment` */
export const attachCommitmentBody = z.object({ commitment: hex32 }).strict();

/** `GET /v1/checkout/sessions` */
export const listSessionsQuery = z
  .object({
    status: z.nativeEnum(SessionStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.coerce.number().int().min(1).optional(),
  })
  .strict();

/** `GET /v1/merchant/webhook/deliveries` */
export const listDeliveriesQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

/** `POST /v1/oracle/quote` */
export const oracleQuoteBody = z
  .object({ baseAmount: baseUnits, fromToken: token, toToken: token })
  .strict()
  .refine((v) => v.fromToken !== v.toToken, {
    message: "fromToken and toToken must differ",
    path: ["toToken"],
  });

/** A Telegram chat id: a non-zero integer, negative for groups. */
export const chatId = z.coerce
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n) && n !== 0, "must be a Telegram chat id");

/** `POST /v1/bot/link` */
export const botLinkBody = z.object({ code: z.string().trim().min(1).max(32), chatId }).strict();

/** `POST /v1/bot/chats/:chatId/sessions` */
export const botCreateSessionBody = z
  .object({
    title: text(120, "title").optional(),
    memo: multiline(500, "memo").optional(),
    kind: kind.optional(),
    token: token.optional(),
    clientReference: text(200, "clientReference").optional(),
    ttlSeconds: ttlSeconds.optional(),
  })
  .strict();

/** `GET /v1/bot/events` */
export const botEventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/**
 * Parse `input` with `schema`, turning a failure into a 400 that names the
 * offending fields.
 *
 * @param schema - The schema to apply.
 * @param input - The untrusted value.
 * @param what - What is being parsed, for the message.
 * @returns The parsed value.
 * @throws {ApiError} 400 listing every field that failed.
 */
export const parseInput = <S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  what: string,
): z.output<S> => {
  const result = schema.safeParse(input);
  if (result.success) return result.data as z.output<S>;
  const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const first = issues[0];
  const where = first?.path ? `${first.path}: ` : "";
  throw badRequest(`Invalid ${what}. ${where}${first?.message ?? "unrecognised input"}`, issues);
};

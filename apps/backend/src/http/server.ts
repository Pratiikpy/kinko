// The request pipeline: CORS, rate limits, authentication, body parsing,
// dispatch and error handling, in that order, for every request.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { safeEqual } from "../domain/crypto.ts";
import { ErrorCode } from "../domain/enums.ts";
import type { Clock } from "../domain/events.ts";
import type { MerchantService, Principal } from "../domain/merchants.ts";
import type { Logger } from "../log.ts";
import { ApiError, badRequest, errorBody, notConfigured, unauthorized } from "./errors.ts";
import { RateLimiter, type RateRule, type RateVerdict } from "./rate-limit.ts";
import {
  AuthMode,
  type HandlerResult,
  LimitClass,
  type RequestContext,
  type Router,
} from "./router.ts";

/** Largest request body accepted. A session or a registration is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The default limits. Generous for real use; tight enough to make abuse expensive. */
export const DEFAULT_LIMITS: Readonly<Record<LimitName, RateRule>> = {
  global: { max: 300, windowMs: 60_000 },
  [LimitClass.REGISTER]: { max: 10, windowMs: 3_600_000 },
  [LimitClass.ORACLE]: { max: 60, windowMs: 60_000 },
  [LimitClass.ASSISTANT]: { max: 20, windowMs: 60_000 },
  [LimitClass.MERCHANT]: { max: 600, windowMs: 60_000 },
  [LimitClass.BOT]: { max: 1_200, windowMs: 60_000 },
};

/** The limits with a rule of their own. A public route is covered by the per-address `global` limit alone. */
export type LimitName = "global" | Exclude<LimitClass, LimitClass.PUBLIC>;

/** What the pipeline needs. */
export interface PipelineOptions {
  readonly router: Router;
  readonly merchants: MerchantService;
  readonly botToken: string | undefined;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: boolean;
  readonly clock: Clock;
  readonly log: Logger;
  readonly limits?: Partial<Record<LimitName, RateRule>>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The caller's address. Behind a trusted proxy the proxy appends the real
 * address as the last `X-Forwarded-For` entry; earlier entries are whatever the
 * client claimed, so they are ignored.
 *
 * @param req - The incoming request.
 * @param trustProxy - Whether a proxy in front of this server is trusted to say who called.
 * @returns The caller's address.
 */
const clientAddress = (req: IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
      .split(",")
      .at(-1)
      ?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES)
    throw new ApiError(
      413,
      ErrorCode.PAYLOAD_TOO_LARGE,
      `The request body is larger than ${String(MAX_BODY_BYTES)} bytes.`,
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw new ApiError(
        413,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `The request body is larger than ${String(MAX_BODY_BYTES)} bytes.`,
      );
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError(
      415,
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      "Send the body as JSON with `Content-Type: application/json`.",
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
};

const parseQuery = (url: URL): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in out) throw badRequest(`The query parameter "${key}" was given more than once.`);
    out[key] = value;
  }
  return out;
};

/**
 * Build the function that serves one request.
 *
 * @param options - The router, the services it authenticates with, and the CORS and rate-limit settings.
 * @returns The request handler.
 */
export const createRequestHandler = (options: PipelineOptions) => {
  const { router, merchants, botToken, corsOrigins, trustProxy, clock, log } = options;
  const rules = { ...DEFAULT_LIMITS, ...options.limits };
  const globalLimiter = new RateLimiter(rules.global, clock);
  const classLimiters = Object.fromEntries(
    (Object.keys(rules) as LimitName[])
      .filter((k) => k !== "global")
      .map((k) => [k, new RateLimiter(rules[k], clock)]),
  ) as Record<Exclude<LimitName, "global">, RateLimiter>;
  const allowAnyOrigin = corsOrigins.includes("*");

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!allowAnyOrigin && !corsOrigins.includes(origin)) return { Vary: "Origin" };
    return {
      "Access-Control-Allow-Origin": allowAnyOrigin ? "*" : origin,
      Vary: "Origin",
      "Access-Control-Expose-Headers":
        "X-Request-Id, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset",
    };
  };

  const authenticate = (mode: AuthMode, header: string | undefined): Principal | undefined => {
    if (mode === AuthMode.MERCHANT) return merchants.authenticate(header);
    if (mode === AuthMode.OPTIONAL_MERCHANT) {
      // Only a header that looks like an API key is tried; anything else (an
      // attach token, no header at all) is for the handler to interpret.
      return /^Bearer\s+kk_/i.test(header ?? "") ? merchants.authenticate(header) : undefined;
    }
    if (mode === AuthMode.BOT) {
      if (botToken === undefined)
        throw notConfigured(
          "The Telegram bot integration is not configured. Set KINKO_BOT_TOKEN on the backend.",
        );
      const presented = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
      if (!presented || !safeEqual(presented, botToken))
        throw unauthorized("A valid bot service token is required.");
    }
    return undefined;
  };

  const enforce = (verdict: RateVerdict, now: number): void => {
    if (verdict.allowed) return;
    const retryAfter = Math.max(1, Math.ceil((verdict.resetAt - now) / 1000));
    throw new ApiError(
      429,
      ErrorCode.RATE_LIMITED,
      `Too many requests. Try again in ${String(retryAfter)} seconds.`,
      undefined,
      {
        "Retry-After": String(retryAfter),
      },
    );
  };

  const send = (
    res: ServerResponse,
    result: HandlerResult,
    extra: Readonly<Record<string, string>>,
  ): void => {
    const payload = result.body === undefined ? "" : JSON.stringify(result.body);
    res.writeHead(result.status, {
      ...SECURITY_HEADERS,
      ...extra,
      ...result.headers,
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(result.status === 204 ? undefined : payload);
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = clock();
    const inbound = req.headers["x-request-id"];
    const requestId =
      typeof inbound === "string" && REQUEST_ID.test(inbound)
        ? inbound
        : `req_${randomBytes(8).toString("hex")}`;
    const method = (req.method ?? "GET").toUpperCase();
    let route = "-";
    let status = 500;
    let merchantId: string | undefined;
    const headers: Record<string, string> = { "X-Request-Id": requestId, ...corsHeaders(req) };
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://kinko.invalid");
      } catch {
        throw badRequest("The request URL is malformed.");
      }
      const path = url.pathname.replace(/\/+$/, "") || "/";
      route = path;
      const ip = clientAddress(req, trustProxy);

      if (method === "OPTIONS") {
        status = 204;
        send(
          res,
          {
            status,
            headers: {
              "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
              "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-Registration-Token, X-Request-Id",
              "Access-Control-Max-Age": "600",
            },
          },
          headers,
        );
        return;
      }

      const match = router.match(method, path);
      if (match.kind === "missing")
        throw new ApiError(404, ErrorCode.NOT_FOUND, `No route ${method} ${path}.`);
      if (match.kind === "method") {
        throw new ApiError(
          405,
          ErrorCode.METHOD_NOT_ALLOWED,
          `${method} is not allowed here. Allowed: ${match.allowed.join(", ")}.`,
          undefined,
          {
            Allow: match.allowed.join(", "),
          },
        );
      }
      route = match.route.pattern;

      enforce(globalLimiter.hit(ip), clock());
      const limit = match.route.limit;
      if (
        limit === LimitClass.REGISTER ||
        limit === LimitClass.ORACLE ||
        limit === LimitClass.ASSISTANT
      ) {
        enforce(classLimiters[limit].hit(ip), clock());
      }

      const principal = authenticate(match.route.auth, req.headers.authorization);
      if (principal) {
        merchantId = principal.merchant.id;
        const verdict = classLimiters[LimitClass.MERCHANT].hit(principal.merchant.id);
        headers["RateLimit-Limit"] = String(verdict.limit);
        headers["RateLimit-Remaining"] = String(verdict.remaining);
        headers["RateLimit-Reset"] = String(Math.ceil((verdict.resetAt - clock()) / 1000));
        enforce(verdict, clock());
      } else if (match.route.auth === AuthMode.BOT) {
        enforce(classLimiters[LimitClass.BOT].hit("bot"), clock());
      }

      let parsed: Promise<unknown> | undefined;
      const context: RequestContext = {
        req,
        method,
        path,
        params: match.params,
        query: parseQuery(url),
        ip,
        requestId,
        log: log.child({ requestId }),
        principal,
        body: () => (parsed ??= readBody(req)),
      };
      const result = await match.route.handler(context);
      status = result.status;
      send(res, result, headers);
    } catch (error) {
      const failure = error instanceof ApiError ? error : undefined;
      if (!failure) log.error("unhandled error", { requestId, route, error });
      const apiError =
        failure ??
        new ApiError(
          500,
          ErrorCode.INTERNAL,
          "Something went wrong on our side. Quote the request id if you contact us.",
        );
      status = apiError.status;
      send(
        res,
        { status, body: { ...errorBody(apiError), requestId }, headers: apiError.headers },
        headers,
      );
    } finally {
      log.info("request", {
        requestId,
        method,
        route,
        status,
        ms: clock() - started,
        ...(merchantId ? { merchant: merchantId } : {}),
      });
    }
  };
};

/**
 * Wrap a request handler in a Node HTTP server with timeouts that bound how
 * long a slow client can hold a connection.
 *
 * @param handler - The function built by {@link createRequestHandler}.
 * @returns A server, not yet listening.
 */
export const createHttpServer = (
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Server => {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
};

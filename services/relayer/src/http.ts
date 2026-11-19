// The relayer's HTTP API: five JSON endpoints on Node's own http server, with input
// validation, a per-client rate limit and CORS for the web app's origin. Everything it
// needs from the chains arrives through the dependencies it is handed, so the layer is
// tested against fakes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { TimedBackingReading } from "./backing.ts";
import type { HttpConfig } from "./config.ts";
import { RequestKindMismatchError } from "./engine.ts";
import type { Logger } from "./ports.ts";
import {
  REQUEST_ID_PATTERN,
  RequestKind,
  type RequestStatus,
  toStatus,
  type TrackedRequest,
} from "./types.ts";

/** The fixed facts `GET /health` reports. */
export interface HealthInfo {
  /** The Midnight network id. */
  readonly network: string;
  /** The vault contract's address, bare hex. */
  readonly vaultContractAddress: string;
  /** The vault's Ethereum account, 0x-prefixed. */
  readonly evmVaultAddress: string;
  /** The USDC contract, 0x-prefixed. */
  readonly usdcAddress: string;
  /** The Ethereum chain id. */
  readonly evmChainId: number;
}

/** What the HTTP layer asks of the stage machine. */
export interface RequestTracker {
  /**
   * Start tracking a request.
   *
   * @param kind - Deposit or withdraw.
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The tracked request, or undefined when the vault holds no such request.
   * @throws {RequestKindMismatchError} When the relayer tracks the id as the other kind.
   * @throws {Error} When the vault cannot be read.
   */
  register(kind: RequestKind, requestId: string): Promise<TrackedRequest | undefined>;
  /**
   * One tracked request.
   *
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The request, or undefined when the relayer does not track it.
   */
  status(requestId: string): TrackedRequest | undefined;
}

/** Everything the HTTP layer runs against. */
export interface HttpDeps {
  /** The server's settings. */
  readonly config: HttpConfig;
  /** What `GET /health` reports. */
  readonly health: HealthInfo;
  /** The stage machine. */
  readonly tracker: RequestTracker;
  /** The backing figures. */
  readonly backing: { get(): Promise<TimedBackingReading> };
  /** Derives a deposit address from an identity commitment, 64 hex characters. */
  readonly depositAddress: (commitmentHex: string) => string;
  /** The current time in epoch milliseconds. */
  readonly clock: () => number;
  /** Where failures are reported. */
  readonly logger: Logger;
}

/** The error codes the API answers with. */
export enum ApiErrorCode {
  /** The route does not exist. */
  NotFound = "not_found",
  /** The route exists but not for this method. */
  MethodNotAllowed = "method_not_allowed",
  /** The client made too many requests. */
  RateLimited = "rate_limited",
  /** The body is larger than the limit. */
  PayloadTooLarge = "payload_too_large",
  /** The body is not JSON. */
  InvalidJson = "invalid_json",
  /** The body is JSON but not the expected object. */
  InvalidBody = "invalid_body",
  /** `kind` is neither deposit nor withdraw. */
  InvalidKind = "invalid_kind",
  /** A request id is not 64 hex characters. */
  InvalidRequestId = "invalid_request_id",
  /** A commitment is not 64 hex characters. */
  InvalidCommitment = "invalid_commitment",
  /** The vault holds no such request. */
  RequestNotFound = "request_not_found",
  /** The relayer tracks the request id as the other kind. */
  KindMismatch = "kind_mismatch",
  /** A chain the answer needs could not be read. */
  Unavailable = "chain_unavailable",
  /** The relayer failed. */
  Internal = "internal_error",
}

class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const MAX_BODY_BYTES = 4096;
const COMMITMENT_PATTERN = /^[0-9a-fA-F]{64}$/;
const WINDOW_MS = 60_000;
const SWEEP_AT_CLIENTS = 10_000;

/** A sliding one-minute window of request times per client. */
class RateLimiter {
  private readonly perMinute: number;
  private readonly clock: () => number;
  private readonly seen = new Map<string, number[]>();

  constructor(perMinute: number, clock: () => number) {
    this.perMinute = perMinute;
    this.clock = clock;
  }

  // Returns 0 when the client may proceed, else the seconds until it may.
  check(client: string): number {
    const now = this.clock();
    if (this.seen.size > SWEEP_AT_CLIENTS) this.sweep(now);
    const recent = (this.seen.get(client) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= this.perMinute) {
      this.seen.set(client, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    }
    recent.push(now);
    this.seen.set(client, recent);
    return 0;
  }

  private sweep(now: number): void {
    for (const [client, times] of this.seen) {
      if (times.every((at) => now - at >= WINDOW_MS)) this.seen.delete(client);
    }
  }
}

function clientOf(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function corsHeaders(request: IncomingMessage, allowed: readonly string[]): Record<string, string> {
  const origin = request.headers.origin;
  if (origin === undefined) return {};
  if (allowed.includes("*")) return { "access-control-allow-origin": "*" };
  if (!allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

function send(
  response: ServerResponse,
  status: number,
  body: object | undefined,
  headers: Record<string, string>,
): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(
        413,
        ApiErrorCode.PayloadTooLarge,
        `the body may be at most ${String(MAX_BODY_BYTES)} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const KINDS: readonly string[] = Object.values(RequestKind);

interface RegistrationBody {
  readonly kind: RequestKind;
  readonly requestId: string;
}

function parseRegistration(text: string): RegistrationBody {
  let body: { kind?: string; requestId?: string } | null;
  try {
    body = JSON.parse(text) as { kind?: string; requestId?: string } | null;
  } catch {
    throw new ApiError(400, ApiErrorCode.InvalidJson, "the body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      400,
      ApiErrorCode.InvalidBody,
      'the body must be a JSON object: {"kind":"deposit"|"withdraw","requestId":"<64 hex>"}',
    );
  }
  const { kind, requestId } = body;
  if (typeof kind !== "string" || !KINDS.includes(kind)) {
    throw new ApiError(400, ApiErrorCode.InvalidKind, 'kind must be "deposit" or "withdraw"');
  }
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ApiError(
      400,
      ApiErrorCode.InvalidRequestId,
      "requestId must be 64 hexadecimal characters",
    );
  }
  return { kind: kind as RequestKind, requestId: requestId.toLowerCase() };
}

// A path segment, percent-decoded; a malformed escape decodes to nothing a request id can match.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function requireMethod(request: IncomingMessage, allowed: string): void {
  if (request.method !== allowed) {
    throw new ApiError(405, ApiErrorCode.MethodNotAllowed, `this route takes ${allowed}`, {
      allow: `${allowed}, OPTIONS`,
    });
  }
}

/**
 * Build the relayer's HTTP server. It does not listen: call `listen` on the result.
 *
 * Routes: `GET /health`, `GET /deposit-address?commitment=`, `POST /requests`,
 * `GET /requests/<requestId>` and `GET /backing`. Every failure is a JSON body
 * `{ "error": { "code", "message" } }` carrying an {@link ApiErrorCode}.
 *
 * @param deps - The settings and the stage machine, backing and derivation to serve.
 * @returns The server.
 */
export function createRelayerServer(deps: HttpDeps): Server {
  const limiter = new RateLimiter(deps.config.rateLimitPerMinute, deps.clock);

  const route = async (
    request: IncomingMessage,
    url: URL,
  ): Promise<{ status: number; body: object }> => {
    const { pathname } = url;
    if (pathname === "/health") {
      requireMethod(request, "GET");
      return { status: 200, body: { ok: true, ...deps.health } };
    }
    if (pathname === "/deposit-address") {
      requireMethod(request, "GET");
      const commitment = url.searchParams.get("commitment") ?? "";
      if (!COMMITMENT_PATTERN.test(commitment)) {
        throw new ApiError(
          400,
          ApiErrorCode.InvalidCommitment,
          "commitment must be 64 hexadecimal characters",
        );
      }
      return { status: 200, body: { evmAddress: deps.depositAddress(commitment.toLowerCase()) } };
    }
    if (pathname === "/requests") {
      requireMethod(request, "POST");
      const { kind, requestId } = parseRegistration(await readBody(request));
      let tracked: TrackedRequest | undefined;
      try {
        tracked = await deps.tracker.register(kind, requestId);
      } catch (error) {
        if (error instanceof RequestKindMismatchError) {
          throw new ApiError(409, ApiErrorCode.KindMismatch, error.message);
        }
        throw new ApiError(503, ApiErrorCode.Unavailable, "the vault could not be read, try again");
      }
      if (tracked === undefined) {
        throw new ApiError(
          404,
          ApiErrorCode.RequestNotFound,
          `the vault holds no ${kind} request ${requestId}: queue it with the start circuit first` +
            (kind === RequestKind.Withdraw
              ? ", and a withdrawal has an id only once a flush gave it its vault nonce"
              : ""),
        );
      }
      return { status: 202, body: { requestId } };
    }
    const lookup = /^\/requests\/([^/]+)$/.exec(pathname);
    if (lookup !== null) {
      requireMethod(request, "GET");
      const requestId = decodeSegment(lookup[1] ?? "");
      if (!REQUEST_ID_PATTERN.test(requestId)) {
        throw new ApiError(
          400,
          ApiErrorCode.InvalidRequestId,
          "the request id must be 64 hexadecimal characters",
        );
      }
      const tracked = deps.tracker.status(requestId.toLowerCase());
      if (tracked === undefined) {
        throw new ApiError(
          404,
          ApiErrorCode.RequestNotFound,
          "the relayer is not tracking this request: register it with POST /requests",
        );
      }
      const status: RequestStatus = toStatus(tracked);
      return { status: 200, body: status };
    }
    if (pathname === "/backing") {
      requireMethod(request, "GET");
      let timed: TimedBackingReading;
      try {
        timed = await deps.backing.get();
      } catch (error) {
        deps.logger.warn(`backing: ${error instanceof Error ? error.message : String(error)}`);
        throw new ApiError(
          503,
          ApiErrorCode.Unavailable,
          "the vault's backing could not be read from the chains, try again",
        );
      }
      const { reading, readAt } = timed;
      return {
        status: 200,
        body: {
          usdcInVault: reading.usdcInVault.toString(),
          kusdMinted: reading.kusdMinted.toString(),
          kusdBurned: reading.kusdBurned.toString(),
          vaultContractAddress: deps.health.vaultContractAddress,
          evmVaultAddress: reading.evmVaultAddress,
          usdcAddress: deps.health.usdcAddress,
          ethereumBlock: reading.ethereumBlock,
          midnightBlock: reading.midnightBlock,
          updatedAt: new Date(readAt).toISOString(),
        },
      };
    }
    throw new ApiError(404, ApiErrorCode.NotFound, `no route ${request.method ?? ""} ${pathname}`);
  };

  return createServer((request, response) => {
    const cors = corsHeaders(request, deps.config.corsOrigins);
    const finish = (
      status: number,
      body: object | undefined,
      extra: Record<string, string> = {},
    ): void => {
      send(response, status, body, { ...cors, ...extra });
    };
    const handle = async (): Promise<void> => {
      if (request.method === "OPTIONS") {
        finish(204, undefined, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        });
        return;
      }
      const wait = limiter.check(clientOf(request, deps.config.trustProxy));
      if (wait > 0) {
        throw new ApiError(
          429,
          ApiErrorCode.RateLimited,
          `too many requests: try again in ${String(wait)}s`,
          { "retry-after": String(wait) },
        );
      }
      const url = new URL(request.url ?? "/", "http://relayer.invalid");
      const { status, body } = await route(request, url);
      finish(status, body);
    };
    handle().catch((error: unknown) => {
      if (error instanceof ApiError) {
        finish(
          error.status,
          { error: { code: error.code, message: error.message } },
          error.headers,
        );
        return;
      }
      deps.logger.warn(
        `unhandled: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      finish(500, { error: { code: ApiErrorCode.Internal, message: "the relayer failed" } });
    });
  });
}

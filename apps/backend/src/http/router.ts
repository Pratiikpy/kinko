// A small router: method plus path pattern to handler.
//
// The API has a few dozen routes and no need for a framework. Patterns use
// `:name` segments; a path matching a pattern under another method answers 405
// with the methods that would have worked, not 404.

import type { IncomingMessage } from "node:http";

import type { Principal } from "../domain/merchants.ts";
import type { Logger } from "../log.ts";

/** Who may call a route. */
export enum AuthMode {
  NONE = "none",
  /** A merchant API key. */
  MERCHANT = "merchant",
  /** Open to anyone, but a merchant API key, if one is sent, identifies the caller. */
  OPTIONAL_MERCHANT = "optional_merchant",
  /** The Telegram bot's service token. */
  BOT = "bot",
}

/** Which rate limit a route counts against. */
export enum LimitClass {
  PUBLIC = "public",
  REGISTER = "register",
  ORACLE = "oracle",
  ASSISTANT = "assistant",
  MERCHANT = "merchant",
  BOT = "bot",
}

/** Everything a handler may use about the request it is serving. */
export interface RequestContext {
  readonly req: IncomingMessage;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  /** Query parameters; a repeated key is rejected before the handler runs. */
  readonly query: Readonly<Record<string, string>>;
  readonly ip: string;
  readonly requestId: string;
  readonly log: Logger;
  /** The authenticated merchant, on routes with {@link AuthMode.MERCHANT}. */
  readonly principal: Principal | undefined;
  /** The parsed JSON body; `{}` when the request has none. Reads at most once. */
  body(): Promise<unknown>;
}

/** What a handler returns. */
export interface HandlerResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A route handler. Throws {@link ApiError} for expected failures. */
export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

/** One route. */
export interface Route {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly pattern: string;
  readonly auth: AuthMode;
  readonly limit: LimitClass;
  readonly handler: Handler;
}

/** The outcome of matching a request line. */
export type Match =
  | { readonly kind: "found"; readonly route: Route; readonly params: Record<string, string> }
  | { readonly kind: "method"; readonly allowed: readonly string[] }
  | { readonly kind: "missing" };

const split = (path: string): string[] => path.split("/").filter(Boolean);

const matchSegments = (pattern: string[], path: string[]): Record<string, string> | undefined => {
  if (pattern.length !== path.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i] ?? "";
    const got = path[i] ?? "";
    if (want.startsWith(":")) {
      try {
        params[want.slice(1)] = decodeURIComponent(got);
      } catch {
        return undefined;
      }
    } else if (want !== got) {
      return undefined;
    }
  }
  return params;
};

/** Finds the route for a request. */
export class Router {
  readonly #routes: readonly (Route & { readonly segments: string[] })[];

  /**
   * Build a router.
   *
   * @param routes - Every route the API serves.
   */
  constructor(routes: readonly Route[]) {
    this.#routes = routes.map((r) => ({ ...r, segments: split(r.pattern) }));
  }

  /**
   * Match a request.
   *
   * @param method - The HTTP method.
   * @param path - The path, without a query string.
   * @returns The route and its parameters, the methods that would have worked, or nothing.
   */
  match(method: string, path: string): Match {
    const segments = split(path);
    const allowed = new Set<string>();
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      if (route.method === method) return { kind: "found", route, params };
      allowed.add(route.method);
    }
    return allowed.size > 0
      ? { kind: "method", allowed: [...allowed].sort() }
      : { kind: "missing" };
  }
}

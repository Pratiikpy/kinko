// The HTTP surface. Three read-only routes and no framework:
//
//   GET /v1/card-snapshot/latest        the birth to stamp on a card being made
//   GET /v1/card-snapshot?birth=<b>     the newest snapshot at or before that birth, for a card opened
//
// A birth is `<event id>-<chain>`: the last event the published tree had applied when the card was
// made, and the first eight hex digits of the chain's first block hash, so a card made on a chain
// that has since been reset is not started from the new chain's tree.
//   GET /healthz                        liveness, and how far the published tree has got
//
// Written on `node:http`, like the sponsor: it needs nothing a framework would add. It holds no
// secret and serves only public chain data, so it asks nothing of a caller but a rate limit.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { publishedSnapshot } from "@kinko/card/snapshot";

import type { SnapshotStore } from "./store.ts";

/** The characters of a chain's identity a birth carries. */
const CHAIN_DIGITS = 8;

/**
 * The birth to stamp on a card made against a snapshot.
 *
 * @param offset - The id of the last event the snapshot applied.
 * @param chain - The chain's identity.
 * @returns The birth.
 */
export const birthOf = (offset: bigint, chain: string): string =>
  `${offset.toString()}-${chain.slice(0, CHAIN_DIGITS)}`;

/** What the server is built from. */
export interface ServerOptions {
  readonly store: SnapshotStore;
  readonly networkId: string;
  /** Origins allowed to call this from a browser. `['*']` for a public service. */
  readonly allowedOrigins?: readonly string[];
  /** Requests one client may make per window. */
  readonly rateMax?: number;
  readonly rateWindowMs?: number;
  /**
   * How many proxies of our own sit in front of this, counted from the right of
   * `X-Forwarded-For`. 0 (the default) trusts only the socket's address; behind a proxy that would
   * put every caller in one bucket, so a proxied deployment sets it. The leftmost entries are
   * whatever the caller sent, so they are never read.
   */
  readonly trustProxyHops?: number;
  readonly now?: () => number;
}

/**
 * The address a request's rate limit is counted against.
 *
 * @param request - The request.
 * @param hops - Proxies of ours in front of the server, counted from the right of `X-Forwarded-For`.
 * @returns The caller's address, as far as it can be believed.
 */
function clientOf(request: IncomingMessage, hops: number): string {
  const socket = request.socket.remoteAddress ?? "unknown";
  if (hops < 1) return socket;
  const header = request.headers["x-forwarded-for"];
  const entries = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries[entries.length - hops] ?? socket;
}

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
};

function corsHeaders(request: IncomingMessage, allowed: readonly string[]): Record<string, string> {
  const origin = request.headers.origin;
  if (origin === undefined || allowed.length === 0) return {};
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
}

/**
 * Build the server.
 *
 * @param options - The store and its limits.
 * @returns The server, not yet listening.
 */
export function createSnapshotServer(options: ServerOptions): Server {
  const { store, networkId } = options;
  const allowed = options.allowedOrigins ?? ["*"];
  const rateMax = options.rateMax ?? 120;
  const rateWindowMs = options.rateWindowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const hops = options.trustProxyHops ?? 0;
  const windows = new Map<string, { start: number; count: number }>();
  let swept = now();

  const limited = (client: string): boolean => {
    const t = now();
    // Expired windows are dropped once a window, not on every request: a scan per request made
    // the cost of each call grow with the number of distinct clients.
    if (t - swept >= rateWindowMs) {
      for (const [key, w] of windows) if (t - w.start >= rateWindowMs) windows.delete(key);
      swept = t;
    }
    const w = windows.get(client);
    if (w !== undefined && t - w.start >= rateWindowMs) windows.delete(client);
    const current = windows.get(client);
    if (current === undefined) {
      windows.set(client, { start: t, count: 1 });
      return false;
    }
    current.count += 1;
    return current.count > rateMax;
  };

  return createServer((request, response) => {
    const cors = corsHeaders(request, allowed);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method !== "GET") {
      json(
        response,
        405,
        { error: "Only GET is served here." },
        { Allow: "GET, OPTIONS", ...cors },
      );
      return;
    }
    if (limited(clientOf(request, hops))) {
      json(response, 429, { error: "Too many requests; try again in a minute." }, cors);
      return;
    }
    const url = new URL(request.url ?? "/", "http://snapshots.local");
    const cache = { "Cache-Control": "public, max-age=30", ...cors };

    if (url.pathname === "/healthz") {
      const latest = store.latest();
      json(
        response,
        200,
        {
          ok: true,
          network: networkId,
          chain: store.chain,
          snapshots: store.size,
          latest:
            latest === undefined
              ? null
              : {
                  offset: latest.offset.toString(),
                  takenAt: latest.takenAt,
                  ageSeconds: Math.round((now() - latest.takenAt) / 1000),
                },
        },
        cors,
      );
      return;
    }
    if (url.pathname === "/v1/card-snapshot/latest") {
      const latest = store.latest();
      if (latest === undefined) {
        json(response, 404, { error: "No snapshot has been published yet." }, cors);
        return;
      }
      json(
        response,
        200,
        {
          offset: latest.offset.toString(),
          takenAt: latest.takenAt,
          birth: birthOf(latest.offset, store.chain),
        },
        cache,
      );
      return;
    }
    if (url.pathname === "/v1/card-snapshot") {
      const birth = /^([0-9]{1,18})-([0-9a-f]{8})$/.exec(url.searchParams.get("birth") ?? "");
      if (birth?.[1] === undefined || birth[2] === undefined) {
        json(response, 400, { error: "birth must look like 12345-1a2b3c4d." }, cors);
        return;
      }
      if (birth[2] !== store.chain.slice(0, CHAIN_DIGITS)) {
        json(response, 404, { error: "That card was made on another chain." }, cors);
        return;
      }
      const found = store.pick(BigInt(birth[1]));
      if (found === undefined) {
        json(response, 404, { error: "No snapshot at or before that birth." }, cors);
        return;
      }
      json(
        response,
        200,
        {
          offset: found.offset.toString(),
          takenAt: found.takenAt,
          snapshot: publishedSnapshot(found.snapshot),
        },
        cache,
      );
      return;
    }
    json(response, 404, { error: "Not found." }, cors);
  });
}

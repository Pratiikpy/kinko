// A pass-through to the Midnight indexer and node that keeps the provider's key on the server.
// A hosted provider such as Blockfrost puts its project key in the URL; built into the app, that
// key ships to every visitor. Here the app is built against /chain/indexer, /chain/indexer/ws and
// /chain/node on its own origin, and only this server knows the keyed upstream URLs:
//
//   CHAIN_INDEXER_UPSTREAM     https://…/api/v0?project_id=…        (GraphQL over HTTP)
//   CHAIN_INDEXER_WS_UPSTREAM  wss://…/api/v0/ws?project_id=…       (GraphQL over WebSocket)
//   CHAIN_NODE_UPSTREAM        https://rpc…/?project_id=…           (JSON-RPC over HTTP, and over
//                                                                    WebSocket at the wss: twin)
//
// Each route is limited per client, so the proxy cannot be used as a free, unmetered key.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

/** The largest request body passed upstream: indexer queries and node calls are small. */
const MAX_BODY_BYTES = 256 * 1024;
/** Requests per client per minute across the HTTP routes. */
const REQUESTS_PER_MINUTE = 600;
/** Open indexer and node sockets per client: a card page holds several, and a shared network many. */
const SOCKETS_PER_CLIENT = 32;
const MINUTE_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

export interface ChainUpstreams {
  readonly indexer?: URL;
  readonly indexerWs?: URL;
  readonly node?: URL;
}

/** Reads the upstreams from the environment; a route without one is not served. */
export function upstreamsFromEnv(env: NodeJS.ProcessEnv): ChainUpstreams {
  const parse = (value: string | undefined, protocols: readonly string[]): URL | undefined => {
    if (!value) return undefined;
    const u = new URL(value);
    if (!protocols.includes(u.protocol)) {
      throw new Error(`${value.split("?")[0] ?? value}: expected ${protocols.join(" or ")}`);
    }
    return u;
  };
  return {
    indexer: parse(env.CHAIN_INDEXER_UPSTREAM, ["https:"]),
    indexerWs: parse(env.CHAIN_INDEXER_WS_UPSTREAM, ["wss:"]),
    node: parse(env.CHAIN_NODE_UPSTREAM, ["https:"]),
  };
}

/**
 * The client a request comes from. The tunnel in front of this server sets CF-Connecting-IP;
 * without it, the socket's address is all there is.
 */
function clientOf(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  return (Array.isArray(cf) ? cf[0] : cf) ?? req.socket.remoteAddress ?? "unknown";
}

const windows = new Map<string, { start: number; count: number }>();
function allowRequest(client: string, now: number): boolean {
  const w = windows.get(client);
  if (!w || now - w.start >= MINUTE_MS) {
    windows.set(client, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (now - v.start >= MINUTE_MS) windows.delete(k);
    }
    return true;
  }
  w.count += 1;
  return w.count <= REQUESTS_PER_MINUTE;
}

const openSockets = new Map<string, number>();

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Serves /chain/indexer and /chain/node. Returns false for any other path, so the caller can
 * serve it.
 */
export function handleChainRequest(
  upstreams: ChainUpstreams,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const pathname = (req.url ?? "").split("?")[0];
  const upstream =
    pathname === "/chain/indexer"
      ? upstreams.indexer
      : pathname === "/chain/node"
        ? upstreams.node
        : undefined;
  if (pathname !== "/chain/indexer" && pathname !== "/chain/node") return false;
  if (!upstream) {
    fail(res, 404, "not configured");
    return true;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { ...CORS, Allow: "POST, OPTIONS" });
    res.end();
    return true;
  }
  if (!allowRequest(clientOf(req), Date.now())) {
    fail(res, 429, "too many requests");
    return true;
  }
  void (async () => {
    try {
      const body = await readBody(req);
      if (!body) {
        fail(res, 413, "request too large");
        return;
      }
      const answer = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const payload = Buffer.from(await answer.arrayBuffer());
      res.writeHead(answer.status, {
        ...CORS,
        "Content-Type": answer.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store, no-transform",
      });
      res.end(payload);
    } catch (e) {
      if (!res.headersSent) fail(res, 502, "upstream unavailable");
      else res.destroy();
      console.error(`chain proxy ${pathname}: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  return true;
}

/** Headers a WebSocket handshake needs passed on; everything else stays here. */
const WS_HEADERS = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];

/** The node's WebSocket endpoint: its HTTP upstream with the scheme swapped, as a wallet derives it. */
function nodeWs(node: URL | undefined): URL | undefined {
  if (!node) return undefined;
  const ws = new URL(node);
  ws.protocol = "wss:";
  return ws;
}

/**
 * Serves the /chain/indexer/ws and /chain/node upgrades by opening the keyed upstream socket and
 * piping the two together. Returns false for any other path.
 */
export function handleChainUpgrade(
  upstreams: ChainUpstreams,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname !== "/chain/indexer/ws" && pathname !== "/chain/node") return false;
  const upstream = pathname === "/chain/node" ? nodeWs(upstreams.node) : upstreams.indexerWs;
  const client = clientOf(req);
  const open = openSockets.get(client) ?? 0;
  if (!upstream || open >= SOCKETS_PER_CLIENT) {
    if (upstream) console.error(`chain proxy ${pathname}: ${client} at ${String(open)} sockets`);
    socket.end(
      upstream ? "HTTP/1.1 429 Too Many Requests\r\n\r\n" : "HTTP/1.1 404 Not Found\r\n\r\n",
    );
    return true;
  }
  openSockets.set(client, open + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const n = (openSockets.get(client) ?? 1) - 1;
    if (n <= 0) openSockets.delete(client);
    else openSockets.set(client, n);
  };

  const port = Number(upstream.port || 443);
  const remote = tlsConnect({ host: upstream.hostname, port, servername: upstream.hostname });
  remote.setTimeout(UPSTREAM_TIMEOUT_MS, () => remote.destroy());
  remote.once("secureConnect", () => {
    remote.setTimeout(0);
    const lines = [
      `GET ${upstream.pathname}${upstream.search} HTTP/1.1`,
      `Host: ${upstream.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
    ];
    for (const name of WS_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") lines.push(`${name}: ${value}`);
    }
    remote.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) remote.write(head);
    // A refused handshake reaches the browser only as "cannot connect"; say here what came back.
    remote.once("data", (chunk: Buffer) => {
      const status = chunk.toString("latin1").split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/1\.1 101\b/.test(status)) {
        console.error(`chain proxy ${pathname}: upstream answered "${status}"`);
      }
    });
    remote.pipe(socket);
    socket.pipe(remote);
  });
  const close = (): void => {
    release();
    remote.destroy();
    socket.destroy();
  };
  remote.on("error", close);
  remote.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
  return true;
}

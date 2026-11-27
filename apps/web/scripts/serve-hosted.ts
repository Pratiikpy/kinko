// Serves a built Kinko web app for hosting: the static files, the single-page fallback, and the
// contracts' proving keys under /zk, which a static host cannot hold because they run to over a
// gigabyte.
//
//   node --experimental-strip-types apps/web/scripts/serve-hosted.ts [dist/hosted]
//
// With no directory it serves only /zk, for an app hosted elsewhere that points
// VITE_ZK_BASE_URL at this server. PORT (default 4180) and HOST (default 127.0.0.1) choose where
// it listens; put a TLS proxy or tunnel in front of it.
//
// Set CHAIN_INDEXER_UPSTREAM, CHAIN_INDEXER_WS_UPSTREAM and CHAIN_NODE_UPSTREAM to also serve the
// key-hiding chain pass-through in chain-proxy.ts under /chain.
//
// Every response carries `Cache-Control: no-transform`, so a CDN in front does not rewrite the
// pages (Cloudflare, for one, would otherwise inject its analytics beacon, and this app promises
// none).

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { managedDirs, resolveZkAsset } from "../zk-assets.ts";
import { handleChainRequest, handleChainUpgrade, upstreamsFromEnv } from "./chain-proxy.ts";

const DEFAULT_PORT = 4180;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = managedDirs(join(webRoot, "..", ".."));
const appDir = process.argv[2] ? resolve(webRoot, process.argv[2]) : undefined;
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const host = process.env.HOST ?? "127.0.0.1";
const chain = upstreamsFromEnv(process.env);

if (appDir && !existsSync(join(appDir, "index.html"))) {
  console.error(`No built app at ${appDir}: run vite build first.`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Proving keys are public and checked against the compiler's manifest before use.
const ZK_HEADERS = {
  ...BASE_HEADERS,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function sendFile(
  res: ServerResponse,
  method: string,
  path: string,
  headers: Record<string, string>,
): void {
  res.writeHead(200, {
    ...headers,
    "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
    "Content-Length": String(statSync(path).size),
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** A file under the app directory, or undefined for anything outside it or missing. */
function appFile(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = normalize(join(root, decoded));
  if (!path.startsWith(root + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (handleChainRequest(chain, req, res)) return;

  if (method === "OPTIONS" && pathname.startsWith("/zk/")) {
    res.writeHead(204, ZK_HEADERS);
    res.end();
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { ...BASE_HEADERS, Allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (pathname === "/healthz") {
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        app: appDir !== undefined,
        contracts: Object.keys(dirs),
        chain: { indexer: !!chain.indexer, indexerWs: !!chain.indexerWs, node: !!chain.node },
      }),
    );
    return;
  }
  if (pathname.startsWith("/zk/")) {
    const path = resolveZkAsset(dirs, pathname);
    if (path) {
      sendFile(res, method, path, {
        ...ZK_HEADERS,
        "Cache-Control": "public, max-age=3600, no-transform",
      });
      return;
    }
    res.writeHead(404, { ...ZK_HEADERS, "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  if (!appDir) {
    res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const file = appFile(appDir, pathname);
  if (file && !file.endsWith(".html")) {
    // Vite fingerprints everything under /assets, so those never change under one name.
    const cache = pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable, no-transform"
      : "public, max-age=3600, no-transform";
    sendFile(res, method, file, { ...BASE_HEADERS, "Cache-Control": cache });
    return;
  }
  // A missing file is a 404, not the page: a stale bundle asking for an old chunk must fail plainly.
  if (extname(pathname) !== "" && !pathname.endsWith(".html")) {
    res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  // Every other path is a route of the single-page app.
  sendFile(res, method, join(appDir, "index.html"), {
    ...BASE_HEADERS,
    "Cache-Control": "no-cache, no-transform",
    "X-Frame-Options": "DENY",
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!handleChainUpgrade(chain, req, socket, head)) socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
});

server.listen(port, host, () => {
  console.log(
    `${appDir ? `app ${appDir} and ` : ""}proving keys on http://${host}:${String(port)}`,
  );
});

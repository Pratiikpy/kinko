// Serving each contract's proving keys and ZK IR under /zk, where the app's
// zk config provider fetches them: `/zk/<contract>/keys/<circuit>.prover`,
// `.verifier`, `/zk/<contract>/zkir/<circuit>.bzkir` and the integrity
// manifest at `/zk/<contract>/compiler/contract-manifest.json`.
//
// The dev server and `vite preview` stream them straight from the compiler
// output. A production build copies them into the bundle only when
// KINKO_ZK_ASSETS=copy, because the keys run to over a gigabyte; a hosted
// deployment would normally serve them from a bucket via VITE_ZK_BASE_URL.

import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";

import type { Plugin } from "vite";

// `compiler` holds contract-manifest.json, the compiler's hashes of every key
// and ZK IR file, which the provider uses to verify what it downloads.
const SUBDIRS = new Set(["keys", "zkir", "compiler"]);
const ROUTE = /^\/zk\/([a-z0-9_-]+)\/(keys|zkir|compiler)\/([A-Za-z0-9_.-]+)$/;

/**
 * Where each contract's compiler output lives, by the directory name the app requests.
 *
 * @param repoRoot - The repository root.
 * @returns Directory name to absolute managed path.
 */
export function managedDirs(repoRoot: string): Record<string, string> {
  const pay = join(repoRoot, "contracts", "kinko-pay", "src", "managed");
  return {
    kinko_pay: join(pay, "kinko_pay"),
    kinko_tags: join(pay, "kinko_tags"),
    kinko_gift: join(pay, "kinko_gift"),
    kinko_disclosure: join(
      repoRoot,
      "contracts",
      "kinko-disclosure",
      "src",
      "managed",
      "kinko_disclosure",
    ),
    "erc20-vault": join(repoRoot, "engine", "vault", "contract", "src", "managed", "erc20-vault"),
  };
}

/**
 * Resolve a /zk request to a file, refusing anything outside the managed directories.
 *
 * @param dirs - From {@link managedDirs}.
 * @param pathname - The request path, without query.
 * @returns The file, or undefined when the path is not a zk asset that exists.
 */
export function resolveZkAsset(dirs: Record<string, string>, pathname: string): string | undefined {
  const match = ROUTE.exec(pathname);
  if (!match) return undefined;
  const [, contract, sub, file] = match;
  const base = contract ? dirs[contract] : undefined;
  if (!base || !sub || !file || !SUBDIRS.has(sub) || file.startsWith(".")) return undefined;
  const root = normalize(join(base, sub)) + sep;
  const path = normalize(join(root, file));
  if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) return undefined;
  return path;
}

function middleware(dirs: Record<string, string>) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (!pathname.startsWith("/zk/")) {
      next();
      return;
    }
    const path = resolveZkAsset(dirs, pathname);
    if (!path) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader(
      "Content-Type",
      path.endsWith(".json") ? "application/json" : "application/octet-stream",
    );
    res.setHeader("Content-Length", String(statSync(path).size));
    res.setHeader("Cache-Control", "public, max-age=3600");
    createReadStream(path).pipe(res);
  };
}

/**
 * The Vite plugin.
 *
 * @param repoRoot - The repository root.
 * @returns The plugin.
 */
export function zkAssets(repoRoot: string): Plugin {
  const dirs = managedDirs(repoRoot);
  let outDir = "dist";
  return {
    name: "kinko-zk-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(middleware(dirs));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(dirs));
    },
    closeBundle() {
      if (process.env.KINKO_ZK_ASSETS !== "copy") return;
      for (const [name, base] of Object.entries(dirs)) {
        for (const sub of SUBDIRS) {
          const from = join(base, sub);
          if (existsSync(from)) cpSync(from, join(outDir, "zk", name, sub), { recursive: true });
        }
      }
    },
  };
}

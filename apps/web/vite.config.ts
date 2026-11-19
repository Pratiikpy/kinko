import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

import { zkAssets } from "./zk-assets.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// The ledger and the on-chain runtime are WebAssembly modules loaded with
// top-level await. Pre-bundling them breaks the WASM load, and pre-bundling
// midnight-js-protocol alone (it re-exports the ledger) gives the page two
// instances of the same classes, which fails every `instanceof` check inside
// the SDK with "expected instance of". So all three are served as they are.
export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), zkAssets(repoRoot)],
  optimizeDeps: {
    exclude: [
      "@midnightntwrk/ledger-v9",
      "@midnightntwrk/onchain-runtime-v4",
      "@midnight-ntwrk/midnight-js-protocol",
    ],
  },
  server: {
    port: 5183,
    strictPort: true,
    // The contract packages live in the workspace, outside this package.
    fs: { allow: [repoRoot] },
  },
  preview: { port: 5183, strictPort: true },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
    // Published with the build so anyone can read the shipped code against the source.
    sourcemap: true,
  },
});

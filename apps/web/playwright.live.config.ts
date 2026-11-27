import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

// The network the run targets: NETWORK_ID from the env file KINKO_ENV_FILE names
// (the repo-root .env by default), the same file the suite's wallets read.
const root = fileURLToPath(new URL("../../", import.meta.url));
const envFile = `${root}${process.env.KINKO_ENV_FILE ?? ".env"}`;
const NETWORK =
  process.env.NETWORK_ID ??
  (existsSync(envFile)
    ? /^\s*NETWORK_ID\s*=\s*(\S+)/m.exec(readFileSync(envFile, "utf8"))?.[1]
    : undefined) ??
  "undeployed";
const LOCAL = NETWORK === "undeployed";
// The stagenet services listen on their own ports, so both stacks can run at once.
const PORT = LOCAL ? "5191" : "4174";
// KINKO_LIVE_BASE_URL runs the suite against a deployment already hosted elsewhere, whose
// services must be on NETWORK_ID, instead of a fresh local build.
const HOSTED = process.env.KINKO_LIVE_BASE_URL?.replace(/\/+$/, "");

// The live suite: the real app against a real chain (the local stack, or a deployed network
// with the real Signature Network MPC and Sepolia), Kinko's deployed contracts, the relayer,
// the backend and the sponsor, with real wallets. Every proof is real, so tests run one at a
// time and allow minutes per step; a deployed network's blocks and finality are slower still.
export default defineConfig({
  testDir: "e2e/live",
  outputDir: `dist/e2e-live-results${LOCAL ? "" : `-${NETWORK}`}`,
  timeout: (LOCAL ? 30 : 90) * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: HOSTED ?? `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: HOSTED
    ? undefined
    : {
        command: `npx vite build --mode ${NETWORK} --outDir dist/live-${NETWORK} && npx vite preview --mode ${NETWORK} --outDir dist/live-${NETWORK} --port ${PORT} --strictPort --host 127.0.0.1`,
        url: `http://127.0.0.1:${PORT}`,
        // Always a fresh build, so a run never tests a stale bundle.
        reuseExistingServer: false,
        timeout: 300_000,
      },
});

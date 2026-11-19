// Entry point: `yarn workspace @kinko/deploy deploy`. Reads the root `.env`
// (the same file the vault's deploy writes its addresses to) and then the
// process environment, which wins.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deployKinko, readDeployment, writeDeployment } from "./deploy-kinko.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

const env: Record<string, string | undefined> = {
  ...readEnvFile(resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env")),
  ...process.env,
  KINKO_SECRETS_DIR: process.env.KINKO_SECRETS_DIR ?? join(ROOT, ".secrets"),
};

const networkId = env.NETWORK_ID ?? "undeployed";
const previous = existsSync(join(ROOT, "deployments", `${networkId}.json`))
  ? readDeployment(ROOT, networkId)
  : undefined;
const deployment = await deployKinko(env, previous);
// A local stack's services sit on fixed ports; a deployed network names them.
const local = deployment.networkId === "undeployed";
const extras: Record<string, string> = {};
for (const [from, to, fallback] of [
  ["MIDNIGHT_VAULT_CONTRACT_ADDRESS", "VITE_VAULT_CONTRACT_ADDRESS", undefined],
  ["ERC20_ADDRESS", "VITE_USDC_ADDRESS", undefined],
  ["EVM_VAULT_ADDRESS", "VITE_EVM_VAULT_ADDRESS", undefined],
  ["MPC_SECP256K1_PUBKEY", "VITE_MPC_PUBLIC_KEY", undefined],
  ["EVM_RPC_URL", "VITE_EVM_RPC_URL", undefined],
  ["EVM_CHAIN_ID", "VITE_EVM_CHAIN_ID", undefined],
  ["MIDNIGHT_NODE_INDEXER_URL", "VITE_INDEXER_URL", undefined],
  ["KINKO_RELAYER_URL", "VITE_RELAYER_URL", local ? "http://localhost:3200" : undefined],
  ["KINKO_BACKEND_URL", "VITE_BACKEND_URL", local ? "http://localhost:3100" : undefined],
  ["KINKO_SPONSOR_URL", "VITE_SPONSOR_URL", local ? "http://localhost:3300" : undefined],
  ["KINKO_SNAPSHOTS_URL", "VITE_SNAPSHOTS_URL", local ? "http://localhost:3400" : undefined],
  ["MIDNIGHT_NODE_URL", "VITE_NODE_URL", local ? "http://localhost:9944" : undefined],
] as const) {
  const value = env[from] ?? fallback;
  if (value) extras[to] = value;
}
for (const path of writeDeployment(deployment, ROOT, extras)) console.log(`wrote ${path}`);

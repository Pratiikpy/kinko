// `yarn workspace @kinko/deploy fund-roles`: give every role wallet Kinko runs
// with a seed and the NIGHT to generate its own fees, from the root wallet: the
// genesis wallet on the local stack, the one the faucet paid on a deployed
// network. The vault's setup funds only its own roles, so these need it on both. A role with no seed in the env file gets a
// fresh one, appended to that file (which stays out of git); a role already
// holding NIGHT is only registered and waited on. Root syncs once for all.
//
//   KINKO_ROLE_NIGHT   NIGHT each empty role receives, in STAR (default 400 NIGHT)

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fundChildFromRoot,
  getDeployConfig,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";

/** The roles a deployed Kinko needs, by the env variable holding each seed. */
export const ROLE_SEEDS = {
  RELAYER_SEED: "relayer",
  USER_SEED: "user",
  BEARER_SEED: "bearer",
} as const;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILE = resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env");

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[2] !== "") {
      out[match[1]] = match[2];
    }
  }
  return out;
}

const env: Record<string, string | undefined> = { ...readEnvFile(ENV_FILE), ...process.env };
const deploy = getDeployConfig(env);

const created: Record<string, string> = {};
for (const name of Object.keys(ROLE_SEEDS)) {
  if (!env[name]) created[name] = randomBytes(32).toString("hex");
}
if (Object.keys(created).length > 0) {
  const lines = Object.entries(created).map(([k, v]) => `${k}=${v}`);
  appendFileSync(ENV_FILE, `\n# role wallets created by fund-roles\n${lines.join("\n")}\n`, {
    mode: 0o600,
  });
  console.log(`created seeds for ${Object.keys(created).join(", ")} in ${ENV_FILE}`);
}
const seeds = { ...env, ...created };

const amount = BigInt(env.KINKO_ROLE_NIGHT ?? String(400n * 1_000_000n));
const registry = new WalletRegistry(deploy.midnightNodeConfig, env);
try {
  // One role at a time: each transfer spends root's NIGHT, and parallel spends of one wallet
  // would race for the same coins.
  for (const [name, label] of Object.entries(ROLE_SEEDS)) {
    const seed = seeds[name];
    if (!seed) throw new Error(`${name} has no seed`);
    const funding = await fundChildFromRoot(registry, deploy.deployerSeed, seed, label, amount);
    console.log(
      `${label} funded: ${JSON.stringify(funding, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }
} finally {
  await registry.close();
}

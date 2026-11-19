// `yarn workspace @kinko/sponsor fund`: create the sponsor's wallet if it has
// none, send it NIGHT from the deployer and register that NIGHT for DUST, so
// the sponsor generates the fees it pays. Run again to top it up.
//
//   KINKO_SPONSOR_NIGHT   NIGHT to send, in STAR (default 500 NIGHT)

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fundChildFromRoot,
  getDeployConfig,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";

import { sponsorSeed } from "./config.ts";
import { loadEnv, ROOT } from "./env.ts";

const env = loadEnv();
const deploy = getDeployConfig(env);
const networkId = deploy.midnightNodeConfig.networkId;
const secretsDir = join(env.KINKO_SECRETS_DIR ?? join(ROOT, ".secrets"), networkId);

let seed: string;
try {
  seed = sponsorSeed(env, secretsDir);
} catch {
  seed = randomBytes(32).toString("hex");
  mkdirSync(secretsDir, { recursive: true });
  const file = join(secretsDir, "sponsor.json");
  if (existsSync(file)) throw new Error(`${file} exists but holds no seed; fix or remove it.`);
  writeFileSync(file, `${JSON.stringify({ seed }, null, 2)}\n`, { mode: 0o600 });
  console.log(`created a sponsor wallet; its seed is in ${file}`);
}

const amount = BigInt(env.KINKO_SPONSOR_NIGHT ?? String(500n * 1_000_000n));
const registry = new WalletRegistry(deploy.midnightNodeConfig, env);
try {
  const funding = await fundChildFromRoot(registry, deploy.deployerSeed, seed, "sponsor", amount);
  console.log(
    `sponsor funded: ${JSON.stringify(funding, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
  );
} finally {
  await registry.close();
}

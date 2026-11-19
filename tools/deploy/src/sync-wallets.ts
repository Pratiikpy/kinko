// `yarn workspace @kinko/deploy sync-wallets`: sync every wallet Kinko runs with
// and save each one's cache, all at once. On a public network a fresh wallet
// replays the chain's whole DUST history before it can pay a fee, which takes
// hours; syncing the roles side by side, ahead of the services and tests that
// open them, pays that cost once and in parallel. Each wallet's cache path comes
// from `<LABEL>_WALLET_CACHE_PATH` in the env file, or the SDK's default.
//
// A sync is bound by one CPU core, so name roles to sync only those, and run one
// process per role to use the machine's cores: `sync-wallets relayer`.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getDeployConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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

const env: Record<string, string | undefined> = {
  ...readEnvFile(resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env")),
  ...process.env,
};
const deploy = getDeployConfig(env);
const secrets = join(
  env.KINKO_SECRETS_DIR ?? join(ROOT, ".secrets"),
  deploy.midnightNodeConfig.networkId,
);
const sponsorFile = join(secrets, "sponsor.json");

/** Each wallet to sync, by the label the code that opens it uses. */
const wallets: [label: string, seed: string | undefined][] = [
  ["relayer", env.RELAYER_SEED],
  ["user", env.USER_SEED],
  ["bearer", env.BEARER_SEED],
  [
    "sponsor",
    env.KINKO_SPONSOR_SEED ??
      (existsSync(sponsorFile)
        ? (JSON.parse(readFileSync(sponsorFile, "utf8")) as { seed?: string }).seed
        : undefined),
  ],
];

const only = process.argv.slice(2);
const unknown = only.filter((label) => !wallets.some(([l]) => l === label));
if (unknown.length > 0) {
  throw new Error(
    `unknown roles ${unknown.join(", ")}; expected some of ${wallets.map(([l]) => l).join(", ")}`,
  );
}
const selected = only.length > 0 ? wallets.filter(([label]) => only.includes(label)) : wallets;

const registry = new WalletRegistry(deploy.midnightNodeConfig, env);
try {
  const results = await Promise.allSettled(
    selected.map(async ([label, seed]) => {
      if (!seed) throw new Error(`${label} has no seed`);
      const started = Date.now();
      await registry.wallet(seed, label);
      return `${label} synced in ${String(Math.round((Date.now() - started) / 1000))}s`;
    }),
  );
  for (const r of results)
    console.log(r.status === "fulfilled" ? r.value : `failed: ${String(r.reason)}`);
} finally {
  // Closing writes each wallet's cache one last time.
  await registry.close();
}

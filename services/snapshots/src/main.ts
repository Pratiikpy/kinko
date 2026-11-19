// Entry point: `yarn workspace @kinko/snapshots start`. A wallet that holds no coin follows the
// chain and publishes its commitment tree, so a new card can start from where it was made.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CardWallet, type FeePayer } from "@kinko/card";
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";

import { loadBootstrap } from "./bootstrap.ts";
import { chainIdentity } from "./chain.ts";
import { readConfig } from "./config.ts";
import { loadEnv, ROOT } from "./env.ts";
import { Keeper } from "./keeper.ts";
import { createSnapshotServer } from "./server.ts";
import { SnapshotStore } from "./store.ts";

/**
 * An endpoint with its path and query dropped: a hosted indexer's URL carries its project key.
 *
 * @param url - The endpoint.
 * @returns Its origin, or a placeholder when it is not a URL.
 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "(unreadable url)";
  }
};

const say = (line: string): void => {
  process.stdout.write(`snapshots: ${line}\n`);
};

/**
 * The keeper wallet's secret: drawn on first start, kept in a file only this process reads.
 *
 * @param path - Where it is kept.
 * @returns 32 bytes.
 */
function keeperSecret(path: string): Uint8Array {
  if (existsSync(path))
    return new Uint8Array(Buffer.from(readFileSync(path, "utf8").trim(), "hex"));
  const secret = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, secret.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return new Uint8Array(secret);
}

/** The keeper never pays: nothing is ever sent from it. */
const noPayer: FeePayer = {
  kind: "wallet",
  pay: () => Promise.reject(new Error("The snapshot keeper never submits a transaction.")),
};

const env = loadEnv();
const node = getMidnightNodeConfig(env);
const config = readConfig(env, ROOT, node.networkId);

say(`network ${node.networkId}, indexer ${hostOf(node.indexerUrl)}`);
let chain: string | undefined;
for (let attempt = 1; chain === undefined; attempt++) {
  try {
    chain = await chainIdentity(node.indexerUrl);
  } catch (error) {
    say(
      `cannot tell which chain this is yet (${error instanceof Error ? error.message : String(error)}); retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, attempt * 5_000)));
  }
}
const store = SnapshotStore.open(config.storePath, chain);
if (store.size === 0 && config.bootstrapPath !== undefined) {
  try {
    store.add(loadBootstrap(config.bootstrapPath, node.networkId));
    say(`started from the tree in ${config.bootstrapPath}`);
  } catch (error) {
    say(
      `not starting from ${config.bootstrapPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
const resumed = store.latest();
say(
  resumed
    ? `chain ${chain.slice(0, 12)}...; resuming from the tree at event ${resumed.offset.toString()} (${String(store.size)} kept)`
    : `chain ${chain.slice(0, 12)}...; no snapshot yet, so the first replays the whole chain`,
);

const wallet = await CardWallet.open(
  keeperSecret(config.seedPath),
  {
    networkId: node.networkId,
    indexerHttpUrl: node.indexerUrl,
    indexerWsUrl: node.indexerWsUrl,
    proofServerUrl: node.proofServerUrl,
    nodeUrl: node.nodeUrl,
  },
  noPayer,
  resumed ? { snapshot: resumed.snapshot } : {},
);
const keeper = new Keeper({
  store,
  source: wallet,
  networkId: node.networkId,
  intervalMs: config.intervalMs,
  log: say,
});
keeper.start();

const server = createSnapshotServer({
  store,
  networkId: node.networkId,
  allowedOrigins: config.allowedOrigins,
  trustProxyHops: config.trustProxyHops,
});
server.listen(config.port, config.host, () => {
  say(`listening on http://${config.host}:${String(config.port)}/v1/card-snapshot`);
});

const shutdown = (): void => {
  keeper.stop();
  server.close();
  void wallet.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

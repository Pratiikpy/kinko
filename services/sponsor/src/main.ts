// Entry point: `yarn workspace @kinko/sponsor start`. A funded wallet behind the HTTP service.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { getMidnightNodeConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

import { readConfig } from "./config.ts";
import { loadEnv, ROOT } from "./env.ts";
import { createSponsorServer } from "./server.ts";
import { type SponsorLogEntry, SponsorService } from "./service.ts";
import { facadeSigner } from "./signer.ts";

const env = loadEnv();
const node = getMidnightNodeConfig(env);
const config = readConfig(env, ROOT, node.networkId);
const say = (line: string) => process.stdout.write(`sponsor: ${line}\n`);

say(`network ${node.networkId}, indexer ${node.indexerUrl}; syncing the sponsoring wallet...`);
const registry = new WalletRegistry(node, env);
const { facade, keys } = await registry.wallet(config.seed, "sponsor");
const signer = facadeSigner(facade, keys);
say(`wallet ${signer.address} holds ${String(await signer.dustSpeck())} SPECK of DUST`);

mkdirSync(dirname(config.logPath), { recursive: true });
const onLog = (entry: SponsorLogEntry): void => {
  appendFileSync(config.logPath, `${JSON.stringify(entry)}\n`, "utf8");
  const what = entry.circuits.join(", ") || "(no call)";
  say(
    entry.outcome === "refused"
      ? `REFUSED ${entry.code ?? ""} for ${what} from ${entry.caller}: ${entry.reason ?? ""}`
      : `${entry.outcome === "paid" ? "PAID" : "SUBMIT-FAILED, CHARGED"} ${entry.feeSpeck ?? "?"} SPECK ` +
          `for ${what} from ${entry.caller} -> ${entry.txId ?? "(no id)"} ` +
          `[spent ${entry.cumulativeFeeSpeck} of ${String(config.policy.budgetSpeck)}]`,
  );
};

const service = new SponsorService({ policy: config.policy, signer, onLog, debug: config.debug });
const server = createSponsorServer({
  service,
  allowedOrigins: config.allowedOrigins,
  trustedProxies: config.trustedProxies,
});
const pruner = setInterval(() => {
  service.pruneRateLimiter();
}, config.policy.rateLimit.windowMs);
pruner.unref();

server.listen(config.port, config.host, () => {
  say(`listening on http://${config.host}:${String(config.port)}/v1/sponsor`);
  say(
    `contracts ${config.policy.contracts.join(", ")}; circuits ${config.policy.circuits.join(", ")}`,
  );
  say(
    `limits <= ${String(config.policy.maxFeeSpeck)} SPECK per transaction, ` +
      `${String(config.policy.rateLimit.maxRequests)} per ${String(config.policy.rateLimit.windowMs / 1000)}s per client, ` +
      `budget ${String(config.policy.budgetSpeck)} SPECK; ledger ${config.logPath}`,
  );
});

const shutdown = (signal: string): void => {
  say(`${signal}, stopping`);
  server.close();
  void registry.close().then(() => process.exit(0));
};
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

// `yarn workspace @kinko/deploy move-kusd <from> <to> <dollars>`: move KUSD between the test
// suite's role wallets, as a plain shielded transfer paid by the sender. The live flows pay each
// other, so over many runs the payer's balance drains into the merchant's and the flows that need
// a balance start to skip; this puts it back without a fresh deposit through the vault.
//
// Roles are `user` (USER_SEED, the suite's payer and card owner) and `bearer` (BEARER_SEED, the
// suite's merchant). Reads the env file KINKO_ENV_FILE names and deployments/<network>.json.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getMidnightNodeConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TTL_MS = 30 * 60 * 1000;
const ROLES = { user: "USER_SEED", bearer: "BEARER_SEED" } as const;
type Role = keyof typeof ROLES;
const BASE_UNITS_PER_DOLLAR = 1_000_000;

function env(): Record<string, string | undefined> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(
    resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env"),
    "utf8",
  ).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return { ...out, ...process.env };
}

const isRole = (v: string | undefined): v is Role => v === "user" || v === "bearer";

const [from, to, dollars] = process.argv.slice(2);
const amountDollars = Number(dollars);
if (!isRole(from) || !isRole(to) || from === to || !(amountDollars > 0)) {
  console.error("usage: move-kusd <user|bearer> <user|bearer> <dollars>, two different roles");
  process.exit(2);
}
const amount = BigInt(Math.round(amountDollars * BASE_UNITS_PER_DOLLAR));

const e = env();
const config = getMidnightNodeConfig(e);
const { kusdColor } = JSON.parse(
  readFileSync(join(ROOT, "deployments", `${config.networkId}.json`), "utf8"),
) as { kusdColor: string };
const registry = new WalletRegistry(config, e);
const seedOf = (role: Role): string => {
  const seed = e[ROLES[role]];
  if (!seed) throw new Error(`${ROLES[role]} is not set in the env file`);
  return seed;
};

try {
  const sender = await registry.wallet(seedOf(from), from);
  const receiver = await registry.wallet(seedOf(to), to);
  const senderState = await sender.facade.waitForSyncedState();
  const receiverState = await receiver.facade.waitForSyncedState();
  const held = senderState.shielded.balances[kusdColor] ?? 0n;
  if (held < amount) {
    throw new Error(`${from} holds ${String(held)} KUSD base units, less than ${String(amount)}`);
  }
  const receiverAddress = receiverState.shielded.address;
  const ttl = new Date(Date.now() + TTL_MS);
  const prepared = await sender.facade.transferTransaction(
    [{ type: "shielded", outputs: [{ type: kusdColor, amount, receiverAddress }] }],
    { ttl, payFees: false },
  );
  const recipe = await sender.facade.balanceUnprovenTransaction(prepared.transaction, { ttl });
  const signed = await sender.facade.signRecipe(
    recipe,
    sender.keys.unshieldedKeystore.signDataAsync,
  );
  const tx = await sender.facade.submitTransaction(await sender.facade.finalizeRecipe(signed));
  console.log(`moved $${String(amountDollars)} KUSD from ${from} to ${to}: ${tx}`);
} finally {
  await registry.close();
}

/* global console, process */
// Copies each contract's proving keys, verifier keys, ZK IR and integrity
// manifest from the compiler's output into public/zk/<contract>, where the
// app's fetch provider reads them. Run after `yarn compile:zk` in the
// contract packages; the keys are large, so they are not committed.
//
//   node scripts/copy-zk.mjs [--check]
//
// --check only reports which contracts have keys, and copies nothing.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(app, "..", "..");
const check = process.argv.includes("--check");

const SOURCES = {
  kinko_pay: "contracts/kinko-pay/src/managed/kinko_pay",
  kinko_tags: "contracts/kinko-pay/src/managed/kinko_tags",
  kinko_gift: "contracts/kinko-pay/src/managed/kinko_gift",
  kinko_card: "contracts/kinko-pay/src/managed/kinko_card",
  kinko_disclosure: "contracts/kinko-disclosure/src/managed/kinko_disclosure",
  "erc20-vault": "engine/vault/contract/src/managed/erc20-vault",
};

let missing = 0;
for (const [name, rel] of Object.entries(SOURCES)) {
  const src = path.join(repo, rel);
  const keys = path.join(src, "keys");
  const hasKeys = existsSync(keys) && readdirSync(keys).some((f) => f.endsWith(".prover"));
  if (!hasKeys) {
    missing++;
    console.log(`${name}: no proving keys at ${rel}/keys (compile it with keys first)`);
    continue;
  }
  if (check) {
    console.log(`${name}: keys present`);
    continue;
  }
  const dest = path.join(app, "public", "zk", name);
  mkdirSync(dest, { recursive: true });
  for (const part of ["keys", "zkir", "compiler"]) {
    if (existsSync(path.join(src, part)))
      cpSync(path.join(src, part), path.join(dest, part), { recursive: true });
  }
  console.log(`${name}: copied to public/zk/${name}`);
}
process.exitCode = missing > 0 && !check ? 1 : 0;

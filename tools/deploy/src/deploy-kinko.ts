// Deploying all of Kinko's contracts to one network.
//
// The payments contract is sealed at construction to the oracle's public key
// and to the colour of the vault's USDC coin (KUSD), so the vault must be
// deployed first. The disclosure contract is sealed to the output of a fresh
// key ceremony: the operator secret and the three keyholder shares are
// written to a secrets directory outside the repository's tracked files and
// must be handed to their holders out of band.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Ceremony,
  constructorArgs as disclosureConstructorArgs,
  runCeremony,
} from "@kinko/kinko-disclosure";
import { emptyPayPrivateState, generateOracleKeypair, kusdColor } from "@kinko/kinko-pay";
import type { Contract } from "@midnight-ntwrk/compact-js/effect";
import { jubjubSchnorrVerifyingKey } from "@midnight-ntwrk/compact-runtime";
import { envOrUndefined, getDeployConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

import { disclosureCompiled, giftCompiled, payCompiled, tagsCompiled } from "./bindings.ts";
import {
  type ContractDeployment,
  deployContract,
  type DeployRequest,
  resolveMaintenanceEnv,
} from "./split-deploy.ts";

/** Addresses of a full Kinko deployment, safe to publish. */
export interface KinkoDeployment {
  readonly networkId: string;
  readonly vault: string;
  readonly usdc: string;
  readonly kusdColor: string;
  readonly oraclePublicKey: { readonly x: string; readonly y: string };
  readonly pay: ContractDeployment;
  readonly tags: ContractDeployment;
  readonly gift: ContractDeployment;
  readonly disclosure: ContractDeployment;
  readonly deployedAt: string;
}

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function required(env: Record<string, string | undefined>, name: string, shape: RegExp): string {
  const value = envOrUndefined(env, name);
  if (!value || !shape.test(value)) {
    throw new Error(
      `${name} must be set (${shape.source}); got ${value ? `"${value}"` : "nothing"}`,
    );
  }
  return value.replace(/^0x(?=[0-9a-fA-F]{64}$)/, "").toLowerCase();
}

function oracleKey(env: Record<string, string | undefined>): { secretKey: bigint; fresh: boolean } {
  const given = envOrUndefined(env, "KINKO_ORACLE_SECRET_KEY");
  if (given) return { secretKey: BigInt(`0x${given.replace(/^0x/, "")}`), fresh: false };
  return { secretKey: generateOracleKeypair().secretKey, fresh: true };
}

function writeSecret(dir: string, file: string, value: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, file);
  writeFileSync(
    path,
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString(16) : v), 2) +
      "\n",
    { mode: 0o600 },
  );
  return path;
}

function ceremonyRecord(c: Ceremony): Record<string, unknown> {
  return {
    operatorSecret: toHex(c.operatorSecret),
    keyholders: c.keyholders.map((k) => ({
      index: k.index,
      x: k.x,
      scalar: k.scalar,
      bindingScalar: k.bindingScalar,
    })),
  };
}

/** Kinko's contracts, by the names `KINKO_DEPLOY_ONLY` takes. */
export const CONTRACT_NAMES = ["pay", "tags", "gift", "disclosure"] as const;
/** One of Kinko's contracts. */
export type ContractName = (typeof CONTRACT_NAMES)[number];

/**
 * Which contracts this run deploys: `KINKO_DEPLOY_ONLY` (comma separated), or all of them.
 *
 * @param env - The environment map.
 * @returns The contracts to deploy.
 * @throws {Error} When the variable names a contract that does not exist.
 */
export function selectedContracts(env: Record<string, string | undefined>): Set<ContractName> {
  const only = envOrUndefined(env, "KINKO_DEPLOY_ONLY");
  if (!only) return new Set(CONTRACT_NAMES);
  const names = only
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!(CONTRACT_NAMES as readonly string[]).includes(n)) {
      throw new Error(
        `KINKO_DEPLOY_ONLY names "${n}"; expected some of ${CONTRACT_NAMES.join(", ")}`,
      );
    }
  }
  return new Set(names as ContractName[]);
}

/**
 * Deploy Kinko's contracts. Reads the target network and deployer from the
 * same variables the vault's deploy uses (`NETWORK_ID`, `DEPLOYER_SEED`,
 * endpoint overrides), plus `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `ERC20_ADDRESS`
 * (USDC), an optional `KINKO_ORACLE_SECRET_KEY`, `KINKO_SECRETS_DIR`, and
 * `KINKO_DEPLOY_ONLY` to redeploy some contracts and keep the rest.
 *
 * @param env - The environment map; never mutated.
 * @param previous - The network's current deployment, whose contracts are kept when not redeployed.
 * @returns The published addresses.
 * @throws {Error} When a required variable is missing, a kept contract has no previous
 *   deployment, or a deploy fails.
 */
export async function deployKinko(
  env: Record<string, string | undefined> = process.env,
  previous?: KinkoDeployment,
): Promise<KinkoDeployment> {
  const deployConfig = getDeployConfig(env);
  const nodeConfig = deployConfig.midnightNodeConfig;
  const deployEnv = resolveMaintenanceEnv(env, nodeConfig.networkId);
  const vault = required(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS", HEX32);
  const usdc = required(env, "ERC20_ADDRESS", EVM_ADDRESS);
  const secretsDir = join(
    envOrUndefined(env, "KINKO_SECRETS_DIR") ?? join(process.cwd(), ".secrets"),
    nodeConfig.networkId,
  );
  const selected = selectedContracts(env);
  for (const name of CONTRACT_NAMES) {
    if (!selected.has(name) && !previous?.[name]) {
      throw new Error(
        `${name} is not being deployed and the network has no previous deployment of it`,
      );
    }
  }
  if (previous && (previous.vault !== vault || previous.usdc !== usdc.toLowerCase())) {
    if (!selected.has("pay")) {
      throw new Error("the vault or USDC changed, so kinko_pay must be redeployed with them");
    }
  }

  const colour = kusdColor(usdc, vault);
  let oraclePublicKey = previous?.oraclePublicKey;
  let oraclePk: ReturnType<typeof jubjubSchnorrVerifyingKey> | undefined;
  if (selected.has("pay")) {
    const oracle = oracleKey(env);
    oraclePk = jubjubSchnorrVerifyingKey(oracle.secretKey);
    oraclePublicKey = { x: oraclePk.x.toString(16), y: oraclePk.y.toString(16) };
    if (oracle.fresh) {
      console.log(
        `oracle secret written to ${writeSecret(secretsDir, "oracle.json", { secretKey: oracle.secretKey })}`,
      );
    }
  }
  const ceremony = selected.has("disclosure") ? runCeremony() : undefined;
  if (ceremony) {
    console.log(
      `disclosure ceremony written to ${writeSecret(secretsDir, "disclosure-ceremony.json", ceremonyRecord(ceremony))}`,
    );
  }

  const registry = new WalletRegistry(nodeConfig, env);
  try {
    const deployer = await registry.wallet(deployConfig.deployerSeed, "deployer");
    const run = <C extends Contract.Contract<PS>, PS>(request: DeployRequest<C, PS>) =>
      deployContract(request, deployer, nodeConfig, deployEnv);
    const keep = (name: ContractName): ContractDeployment => {
      const kept = previous?.[name];
      if (!kept) throw new Error(`no previous deployment of ${name}`);
      console.log(`keeping ${name} at ${kept.contractAddress}`);
      return kept;
    };

    const pay =
      selected.has("pay") && oraclePk
        ? await run({
            name: "kinko_pay",
            compiledContract: payCompiled,
            initialPrivateState: emptyPayPrivateState(),
            baseCircuits: ["create_invoice"],
            constructorArgs: [oraclePk, colour],
          })
        : keep("pay");
    const tags = selected.has("tags")
      ? await run({
          name: "kinko_tags",
          compiledContract: tagsCompiled,
          initialPrivateState: { tagSecret: new Uint8Array(32) },
          baseCircuits: ["register_tag"],
          constructorArgs: [],
        })
      : keep("tags");
    const gift = selected.has("gift")
      ? await run({
          name: "kinko_gift",
          compiledContract: giftCompiled,
          initialPrivateState: { cardSecret: new Uint8Array(32), issuerSecret: new Uint8Array(32) },
          baseCircuits: ["issue"],
          constructorArgs: [],
        })
      : keep("gift");
    const disclosure = ceremony
      ? await run({
          name: "kinko_disclosure",
          compiledContract: disclosureCompiled,
          initialPrivateState: { secretKey: ceremony.operatorSecret },
          baseCircuits: ["file_record"],
          constructorArgs: disclosureConstructorArgs(ceremony.config),
        })
      : keep("disclosure");
    if (!oraclePublicKey) throw new Error("no oracle key for kinko_pay");
    return {
      networkId: nodeConfig.networkId,
      vault,
      usdc,
      kusdColor: toHex(colour),
      oraclePublicKey,
      pay,
      tags,
      gift,
      disclosure,
      deployedAt: new Date().toISOString(),
    };
  } finally {
    await registry.close();
  }
}

/**
 * Write a deployment where each part of Kinko reads it: a JSON record under
 * `deployments/`, the web app's build environment, and the variables the
 * backend and relayer take.
 *
 * @param d - The deployment.
 * @param root - The repository root.
 * @param extras - Endpoint values to carry into the web app's environment.
 * @returns The paths written.
 */
export function writeDeployment(
  d: KinkoDeployment,
  root: string,
  extras: Readonly<Record<string, string>>,
): string[] {
  const record = join(root, "deployments", `${d.networkId}.json`);
  mkdirSync(join(root, "deployments"), { recursive: true });
  writeFileSync(record, JSON.stringify(d, null, 2) + "\n");

  const web = join(root, "apps", "web", `.env.${d.networkId}.local`);
  const lines = [
    `VITE_NETWORK_ID=${d.networkId}`,
    `VITE_KINKO_PAY_ADDRESS=${d.pay.contractAddress}`,
    `VITE_KINKO_TAGS_ADDRESS=${d.tags.contractAddress}`,
    `VITE_KINKO_GIFT_ADDRESS=${d.gift.contractAddress}`,
    `VITE_KINKO_DISCLOSURE_ADDRESS=${d.disclosure.contractAddress}`,
    ...Object.entries(extras).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(web, lines.join("\n") + "\n");

  const backend = join(root, "deployments", `${d.networkId}.backend.env`);
  writeFileSync(backend, `KINKO_PAY_ADDRESS=${d.pay.contractAddress}\n`);
  return [record, web, backend];
}

/**
 * Read a previously written deployment record.
 *
 * @param root - The repository root.
 * @param networkId - The network.
 * @returns The deployment.
 */
export function readDeployment(root: string, networkId: string): KinkoDeployment {
  return JSON.parse(
    readFileSync(join(root, "deployments", `${networkId}.json`), "utf8"),
  ) as KinkoDeployment;
}

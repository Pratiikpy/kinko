// Deploying one compiled Compact contract whose verifier keys do not all fit
// in one block: a base deploy that registers a few circuits, then one
// maintenance update per remaining circuit, each signed by the contract's
// maintenance authority. Every Kinko contract goes through this one path.

import { randomBytes } from "node:crypto";

import type { CompiledContract, Contract } from "@midnight-ntwrk/compact-js/effect";
import {
  type IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import * as ledger from "@midnightntwrk/ledger-v9";
import {
  ensureFeeReady,
  envOrUndefined,
  estimateUnprovenTransactionFee,
  formatDust,
  getFaucetUrl,
  isLocalStandaloneNetwork,
  type MidnightNodeConfig,
  type NetworkId,
  type RegisteredWallet,
  submitUnprovenTransaction,
  type TransactionIdentifier,
} from "@sig-net/midnight-contract-deploy";
import {
  buildDeployTransactionDeferring,
  buildMaintenanceInsertTransaction,
  type DeferredCircuit,
  SplitDeployAfterBaseSubmitError,
} from "@sig-net/midnight-examples-lib";

const MINUTE_MS = 60_000;
// Funding must finish within the base intent's 30-minute lifetime.
const FUNDING_TIMEOUT_MS = 20 * MINUTE_MS;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a finished deploy produced. */
export interface ContractDeployment {
  /** The contract's address on Midnight, 64 hex characters. */
  readonly contractAddress: string;
  /** The base deploy transaction. */
  readonly txId: TransactionIdentifier;
  /** Every circuit the contract has installed, base and deferred. */
  readonly circuits: readonly string[];
}

/** Everything needed to deploy one contract. */
export interface DeployRequest<C extends Contract.Contract<PS>, PS> {
  /** A name for logs and records. */
  readonly name: string;
  /** The contract bound to its compiler output. */
  readonly compiledContract: CompiledContract.CompiledContract<C, PS>;
  /** The private state the constructor runs against. */
  readonly initialPrivateState: PS;
  /** Circuits registered by the base deploy; the rest are maintenance-added. */
  readonly baseCircuits: readonly string[];
  /** The constructor's arguments, in order. */
  readonly constructorArgs: Contract.Contract.InitializeParameters<C>;
}

/**
 * The environment a split deploy signs with. A deployed network requires a
 * stable `MAINTENANCE_SIGNING_KEY`, because it becomes the contract's sealed
 * maintenance authority; a local standalone chain may use a throwaway key,
 * which is printed so a failed deploy can be resumed.
 *
 * @param env - The caller's environment map.
 * @param networkId - The target network.
 * @returns The environment with a maintenance key present.
 * @throws {Error} When a deployed network has no maintenance key.
 */
export function resolveMaintenanceEnv(
  env: Record<string, string | undefined>,
  networkId: NetworkId,
): Record<string, string | undefined> {
  if (envOrUndefined(env, "MAINTENANCE_SIGNING_KEY")) return env;
  if (!isLocalStandaloneNetwork(networkId)) {
    throw new Error(
      `deploying to ${networkId} needs MAINTENANCE_SIGNING_KEY (32 bytes of hex): it becomes ` +
        "each contract's maintenance authority, the only way to add or replace a circuit later",
    );
  }
  const key = randomBytes(32).toString("hex");
  console.log(`generated a throwaway MAINTENANCE_SIGNING_KEY for this local deploy: ${key}`);
  return { ...env, MAINTENANCE_SIGNING_KEY: key };
}

async function readContractState(
  pdp: IndexerPublicDataProvider,
  contractAddress: string,
): Promise<{ serialized: Uint8Array; counter: bigint } | undefined> {
  const state = await pdp.queryContractState(contractAddress);
  if (!state) return undefined;
  const serialized = state.contractState.serialize();
  const counter = ledger.ContractState.deserialize(serialized).maintenanceAuthority.counter;
  return { serialized, counter };
}

async function fundAndSubmit(
  deployer: RegisteredWallet,
  env: Record<string, string | undefined>,
  networkId: NetworkId,
  label: string,
  serializedTransaction: Uint8Array,
): Promise<TransactionIdentifier> {
  const fee = await estimateUnprovenTransactionFee(deployer.facade, serializedTransaction);
  console.log(`[${label}] estimated fee: ${formatDust(fee)} DUST`);
  const state = await deployer.facade.waitForSyncedState();
  await ensureFeeReady(
    deployer.facade,
    deployer.keys,
    state,
    networkId,
    getFaucetUrl(env, networkId),
    fee,
    FUNDING_TIMEOUT_MS,
  );
  return submitUnprovenTransaction(deployer.facade, deployer.keys, serializedTransaction);
}

async function installDeferred(
  pdp: IndexerPublicDataProvider,
  deployer: RegisteredWallet,
  env: Record<string, string | undefined>,
  networkId: NetworkId,
  name: string,
  contractAddress: string,
  deferred: readonly DeferredCircuit[],
): Promise<void> {
  const indexDeadline = Date.now() + 5 * MINUTE_MS;
  while (!(await readContractState(pdp, contractAddress))) {
    if (Date.now() > indexDeadline) {
      throw new Error(`${name}: base deploy ${contractAddress} was not indexed within 5 minutes`);
    }
    await sleep(3000);
  }
  for (const { circuitId, verifierKey } of deferred) {
    const current = await readContractState(pdp, contractAddress);
    if (!current) throw new Error(`${name}: contract state vanished mid-deploy`);
    const { serializedTransaction } = buildMaintenanceInsertTransaction(
      networkId,
      env,
      contractAddress,
      circuitId,
      verifierKey,
      current.serialized,
    );
    const label = `${name}.${circuitId}`;
    const txId = await fundAndSubmit(deployer, env, networkId, label, serializedTransaction);
    const target = current.counter + 1n;
    console.log(`[${label}] maintenance tx ${txId}, waiting for counter ${target.toString()}`);
    const deadline = Date.now() + 5 * MINUTE_MS;
    for (;;) {
      await sleep(4000);
      const now = await readContractState(pdp, contractAddress);
      if (now && now.counter >= target) break;
      if (Date.now() > deadline) {
        throw new Error(`[${label}] timed out waiting for counter ${target.toString()}`);
      }
    }
  }
}

/**
 * Deploy one contract: build and submit the base deploy, then install every
 * deferred circuit by a maintenance update, waiting for each to be indexed.
 *
 * @param request - The contract, its private state, base circuits and constructor arguments.
 * @param deployer - A synced, funded wallet that pays and submits.
 * @param nodeConfig - The network's endpoints.
 * @param env - The environment, carrying `MAINTENANCE_SIGNING_KEY`.
 * @returns The address, the base transaction and the installed circuits.
 * @throws {SplitDeployAfterBaseSubmitError} When a deferred circuit fails after the base deploy
 *   landed; the address in the error's message is what a resume needs.
 */
export async function deployContract<C extends Contract.Contract<PS>, PS>(
  request: DeployRequest<C, PS>,
  deployer: RegisteredWallet,
  nodeConfig: MidnightNodeConfig,
  env: Record<string, string | undefined>,
): Promise<ContractDeployment> {
  const { networkId } = nodeConfig;
  console.log(`deploying ${request.name} to ${networkId}`);
  const tx = await buildDeployTransactionDeferring(
    request.compiledContract,
    networkId,
    deployer.keys.shieldedSecretKeys.coinPublicKey,
    env,
    request.initialPrivateState,
    request.baseCircuits,
    ...request.constructorArgs,
  );
  const txId = await fundAndSubmit(
    deployer,
    env,
    networkId,
    request.name,
    tx.serializedTransaction,
  );
  console.log(`[${request.name}] base deploy ${txId} at ${tx.contractAddress}`);

  const pdp = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  });
  try {
    await installDeferred(
      pdp,
      deployer,
      env,
      networkId,
      request.name,
      tx.contractAddress,
      tx.deferred,
    );
  } catch (error) {
    throw new SplitDeployAfterBaseSubmitError(
      `${request.name}: installing deferred circuits on ${tx.contractAddress} failed after the ` +
        "base deploy landed",
      { cause: error },
    );
  } finally {
    await pdp.dispose();
  }
  const circuits = [...request.baseCircuits, ...tx.deferred.map((d) => d.circuitId)];
  console.log(
    `[${request.name}] deployed at ${tx.contractAddress} with ${String(circuits.length)} circuits`,
  );
  return { contractAddress: tx.contractAddress, txId, circuits };
}

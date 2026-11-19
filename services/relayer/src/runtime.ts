// Wires the relayer to the live chains: its own funded Midnight wallet, the vault joined
// with a throwaway identity (the relayer calls only permissionless circuits and holds no
// user key), the Ethereum provider, the engine and the HTTP server.

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
import {
  bytesToHex,
  deriveEvmAddress,
  signetEventSourceFromIndexer,
  SignetRequestResponseReader,
} from "@sig-net/midnight";
import {
  deriveAccountKeys,
  ensureFeeReady,
  openSyncedWallet,
  type WalletFacade,
} from "@sig-net/midnight-contract-deploy";
import {
  createVaultPrivateState,
  deriveVaultEvmAddress,
  readVaultLedger,
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_PRIVATE_STATE_ID,
  VAULT_WITHDRAW_REQUESTS_PATH,
  type VaultProviders,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  buildVaultProviders,
  vaultCompiledContract,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import { JsonRpcProvider } from "ethers";

import { CachedBacking } from "./backing.ts";
import { ChainBackingReader } from "./chain/backing-reader.ts";
import { EthersEvmPort, ethersTransfer, LimitedGasSponsor } from "./chain/evm-port.ts";
import { SignetMpcPort } from "./chain/mpc-port.ts";
import { MidnightVaultPort } from "./chain/vault-port.ts";
import type { RelayerConfig } from "./config.ts";
import { RelayerEngine } from "./engine.ts";
import { createRelayerServer } from "./http.ts";
import type { Logger } from "./ports.ts";
import { FilePersistence, StateStore } from "./store.ts";
import { RequestKind } from "./types.ts";

/** A running relayer. */
export interface RelayerRuntime {
  /** The stage machine. */
  readonly engine: RelayerEngine;
  /** The HTTP server, already listening. */
  readonly server: Server;
  /** The relayer's Midnight wallet. */
  readonly facade: WalletFacade;
  /**
   * Stop ticking, close the server, let started steps finish and stop the wallet.
   *
   * @returns Once everything is stopped.
   */
  stop(): Promise<void>;
}

/**
 * Start a relayer against the chains `config` names: sync and fund-check its wallet, join the
 * vault, check the configuration against what the vault pinned, then serve and tick.
 *
 * On a deployed network a fresh wallet replays the chain's whole history before it can pay a
 * fee, so the wallet resumes from its cache file and keeps it current while it runs: the file
 * `RELAYER_WALLET_CACHE_PATH` names, else the deploy SDK's default one in the repository root.
 *
 * @param config - The validated configuration.
 * @param logger - Where progress and failures go.
 * @param env - The environment holding the wallet's cache path variable.
 * @returns The running relayer.
 * @throws {Error} When the wallet cannot pay fees, the vault does not exist or is not initialised,
 *   or the configured chain, MPC key or addresses disagree with the vault's own.
 */
export async function startRelayer(
  config: RelayerConfig,
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
): Promise<RelayerRuntime> {
  const keys = deriveAccountKeys(config.relayerSeed, config.node.networkId);
  const wallet = await openSyncedWallet({ keys, config: config.node, label: "relayer", env });
  const { facade } = wallet;
  const state = await facade.waitForSyncedState();
  const dust = await ensureFeeReady(facade, keys, state, config.node.networkId);
  logger.info(`wallet ready with ${String(dust)} DUST base units`);

  const built = buildVaultProviders(facade, keys, config.node);
  // Every transaction the relayer submits, flushes included, is logged under its id, so an
  // operator can follow what it paid for.
  const providers: VaultProviders = {
    ...built,
    midnightProvider: {
      supportedEras: built.midnightProvider.supportedEras,
      submitTx: async (transaction) => {
        const transactionId = await built.midnightProvider.submitTx(transaction);
        logger.info(`submitted Midnight transaction ${transactionId}`);
        return transactionId;
      },
    },
  };
  const vault = await findDeployedContract(providers, {
    contractAddress: config.vaultContractAddress,
    compiledContract: vaultCompiledContract,
    privateStateId: VAULT_PRIVATE_STATE_ID,
    // The relayer calls only circuits that read no identity, so this key is never used to
    // own or settle anything; the private-state store only needs one to exist.
    initialPrivateState: createVaultPrivateState(randomBytes(32)),
  });

  const evmProvider = new JsonRpcProvider(config.evmRpcUrl, Number(config.evmChainId), {
    staticNetwork: true,
  });
  const ledger = await readVaultLedger(providers.publicDataProvider, config.vaultContractAddress);
  if (!ledger.initialised) throw new Error("the vault is not initialised");
  if (ledger.evmChainId !== config.evmChainId) {
    throw new Error(
      `EVM_CHAIN_ID is ${String(config.evmChainId)} but the vault is pinned to ${String(ledger.evmChainId)}`,
    );
  }
  const evmVaultAddress = `0x${bytesToHex(ledger.vaultEvmAddress)}`;
  const derived = deriveVaultEvmAddress(config.mpcPublicKey, config.vaultContractAddress);
  if (derived.toLowerCase() !== evmVaultAddress.toLowerCase()) {
    throw new Error(
      `MPC_SECP256K1_PUBKEY derives vault account ${derived} but the vault holds ${evmVaultAddress}: ` +
        "this is not the MPC key the vault was initialised with",
    );
  }

  const store = new StateStore(new FilePersistence(config.stateFile));
  const clock = (): number => Date.now();
  const readerFor = (path: readonly number[]): SignetRequestResponseReader =>
    new SignetRequestResponseReader({
      requesterContractAddress: config.vaultContractAddress,
      requesterRequestsPath: path,
      responderContractAddress: config.responderContractAddress,
      publicDataProvider: providers.publicDataProvider,
      eventSource: signetEventSourceFromIndexer({ queryUrl: config.node.indexerUrl }),
    });

  const engine = new RelayerEngine({
    vault: new MidnightVaultPort({
      providers,
      vault,
      compiledContract: vaultCompiledContract,
      vaultContractAddress: config.vaultContractAddress,
    }),
    mpc: new SignetMpcPort({
      readers: new Map([
        [RequestKind.Deposit, readerFor(VAULT_DEPOSIT_REQUESTS_PATH)],
        [RequestKind.Withdraw, readerFor(VAULT_WITHDRAW_REQUESTS_PATH)],
      ]),
      mpcPublicKey: config.mpcPublicKey,
    }),
    evm: new EthersEvmPort(evmProvider),
    ...(config.gasTopUp === undefined
      ? {}
      : {
          gas: new LimitedGasSponsor(
            config.gasTopUp,
            ethersTransfer(evmProvider, config.gasTopUp.privateKey),
            store,
            clock,
          ),
        }),
    store,
    options: config.engine,
    logger,
    clock,
  });

  const backing = new CachedBacking(
    new ChainBackingReader({
      providers,
      vaultContractAddress: config.vaultContractAddress,
      evmProvider,
      usdcAddress: config.usdcAddress,
      indexerUrl: config.node.indexerUrl,
    }),
    config.backingCacheMs,
    clock,
  );

  const server = createRelayerServer({
    config: config.http,
    health: {
      network: config.node.networkId,
      vaultContractAddress: config.vaultContractAddress,
      evmVaultAddress,
      usdcAddress: config.usdcAddress,
      evmChainId: Number(config.evmChainId),
    },
    tracker: engine,
    backing,
    depositAddress: (commitmentHex) =>
      deriveEvmAddress(config.mpcPublicKey, config.vaultContractAddress, commitmentHex),
    clock,
    logger,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info(`listening on http://${config.http.host}:${String(config.http.port)}`);

  const stopping = new AbortController();
  const loop = (async (): Promise<void> => {
    while (!stopping.signal.aborted) {
      try {
        await engine.tick();
      } catch (error) {
        logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, config.engine.pollIntervalMs));
    }
  })();

  return {
    engine,
    server,
    facade,
    async stop(): Promise<void> {
      stopping.abort();
      await loop;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      await engine.idle();
      await wallet.stop();
      evmProvider.destroy();
    },
  };
}

// The midnight-js provider set for one connected account, in the browser.
//
//   provider              where it comes from here
//   --------------------  ------------------------------------------------------
//   publicDataProvider    the indexer the wallet is configured for
//   zkConfigProvider      keys and ZK IR fetched from this site (ZK_BASE_URL)
//   proofProvider         the wallet proves (getProvingProvider); a local proof
//                         server only when the wallet cannot
//   walletProvider        the wallet balances and signs (balanceUnsealedTransaction)
//   midnightProvider      the wallet submits (submitTransaction)
//   privateStateProvider  in memory, filled per call from the encrypted records
//
// Private state is per call on purpose: each circuit needs the terms of one
// specific invoice or card, and setting exactly those right before the call is
// what keeps a payer's browser from ever holding someone else's secrets.

import { type ChargedState, ContractState } from "@midnight-ntwrk/compact-runtime";
import { dappConnectorProofProvider } from "@midnight-ntwrk/midnight-js-dapp-connector-proof-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { CostModel, Transaction } from "@midnight-ntwrk/midnight-js-protocol/v9";
import {
  type ContractPrivateStates,
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProvider,
  type MidnightProviders,
  type PrivateStateProvider,
  type ProofProvider,
  type PublicDataProvider,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { assertIsContractAddress } from "@midnight-ntwrk/midnight-js-utils";
import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";

import { PROOF_SERVER_URL, PUBLIC_INDEXER, ZK_BASE_URL } from "../config.ts";
import { fromHex, toHex } from "../format.ts";

// How long a call transaction stays valid once midnight-js starts building it.
const CALL_TTL_SECONDS = 60 * 60;

/** What the app needs to know about the connected account. */
export interface Account {
  readonly api: ConnectedAPI;
  /** Hex, 32 bytes. */
  readonly coinPublicKey: string;
  /** Hex, 32 bytes. */
  readonly encryptionPublicKey: string;
  /** Bech32m shielded address, for display and for receiving. */
  readonly shieldedAddress: string;
}

/**
 * A complete PrivateStateProvider kept in memory for the page's lifetime,
 * scoped by contract address exactly as the persistent one is.
 *
 * @returns The provider.
 */
export function memoryPrivateStateProvider<PS>(): PrivateStateProvider<string, PS> {
  type SigningKey = NonNullable<
    Awaited<ReturnType<PrivateStateProvider<string, PS>["getSigningKey"]>>
  >;
  const states = new Map<string, Map<string, PS>>();
  const signingKeys = new Map<string, SigningKey>();
  const done = Promise.resolve();
  const unsupported = (what: string) => (): Promise<never> =>
    Promise.reject(
      new Error(
        `${what} is not available: Kinko keeps private state in its encrypted records instead.`,
      ),
    );
  const forContract = (address: string): ContractPrivateStates<string, PS> => {
    assertIsContractAddress(address);
    const contractAddress = address.toLowerCase();
    const scoped = (): Map<string, PS> => {
      let m = states.get(contractAddress);
      if (!m) {
        m = new Map<string, PS>();
        states.set(contractAddress, m);
      }
      return m;
    };
    return {
      contractAddress,
      set: (id, state) => {
        scoped().set(id, state);
        return done;
      },
      get: (id) => Promise.resolve(states.get(contractAddress)?.get(id) ?? null),
      remove: (id) => {
        states.get(contractAddress)?.delete(id);
        return done;
      },
      clear: () => {
        states.delete(contractAddress);
        return done;
      },
      exportPrivateStates: unsupported("Exporting private state"),
      importPrivateStates: unsupported("Importing private state"),
    };
  };
  return {
    forContract,
    clearAll: () => {
      states.clear();
      return done;
    },
    setSigningKey: (address, key) => {
      signingKeys.set(address.toLowerCase(), key);
      return done;
    },
    getSigningKey: (address) => Promise.resolve(signingKeys.get(address.toLowerCase()) ?? null),
    removeSigningKey: (address) => {
      signingKeys.delete(address.toLowerCase());
      return done;
    },
    clearSigningKeys: () => {
      signingKeys.clear();
      return done;
    },
    exportSigningKeys: unsupported("Exporting signing keys"),
    importSigningKeys: unsupported("Importing signing keys"),
  };
}

const providerCache = new Map<string, PublicDataProvider>();

function publicData(queryURL: string, subscriptionURL: string): PublicDataProvider {
  const key = `${queryURL} ${subscriptionURL}`;
  let p = providerCache.get(key);
  if (!p) {
    // The browser's WebSocket is passed explicitly: the bundled isomorphic-ws
    // has only a default export, so the provider's own default is undefined.
    p = indexerPublicDataProvider({
      queryURL,
      subscriptionURL,
      webSocket: window.WebSocket as never,
    });
    providerCache.set(key, p);
  }
  return p;
}

/**
 * A read-only public data provider for pages that need no wallet.
 *
 * @returns The provider, or null when this build names no public indexer.
 */
export function publicDataProvider(): PublicDataProvider | null {
  return PUBLIC_INDEXER ? publicData(PUBLIC_INDEXER.http, PUBLIC_INDEXER.ws) : null;
}

/**
 * The indexer the connected wallet is configured for, for reads around its own calls.
 *
 * @param account - The connected account.
 * @returns A reader on the wallet's indexer.
 */
export async function walletPublicData(account: Account): Promise<PublicDataProvider> {
  const config = await account.api.getConfiguration();
  return publicData(config.indexerUri, config.indexerWsUri);
}

/**
 * The wallet's indexer when connected, otherwise the build's public one.
 *
 * @param account - The connected account, or null.
 * @returns A reader on the chain.
 * @throws {Error} When no wallet is connected and the build names no public indexer.
 */
export async function readerFor(account: Account | null): Promise<PublicDataProvider> {
  if (account) return walletPublicData(account);
  const p = publicDataProvider();
  if (!p)
    throw new Error(
      "This build has no public Midnight indexer (VITE_INDEXER_URL), so the chain cannot be read without a wallet.",
    );
  return p;
}

/**
 * Read a contract's current state, decoded for its compiled `ledger()` accessor.
 *
 * @param pdp - Where to read the chain.
 * @param address - The contract address.
 * @returns The state's data, or null when no contract exists at the address.
 */
export async function queryContractData(
  pdp: PublicDataProvider,
  address: string,
): Promise<ChargedState | null> {
  const read = await pdp.queryContractState(address);
  return read ? read.contractState.deserialize({ v9: ContractState }).data : null;
}

/**
 * Fetches one contract's keys and ZK IR from this site.
 *
 * @param contractDir - The contract's directory under ZK_BASE_URL.
 * @returns The zk config provider.
 */
export function zkConfigFor<C extends string>(contractDir: string): FetchZkConfigProvider<C> {
  const base = new URL(`${ZK_BASE_URL}/${contractDir}`, window.location.origin).toString();
  return new FetchZkConfigProvider<C>(base, { fetchFunc: fetch.bind(window) });
}

async function proofProviderFor(
  api: ConnectedAPI,
  zk: FetchZkConfigProvider<string>,
): Promise<ProofProvider> {
  if (typeof api.getProvingProvider === "function") {
    return dappConnectorProofProvider(api, zk, CostModel.initialCostModel());
  }
  return httpClientProofProvider({ url: PROOF_SERVER_URL, zkConfigProvider: zk });
}

function walletProvidersFor(account: Account): {
  readonly walletProvider: WalletProvider;
  readonly midnightProvider: MidnightProvider;
} {
  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => account.coinPublicKey,
    getEncryptionPublicKey: () => account.encryptionPublicKey,
    // midnight-js hands over a proven, unbound transaction. The wallet adds
    // the fee inputs, signs and binds; the connector speaks hex.
    balanceTx: async (tx) => {
      const { tx: balanced } = await account.api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return fromHex(balanced);
    },
  });
  // submitTransaction resolves to nothing, so the id is read off the
  // transaction itself: the same id the indexer reports.
  const midnightProvider = createLedger9MidnightProvider(async (tx) => {
    const [id] = tx.deserialize({ v9: Transaction }).identifiers();
    if (!id) throw new Error("The transaction to submit has no identifier.");
    await account.api.submitTransaction(toHex(tx.serialize()));
    return id;
  });
  return { walletProvider, midnightProvider };
}

/**
 * Build the providers for one contract and one account.
 *
 * @param account - The connected account.
 * @param contractDir - The directory under ZK_BASE_URL holding this contract's keys.
 * @returns The full provider set midnight-js calls a contract with.
 */
export async function providersFor<C extends string, PS>(
  account: Account,
  contractDir: string,
): Promise<MidnightProviders<C, string, PS>> {
  const config = await account.api.getConfiguration();
  const zk = zkConfigFor<C>(contractDir);
  const { walletProvider, midnightProvider } = walletProvidersFor(account);
  return {
    publicDataProvider: publicData(config.indexerUri, config.indexerWsUri),
    zkConfigProvider: zk,
    proofProvider: await proofProviderFor(account.api, zk),
    walletProvider,
    midnightProvider,
    privateStateProvider: memoryPrivateStateProvider<PS>(),
    config: { networkId: config.networkId, ttlSeconds: CALL_TTL_SECONDS },
  };
}

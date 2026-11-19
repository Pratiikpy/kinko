// Builds the real chain reader: Midnight's public data provider pointed at an
// indexer. Kept apart from reader.ts so tests that use a fake never import the
// provider and its GraphQL stack.

import { ContractState } from "@midnight-ntwrk/compact-runtime";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";

import { IndexerChainReader, type StateProvider } from "./reader.ts";

/** Where to read from. */
export interface IndexerEndpoints {
  readonly contractAddress: string;
  readonly indexerUri: string;
  readonly indexerWsUri: string;
  /** The longest to wait for one read. Defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** The clock for the read cache. Defaults to the system clock. */
  readonly now?: () => number;
}

/** A reader plus the means to release its connection. */
export interface LiveChainReader {
  readonly reader: IndexerChainReader;
  /** Close the indexer connection. Safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Connect a reader to an indexer. Nothing is requested until the first
 * snapshot, so a backend started before its indexer is up simply reports the
 * chain as unreachable until it is.
 *
 * @param endpoints - The contract and the indexer's HTTP and WebSocket URLs.
 * @returns The reader and its disposer.
 */
export const connectIndexer = (endpoints: IndexerEndpoints): LiveChainReader => {
  const provider = indexerPublicDataProvider({
    queryURL: endpoints.indexerUri,
    subscriptionURL: endpoints.indexerWsUri,
  });
  const states: StateProvider = {
    async queryContractState(address) {
      const read = await provider.queryContractState(address);
      if (!read) return null;
      // Decoded on access, so the reader reports undecodable bytes as a bad
      // ledger rather than as an unreachable indexer.
      return {
        get data() {
          return read.contractState.deserialize({ v9: ContractState }).data;
        },
      };
    },
  };
  return {
    reader: new IndexerChainReader({
      contractAddress: endpoints.contractAddress,
      provider: states,
      ...(endpoints.timeoutMs === undefined ? {} : { timeoutMs: endpoints.timeoutMs }),
      ...(endpoints.now === undefined ? {} : { now: endpoints.now }),
    }),
    dispose: () => provider.dispose(),
  };
};

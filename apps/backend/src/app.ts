// Wires the backend together. Every dependency that touches the outside world
// (the indexer, the clock, the webhook socket, the model provider, the rate
// source) can be replaced through `overrides`, which is how the tests run the
// whole stack against fakes without a second code path.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Assistant } from "./assistant.ts";
import { connectIndexer } from "./chain/indexer.ts";
import { ChainError, type ChainReader } from "./chain/reader.ts";
import type { Config } from "./config.ts";
import { Vault } from "./domain/crypto.ts";
import { type Clock, EventRecorder } from "./domain/events.ts";
import { MerchantService } from "./domain/merchants.ts";
import { SessionService } from "./domain/sessions.ts";
import { TelegramService } from "./domain/telegram.ts";
import type { RateRule } from "./http/rate-limit.ts";
import { Router } from "./http/router.ts";
import { createHttpServer, createRequestHandler, type LimitName } from "./http/server.ts";
import { createLogger, type Logger } from "./log.ts";
import { Oracle } from "./oracle/oracle.ts";
import { createRateSource, type RateSource } from "./oracle/rates.ts";
import { assistantRoutes } from "./routes/assistant.ts";
import { botRoutes } from "./routes/bot.ts";
import { chainRoutes } from "./routes/chain.ts";
import type { RouteDeps } from "./routes/deps.ts";
import { healthRoutes } from "./routes/health.ts";
import { merchantRoutes } from "./routes/merchants.ts";
import { oracleRoutes } from "./routes/oracle.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { SqliteStore } from "./store/sqlite.ts";
import type { Store } from "./store/store.ts";
import { Watcher } from "./watcher.ts";
import { WebhookDispatcher } from "./webhooks/dispatcher.ts";
import { type Deliverer, HttpDeliverer } from "./webhooks/http-deliverer.ts";

/** Replacements for the parts that reach outside the process. */
export interface AppOverrides {
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly store?: Store;
  readonly chain?: ChainReader;
  readonly deliverer?: Deliverer;
  readonly rates?: RateSource;
  readonly assistantFetch?: typeof fetch;
  readonly limits?: Partial<Record<LimitName, RateRule>>;
}

/** A running (or runnable) backend. */
export interface App {
  readonly server: Server;
  /** Everything the routes use, exposed so tests can drive passes directly. */
  readonly deps: RouteDeps;
  /**
   * Start listening and, unless told not to, the background loops (chain
   * watcher and webhook dispatcher). Tests pass `background: false` and drive
   * the loops one pass at a time.
   *
   * @returns The bound port.
   */
  start(options?: { readonly background?: boolean }): Promise<number>;
  /** Stop listening and the loops, then release the store and the indexer connection. */
  stop(): Promise<void>;
}

/**
 * Build the backend from a validated configuration.
 *
 * @param config - The configuration.
 * @param overrides - Replacements for external dependencies; omit all in production.
 * @returns The app, not yet listening.
 */
export const createApp = (config: Config, overrides: AppOverrides = {}): App => {
  const clock = overrides.clock ?? Date.now;
  const log =
    overrides.log ?? createLogger((line) => process.stdout.write(`${line}\n`), config.logLevel);
  const store = overrides.store ?? new SqliteStore(config.dbPath);
  const vault = new Vault(config.dataKey);
  const connection = overrides.chain
    ? { reader: overrides.chain, dispose: undefined }
    : connectIndexer({
        contractAddress: config.chain.contractAddress,
        indexerUri: config.chain.indexerUri,
        indexerWsUri: config.chain.indexerWsUri,
        now: clock,
      });
  const chain: ChainReader = connection.reader;

  const events = new EventRecorder(store, clock);
  const merchants = new MerchantService(store, vault, clock, config);
  const sessions = new SessionService(store, clock, config);
  const telegram = new TelegramService(store, clock);
  const watcher = new Watcher({
    store,
    reader: chain,
    events,
    clock,
    log,
    pollMs: config.chain.pollMs,
    lateSettlementMs: config.chain.lateSettlementMs,
  });
  const dispatcher = new WebhookDispatcher({
    store,
    vault,
    clock,
    log,
    deliverer:
      overrides.deliverer ??
      new HttpDeliverer({ allowPrivateTargets: config.webhooks.allowPrivateTargets }),
    timeoutMs: config.webhooks.timeoutMs,
    allowPrivateTargets: config.webhooks.allowPrivateTargets,
  });
  const oracle =
    config.oracle.secretKey === undefined
      ? undefined
      : new Oracle({
          secretKey: config.oracle.secretKey,
          rates: overrides.rates ?? createRateSource(config.oracle.rate),
          quoteTtlSeconds: config.oracle.quoteTtlSeconds,
          now: clock,
        });
  const assistant = new Assistant({
    apiKey: config.assistant.apiKey,
    model: config.assistant.model,
    ...(overrides.assistantFetch ? { fetchImpl: overrides.assistantFetch } : {}),
  });

  const deps: RouteDeps = {
    config,
    store,
    clock,
    log,
    vault,
    merchants,
    sessions,
    telegram,
    events,
    watcher,
    dispatcher,
    chain,
    oracle,
    assistant,
  };
  const router = new Router([
    ...healthRoutes(deps),
    ...merchantRoutes(deps),
    ...sessionRoutes(deps),
    ...chainRoutes(deps),
    ...oracleRoutes(deps),
    ...assistantRoutes(deps),
    ...botRoutes(deps),
  ]);
  const server = createHttpServer(
    createRequestHandler({
      router,
      merchants,
      botToken: config.botToken,
      corsOrigins: config.corsOrigins,
      trustProxy: config.trustProxy,
      clock,
      log,
      ...(overrides.limits ? { limits: overrides.limits } : {}),
    }),
  );

  /** Say once, at start, whether the contract trusts the key this backend signs with. */
  const checkOracleKey = async (): Promise<void> => {
    if (!oracle) return;
    try {
      const sealed = (await chain.snapshot()).oraclePublicKey;
      if (sealed.x !== oracle.publicKey.x || sealed.y !== oracle.publicKey.y) {
        log.warn(
          "the oracle key does not match the key sealed into the contract; quotes will be refused on chain",
        );
      }
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      log.warn("could not compare the oracle key with the contract", { error });
    }
  };

  return {
    server,
    deps,
    async start(options: { readonly background?: boolean } = {}): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (options.background ?? true) {
        watcher.start();
        dispatcher.start();
      }
      const port = (server.address() as AddressInfo).port;
      log.info("backend listening", {
        host: config.host,
        port,
        contract: config.chain.contractAddress,
        indexer: hostOf(config.chain.indexerUri),
        appUrl: config.appUrl,
      });
      if (options.background ?? true) void checkOracleKey();
      return port;
    },
    async stop(): Promise<void> {
      await Promise.all([watcher.stop(), dispatcher.stop()]);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      await connection.dispose?.();
      if (!overrides.store) store.close();
    },
  };
};

/**
 * An endpoint with its path and query dropped: a hosted indexer's URL carries its project key.
 *
 * @param url - The endpoint.
 * @returns Its origin, or a placeholder when it is not a URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unreadable url)";
  }
}

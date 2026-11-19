// Liveness and configuration status, with no secret in it.

import { ChainError } from "../chain/reader.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";

/**
 * Build the health routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const healthRoutes = (d: RouteDeps): Route[] => {
  const handler = async () => {
    const storeOk = d.store.ping();
    let chain: "ok" | "unreachable" = "ok";
    let oracleKeyMatchesContract: boolean | null = null;
    try {
      const snapshot = await d.chain.snapshot();
      if (d.oracle) {
        oracleKeyMatchesContract =
          snapshot.oraclePublicKey.x === d.oracle.publicKey.x &&
          snapshot.oraclePublicKey.y === d.oracle.publicKey.y;
      }
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      chain = "unreachable";
    }
    const { watcher, dispatcher } = d;
    return {
      // A degraded backend answers 503 so a load balancer takes it out of rotation.
      status: storeOk ? 200 : 503,
      body: {
        service: "kinko-backend",
        status: storeOk ? (chain === "ok" ? "ok" : "degraded") : "down",
        store: storeOk ? "ok" : "down",
        chain: { status: chain, contract: d.config.chain.contractAddress },
        watcher: {
          passes: watcher.stats.passes,
          lastSuccessAt:
            watcher.stats.lastSuccessAt === null
              ? null
              : new Date(watcher.stats.lastSuccessAt).toISOString(),
          lastError: watcher.stats.lastError,
          payments: watcher.stats.payments,
          settled: watcher.stats.settled,
          cancelled: watcher.stats.cancelled,
          expired: watcher.stats.expired,
        },
        webhooks: { ...dispatcher.stats },
        oracle: d.oracle
          ? {
              configured: true,
              canQuote: d.oracle.canQuote,
              keyMatchesContract: oracleKeyMatchesContract,
            }
          : { configured: false },
        assistant: d.assistant.configured ? "available" : "not configured",
        bot: d.config.botToken === undefined ? "not configured" : "available",
        note: "This server never sees a private key or a witness, and holds an invoice amount only if its merchant supplied one.",
      },
    };
  };
  return [
    { method: "GET", pattern: "/health", auth: AuthMode.NONE, limit: LimitClass.PUBLIC, handler },
    { method: "GET", pattern: "/", auth: AuthMode.NONE, limit: LimitClass.PUBLIC, handler },
  ];
};

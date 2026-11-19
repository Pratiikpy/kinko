// Public chain reads: what the ledger says about an invoice, and the contract's
// own aggregates. Nothing here needs credentials, because nothing here is
// private: it is all readable by anyone with an indexer.

import { ChainError } from "../chain/reader.ts";
import { ErrorCode } from "../domain/enums.ts";
import { hex32, parseInput } from "../domain/schemas.ts";
import { ApiError } from "../http/errors.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";
import { isoOrNull } from "./util.ts";

/** The status reported for a commitment the chain has not seen. */
const UNKNOWN = "unknown";

/**
 * Build the chain routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const chainRoutes = (d: RouteDeps): Route[] => {
  const read = async () => {
    try {
      return await d.chain.snapshot();
    } catch (error) {
      if (error instanceof ChainError) {
        d.log.warn("chain read failed", { error });
        throw new ApiError(
          502,
          ErrorCode.UPSTREAM_FAILED,
          "The chain could not be read right now. Try again shortly.",
        );
      }
      throw error;
    }
  };
  return [
    {
      // What a client needs to build payment links, served without touching the
      // chain so it keeps answering while the indexer is down.
      method: "GET",
      pattern: "/v1/config",
      auth: AuthMode.NONE,
      limit: LimitClass.PUBLIC,
      handler: () => ({
        status: 200,
        body: {
          contractAddress: d.config.chain.contractAddress,
          appUrl: d.config.appUrl,
          payPath: "/pay",
          checkoutPath: "/checkout",
          invoicePath: d.config.appInvoicePath,
          oracle: d.oracle?.canQuote ?? false,
          assistant: d.assistant.configured,
        },
      }),
    },
    {
      method: "GET",
      pattern: "/v1/chain",
      auth: AuthMode.NONE,
      limit: LimitClass.PUBLIC,
      handler: async () => {
        const snapshot = await read();
        return {
          status: 200,
          body: {
            contractAddress: d.config.chain.contractAddress,
            invoicesCreated: snapshot.created.toString(),
            kusdColor: snapshot.kusdColor,
            oraclePublicKey: {
              x: snapshot.oraclePublicKey.x.toString(),
              y: snapshot.oraclePublicKey.y.toString(),
            },
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/v1/chain/invoices/:commitment",
      auth: AuthMode.NONE,
      limit: LimitClass.PUBLIC,
      handler: async (ctx) => {
        const commitment = parseInput(hex32, ctx.params.commitment, "commitment");
        const invoice = (await read()).invoice(commitment);
        // An invoice the chain has not seen yet is a normal moment, just after
        // creation, so it is an answer rather than an error.
        const body = invoice
          ? {
              commitment,
              found: true,
              status: invoice.status,
              kind: invoice.kind,
              asset: invoice.token,
              expiresAt: isoOrNull(invoice.expiresAt),
              contributions: invoice.contributions,
            }
          : {
              commitment,
              found: false,
              status: UNKNOWN,
              kind: null,
              asset: null,
              expiresAt: null,
              contributions: 0,
            };
        return { status: 200, body };
      },
    },
  ];
};

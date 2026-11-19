// The conversion oracle's routes.

import { ChainError } from "../chain/reader.ts";
import { TokenName } from "../domain/enums.ts";
import { oracleQuoteBody, parseInput } from "../domain/schemas.ts";
import { notConfigured } from "../http/errors.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";

/**
 * Build the oracle routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const oracleRoutes = (d: RouteDeps): Route[] => [
  {
    method: "GET",
    pattern: "/v1/oracle",
    auth: AuthMode.NONE,
    limit: LimitClass.PUBLIC,
    handler: async () => {
      const oracle = d.oracle;
      if (!oracle)
        return {
          status: 200,
          body: { configured: false, canQuote: false, publicKey: null, matchesContract: null },
        };
      let matchesContract: boolean | null = null;
      try {
        const sealed = (await d.chain.snapshot()).oraclePublicKey;
        matchesContract = sealed.x === oracle.publicKey.x && sealed.y === oracle.publicKey.y;
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
      }
      return {
        status: 200,
        body: {
          configured: true,
          canQuote: oracle.canQuote,
          publicKey: { x: oracle.publicKey.x.toString(), y: oracle.publicKey.y.toString() },
          // False means quotes would be refused on chain: the contract was
          // deployed with a different key. Null means the chain was not readable.
          matchesContract,
          quoteTtlSeconds: d.config.oracle.quoteTtlSeconds,
          assets: Object.values(TokenName),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/v1/oracle/quote",
    auth: AuthMode.NONE,
    limit: LimitClass.ORACLE,
    handler: async (ctx) => {
      if (!d.oracle)
        throw notConfigured(
          "The oracle is not configured. Set KINKO_ORACLE_SECRET_KEY on the backend.",
        );
      const input = parseInput(oracleQuoteBody, await ctx.body(), "quote request");
      const quote = await d.oracle.quote(BigInt(input.baseAmount), input.fromToken, input.toToken);
      return { status: 200, body: { quote } };
    },
  },
];

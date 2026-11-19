// Small helpers shared by route groups.

import type { Principal } from "../domain/merchants.ts";
import { unauthorized } from "../http/errors.ts";
import type { RequestContext } from "../http/router.ts";

/**
 * The authenticated merchant. Routes declared with merchant auth always have
 * one, because the pipeline refuses the request before the handler otherwise;
 * the check is here so a mis-declared route fails closed instead of crashing.
 *
 * @param ctx - The request context.
 * @returns The merchant and the key used.
 * @throws {ApiError} 401 when the request has no authenticated merchant.
 */
export const principalOf = (ctx: RequestContext): Principal => {
  if (!ctx.principal) throw unauthorized();
  return ctx.principal;
};

/**
 * An ISO timestamp, or null.
 *
 * @param ms - Milliseconds since the epoch, or null.
 * @returns The timestamp in ISO 8601, or null when there is none.
 */
export const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

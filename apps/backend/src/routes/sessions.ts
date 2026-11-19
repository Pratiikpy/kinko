// Checkout session routes.

import {
  attachCommitmentBody,
  createSessionBody,
  listSessionsQuery,
  parseInput,
} from "../domain/schemas.ts";
import { forbidden } from "../http/errors.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";
import { principalOf } from "./util.ts";

/**
 * Build the checkout session routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const sessionRoutes = (d: RouteDeps): Route[] => [
  {
    method: "POST",
    pattern: "/v1/checkout/sessions",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: async (ctx) => {
      const input = parseInput(createSessionBody, await ctx.body(), "checkout session");
      const { session, attachToken } = d.sessions.create(principalOf(ctx).merchant.id, input);
      return {
        status: 201,
        body: {
          session: d.sessions.view(session),
          attachToken,
          ...(attachToken === null
            ? {}
            : { formUrl: d.sessions.draftFormUrl(session, attachToken) }),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/checkout/sessions",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => {
      const query = parseInput(listSessionsQuery, ctx.query, "query");
      const { sessions, nextCursor } = d.sessions.list(principalOf(ctx).merchant.id, {
        limit: query.limit,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.before === undefined ? {} : { before: query.before }),
      });
      return {
        status: 200,
        body: {
          data: sessions.map((s) => d.sessions.view(s)),
          nextCursor: nextCursor === null ? null : String(nextCursor),
        },
      };
    },
  },
  {
    // Public, because the hosted checkout page reads it with no credentials. A
    // merchant who sends their API key gets the full record instead.
    method: "GET",
    pattern: "/v1/checkout/sessions/:id",
    auth: AuthMode.OPTIONAL_MERCHANT,
    limit: LimitClass.PUBLIC,
    handler: (ctx) => {
      const id = ctx.params.id ?? "";
      if (ctx.principal) {
        return {
          status: 200,
          body: { session: d.sessions.view(d.sessions.getOwned(ctx.principal.merchant.id, id)) },
        };
      }
      return { status: 200, body: { session: d.sessions.publicView(id) } };
    },
  },
  {
    // Attaches the invoice's commitment to a draft. Callable with the merchant's
    // API key, or with the one-time attach token the draft was created with, so
    // a browser wallet can finish the job without holding an API key.
    method: "POST",
    pattern: "/v1/checkout/sessions/:id/commitment",
    auth: AuthMode.OPTIONAL_MERCHANT,
    limit: LimitClass.PUBLIC,
    handler: async (ctx) => {
      const { commitment } = parseInput(attachCommitmentBody, await ctx.body(), "commitment");
      const id = ctx.params.id ?? "";
      let credential: { attachToken: string } | { merchantId: string };
      if (ctx.principal) {
        credential = { merchantId: ctx.principal.merchant.id };
      } else {
        const token = /^Bearer\s+(at_\S+)$/i.exec(ctx.req.headers.authorization ?? "")?.[1];
        if (!token)
          throw forbidden(
            "Send the draft's attach token, or your API key, as `Authorization: Bearer <credential>`.",
          );
        credential = { attachToken: token };
      }
      return {
        status: 200,
        body: { session: d.sessions.view(d.sessions.attach(id, credential, commitment)) },
      };
    },
  },
];

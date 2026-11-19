// The assistant routes.

import { assertMessages, assertPublicContext } from "../assistant.ts";
import { badRequest } from "../http/errors.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";

/**
 * Build the assistant routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const assistantRoutes = (d: RouteDeps): Route[] => [
  {
    // The browser asks first, so it never offers a chat box that cannot answer.
    method: "GET",
    pattern: "/v1/assistant",
    auth: AuthMode.NONE,
    limit: LimitClass.PUBLIC,
    handler: () => ({
      status: 200,
      body: {
        configured: d.assistant.configured,
        model: d.assistant.configured ? d.assistant.model : null,
      },
    }),
  },
  {
    method: "POST",
    pattern: "/v1/assistant/chat",
    auth: AuthMode.NONE,
    limit: LimitClass.ASSISTANT,
    handler: async (ctx) => {
      const body = await ctx.body();
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw badRequest("The body must be a JSON object.");
      const { messages, context, ...rest } = body as Record<string, unknown>;
      if (Object.keys(rest).length > 0)
        throw badRequest(`Unknown field(s): ${Object.keys(rest).join(", ")}.`);
      // Validated before anything is built, so a request carrying a secret is
      // refused here rather than quietly cleaned up and forwarded.
      const answer = await d.assistant.chat(assertMessages(messages), assertPublicContext(context));
      return { status: 200, body: answer };
    },
  },
];

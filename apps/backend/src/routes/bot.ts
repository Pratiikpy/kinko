// Routes for the Telegram bot, a trusted service with its own token.
//
// The bot holds no merchant API keys. It acts for a chat, and the backend
// resolves which merchant the chat is linked to. A chat that was never linked
// can do nothing, and a merchant sees only their own sessions and events.

import { z } from "zod";

import {
  botCreateSessionBody,
  botEventsQuery,
  botLinkBody,
  chatId,
  listSessionsQuery,
  parseInput,
} from "../domain/schemas.ts";
import { notFound } from "../http/errors.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";

const chatParam = z.object({ chatId });

/**
 * Build the bot routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const botRoutes = (d: RouteDeps): Route[] => {
  const merchantFor = (raw: string | undefined) =>
    d.telegram.merchantForChat(parseInput(chatParam, { chatId: raw }, "chat id").chatId);

  return [
    {
      method: "POST",
      pattern: "/v1/bot/link",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: async (ctx) => {
        const { code, chatId: chat } = parseInput(botLinkBody, await ctx.body(), "link request");
        const merchant = d.telegram.redeem(code, chat);
        ctx.log.info("telegram chat linked", { merchant: merchant.id });
        return { status: 200, body: { merchant: { id: merchant.id, name: merchant.name } } };
      },
    },
    {
      method: "POST",
      pattern: "/v1/bot/chats/:chatId/unlink",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: (ctx) => {
        const chat = parseInput(chatParam, { chatId: ctx.params.chatId }, "chat id").chatId;
        return { status: 200, body: { unlinked: d.telegram.unlink(chat) } };
      },
    },
    {
      method: "GET",
      pattern: "/v1/bot/chats/:chatId",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: (ctx) => {
        const merchant = merchantFor(ctx.params.chatId);
        return {
          status: 200,
          body: {
            merchant: { id: merchant.id, name: merchant.name },
            sessions: d.store.countSessionsByStatus(merchant.id),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/v1/bot/chats/:chatId/sessions",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: (ctx) => {
        const merchant = merchantFor(ctx.params.chatId);
        const query = parseInput(listSessionsQuery, ctx.query, "query");
        const { sessions } = d.sessions.list(merchant.id, {
          limit: query.limit,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.before === undefined ? {} : { before: query.before }),
        });
        return { status: 200, body: { data: sessions.map((s) => d.sessions.view(s)) } };
      },
    },
    {
      method: "GET",
      pattern: "/v1/bot/chats/:chatId/sessions/:ref",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: (ctx) => {
        const merchant = merchantFor(ctx.params.chatId);
        const session = d.sessions.findOwned(merchant.id, ctx.params.ref ?? "");
        if (!session)
          throw notFound(
            "No invoice of yours matches that reference. Use a session id, or at least eight characters of its commitment.",
          );
        return { status: 200, body: { session: d.sessions.view(session) } };
      },
    },
    {
      method: "POST",
      pattern: "/v1/bot/chats/:chatId/sessions",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: async (ctx) => {
        const merchant = merchantFor(ctx.params.chatId);
        const input = parseInput(botCreateSessionBody, await ctx.body(), "payment link request");
        const { session, attachToken } = d.sessions.create(merchant.id, input);
        if (attachToken === null) throw new Error("a session without a commitment must be a draft");
        return {
          status: 201,
          body: {
            session: d.sessions.view(session),
            formUrl: d.sessions.draftFormUrl(session, attachToken),
          },
        };
      },
    },
    {
      // Where the bot starts listening: the newest event, so that history from
      // before it was running is never replayed into a chat.
      method: "GET",
      pattern: "/v1/bot/cursor",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: () => ({ status: 200, body: { seq: d.store.latestEventSeq() } }),
    },
    {
      method: "GET",
      pattern: "/v1/bot/events",
      auth: AuthMode.BOT,
      limit: LimitClass.BOT,
      handler: (ctx) => {
        const { after, limit } = parseInput(botEventsQuery, ctx.query, "query");
        const linked = d.store.listLinkedMerchantIds();
        const events = d.store.listEvents(after, limit, linked);
        const chats = new Map<string, number[]>();
        for (const link of d.store.listLinksForMerchants([
          ...new Set(events.map((e) => e.merchantId)),
        ])) {
          chats.set(link.merchantId, [...(chats.get(link.merchantId) ?? []), link.chatId]);
        }
        const data = events.map((e) => {
          const payload = JSON.parse(e.body) as {
            data: Record<string, unknown>;
            createdAt: string;
          };
          return {
            seq: e.seq,
            id: e.id,
            type: e.type,
            createdAt: payload.createdAt,
            merchant: { id: e.merchantId, name: d.store.getMerchant(e.merchantId)?.name ?? "" },
            chatIds: chats.get(e.merchantId) ?? [],
            data: payload.data,
          };
        });
        return { status: 200, body: { data, nextAfter: events.at(-1)?.seq ?? after } };
      },
    },
  ];
};

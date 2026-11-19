// Merchant routes: registration, settings, API keys, webhooks and Telegram links.

import { safeEqual } from "../domain/crypto.ts";
import { newId } from "../domain/crypto.ts";
import { DeliveryStatus, EventType } from "../domain/enums.ts";
import type { EventPayload } from "../domain/events.ts";
import { apiKeyView, merchantView } from "../domain/merchants.ts";
import {
  createApiKeyBody,
  createMerchantBody,
  listDeliveriesQuery,
  parseInput,
  updateMerchantBody,
} from "../domain/schemas.ts";
import { notFound, unauthorized } from "../http/errors.ts";
import { AuthMode, LimitClass, type Route } from "../http/router.ts";
import type { RouteDeps } from "./deps.ts";
import { isoOrNull, principalOf } from "./util.ts";

/**
 * Build the merchant routes.
 *
 * @param d - The services and settings the routes use.
 * @returns The routes.
 */
export const merchantRoutes = (d: RouteDeps): Route[] => [
  {
    method: "POST",
    pattern: "/v1/merchants",
    auth: AuthMode.NONE,
    limit: LimitClass.REGISTER,
    handler: async (ctx) => {
      if (d.config.registrationToken !== undefined) {
        const presented = ctx.req.headers["x-registration-token"];
        if (typeof presented !== "string" || !safeEqual(presented, d.config.registrationToken)) {
          throw unauthorized(
            "Registration is restricted. Send the operator's token as `X-Registration-Token`.",
          );
        }
      }
      const input = parseInput(createMerchantBody, await ctx.body(), "registration");
      const registration = d.merchants.register(input);
      ctx.log.info("merchant registered", { merchant: registration.merchant.id });
      return { status: 201, body: registration };
    },
  },
  {
    method: "GET",
    pattern: "/v1/merchant",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => {
      const { merchant } = principalOf(ctx);
      return {
        status: 200,
        body: {
          merchant: merchantView(merchant),
          sessions: d.store.countSessionsByStatus(merchant.id),
        },
      };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/merchant",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: async (ctx) => {
      const patch = parseInput(updateMerchantBody, await ctx.body(), "settings");
      return {
        status: 200,
        body: { merchant: merchantView(d.merchants.update(principalOf(ctx).merchant.id, patch)) },
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/merchant/api-keys",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => ({
      status: 200,
      body: { data: d.merchants.listKeys(principalOf(ctx).merchant.id).map(apiKeyView) },
    }),
  },
  {
    method: "POST",
    pattern: "/v1/merchant/api-keys",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: async (ctx) => {
      const { label } = parseInput(createApiKeyBody, await ctx.body(), "API key request");
      const { record, key } = d.merchants.createKey(principalOf(ctx).merchant.id, label);
      return { status: 201, body: { apiKey: { ...apiKeyView(record), key } } };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/merchant/api-keys/:id",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => {
      d.merchants.revokeKey(principalOf(ctx).merchant.id, ctx.params.id ?? "");
      return { status: 204 };
    },
  },
  {
    method: "POST",
    pattern: "/v1/merchant/webhook/secret",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => ({
      status: 200,
      body: { webhookSecret: d.merchants.rotateWebhookSecret(principalOf(ctx).merchant.id) },
    }),
  },
  {
    method: "POST",
    pattern: "/v1/merchant/webhook/test",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: async (ctx) => {
      const { merchant } = principalOf(ctx);
      const now = d.clock();
      const id = newId("evt");
      const payload: EventPayload = {
        id,
        type: EventType.WEBHOOK_TEST,
        createdAt: new Date(now).toISOString(),
        data: { message: "This is a test event from Kinko. Nothing was paid." },
      };
      const event = d.store.insertEvent({
        id,
        merchantId: merchant.id,
        sessionId: null,
        type: payload.type,
        body: JSON.stringify(payload),
        createdAt: now,
      });
      // The merchant's record is re-read so a URL set a moment ago is the one used.
      const current = d.store.getMerchant(merchant.id) ?? merchant;
      const outcome = await d.dispatcher.sendNow(current, event);
      return {
        status: 200,
        body: {
          eventId: id,
          delivered: outcome.ok,
          httpStatus: outcome.httpStatus,
          error: outcome.error,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/merchant/webhook/deliveries",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => {
      const { limit } = parseInput(listDeliveriesQuery, ctx.query, "query");
      const data = d.store.listDeliveries(principalOf(ctx).merchant.id, limit).map((delivery) => {
        const event = d.store.getEvent(delivery.eventSeq);
        return {
          id: delivery.id,
          eventId: event?.id ?? null,
          type: event?.type ?? null,
          status: delivery.status,
          attempts: delivery.attempts,
          nextAttemptAt:
            delivery.status === DeliveryStatus.PENDING
              ? new Date(delivery.nextAttemptAt).toISOString()
              : null,
          lastHttpStatus: delivery.lastHttpStatus,
          lastError: delivery.lastError,
          createdAt: new Date(delivery.createdAt).toISOString(),
          deliveredAt: isoOrNull(delivery.deliveredAt),
        };
      });
      return { status: 200, body: { data } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/merchant/telegram/link-codes",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => {
      const { code, expiresAt } = d.telegram.issueCode(principalOf(ctx).merchant.id);
      return { status: 201, body: { code, expiresAt: new Date(expiresAt).toISOString() } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/merchant/telegram",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => ({
      status: 200,
      body: {
        chats: d.store
          .listLinksForMerchant(principalOf(ctx).merchant.id)
          .map((l) => ({ chatId: l.chatId, linkedAt: new Date(l.linkedAt).toISOString() })),
      },
    }),
  },
  {
    method: "DELETE",
    pattern: "/v1/merchant/telegram/:chatId",
    auth: AuthMode.MERCHANT,
    limit: LimitClass.MERCHANT,
    handler: (ctx) => {
      const chatId = Number(ctx.params.chatId);
      if (
        !Number.isSafeInteger(chatId) ||
        !d.telegram.unlink(chatId, principalOf(ctx).merchant.id)
      ) {
        throw notFound("That chat is not linked to your account.");
      }
      return { status: 204 };
    },
  },
];

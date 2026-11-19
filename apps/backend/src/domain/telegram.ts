// Linking a Telegram chat to a merchant.
//
// The merchant, authenticated by API key, asks for a short code. They type it
// into the bot, which redeems it with the service token and the chat id. The
// code is single use, expires in fifteen minutes, and only its hash is stored,
// so neither the database nor a log line can be used to link someone else's
// chat.

import { notFound } from "../http/errors.ts";
import type { MerchantRecord, Store } from "../store/store.ts";
import { generateLinkCode, normaliseLinkCode, sha256Hex } from "./crypto.ts";
import type { Clock } from "./events.ts";

/** How long a link code can be redeemed. */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/** Issues and redeems link codes. */
export class TelegramService {
  readonly #store: Store;
  readonly #clock: Clock;

  /**
   * Create the service.
   *
   * @param store - Where codes and links are kept.
   * @param clock - The source of time, in milliseconds.
   */
  constructor(store: Store, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  /**
   * Issue a code for a merchant.
   *
   * @param merchantId - The merchant linking a chat.
   * @returns The code, shown once, and when it stops working.
   */
  issueCode(merchantId: string): { code: string; expiresAt: number } {
    const code = generateLinkCode();
    const expiresAt = this.#clock() + LINK_CODE_TTL_MS;
    this.#store.insertLinkCode(sha256Hex(code), merchantId, expiresAt);
    return { code, expiresAt };
  }

  /**
   * Redeem a code for a chat. A chat already linked to another merchant moves
   * to this one.
   *
   * @param typed - What the person typed; case, spaces and look-alike letters are forgiven.
   * @param chatId - The Telegram chat id.
   * @returns The merchant now linked to the chat.
   * @throws {ApiError} 404 for a code that is wrong, used or expired. One message for all three, so a guess learns nothing.
   */
  redeem(typed: string, chatId: number): MerchantRecord {
    const code = normaliseLinkCode(typed);
    const refusal = notFound(
      "That code is not valid. Ask for a new one from your merchant settings; codes work once and expire after fifteen minutes.",
    );
    if (code === undefined) throw refusal;
    return this.#store.transaction(() => {
      const merchantId = this.#store.consumeLinkCode(sha256Hex(code), this.#clock());
      const merchant = merchantId === undefined ? undefined : this.#store.getMerchant(merchantId);
      if (!merchant) throw refusal;
      this.#store.linkChat({ chatId, merchantId: merchant.id, linkedAt: this.#clock() });
      return merchant;
    });
  }

  /**
   * The merchant a chat belongs to.
   *
   * @param chatId - The Telegram chat id.
   * @returns The merchant.
   * @throws {ApiError} 404 when the chat is not linked.
   */
  merchantForChat(chatId: number): MerchantRecord {
    const link = this.#store.getLinkByChat(chatId);
    const merchant = link && this.#store.getMerchant(link.merchantId);
    if (!merchant) throw notFound("This chat is not linked to a merchant.");
    return merchant;
  }

  /**
   * Unlink a chat, optionally only if it belongs to a given merchant.
   *
   * @param chatId - The chat to unlink.
   * @param merchantId - When given, the chat must be linked to this merchant.
   * @returns Whether a link was removed.
   */
  unlink(chatId: number, merchantId?: string): boolean {
    const link = this.#store.getLinkByChat(chatId);
    if (!link || (merchantId !== undefined && link.merchantId !== merchantId)) return false;
    return this.#store.unlinkChat(chatId);
  }
}

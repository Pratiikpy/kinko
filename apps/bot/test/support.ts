// Fakes for the two things the bot talks to.

import {
  type Account,
  type Backend,
  BackendError,
  type BotEvent,
  type SessionView,
} from "../src/backend.ts";
import type {
  InlineButton,
  TelegramApi,
  TelegramMessage,
  TelegramUpdate,
} from "../src/telegram.ts";
import { TelegramError } from "../src/telegram.ts";

/** One message the bot sent. */
export interface Sent {
  readonly chatId: number;
  readonly text: string;
  readonly buttons: readonly InlineButton[] | undefined;
}

/** A Telegram that records what it is told to send, and fails when told to. */
export class FakeTelegram implements TelegramApi {
  readonly sent: Sent[] = [];
  commands: readonly { command: string; description: string }[] = [];
  /** Errors to throw from the next sends, in order; undefined lets a send through. */
  readonly sendFailures: (TelegramError | undefined)[] = [];
  /** Update batches `getUpdates` returns, in order; then it waits for `stop`. */
  readonly batches: TelegramUpdate[][] = [];
  pollFailures = 0;
  polls = 0;
  onIdle: (() => void) | undefined;

  getMe(): Promise<{ id: number; username: string }> {
    return Promise.resolve({ id: 1, username: "KinkoTestBot" });
  }

  getUpdates(): Promise<TelegramUpdate[]> {
    this.polls++;
    if (this.pollFailures > 0) {
      this.pollFailures--;
      return Promise.reject(new TelegramError("getUpdates", 0, "network error"));
    }
    const next = this.batches.shift();
    if (next) return Promise.resolve(next);
    this.onIdle?.();
    return Promise.resolve([]);
  }

  sendMessage(chatId: number, text: string, buttons?: readonly InlineButton[]): Promise<void> {
    const failure = this.sendFailures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push({ chatId, text, buttons });
    return Promise.resolve();
  }

  setMyCommands(commands: readonly { command: string; description: string }[]): Promise<void> {
    this.commands = commands;
    return Promise.resolve();
  }

  /** The text of everything sent to a chat. */
  to(chatId: number): string[] {
    return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
  }
}

/** A private chat message. */
export const message = (text: string, chatId = 100, type = "private"): TelegramMessage => ({
  message_id: 1,
  chat: { id: chatId, type },
  text,
  from: { id: chatId, is_bot: false },
});

/** An update wrapping a message. */
export const update = (id: number, text: string, chatId = 100): TelegramUpdate => ({
  update_id: id,
  message: message(text, chatId),
});

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: `cs_${"1".repeat(32)}`,
  status: "pending",
  commitment: "ab".repeat(32),
  kind: "standard",
  asset: "KUSD",
  title: "Logo design",
  clientReference: "order-9",
  contributions: 0,
  expiresAt: "2027-01-15T13:00:00.000Z",
  settledAt: null,
  late: false,
  checkoutUrl: "https://app.kinko.example/checkout?session=cs_1",
  ...over,
});

/** A session with defaults. */
export const aSession = session;

/** A backend held in memory. */
export class FakeBackend implements Backend {
  /** chatId to merchant. */
  readonly links = new Map<number, { id: string; name: string }>();
  readonly sessions: SessionView[] = [];
  readonly validCodes = new Map<string, { id: string; name: string }>();
  readonly feed: BotEvent[] = [];
  readonly unlinked: number[] = [];
  readonly drafts: { chatId: number; draft: { title?: string; kind?: string } }[] = [];
  latest = 0;
  failWith: BackendError | undefined;
  appUrlValue = "https://app.kinko.example";
  eventCalls: number[] = [];

  #check(): void {
    if (this.failWith) throw this.failWith;
  }

  link(code: string, chatId: number): Promise<{ id: string; name: string }> {
    this.#check();
    const merchant = this.validCodes.get(code);
    if (!merchant)
      return Promise.reject(new BackendError(404, "not_found", "That code is not valid."));
    this.validCodes.delete(code);
    this.links.set(chatId, merchant);
    return Promise.resolve(merchant);
  }

  unlink(chatId: number): Promise<boolean> {
    this.#check();
    this.unlinked.push(chatId);
    return Promise.resolve(this.links.delete(chatId));
  }

  account(chatId: number): Promise<Account | null> {
    this.#check();
    const merchant = this.links.get(chatId);
    if (!merchant) return Promise.resolve(null);
    const counts: Record<string, number> = {
      draft: 0,
      pending: 0,
      settled: 0,
      cancelled: 0,
      expired: 0,
    };
    for (const s of this.sessions) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return Promise.resolve({ merchant, sessions: counts });
  }

  listSessions(
    chatId: number,
    query: { status?: string; limit: number },
  ): Promise<readonly SessionView[]> {
    this.#check();
    if (!this.links.has(chatId))
      return Promise.reject(
        new BackendError(404, "not_found", "This chat is not linked to a merchant."),
      );
    return Promise.resolve(
      this.sessions.filter((s) => !query.status || s.status === query.status).slice(0, query.limit),
    );
  }

  findSession(_chatId: number, reference: string): Promise<SessionView | null> {
    this.#check();
    return Promise.resolve(
      this.sessions.find(
        (s) =>
          s.id === reference ||
          (s.commitment !== null &&
            s.commitment.startsWith(reference.toLowerCase()) &&
            reference.length >= 8),
      ) ?? null,
    );
  }

  createDraft(
    chatId: number,
    draft: { title?: string; kind?: string },
  ): Promise<{ session: SessionView; formUrl: string }> {
    this.#check();
    this.drafts.push({ chatId, draft });
    const made = session({
      status: "draft",
      commitment: null,
      id: `cs_${"d".repeat(32)}`,
      title: draft.title ?? null,
    });
    return Promise.resolve({
      session: made,
      formUrl: `https://app.kinko.example/app/invoices#session=${made.id}&attach=at_secret`,
    });
  }

  cursor(): Promise<number> {
    this.#check();
    return Promise.resolve(this.latest);
  }

  events(after: number, limit: number): Promise<{ data: readonly BotEvent[]; nextAfter: number }> {
    this.#check();
    this.eventCalls.push(after);
    const data = this.feed.filter((e) => e.seq > after).slice(0, limit);
    return Promise.resolve({ data, nextAfter: data.at(-1)?.seq ?? after });
  }

  appUrl(): Promise<string> {
    return Promise.resolve(this.appUrlValue);
  }
}

/** An event, with defaults. */
export const anEvent = (
  seq: number,
  type: string,
  over: Partial<BotEvent> & { data?: BotEvent["data"] } = {},
): BotEvent => ({
  seq,
  id: `evt_${String(seq)}`,
  type,
  createdAt: "2027-01-15T12:00:00.000Z",
  merchant: { id: "mer_1", name: "Acme Studio" },
  chatIds: [100],
  data: {
    sessionId: `cs_${"1".repeat(32)}`,
    commitment: "ab".repeat(32),
    title: "Logo design",
    clientReference: "order-9",
    contributions: 1,
    late: false,
  },
  ...over,
});

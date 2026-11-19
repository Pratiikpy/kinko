import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackendError, HttpBackend } from "../src/backend.ts";
import { KinkoBot } from "../src/bot.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { describeEvent } from "../src/format.ts";
import { Notifier } from "../src/notifier.ts";
import { FileCursorStore, MemoryCursorStore } from "../src/state.ts";
import { TelegramClient, TelegramError } from "../src/telegram.ts";
import { anEvent, aSession, FakeBackend, FakeTelegram, update } from "./support.ts";

const TOKEN = `123456789:${"A".repeat(35)}`;
const SERVICE = "s".repeat(40);
const ENV = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  KINKO_API_URL: "https://api.kinko.example/",
  KINKO_BOT_TOKEN: SERVICE,
};

describe("configuration", () => {
  it("reads a complete environment", () => {
    expect(loadConfig(ENV)).toEqual({
      telegramToken: TOKEN,
      apiUrl: "https://api.kinko.example",
      serviceToken: SERVICE,
      statePath: "./kinko-bot-state.json",
      pollSeconds: 50,
      notifyIntervalMs: 5_000,
    });
  });

  it.each([
    [{ ...ENV, TELEGRAM_BOT_TOKEN: undefined }, /TELEGRAM_BOT_TOKEN is not set.*@BotFather/s],
    [{ ...ENV, TELEGRAM_BOT_TOKEN: "   " }, /TELEGRAM_BOT_TOKEN is not set/],
    [{ ...ENV, TELEGRAM_BOT_TOKEN: "not-a-token" }, /does not look like a bot token/],
    [{ ...ENV, KINKO_API_URL: undefined }, /KINKO_API_URL is not set/],
    [{ ...ENV, KINKO_API_URL: "nonsense" }, /absolute URL/],
    [{ ...ENV, KINKO_API_URL: "ftp://x.example" }, /http\(s\)/],
    [{ ...ENV, KINKO_BOT_TOKEN: undefined }, /KINKO_BOT_TOKEN is not set/],
    [{ ...ENV, KINKO_BOT_TOKEN: "short" }, /at least 32/],
    [
      { ...ENV, KINKO_BOT_POLL_SECONDS: "99" },
      /KINKO_BOT_POLL_SECONDS must be a whole number between 1 and 50/,
    ],
    [
      { ...ENV, KINKO_BOT_NOTIFY_MS: "10" },
      /KINKO_BOT_NOTIFY_MS must be a whole number between 1000/,
    ],
  ])("refuses a bad environment %#", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("never prints a token in its complaints", () => {
    expect(() => loadConfig({ ...ENV, KINKO_BOT_TOKEN: "short-secret" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...ENV, KINKO_BOT_TOKEN: "short-secret" })).not.toThrow(
      /short-secret/,
    );
  });

  it("exits with a clear message and code 2 when started without a token", async () => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "src/index.ts"],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(2);
    expect(stderr).toContain("TELEGRAM_BOT_TOKEN is not set");
    expect(stderr).toContain("@BotFather");
  });
});

describe("TelegramClient", () => {
  const client = (answer: (url: string, body: Record<string, unknown>) => Response) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const impl = ((url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ url, body });
      return Promise.resolve(answer(url, body));
    }) as unknown as typeof fetch;
    return { telegram: new TelegramClient(TOKEN, impl), calls };
  };
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));

  it("sends a message with link previews off and buttons as an inline keyboard", async () => {
    const { telegram, calls } = client(() => ok({}));
    await telegram.sendMessage(7, "hello", [{ text: "Open", url: "https://x.example" }]);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toEqual({
      chat_id: 7,
      text: "hello",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Open", url: "https://x.example" }]] },
    });
    await telegram.sendMessage(7, "no buttons");
    expect(calls[1]?.body.reply_markup).toBeUndefined();
  });

  it("long polls for messages only", async () => {
    const { telegram, calls } = client(() => ok([{ update_id: 5 }]));
    expect(await telegram.getUpdates(5, 50)).toEqual([{ update_id: 5 }]);
    expect(calls[0]?.body).toEqual({ offset: 5, timeout: 50, allowed_updates: ["message"] });
  });

  it("carries Telegram's code and its retry-after on a rate limit", async () => {
    const { telegram } = client(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 7 },
          }),
          { status: 429 },
        ),
    );
    const error = await telegram.sendMessage(1, "x").catch((e: unknown) => e as TelegramError);
    expect(error).toMatchObject({ code: 429, retryAfter: 7 });
  });

  it("never lets the token, which is in the URL, into an error", async () => {
    const telegram = new TelegramClient(TOKEN, () =>
      Promise.reject(new Error(`getaddrinfo ENOTFOUND api.telegram.org/bot${TOKEN}/sendMessage`)),
    );
    const error = await telegram.sendMessage(1, "x").catch((e: unknown) => e as TelegramError);
    expect(error).toBeInstanceOf(TelegramError);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("refuses an empty token, and reads the bot's own name", async () => {
    expect(() => new TelegramClient("")).toThrow();
    expect(await client(() => ok({ id: 1, username: "KinkoBot" })).telegram.getMe()).toEqual({
      id: 1,
      username: "KinkoBot",
    });
  });
});

describe("HttpBackend", () => {
  const make = (answer: (url: URL, init: RequestInit) => Response) => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const impl = ((url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ url: u, init: init ?? {} });
      return Promise.resolve(answer(u, init ?? {}));
    }) as unknown as typeof fetch;
    return { backend: new HttpBackend("https://api.kinko.example/", SERVICE, impl), calls };
  };
  const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const err = (status: number, message: string) => body({ error: { code: "x", message } }, status);

  it("presents the service token on every call but the public one, and uses the chat in the path", async () => {
    const { backend, calls } = make((url) =>
      url.pathname === "/v1/config"
        ? body({ appUrl: "https://app.kinko.example/" })
        : body({ merchant: { id: "m", name: "A" }, sessions: {} }),
    );
    await backend.account(-1001);
    expect(calls[0]?.url.pathname).toBe("/v1/bot/chats/-1001");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SERVICE}`,
    );
    expect(await backend.appUrl()).toBe("https://app.kinko.example");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("asks for the app address once", async () => {
    const { backend, calls } = make(() => body({ appUrl: "https://app.kinko.example" }));
    await backend.appUrl();
    await backend.appUrl();
    expect(calls).toHaveLength(1);
  });

  it("reads 404 as 'not linked' and 'no such invoice', and nothing else as either", async () => {
    expect(await make(() => err(404, "This chat is not linked.")).backend.account(1)).toBeNull();
    expect(await make(() => err(404, "none")).backend.findSession(1, "cs_x")).toBeNull();
    await expect(make(() => err(500, "boom")).backend.account(1)).rejects.toMatchObject({
      status: 500,
      message: "boom",
    });
  });

  it("links with the code and the chat id, and reports a refusal in the backend's words", async () => {
    const ok = make(() => body({ merchant: { id: "m", name: "Acme" } }));
    expect(await ok.backend.link("K7QM-4XD2-9PTV", 5)).toEqual({ id: "m", name: "Acme" });
    expect(JSON.parse(ok.calls[0]?.init.body as string)).toEqual({
      code: "K7QM-4XD2-9PTV",
      chatId: 5,
    });
    await expect(
      make(() => err(404, "That code is not valid.")).backend.link("x", 5),
    ).rejects.toThrow("That code is not valid.");
  });

  it("builds list, draft and event requests", async () => {
    const { backend, calls } = make((url) =>
      url.pathname.endsWith("/events")
        ? body({ data: [], nextAfter: 9 })
        : url.pathname.endsWith("/sessions") && calls.at(-1)?.init.method === "POST"
          ? body({ session: {}, formUrl: "u" })
          : body({ data: [] }),
    );
    await backend.listSessions(3, { status: "settled", limit: 5 });
    expect(calls[0]?.url.search).toBe("?limit=5&status=settled");
    await backend.createDraft(3, { title: "T", kind: "multipay" });
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ title: "T", kind: "multipay" });
    await backend.events(41, 100);
    expect(calls[2]?.url.search).toBe("?after=41&limit=100");
  });

  it("turns a network failure into a status-0 error without the URL's secrets", async () => {
    const backend = new HttpBackend("https://api.kinko.example", SERVICE, () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const error = await backend.cursor().catch((e: unknown) => e as BackendError);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
    expect(JSON.stringify(error)).not.toContain(SERVICE);
  });
});

describe("the update loop", () => {
  let telegram: FakeTelegram;
  let backend: FakeBackend;
  let bot: KinkoBot;
  beforeEach(async () => {
    telegram = new FakeTelegram();
    backend = new FakeBackend();
    bot = new KinkoBot({ telegram, backend, pollSeconds: 1, retryDelayMs: 1 });
    await bot.init();
  });

  it("publishes the command menu on start", () => {
    expect(telegram.commands.map((c) => c.command)).toContain("newlink");
  });

  it("answers each update, in order, to the chat it came from", async () => {
    await bot.processUpdates([update(1, "/start", 100), update(2, "/privacy", 200)]);
    expect(telegram.sent.map((s) => s.chatId)).toEqual([100, 200]);
  });

  it("reads an edited message as well as a new one, and skips an update with no message", async () => {
    await bot.processUpdates([
      {
        update_id: 1,
        edited_message: { message_id: 1, chat: { id: 5, type: "private" }, text: "/start" },
      },
      { update_id: 2 },
    ]);
    expect(telegram.sent).toHaveLength(1);
  });

  it("sends the buttons with a reply", async () => {
    backend.links.set(100, { id: "m", name: "A" });
    await bot.processUpdates([update(1, "/newlink Logo")]);
    expect(telegram.sent[0]?.buttons?.[0]?.text).toBe("Create the invoice");
  });

  it("puts a button's link in the text when Telegram refuses the button, as it does for a local http address", async () => {
    backend.links.set(100, { id: "m", name: "A" });
    telegram.sendFailures.push(
      new TelegramError("sendMessage", 400, "Bad Request: wrong HTTP URL"),
    );
    await bot.processUpdates([update(1, "/newlink Logo")]);
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.buttons).toBeUndefined();
    expect(telegram.sent[0]?.text).toContain(
      "Create the invoice: https://app.kinko.example/app/invoices#session=",
    );
  });

  it("apologises, and carries on, when handling a message throws", async () => {
    const logs: string[] = [];
    const failing = new FakeBackend();
    failing.account = () => Promise.reject(new TypeError("boom"));
    const quiet = new KinkoBot({
      telegram,
      backend: failing,
      pollSeconds: 1,
      log: (m) => logs.push(m),
    });
    await quiet.init();
    await quiet.processUpdates([update(1, "/status"), update(2, "/start")]);
    expect(telegram.to(100)[0]).toContain("Something went wrong");
    expect(telegram.to(100)[1]).toContain("Kinko");
    expect(logs[0]).toContain("boom");
  });

  it("survives a failed reply", async () => {
    telegram.sendFailures.push(new TelegramError("sendMessage", 500, "oops"));
    await expect(
      bot.processUpdates([update(1, "/start"), update(2, "/start")]),
    ).resolves.toBeUndefined();
    expect(telegram.sent).toHaveLength(1);
  });

  it("polls from the next update id, retries a failed poll, and stops when asked", async () => {
    telegram.batches.push([update(10, "/start")], [update(11, "/privacy")]);
    telegram.pollFailures = 1;
    const offsets: number[] = [];
    const original = telegram.getUpdates.bind(telegram);
    telegram.getUpdates = (offset?: number) => (offsets.push(offset ?? -1), original());
    telegram.onIdle = () => {
      bot.stop();
    };
    await bot.run();
    expect(telegram.sent).toHaveLength(2);
    expect(offsets).toEqual([0, 0, 11, 12]);
  });
});

describe("Notifier", () => {
  let telegram: FakeTelegram;
  let backend: FakeBackend;
  let cursor: MemoryCursorStore;
  const make = (store: MemoryCursorStore | FileCursorStore = cursor) =>
    new Notifier({ telegram, backend, cursor: store, intervalMs: 10 });

  beforeEach(() => {
    telegram = new FakeTelegram();
    backend = new FakeBackend();
    cursor = new MemoryCursorStore();
  });

  it("starts at the newest event when it has no saved place, so history is never replayed", async () => {
    backend.latest = 2;
    backend.feed.push(
      anEvent(1, "invoice.settled"),
      anEvent(2, "invoice.settled"),
      anEvent(3, "invoice.settled"),
    );
    const notifier = make();
    expect(await notifier.tick()).toBe(1);
    expect(telegram.sent).toHaveLength(1);
    expect(await cursor.load()).toBe(3);
  });

  it("resumes from the saved cursor", async () => {
    cursor = new MemoryCursorStore(1);
    backend.feed.push(anEvent(1, "invoice.settled"), anEvent(2, "invoice.cancelled"));
    await make().tick();
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toContain("Cancelled");
  });

  it("tells every chat on an event, and only the event's own chats", async () => {
    cursor = new MemoryCursorStore(0);
    backend.feed.push(
      anEvent(1, "invoice.settled", { chatIds: [100, 200] }),
      anEvent(2, "invoice.settled", { chatIds: [300] }),
    );
    await make().tick();
    expect(telegram.sent.map((s) => s.chatId)).toEqual([100, 200, 300]);
  });

  it("does not repeat a message on the next pass", async () => {
    cursor = new MemoryCursorStore(0);
    backend.feed.push(anEvent(1, "invoice.settled"));
    const notifier = make();
    await notifier.tick();
    await notifier.tick();
    await notifier.tick();
    expect(telegram.sent).toHaveLength(1);
    expect(backend.eventCalls).toEqual([0, 1, 1]);
  });

  it("does not move the cursor past a message it could not send, and retries it whole", async () => {
    cursor = new MemoryCursorStore(0);
    backend.feed.push(anEvent(1, "invoice.settled"));
    telegram.sendFailures.push(new TelegramError("sendMessage", 500, "Internal"));
    const notifier = make();
    expect(await notifier.tick()).toBe(0);
    expect(await cursor.load()).toBe(0);
    expect(notifier.stats.failures).toBe(1);
    await notifier.tick();
    expect(telegram.sent).toHaveLength(1);
    expect(await cursor.load()).toBe(1);
  });

  it("unlinks a chat that blocked the bot, and carries on with the others", async () => {
    cursor = new MemoryCursorStore(0);
    backend.links.set(100, { id: "m", name: "A" });
    backend.feed.push(anEvent(1, "invoice.settled", { chatIds: [100, 200] }));
    telegram.sendFailures.push(
      new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user"),
    );
    const notifier = make();
    await notifier.tick();
    expect(backend.unlinked).toEqual([100]);
    expect(telegram.to(200)).toHaveLength(1);
    expect(await cursor.load()).toBe(1);
    expect(notifier.stats.unlinked).toBe(1);
  });

  it("backs off for as long as Telegram asks after a rate limit, then retries", async () => {
    cursor = new MemoryCursorStore(0);
    backend.feed.push(anEvent(1, "invoice.settled"));
    telegram.sendFailures.push(new TelegramError("sendMessage", 429, "Too Many Requests", 30));
    const notifier = make();
    await notifier.tick(1_000);
    expect(await notifier.tick(20_000)).toBe(0);
    expect(telegram.sent).toHaveLength(0);
    expect(await notifier.tick(31_001)).toBe(1);
    expect(telegram.sent).toHaveLength(1);
  });

  it("holds position when the backend is down, and says so", async () => {
    cursor = new MemoryCursorStore(5);
    const logs: string[] = [];
    backend.failWith = new BackendError(503, "x", "down");
    const notifier = new Notifier({
      telegram,
      backend,
      cursor,
      intervalMs: 10,
      log: (m) => logs.push(m),
    });
    expect(await notifier.tick()).toBe(0);
    expect(await cursor.load()).toBe(5);
    expect(logs[0]).toContain("down");
  });

  it("moves past events it does not announce, such as a webhook test", async () => {
    cursor = new MemoryCursorStore(0);
    backend.feed.push(anEvent(1, "webhook.test"), anEvent(2, "invoice.settled"));
    await make().tick();
    expect(telegram.sent).toHaveLength(1);
    expect(await cursor.load()).toBe(2);
  });

  it("runs on a timer and stops cleanly", async () => {
    cursor = new MemoryCursorStore(0);
    backend.feed.push(anEvent(1, "invoice.settled"));
    const notifier = make();
    notifier.start();
    notifier.start();
    await new Promise((r) => setTimeout(r, 60));
    await notifier.stop();
    expect(telegram.sent).toHaveLength(1);
    expect(notifier.stats.passes).toBeGreaterThan(1);
  });

  describe("with its place saved in a file", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kinko-bot-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("survives a restart without repeating or skipping", async () => {
      const path = join(dir, "state.json");
      backend.feed.push(anEvent(1, "invoice.settled"), anEvent(2, "invoice.settled"));
      backend.latest = 0;
      const first = make(new FileCursorStore(path));
      await first.tick();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ cursor: 2 });
      backend.feed.push(anEvent(3, "invoice.expired"));
      const second = make(new FileCursorStore(path));
      await second.tick();
      expect(telegram.sent.map((s) => s.text.split(":")[0])).toEqual([
        "Paid",
        "Paid",
        "Expired unpaid",
      ]);
    });

    it("starts afresh when there is no file, and refuses a corrupt one", async () => {
      expect(await new FileCursorStore(join(dir, "none.json")).load()).toBeUndefined();
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ cursor: "x" }));
      await expect(new FileCursorStore(join(dir, "bad.json")).load()).rejects.toThrow(
        /does not hold a valid cursor/,
      );
    });
  });
});

describe("messages", () => {
  it.each([
    ["invoice.settled", "Paid: Logo design"],
    ["invoice.payment_received", "Payment received: Logo design"],
    ["invoice.cancelled", "Cancelled: Logo design"],
    ["invoice.expired", "Expired unpaid: Logo design"],
  ])("announces %s", (type, headline) => {
    expect(describeEvent(anEvent(1, type))).toContain(headline);
  });

  it("includes the reference and the running count, and says a late payment was late", () => {
    const text =
      describeEvent(
        anEvent(1, "invoice.payment_received", {
          data: {
            title: "Logo",
            clientReference: "order-9",
            contributions: 3,
            newPayments: 2,
            late: true,
          },
        }),
      ) ?? "";
    expect(text).toContain("reference order-9");
    expect(text).toContain("2 new payments, 3 in all.");
    expect(text).toContain("after the checkout session expired");
  });

  it("falls back to the commitment, then the session, when there is no title", () => {
    expect(
      describeEvent(anEvent(1, "invoice.settled", { data: { commitment: "ab".repeat(32) } })),
    ).toContain("Paid: abababab…");
    expect(describeEvent(anEvent(1, "invoice.settled", { data: { sessionId: "cs_9" } }))).toContain(
      "Paid: cs_9",
    );
  });

  it("never contains an amount, and says why", () => {
    for (const type of [
      "invoice.settled",
      "invoice.payment_received",
      "invoice.cancelled",
      "invoice.expired",
    ]) {
      const text = describeEvent(anEvent(1, type)) ?? "";
      expect(text).not.toMatch(/\d+\.\d\d|KUSD|\$/);
      expect(text).toContain("The amount is not in this message");
    }
  });

  it("says nothing about an event type it does not know", () => {
    expect(describeEvent(anEvent(1, "webhook.test"))).toBeUndefined();
    expect(aSession().title).toBe("Logo design");
  });
});

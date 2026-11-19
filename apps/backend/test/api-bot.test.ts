import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeCommitment, field, startTestApp, type TestApp } from "./support/fixtures.ts";

const BOT = "b".repeat(40);
const bot = { Authorization: `Bearer ${BOT}` };

let t: TestApp;
beforeEach(async () => {
  t = await startTestApp({ env: { KINKO_BOT_TOKEN: BOT } });
});
afterEach(async () => {
  await t.stop();
});

/** Register a merchant and link a chat through the real code flow. */
const linked = async (chatId = 1001, name = "Acme Studio") => {
  const m = await t.register(name, `https://hooks.example.com/${name.length.toString()}`);
  const code = field(
    (await t.call("POST", "/v1/merchant/telegram/link-codes", { key: m.key })).body,
    "code",
  ) as string;
  const reply = await t.call("POST", "/v1/bot/link", { headers: bot, body: { code, chatId } });
  return { ...m, chatId, code, reply };
};

describe("bot authentication", () => {
  it("answers 503 on every bot route when no token is configured", async () => {
    await t.stop();
    t = await startTestApp();
    const reply = await t.call("GET", "/v1/bot/cursor", { headers: bot });
    expect(reply.status).toBe(503);
    expect(field(reply.body, "error.message")).toContain("KINKO_BOT_TOKEN");
  });

  it.each([
    ["no header", {}],
    ["a wrong token", { Authorization: `Bearer ${"x".repeat(40)}` }],
    ["a merchant API key", { Authorization: "Bearer kk_something" }],
    ["a shorter prefix of the token", { Authorization: `Bearer ${BOT.slice(0, 39)}` }],
  ])("refuses %s on every route", async (_n, headers) => {
    for (const [method, path] of [
      ["GET", "/v1/bot/cursor"],
      ["GET", "/v1/bot/events"],
      ["POST", "/v1/bot/link"],
      ["GET", "/v1/bot/chats/1"],
      ["GET", "/v1/bot/chats/1/sessions"],
      ["POST", "/v1/bot/chats/1/sessions"],
      ["POST", "/v1/bot/chats/1/unlink"],
    ] as const) {
      expect(
        (await t.call(method, path, { headers, body: method === "POST" ? {} : undefined })).status,
      ).toBe(401);
    }
  });

  it("does not let the bot token act as a merchant key", async () => {
    expect((await t.call("GET", "/v1/merchant", { key: BOT })).status).toBe(401);
  });
});

describe("linking", () => {
  it("links a chat with a code from the merchant", async () => {
    const { reply, id } = await linked();
    expect(reply.status).toBe(200);
    expect(field(reply.body, "merchant")).toEqual({ id, name: "Acme Studio" });
    expect((await t.call("GET", "/v1/bot/chats/1001", { headers: bot })).body).toMatchObject({
      merchant: { id },
      sessions: { pending: 0 },
    });
  });

  it("forgives how a person types the code", async () => {
    const m = await t.register();
    const code = field(
      (await t.call("POST", "/v1/merchant/telegram/link-codes", { key: m.key })).body,
      "code",
    ) as string;
    const sloppy = code.toLowerCase().replace(/-/g, " ");
    expect(
      (await t.call("POST", "/v1/bot/link", { headers: bot, body: { code: sloppy, chatId: 5 } }))
        .status,
    ).toBe(200);
  });

  it("works once only", async () => {
    const { code } = await linked(1001);
    const again = await t.call("POST", "/v1/bot/link", {
      headers: bot,
      body: { code, chatId: 2002 },
    });
    expect(again.status).toBe(404);
    expect(field(again.body, "error.message")).toMatch(/not valid/);
    expect((await t.call("GET", "/v1/bot/chats/2002", { headers: bot })).status).toBe(404);
  });

  it("stops working after fifteen minutes", async () => {
    const m = await t.register();
    const code = field(
      (await t.call("POST", "/v1/merchant/telegram/link-codes", { key: m.key })).body,
      "code",
    ) as string;
    t.clock.advance(15 * 60_000 + 1);
    expect(
      (await t.call("POST", "/v1/bot/link", { headers: bot, body: { code, chatId: 5 } })).status,
    ).toBe(404);
  });

  it("gives a guess no information: wrong, malformed and used codes read the same", async () => {
    const wrong = await t.call("POST", "/v1/bot/link", {
      headers: bot,
      body: { code: "ABCD-EFGH-JKMN", chatId: 5 },
    });
    const malformed = await t.call("POST", "/v1/bot/link", {
      headers: bot,
      body: { code: "hello", chatId: 5 },
    });
    expect(wrong.status).toBe(404);
    expect(field(malformed.body, "error.message")).toBe(field(wrong.body, "error.message"));
  });

  it("validates the request", async () => {
    for (const body of [
      {},
      { code: "ABCD" },
      { code: "ABCD-EFGH-JKMN", chatId: 0 },
      { code: "ABCD-EFGH-JKMN", chatId: "x" },
      { code: "ABCD-EFGH-JKMN", chatId: 5, extra: 1 },
    ]) {
      expect((await t.call("POST", "/v1/bot/link", { headers: bot, body })).status).toBe(400);
    }
  });

  it("unlinks, and the chat can then do nothing", async () => {
    await linked(1001);
    expect((await t.call("POST", "/v1/bot/chats/1001/unlink", { headers: bot })).body).toEqual({
      unlinked: true,
    });
    expect((await t.call("POST", "/v1/bot/chats/1001/unlink", { headers: bot })).body).toEqual({
      unlinked: false,
    });
    expect((await t.call("GET", "/v1/bot/chats/1001/sessions", { headers: bot })).status).toBe(404);
  });

  it("supports group chats, which have negative ids", async () => {
    await linked(-1001234567890);
    expect((await t.call("GET", "/v1/bot/chats/-1001234567890", { headers: bot })).status).toBe(
      200,
    );
  });

  it("rejects a chat id that is not one", async () => {
    expect((await t.call("GET", "/v1/bot/chats/abc", { headers: bot })).status).toBe(400);
    expect((await t.call("GET", "/v1/bot/chats/0", { headers: bot })).status).toBe(400);
  });
});

describe("a linked chat's invoices", () => {
  it("lists only its own merchant's sessions", async () => {
    const a = await linked(1, "Alpha Shop");
    const b = await linked(2, "Beta Store");
    await t.call("POST", "/v1/checkout/sessions", {
      key: a.key,
      body: { commitment: fakeCommitment(1), title: "Alpha invoice" },
    });
    await t.call("POST", "/v1/checkout/sessions", {
      key: b.key,
      body: { commitment: fakeCommitment(2), title: "Beta invoice" },
    });
    const forA = await t.call("GET", "/v1/bot/chats/1/sessions", { headers: bot });
    expect((field(forA.body, "data") as { title: string }[]).map((s) => s.title)).toEqual([
      "Alpha invoice",
    ]);
    expect(
      field(
        (await t.call("GET", "/v1/bot/chats/2/sessions?status=settled", { headers: bot })).body,
        "data",
      ),
    ).toEqual([]);
  });

  it("finds a session by id, by commitment, and by an unambiguous prefix, but never across merchants", async () => {
    const a = await linked(1, "Alpha Shop");
    const b = await linked(2, "Beta Store");
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key: a.key,
      body: { commitment: fakeCommitment(0xc1), title: "Alpha invoice" },
    });
    const id = field(created.body, "session.id") as string;
    const find = (chat: number, ref: string) =>
      t.call("GET", `/v1/bot/chats/${String(chat)}/sessions/${ref}`, { headers: bot });
    expect(field((await find(1, id)).body, "session.title")).toBe("Alpha invoice");
    expect(field((await find(1, fakeCommitment(0xc1))).body, "session.id")).toBe(id);
    expect(field((await find(1, fakeCommitment(0xc1).slice(0, 8))).body, "session.id")).toBe(id);
    expect((await find(1, fakeCommitment(0xc1).slice(0, 7))).status).toBe(404);
    expect((await find(2, id)).status).toBe(404);
    expect((await find(2, fakeCommitment(0xc1))).status).toBe(404);
    expect((await find(2, fakeCommitment(0xc1).slice(0, 8))).status).toBe(404);
    expect((await find(1, "nonsense")).status).toBe(404);
    expect(b.id).not.toBe(a.id);
  });

  it("refuses a prefix that matches two sessions rather than pick one", async () => {
    const a = await linked(1);
    const stem = "e1e1e1e1";
    await t.call("POST", "/v1/checkout/sessions", {
      key: a.key,
      body: { commitment: stem + "0".repeat(56) },
    });
    await t.call("POST", "/v1/checkout/sessions", {
      key: a.key,
      body: { commitment: stem + "1".repeat(56) },
    });
    expect((await t.call("GET", `/v1/bot/chats/1/sessions/${stem}`, { headers: bot })).status).toBe(
      404,
    );
  });
});

describe("creating a payment link", () => {
  it("creates a draft and returns a form URL that carries the attach token in its fragment only", async () => {
    const m = await linked(1);
    const reply = await t.call("POST", "/v1/bot/chats/1/sessions", {
      headers: bot,
      body: { title: "Logo design", memo: "Round one", kind: "multipay", token: "KUSD" },
    });
    expect(reply.status).toBe(201);
    expect(field(reply.body, "session")).toMatchObject({
      status: "draft",
      title: "Logo design",
      kind: "multipay",
    });
    expect(JSON.stringify(field(reply.body, "session"))).not.toContain("at_");
    const url = new URL(field(reply.body, "formUrl") as string);
    expect(url.origin + url.pathname).toBe("https://app.kinko.example/app/invoices");
    expect(url.search).toBe("");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("session")).toBe(field(reply.body, "session.id"));
    expect(fragment.get("attach")).toMatch(/^at_/);
    expect(
      Object.fromEntries(["title", "memo", "kind", "asset"].map((k) => [k, fragment.get(k)])),
    ).toEqual({ title: "Logo design", memo: "Round one", kind: "multipay", asset: "KUSD" });

    // The wallet then attaches the real commitment with that token, and the watcher takes over.
    const attached = await t.call(
      "POST",
      `/v1/checkout/sessions/${field(reply.body, "session.id") as string}/commitment`,
      {
        headers: { Authorization: `Bearer ${fragment.get("attach") ?? ""}` },
        body: { commitment: fakeCommitment(7) },
      },
    );
    expect(field(attached.body, "session.status")).toBe("pending");
    expect(
      field((await t.call("GET", "/v1/merchant", { key: m.key })).body, "sessions.pending"),
    ).toBe(1);
  });

  it("works with no fields at all, and validates the ones given", async () => {
    await linked(1);
    expect(
      (await t.call("POST", "/v1/bot/chats/1/sessions", { headers: bot, body: {} })).status,
    ).toBe(201);
    for (const body of [
      { title: "" },
      { kind: "x" },
      { amount: "5" },
      { commitment: fakeCommitment(1) },
    ]) {
      expect(
        (await t.call("POST", "/v1/bot/chats/1/sessions", { headers: bot, body })).status,
      ).toBe(400);
    }
  });

  it("refuses for a chat that is not linked", async () => {
    expect(
      (await t.call("POST", "/v1/bot/chats/99/sessions", { headers: bot, body: {} })).status,
    ).toBe(404);
  });

  it("points at the configured invoice path", async () => {
    await t.stop();
    t = await startTestApp({
      env: { KINKO_BOT_TOKEN: BOT, KINKO_APP_INVOICE_PATH: "/app/request" },
    });
    await linked(1);
    const reply = await t.call("POST", "/v1/bot/chats/1/sessions", { headers: bot, body: {} });
    expect(new URL(field(reply.body, "formUrl") as string).pathname).toBe("/app/request");
  });
});

describe("settlement notifications", () => {
  it("starts listening at the newest event, so history is never replayed into a chat", async () => {
    const m = await linked(1);
    await t.call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: fakeCommitment(1) },
    });
    t.chain.open(fakeCommitment(1), { status: "settled" as never, contributions: 1 });
    await t.app.deps.watcher.tick();
    const cursor = field(
      (await t.call("GET", "/v1/bot/cursor", { headers: bot })).body,
      "seq",
    ) as number;
    expect(cursor).toBeGreaterThan(0);
    expect(
      (await t.call("GET", `/v1/bot/events?after=${String(cursor)}`, { headers: bot })).body,
    ).toEqual({ data: [], nextAfter: cursor });
  });

  it("reports an event with the chats to tell, and no amount", async () => {
    const m = await linked(1, "Alpha Shop");
    // A second chat for the same merchant also gets told.
    const code2 = field(
      (await t.call("POST", "/v1/merchant/telegram/link-codes", { key: m.key })).body,
      "code",
    ) as string;
    await t.call("POST", "/v1/bot/link", { headers: bot, body: { code: code2, chatId: 2 } });
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: {
        commitment: fakeCommitment(1),
        title: "Logo design",
        clientReference: "order-9",
        amount: "42500",
      },
    });
    t.chain.open(fakeCommitment(1), { status: "settled" as never, contributions: 1 });
    await t.app.deps.watcher.tick();
    const events = (await t.call("GET", "/v1/bot/events?after=0", { headers: bot })).body as {
      data: { seq: number; type: string }[];
      nextAfter: number;
    };
    expect(events.data.map((e) => e.type)).toEqual(["invoice.payment_received", "invoice.settled"]);
    expect(events.data[1]).toMatchObject({
      merchant: { id: m.id, name: "Alpha Shop" },
      chatIds: [1, 2],
      data: {
        sessionId: field(created.body, "session.id"),
        title: "Logo design",
        clientReference: "order-9",
        status: "settled",
        contributions: 1,
        late: false,
      },
    });
    expect(JSON.stringify(events)).not.toContain("42500");
    expect(events.nextAfter).toBe(events.data[1]?.seq);
  });

  it("returns only the events of merchants who have a linked chat", async () => {
    const linkedMerchant = await linked(1);
    const unlinked = await t.register("Gamma", "https://hooks.example.com/g");
    await t.call("POST", "/v1/checkout/sessions", {
      key: linkedMerchant.key,
      body: { commitment: fakeCommitment(1) },
    });
    await t.call("POST", "/v1/checkout/sessions", {
      key: unlinked.key,
      body: { commitment: fakeCommitment(2) },
    });
    t.chain.open(fakeCommitment(1), { status: "cancelled" as never });
    t.chain.open(fakeCommitment(2), { status: "cancelled" as never });
    await t.app.deps.watcher.tick();
    const data = field(
      (await t.call("GET", "/v1/bot/events?after=0", { headers: bot })).body,
      "data",
    ) as {
      merchant: { id: string };
    }[];
    expect(data).toHaveLength(1);
    expect(data[0]?.merchant.id).toBe(linkedMerchant.id);
  });

  it("pages by cursor and validates the query", async () => {
    const m = await linked(1);
    for (let i = 1; i <= 3; i++) {
      await t.call("POST", "/v1/checkout/sessions", {
        key: m.key,
        body: { commitment: fakeCommitment(i) },
      });
      t.chain.open(fakeCommitment(i), { status: "cancelled" as never });
    }
    await t.app.deps.watcher.tick();
    const first = (await t.call("GET", "/v1/bot/events?after=0&limit=2", { headers: bot }))
      .body as { data: unknown[]; nextAfter: number };
    expect(first.data).toHaveLength(2);
    const next = (
      await t.call("GET", `/v1/bot/events?after=${String(first.nextAfter)}&limit=2`, {
        headers: bot,
      })
    ).body as { data: unknown[] };
    expect(next.data).toHaveLength(1);
    for (const q of ["after=-1", "limit=0", "limit=201", "after=x", "junk=1"]) {
      expect((await t.call("GET", `/v1/bot/events?${q}`, { headers: bot })).status).toBe(400);
    }
  });

  it("stops telling a chat once it is unlinked", async () => {
    const m = await linked(1);
    await t.call("POST", "/v1/checkout/sessions", {
      key: m.key,
      body: { commitment: fakeCommitment(1) },
    });
    t.chain.open(fakeCommitment(1), { status: "cancelled" as never });
    await t.app.deps.watcher.tick();
    await t.call("POST", "/v1/bot/chats/1/unlink", { headers: bot });
    expect(
      field((await t.call("GET", "/v1/bot/events?after=0", { headers: bot })).body, "data"),
    ).toEqual([]);
  });
});

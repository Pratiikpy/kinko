import { beforeEach, describe, expect, it } from "vitest";

import { BackendError } from "../src/backend.ts";
import { COMMANDS, handleMessage, parseCommand, type Reply } from "../src/commands.ts";
import { aSession, FakeBackend, message } from "./support.ts";

let backend: FakeBackend;
const USERNAME = "KinkoTestBot";
const say = (text: string, chatId = 100, type = "private"): Promise<Reply | undefined> =>
  handleMessage(message(text, chatId, type), { backend, username: USERNAME });
const linkChat = (chatId = 100) => backend.links.set(chatId, { id: "mer_1", name: "Acme Studio" });

beforeEach(() => {
  backend = new FakeBackend();
});

describe("parseCommand", () => {
  it.each([
    ["/start", "start", ""],
    ["/START", "start", ""],
    ["/invoice cs_abc", "invoice", "cs_abc"],
    ["/invoice   spaced   out  ", "invoice", "spaced   out"],
    ["/newlink@KinkoTestBot multipay Logo", "newlink", "multipay Logo"],
    ["/newlink@kinkotestbot Logo", "newlink", "Logo"],
    ["/link K7QM-4XD2-9PTV", "link", "K7QM-4XD2-9PTV"],
    ["/newlink line one\nline two", "newlink", "line one\nline two"],
  ])("reads %j", (text, command, args) => {
    expect(parseCommand(text, USERNAME)).toEqual({ command, args });
  });

  it.each(["hello", "", "/", "/ start", "//start", "start"])(
    "does not read %j as a command",
    (text) => {
      expect(parseCommand(text, USERNAME)).toBeUndefined();
    },
  );

  it("ignores a command addressed to another bot", () => {
    expect(parseCommand("/start@SomeOtherBot", USERNAME)).toBeUndefined();
  });
});

describe("menu and help", () => {
  it("publishes every command it handles, each with a description", () => {
    for (const c of COMMANDS) {
      expect(c.description.length).toBeGreaterThan(5);
      expect(c.command).toMatch(/^[a-z]+$/);
    }
    expect(COMMANDS.map((c) => c.command)).toEqual([
      "start",
      "link",
      "unlink",
      "status",
      "invoices",
      "invoice",
      "newlink",
      "privacy",
    ]);
  });

  it("says what it does not do as plainly as what it does", async () => {
    const reply = await say("/start");
    expect(reply?.text).toContain("/link <code>");
    expect(reply?.text).toMatch(
      /never does: hold your keys, create an invoice itself, or learn an amount/,
    );
    expect((await say("/help"))?.text).toBe(reply?.text);
  });

  it("explains its privacy position", async () => {
    const text = (await say("/privacy"))?.text ?? "";
    for (const part of [
      "amount of any invoice",
      "merchant or payout keys",
      "salt or owner secret",
      "Telegram itself can read this chat",
    ])
      expect(text).toContain(part);
  });

  it("answers a stray message with a pointer, and an unknown command by name", async () => {
    expect((await say("hello there"))?.text).toContain("/start");
    expect((await say("/frobnicate"))?.text).toContain("/frobnicate");
  });

  it("stays silent for a message with no text and for commands meant for other bots", async () => {
    expect(
      await handleMessage(
        { message_id: 1, chat: { id: 1, type: "private" } },
        { backend, username: USERNAME },
      ),
    ).toBeUndefined();
    expect(await say("/start@SomeOtherBot")).toBeUndefined();
  });
});

describe("groups", () => {
  it("serves no merchant command in a group, where anyone could act as the merchant", async () => {
    linkChat(-100);
    for (const text of ["/invoices", "/status", "/newlink x", "/link ABCD-EFGH-JKMN", "/unlink"]) {
      for (const type of ["group", "supergroup", "channel"]) {
        expect((await say(text, -100, type))?.text).toContain("private chat only");
      }
    }
    expect(backend.drafts).toEqual([]);
    expect(backend.links.has(-100)).toBe(true);
  });
});

describe("/link and /unlink", () => {
  it("links the chat with a valid code, and the code stops working", async () => {
    backend.validCodes.set("K7QM-4XD2-9PTV", { id: "mer_1", name: "Acme Studio" });
    const reply = await say("/link K7QM-4XD2-9PTV");
    expect(reply?.text).toContain("Linked to Acme Studio");
    expect(reply?.text).toContain("delete your message");
    expect(backend.links.get(100)?.name).toBe("Acme Studio");
    expect((await say("/link K7QM-4XD2-9PTV", 200))?.text).toBe("That code is not valid.");
  });

  it("asks for the code when none is given", async () => {
    expect((await say("/link"))?.text).toContain("followed by the code");
  });

  it("unlinks, and says so when there was nothing to unlink", async () => {
    linkChat();
    expect((await say("/unlink"))?.text).toContain("Unlinked");
    expect((await say("/unlink"))?.text).toBe("This chat was not linked.");
  });
});

describe("unlinked chats", () => {
  it.each(["/status", "/invoices", "/invoice cs_abc", "/newlink Logo"])(
    "tell the user how to link on %s, and do nothing else",
    async (text) => {
      const reply = await say(text);
      expect(reply?.text).toContain("not linked");
      expect(reply?.text).toContain("/link");
      expect(backend.drafts).toEqual([]);
    },
  );
});

describe("/status", () => {
  it("counts invoices by status under the merchant's name", async () => {
    linkChat();
    backend.sessions.push(
      aSession({ status: "settled" }),
      aSession({ status: "settled", id: "cs_2" }),
      aSession({ status: "pending", id: "cs_3" }),
    );
    const text = (await say("/status"))?.text ?? "";
    expect(text).toContain("Acme Studio");
    expect(text).toMatch(/settled\s+2/);
    expect(text).toMatch(/pending\s+1/);
    expect(text).toMatch(/expired\s+0/);
  });
});

describe("/invoices", () => {
  beforeEach(() => {
    linkChat();
    backend.sessions.push(
      aSession(),
      aSession({ id: "cs_2", status: "settled", title: null, commitment: null }),
    );
  });

  it("lists them with title, status and a short commitment", async () => {
    const text = (await say("/invoices"))?.text ?? "";
    expect(text).toContain("Logo design");
    expect(text).toContain("abababab…");
    expect(text).toContain("(untitled)");
    expect(text).toContain("draft");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("filters by status, and says when nothing matches", async () => {
    expect((await say("/invoices settled"))?.text.split("\n")).toHaveLength(1);
    expect((await say("/invoices expired"))?.text).toBe("No expired invoices.");
  });

  it("refuses a status it does not know", async () => {
    expect((await say("/invoices paid"))?.text).toContain("Status must be one of");
  });

  it("points a new merchant at /newlink", async () => {
    backend.sessions.length = 0;
    expect((await say("/invoices"))?.text).toContain("/newlink");
  });
});

describe("/invoice", () => {
  beforeEach(() => linkChat());

  it("shows one invoice, with a button into the web app and no amount", async () => {
    backend.sessions.push(
      aSession({
        contributions: 2,
        late: true,
        status: "settled",
        settledAt: "2027-01-15T12:30:00.000Z",
      }),
    );
    const reply = await say(`/invoice ${"ab".repeat(4)}`);
    expect(reply?.text).toContain("Logo design");
    expect(reply?.text).toContain("status         settled (paid after it expired)");
    expect(reply?.text).toContain("payments       2");
    expect(reply?.text).toContain("reference      order-9");
    expect(reply?.text).not.toMatch(/amount/i);
    expect(reply?.buttons).toEqual([
      { text: "Open in Kinko", url: `https://app.kinko.example/app/invoices/${"ab".repeat(32)}` },
    ]);
  });

  it("offers no button for a draft, which has no commitment yet", async () => {
    backend.sessions.push(aSession({ commitment: null, status: "draft" }));
    const reply = await say(`/invoice cs_${"1".repeat(32)}`);
    expect(reply?.buttons).toEqual([]);
    expect(reply?.text).toContain("no invoice attached yet");
  });

  it("explains what to give it, and when nothing matches", async () => {
    expect((await say("/invoice"))?.text).toContain("session id");
    expect((await say("/invoice nonsense"))?.text).toContain("None of your invoices matches");
  });
});

describe("/newlink", () => {
  beforeEach(() => linkChat());

  it("starts a draft and hands back a button to the wallet, never the address in the text", async () => {
    const reply = await say("/newlink Logo design for Acme");
    expect(backend.drafts).toEqual([{ chatId: 100, draft: { title: "Logo design for Acme" } }]);
    expect(reply?.buttons?.[0]?.text).toBe("Create the invoice");
    expect(reply?.buttons?.[0]?.url).toContain("/app/invoices#session=");
    expect(reply?.text).not.toContain("at_secret");
    expect(reply?.text).toContain("one-time token");
  });

  it("takes a kind first, and treats the rest as the title", async () => {
    await say("/newlink multipay Fundraiser");
    expect(backend.drafts[0]?.draft).toEqual({ title: "Fundraiser", kind: "multipay" });
    await say("/newlink donation");
    expect(backend.drafts[1]?.draft).toEqual({ kind: "donation" });
    await say("/newlink");
    expect(backend.drafts[2]?.draft).toEqual({});
  });

  it("does not mistake a title that starts like a kind for one", async () => {
    await say("/newlink standardised parts");
    expect(backend.drafts[0]?.draft).toEqual({ title: "standardised parts" });
  });

  it("refuses an overlong title before asking the backend", async () => {
    expect((await say(`/newlink ${"x".repeat(121)}`))?.text).toContain("under 120");
    expect(backend.drafts).toEqual([]);
  });
});

describe("when the backend fails", () => {
  it("passes on the backend's own words for a refusal", async () => {
    linkChat();
    backend.failWith = new BackendError(400, "invalid_request", "Invalid draft. title: too long");
    expect((await say("/status"))?.text).toBe("Invalid draft. title: too long");
  });

  it("apologises, without detail, for an outage or an unreachable backend", async () => {
    for (const status of [0, 500, 502, 503]) {
      backend.failWith = new BackendError(
        status,
        "x",
        "connection refused at http://10.0.0.5:3100",
      );
      const reply = await say("/status");
      expect(reply?.text).toBe("I could not reach Kinko just now. Try again in a minute.");
    }
  });

  it("recognises 'not linked' from the backend even when its own check said otherwise", async () => {
    linkChat();
    backend.failWith = new BackendError(404, "not_found", "This chat is not linked to a merchant.");
    expect((await say("/unlink"))?.text).toContain("not linked");
  });

  it("lets a truly unexpected error out, for the loop to apologise for", async () => {
    backend.account = () => Promise.reject(new TypeError("boom"));
    await expect(say("/status")).rejects.toThrow("boom");
  });
});

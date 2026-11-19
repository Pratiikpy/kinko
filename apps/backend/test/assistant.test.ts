import { describe, expect, it } from "vitest";

import {
  assertMessages,
  assertPublicContext,
  Assistant,
  ChatRole,
  PUBLIC_CONTEXT_FIELDS,
} from "../src/assistant.ts";
import { ApiError } from "../src/http/errors.ts";
import { containing } from "./support/fixtures.ts";

const reply = (text: string) => () =>
  Promise.resolve(
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
    }),
  );

describe("assertPublicContext", () => {
  it("accepts nothing, and every whitelisted field", () => {
    expect(assertPublicContext(undefined)).toEqual({});
    expect(assertPublicContext(null)).toEqual({});
    const all = Object.fromEntries(PUBLIC_CONTEXT_FIELDS.map((f) => [f, 1]));
    expect(assertPublicContext(all)).toEqual(all);
  });

  it.each(["amount", "merchantKey", "salt", "ownerSecret", "invoiceAmount", "balance", "seed"])(
    "refuses %s, and names it",
    (field) => {
      expect(() => assertPublicContext({ [field]: "x" })).toThrow(new RegExp(`Refused: ${field}`));
    },
  );

  it("refuses a whitelisted key that carries an object, which could smuggle anything", () => {
    expect(() => assertPublicContext({ currentPage: { amount: 5 } })).toThrow(
      /currentPage must be a string, number, boolean or null/,
    );
    expect(() => assertPublicContext({ currentPage: [1] })).toThrow(ApiError);
  });

  it("refuses non-objects and oversized strings", () => {
    expect(() => assertPublicContext("hi")).toThrow(/must be an object/);
    expect(() => assertPublicContext([])).toThrow(/must be an object/);
    expect(() => assertPublicContext({ currentPage: "x".repeat(201) })).toThrow(/too long/);
  });
});

describe("assertMessages", () => {
  it("accepts a conversation", () => {
    expect(
      assertMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
    ).toHaveLength(2);
  });
  it.each([
    [undefined, /non-empty array/],
    [[], /non-empty array/],
    ["hi", /non-empty array/],
    [[{ role: "system", content: "x" }], /role must be/],
    [[{ role: "user", content: "" }], /non-empty string/],
    [[{ role: "user", content: "   " }], /non-empty string/],
    [[{ role: "user", content: 5 }], /non-empty string/],
    [[{ role: "user", content: "x".repeat(4_001) }], /too long/],
    [[null], /role must be/],
    [Array.from({ length: 41 }, () => ({ role: "user", content: "x" })), /too long/],
  ])("refuses %j", (input, message) => {
    expect(() => assertMessages(input)).toThrow(message);
    expect(() => assertMessages(input)).toThrow(ApiError);
  });
});

describe("Assistant", () => {
  const messages = [{ role: ChatRole.USER, content: "What can an invoice reveal?" }];

  it("answers 503 and says how to turn it on when no key is set, rather than inventing an answer", async () => {
    const assistant = new Assistant({
      apiKey: undefined,
      model: "m",
      fetchImpl: () => Promise.reject(new Error("must not be called")),
    });
    expect(assistant.configured).toBe(false);
    await expect(assistant.chat(messages)).rejects.toMatchObject({
      status: 503,
      message: containing("KINKO_ASSISTANT_API_KEY"),
    });
  });

  it("sends the key in a header, never in the URL, and the context in the system prompt", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const assistant = new Assistant({
      apiKey: "secret-key-123",
      model: "gemini-test",
      fetchImpl: (url, init) => {
        seen = { url: url instanceof Request ? url.url : String(url), init: init ?? {} };
        return reply("Plain answer.")();
      },
    });
    expect(assistant.configured).toBe(true);
    await expect(
      assistant.chat(messages, { currentPage: "invoices", invoiceCount: 3 }),
    ).resolves.toEqual({ text: "Plain answer.", model: "gemini-test" });
    expect(seen?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
    );
    expect(seen?.url).not.toContain("secret-key-123");
    expect((seen?.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key-123");
    const body = JSON.parse(seen?.init.body as string) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string }[];
    };
    expect(body.systemInstruction.parts[0]?.text).toContain("- currentPage: invoices");
    expect(body.systemInstruction.parts[0]?.text).toContain("- invoiceCount: 3");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "What can an invoice reveal?" }] },
    ]);
  });

  it("maps assistant turns to the provider's role name", async () => {
    let body = "";
    const assistant = new Assistant({
      apiKey: "k",
      model: "m",
      fetchImpl: (_u, init) => ((body = init?.body as string), reply("ok")()),
    });
    await assistant.chat([
      { role: ChatRole.USER, content: "a" },
      { role: ChatRole.ASSISTANT, content: "b" },
      { role: ChatRole.USER, content: "c" },
    ]);
    expect(
      (JSON.parse(body) as { contents: { role: string }[] }).contents.map((c) => c.role),
    ).toEqual(["user", "model", "user"]);
  });

  it("states what it cannot see in its instructions", async () => {
    let body = "";
    await new Assistant({
      apiKey: "k",
      model: "m",
      fetchImpl: (_u, init) => ((body = init?.body as string), reply("ok")()),
    }).chat(messages);
    expect(body).toContain("You have no access to any amount, key or invoice term");
  });

  it("reports a provider error as a 502 without echoing the provider's body, which may contain the key", async () => {
    const assistant = new Assistant({
      apiKey: "k",
      model: "m",
      fetchImpl: () => Promise.resolve(new Response("bad key: k", { status: 403 })),
    });
    const error = await assistant.chat(messages).catch((e: unknown) => e as ApiError);
    expect(error).toMatchObject({ status: 502, message: "The model returned 403." });
    expect(JSON.stringify(error)).not.toContain("bad key");
    expect(assistant.stats).toEqual({ requests: 1, failures: 1 });
  });

  it("reports an unreachable provider and an empty answer as 502", async () => {
    await expect(
      new Assistant({
        apiKey: "k",
        model: "m",
        fetchImpl: () => Promise.reject(new Error("ENOTFOUND")),
      }).chat(messages),
    ).rejects.toMatchObject({ status: 502, message: containing("ENOTFOUND") });
    await expect(
      new Assistant({ apiKey: "k", model: "m", fetchImpl: reply("   ") }).chat(messages),
    ).rejects.toMatchObject({ status: 502, message: containing("empty answer") });
    await expect(
      new Assistant({
        apiKey: "k",
        model: "m",
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
      }).chat(messages),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("counts requests only, never their content", async () => {
    const assistant = new Assistant({ apiKey: "k", model: "m", fetchImpl: reply("ok") });
    await assistant.chat(messages);
    expect(JSON.stringify(assistant.stats)).toBe('{"requests":1,"failures":0}');
  });
});

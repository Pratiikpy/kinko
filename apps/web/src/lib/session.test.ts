import { afterEach, describe, expect, it, vi } from "vitest";

import { attachCommitment, isSessionId, parseDraftFragment, readSession } from "./session.ts";

const SESSION = "cs_0123456789abcdef0123456789abcdef";
const TOKEN = "at_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const COMMITMENT = "ab".repeat(32);

describe("parseDraftFragment", () => {
  it.each([
    {
      name: "a full draft",
      fragment: `session=${SESSION}&attach=${TOKEN}&title=Order%2042&memo=Two%20mugs&kind=multipay&asset=KUSD`,
      expected: {
        sessionId: SESSION,
        attachToken: TOKEN,
        title: "Order 42",
        memo: "Two mugs",
        kind: "multipay",
      },
    },
    {
      name: "missing labels default to empty and standard",
      fragment: `session=${SESSION}&attach=${TOKEN}`,
      expected: { sessionId: SESSION, attachToken: TOKEN, title: "", memo: "", kind: "standard" },
    },
    {
      name: "an unknown kind falls back to standard",
      fragment: `session=${SESSION}&attach=${TOKEN}&kind=subscription`,
      expected: { sessionId: SESSION, attachToken: TOKEN, title: "", memo: "", kind: "standard" },
    },
  ])("reads $name", ({ fragment, expected }) => {
    expect(parseDraftFragment(fragment)).toEqual(expected);
  });

  it.each([
    { name: "a payment link", fragment: "v=1&c=abc" },
    { name: "no attach token", fragment: `session=${SESSION}` },
    { name: "a session id with a slash", fragment: `session=cs_ab%2F..&attach=${TOKEN}` },
    { name: "a short token", fragment: `session=${SESSION}&attach=at_x` },
  ])("rejects $name", ({ fragment }) => {
    expect(parseDraftFragment(fragment)).toBeNull();
  });

  it("caps long labels", () => {
    const d = parseDraftFragment(`session=${SESSION}&attach=${TOKEN}&title=${"x".repeat(200)}`);
    expect(d?.title).toHaveLength(80);
  });
});

describe("isSessionId", () => {
  it.each([
    { id: SESSION, ok: true },
    { id: "cs_1", ok: false },
    { id: "../etc/passwd", ok: false },
  ])("$id → $ok", ({ id, ok }) => {
    expect(isSessionId(id)).toBe(ok);
  });
});

describe("backend calls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a public session", async () => {
    const session = {
      id: SESSION,
      status: "pending",
      commitment: COMMITMENT,
      kind: "standard",
      asset: "KUSD",
      title: "Order 42",
      memo: null,
      amount: null,
      merchantName: "Shop",
      expiresAt: "2026-11-15T12:00:00.000Z",
      contributions: 0,
      successUrl: null,
      cancelUrl: null,
      contractAddress: "cd".repeat(32),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ session }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readSession(SESSION)).resolves.toEqual(session);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/v1/checkout/sessions/${SESSION}`);
  });

  it("reports an unknown session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(readSession(SESSION)).rejects.toThrow("does not exist");
  });

  it("refuses a malformed session before calling the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(readSession("bad id")).rejects.toThrow("invalid session id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches a commitment with the one-time token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const draft = {
      sessionId: SESSION,
      attachToken: TOKEN,
      title: "",
      memo: "",
      kind: "standard" as const,
    };
    await attachCommitment(draft, COMMITMENT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/v1/checkout/sessions/${SESSION}/commitment`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe(JSON.stringify({ commitment: COMMITMENT }));
  });

  it("surfaces the backend's refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Token already used." } }), {
          status: 409,
        }),
      ),
    );
    const draft = {
      sessionId: SESSION,
      attachToken: TOKEN,
      title: "",
      memo: "",
      kind: "standard" as const,
    };
    await expect(attachCommitment(draft, COMMITMENT)).rejects.toThrow("Token already used.");
  });
});

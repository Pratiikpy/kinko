import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeCommitment, field, matching, startTestApp, type TestApp } from "./support/fixtures.ts";

let t: TestApp;
let key: string;
let merchantId: string;
beforeEach(async () => {
  t = await startTestApp();
  const m = await t.register();
  key = m.key;
  merchantId = m.id;
});
afterEach(async () => {
  await t.stop();
});

const C1 = fakeCommitment(0xa1);
const titles = (body: unknown): string[] =>
  (field(body, "data") as { title: string }[]).map((s) => s.title);
const C2 = fakeCommitment(0xa2);

describe("POST /v1/checkout/sessions", () => {
  it("creates a pending session for a commitment, with a hosted checkout URL", async () => {
    const reply = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: {
        commitment: C1,
        title: "Invoice 12",
        memo: "Design work",
        clientReference: "order-9",
        successUrl: "https://shop.example/ok",
        cancelUrl: "https://shop.example/no",
      },
    });
    expect(reply.status).toBe(201);
    expect(field(reply.body, "attachToken")).toBeNull();
    expect(field(reply.body, "session")).toMatchObject({
      id: matching(/^cs_[0-9a-f]{32}$/),
      status: "pending",
      commitment: C1,
      kind: "standard",
      asset: "KUSD",
      title: "Invoice 12",
      memo: "Design work",
      amount: null,
      clientReference: "order-9",
      onChain: false,
      contributions: 0,
      late: false,
      expiresAt: new Date(t.clock.now() + 3_600_000).toISOString(),
    });
    expect(field(reply.body, "session.checkoutUrl")).toBe(
      `https://app.kinko.example/checkout?session=${field(reply.body, "session.id") as string}`,
    );
  });

  it("stores an amount only when the merchant supplies one", async () => {
    const without = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1 },
    });
    expect(field(without.body, "session.amount")).toBeNull();
    const withAmount = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C2, amount: "42500" },
    });
    expect(field(withAmount.body, "session.amount")).toBe("42500");
  });

  it("honours kind, asset and a custom lifetime", async () => {
    const reply = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1, kind: "donation", token: "NATIVE", ttlSeconds: 600 },
    });
    expect(field(reply.body, "session")).toMatchObject({
      kind: "donation",
      asset: "NATIVE",
      expiresAt: new Date(t.clock.now() + 600_000).toISOString(),
    });
  });

  it("creates a draft without a commitment and hands back a one-time attach token", async () => {
    const reply = await t.call("POST", "/v1/checkout/sessions", { key, body: { title: "Draft" } });
    expect(reply.status).toBe(201);
    expect(field(reply.body, "session")).toMatchObject({ status: "draft", commitment: null });
    expect(field(reply.body, "attachToken")).toMatch(/^at_/);
    expect(
      JSON.stringify(t.app.deps.store.getSession(field(reply.body, "session.id") as string)),
    ).not.toContain(field(reply.body, "attachToken") as string);
  });

  it("returns the address where the merchant's wallet finishes a draft, with the secrets in the fragment only", async () => {
    const reply = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { title: "Draft & more", memo: "a b", kind: "donation", token: "NATIVE" },
    });
    const url = new URL(field(reply.body, "formUrl") as string);
    expect(url.origin + url.pathname + url.search).toBe("https://app.kinko.example/app/invoices");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(Object.fromEntries(fragment)).toEqual({
      session: field(reply.body, "session.id"),
      attach: field(reply.body, "attachToken"),
      title: "Draft & more",
      memo: "a b",
      kind: "donation",
      asset: "NATIVE",
    });
    expect(
      field(
        (await t.call("POST", "/v1/checkout/sessions", { key, body: { commitment: C1 } })).body,
        "formUrl",
      ),
    ).toBeUndefined();
  });

  it("refuses a second session for the same commitment, naming the first only to its owner", async () => {
    const first = await t.call("POST", "/v1/checkout/sessions", { key, body: { commitment: C1 } });
    const again = await t.call("POST", "/v1/checkout/sessions", { key, body: { commitment: C1 } });
    expect(again.status).toBe(409);
    expect(field(again.body, "error.details")).toEqual({
      sessionId: field(first.body, "session.id"),
    });
    const other = await t.register("Other", "https://hooks.example.com/o");
    const theirs = await t.call("POST", "/v1/checkout/sessions", {
      key: other.key,
      body: { commitment: C1 },
    });
    expect(theirs.status).toBe(409);
    expect(field(theirs.body, "error.details")).toBeUndefined();
  });

  it("requires authentication", async () => {
    expect(
      (await t.call("POST", "/v1/checkout/sessions", { body: { commitment: C1 } })).status,
    ).toBe(401);
  });

  it.each([
    [{ commitment: "short" }, "commitment"],
    [{ commitment: C1, amount: "0" }, "amount"],
    [{ commitment: C1, amount: 42500 }, "amount"],
    [{ commitment: C1, kind: "weekly" }, "kind"],
    [{ commitment: C1, ttlSeconds: 1 }, "ttlSeconds"],
    [{ commitment: C1, successUrl: "https://shop.example/ok#amount=500" }, "fragment"],
    [{ commitment: C1, paymentUrl: "https://app/pay#eyJ" }, "Unrecognized"],
    [{ commitment: C1, merchantKey: "ab".repeat(32) }, "Unrecognized"],
    [{ commitment: C1, salt: "ab".repeat(32) }, "Unrecognized"],
  ])("rejects %j", async (body, expected) => {
    const reply = await t.call("POST", "/v1/checkout/sessions", { key, body });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(field(reply.body, "error"))).toContain(expected);
  });

  it("explains that a payment link's fragment must stay with the merchant", async () => {
    const reply = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1, cancelUrl: "https://pay.example/pay#eyJhbW91bnQiOiI1In0" },
    });
    expect(field(reply.body, "error.message")).toMatch(
      /must not contain a fragment.*must not reach this server/,
    );
  });

  it("never stores anything that looks like a payment link's terms", async () => {
    await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1, amount: "42500", title: "T" },
    });
    const stored = JSON.stringify(t.app.deps.store.getSessionByCommitment(C1));
    for (const forbidden of ["merchantKey", "salt", "payout", "ownerSecret"])
      expect(stored).not.toContain(forbidden);
  });
});

describe("GET /v1/checkout/sessions/:id", () => {
  it("serves the hosted checkout page what it needs, without credentials", async () => {
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: {
        commitment: C1,
        title: "Invoice 12",
        memo: "Hello",
        amount: "42500",
        clientReference: "internal-ref",
        successUrl: "https://shop.example/ok",
      },
    });
    const reply = await t.call(
      "GET",
      `/v1/checkout/sessions/${field(created.body, "session.id") as string}`,
    );
    expect(reply.status).toBe(200);
    expect(field(reply.body, "session")).toEqual({
      id: field(created.body, "session.id"),
      status: "pending",
      commitment: C1,
      kind: "standard",
      asset: "KUSD",
      title: "Invoice 12",
      memo: "Hello",
      amount: "42500",
      merchantName: "Acme Studio",
      expiresAt: new Date(t.clock.now() + 3_600_000).toISOString(),
      contributions: 0,
      successUrl: "https://shop.example/ok",
      cancelUrl: null,
      contractAddress: "cd".repeat(32),
    });
    // The merchant's own reference is theirs, not the payer's.
    expect(JSON.stringify(reply.body)).not.toContain("internal-ref");
  });

  it("serves the full record to the owning merchant", async () => {
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1, clientReference: "internal-ref" },
    });
    const reply = await t.call(
      "GET",
      `/v1/checkout/sessions/${field(created.body, "session.id") as string}`,
      { key },
    );
    expect(field(reply.body, "session.clientReference")).toBe("internal-ref");
    expect(field(reply.body, "session.checkoutUrl")).toContain("/checkout?session=");
  });

  it("does not show another merchant's full record to a merchant", async () => {
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1 },
    });
    const other = await t.register("Other", "https://hooks.example.com/o");
    expect(
      (
        await t.call(
          "GET",
          `/v1/checkout/sessions/${field(created.body, "session.id") as string}`,
          {
            key: other.key,
          },
        )
      ).status,
    ).toBe(404);
  });

  it("answers 404 for an unknown id, and 401 for a bad API key rather than quietly serving the public view", async () => {
    expect((await t.call("GET", "/v1/checkout/sessions/cs_nope")).status).toBe(404);
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1 },
    });
    expect(
      (
        await t.call(
          "GET",
          `/v1/checkout/sessions/${field(created.body, "session.id") as string}`,
          {
            key: "kk_wrong",
          },
        )
      ).status,
    ).toBe(401);
  });

  it("shows a lapsed session as expired at once, before the watcher has run", async () => {
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1, ttlSeconds: 60 },
    });
    t.clock.advance(61_000);
    expect(
      field(
        (
          await t.call(
            "GET",
            `/v1/checkout/sessions/${field(created.body, "session.id") as string}`,
          )
        ).body,
        "session.status",
      ),
    ).toBe("expired");
    expect(t.app.deps.store.getSession(field(created.body, "session.id") as string)?.status).toBe(
      "pending",
    );
  });

  it("follows the chain once the watcher has run", async () => {
    const created = await t.call("POST", "/v1/checkout/sessions", {
      key,
      body: { commitment: C1 },
    });
    t.chain.open(C1, { status: "settled" as never, contributions: 1 });
    await t.app.deps.watcher.tick();
    const reply = await t.call(
      "GET",
      `/v1/checkout/sessions/${field(created.body, "session.id") as string}`,
      { key },
    );
    expect(field(reply.body, "session")).toMatchObject({
      status: "settled",
      contributions: 1,
      onChain: true,
      late: false,
      settledAt: new Date(t.clock.now()).toISOString(),
    });
  });
});

describe("GET /v1/checkout/sessions", () => {
  it("lists newest first with a cursor, and filters by status", async () => {
    for (let i = 1; i <= 5; i++)
      await t.call("POST", "/v1/checkout/sessions", {
        key,
        body: { commitment: fakeCommitment(i), title: `n${String(i)}` },
      });
    const page1 = await t.call("GET", "/v1/checkout/sessions?limit=2", { key });
    expect(titles(page1.body)).toEqual(["n5", "n4"]);
    expect(field(page1.body, "nextCursor")).toEqual(expect.any(String));
    const page2 = await t.call(
      "GET",
      `/v1/checkout/sessions?limit=2&before=${field(page1.body, "nextCursor") as string}`,
      { key },
    );
    expect(titles(page2.body)).toEqual(["n3", "n2"]);
    const page3 = await t.call(
      "GET",
      `/v1/checkout/sessions?limit=2&before=${field(page2.body, "nextCursor") as string}`,
      { key },
    );
    expect(titles(page3.body)).toEqual(["n1"]);
    expect(field(page3.body, "nextCursor")).toBeNull();
    expect(
      field((await t.call("GET", "/v1/checkout/sessions?status=settled", { key })).body, "data"),
    ).toEqual([]);
    expect(
      field(
        (await t.call("GET", "/v1/checkout/sessions?status=pending&limit=100", { key })).body,
        "data",
      ),
    ).toHaveLength(5);
  });

  it("lists only the caller's sessions, and requires a key", async () => {
    await t.call("POST", "/v1/checkout/sessions", { key, body: { commitment: C1 } });
    const other = await t.register("Other", "https://hooks.example.com/o");
    expect(
      field((await t.call("GET", "/v1/checkout/sessions", { key: other.key })).body, "data"),
    ).toEqual([]);
    expect((await t.call("GET", "/v1/checkout/sessions")).status).toBe(401);
  });

  it.each(["limit=0", "limit=101", "limit=abc", "status=weird", "before=0", "extra=1"])(
    "rejects ?%s",
    async (query) => {
      expect((await t.call("GET", `/v1/checkout/sessions?${query}`, { key })).status).toBe(400);
    },
  );
});

describe("POST /v1/checkout/sessions/:id/commitment", () => {
  const draft = async () => {
    const reply = await t.call("POST", "/v1/checkout/sessions", { key, body: { title: "Draft" } });
    return {
      id: field(reply.body, "session.id") as string,
      token: field(reply.body, "attachToken") as string,
    };
  };

  it("attaches a commitment with the one-time token, making the session pending", async () => {
    const { id, token } = await draft();
    const reply = await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { commitment: C1.toUpperCase() },
    });
    expect(reply.status).toBe(200);
    expect(field(reply.body, "session")).toMatchObject({ status: "pending", commitment: C1 });
    expect(t.app.deps.store.getSessionByCommitment(C1)?.id).toBe(id);
  });

  it("is safe to repeat with the same commitment, and refuses a different one", async () => {
    const { id, token } = await draft();
    const auth = { Authorization: `Bearer ${token}` };
    await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
      headers: auth,
      body: { commitment: C1 },
    });
    expect(
      (
        await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
          headers: auth,
          body: { commitment: C1 },
        })
      ).status,
    ).toBe(200);
    const other = await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
      headers: auth,
      body: { commitment: C2 },
    });
    expect(other.status).toBe(409);
    expect(field(other.body, "error.message")).toMatch(/different commitment/);
  });

  it("also works with the merchant's own API key", async () => {
    const { id } = await draft();
    expect(
      (
        await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
          key,
          body: { commitment: C1 },
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a wrong token, another session's token, a missing token and another merchant's key", async () => {
    const a = await draft();
    const b = await draft();
    const attach = (id: string, headers: Record<string, string>) =>
      t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
        headers,
        body: { commitment: C1 },
      });
    expect((await attach(a.id, { Authorization: "Bearer at_wrong" })).status).toBe(403);
    expect((await attach(a.id, { Authorization: `Bearer ${b.token}` })).status).toBe(403);
    expect((await attach(a.id, {})).status).toBe(403);
    const other = await t.register("Other", "https://hooks.example.com/o");
    expect((await attach(a.id, { Authorization: `Bearer ${other.key}` })).status).toBe(404);
    expect(t.app.deps.store.getSession(a.id)?.commitment).toBeNull();
  });

  it("refuses a commitment that already belongs to another session", async () => {
    await t.call("POST", "/v1/checkout/sessions", { key, body: { commitment: C1 } });
    const { id, token } = await draft();
    const reply = await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { commitment: C1 },
    });
    expect(reply.status).toBe(409);
    expect(t.app.deps.store.getSession(id)?.status).toBe("draft");
  });

  it("refuses to attach to a draft that has expired", async () => {
    const { id, token } = await draft();
    t.clock.advance(3_600_001);
    const reply = await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { commitment: C1 },
    });
    expect(reply.status).toBe(409);
    expect(field(reply.body, "error.message")).toMatch(/expired/);
  });

  it("validates the commitment and 404s an unknown session", async () => {
    const { id, token } = await draft();
    expect(
      (
        await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
          headers: { Authorization: `Bearer ${token}` },
          body: { commitment: "nope" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call("POST", "/v1/checkout/sessions/cs_missing/commitment", {
          key,
          body: { commitment: C1 },
        })
      ).status,
    ).toBe(404);
  });

  it("starts the watcher on the attached invoice", async () => {
    const { id, token } = await draft();
    await t.call("POST", `/v1/checkout/sessions/${id}/commitment`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { commitment: C1 },
    });
    t.chain.open(C1, { status: "settled" as never, contributions: 1 });
    await t.app.deps.watcher.tick();
    expect(t.app.deps.store.getSession(id)?.status).toBe("settled");
    expect(t.app.deps.store.listEvents(0, 10, [merchantId]).map((e) => e.type)).toEqual([
      "invoice.payment_received",
      "invoice.settled",
    ]);
  });
});

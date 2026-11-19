import { decodePaymentLink } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { Kinko, KinkoApiError, WaitTimeoutError } from "../src/index.ts";
import { Asset, InvoiceKind, SessionStatus } from "../src/types.ts";
import { signWebhookBody } from "../src/webhooks.ts";
import { PAYOUT_ADDRESS, PAYOUT_COIN } from "./payout.ts";

/** An asymmetric matcher for a string containing `text`, typed so it can sit inside an expected object. */
const containing = (text: string): string => expect.stringContaining(text) as string;

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

type Answer = Response | Error | ((seen: Seen) => Response | Error);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response => json(status, { error: { code, message, ...extra }, requestId: "req_abc12345" });

/** A fetch that answers from a queue and records what it was asked. */
const fakeFetch = (...answers: Answer[]) => {
  const seen: Seen[] = [];
  let i = 0;
  const impl = ((input: URL | string, init?: RequestInit): Promise<Response> => {
    const request: Seen = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    };
    seen.push(request);
    const answer = answers[Math.min(i++, answers.length - 1)];
    const resolved = typeof answer === "function" ? answer(request) : answer;
    return resolved instanceof Error
      ? Promise.reject(resolved)
      : Promise.resolve((resolved ?? json(200, {})).clone());
  }) as typeof fetch;
  return { impl, seen };
};

const SESSION = {
  id: "cs_1",
  status: "pending",
  commitment: "ab".repeat(32),
  kind: "standard",
  asset: "KUSD",
  title: null,
  memo: null,
  amount: null,
  clientReference: null,
  successUrl: null,
  cancelUrl: null,
  createdAt: "2027-01-15T12:00:00.000Z",
  expiresAt: "2027-01-15T13:00:00.000Z",
  settledAt: null,
  contributions: 0,
  onChain: false,
  late: false,
  checkoutUrl: "https://app.kinko.example/checkout?session=cs_1",
};
const CONFIG = {
  contractAddress: "cd".repeat(32),
  appUrl: "https://app.kinko.example",
  payPath: "/pay",
  checkoutPath: "/checkout",
  oracle: true,
  assistant: false,
};
const KEY = `kk_${"A".repeat(43)}`;
const MERCHANT = { merchantKey: "11".repeat(32), payoutAddress: PAYOUT_ADDRESS };

const make = (
  fetchImpl: typeof fetch,
  over: Partial<ConstructorParameters<typeof Kinko>[0]> = {},
) =>
  new Kinko({
    apiKey: KEY,
    baseUrl: "https://api.kinko.example/",
    merchant: MERCHANT,
    fetch: fetchImpl,
    retries: 2,
    ...over,
  });

describe("construction", () => {
  it("refuses a key that is not a Kinko key, and a base URL that is not a URL", () => {
    expect(() => new Kinko({ apiKey: "sk_live_123", baseUrl: "https://x.example" })).toThrow(
      /starts with kk_/,
    );
    expect(() => new Kinko({ apiKey: KEY, baseUrl: "not a url" })).toThrow(/absolute URL/);
    expect(() => new Kinko({ apiKey: KEY, baseUrl: "ftp://x.example" })).toThrow(/http\(s\)/);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const f = fakeFetch(json(200, { session: SESSION }));
    await make(f.impl).checkout.sessions.retrieve("cs_1");
    expect(f.seen[0]?.url.href).toBe("https://api.kinko.example/v1/checkout/sessions/cs_1");
  });
});

describe("checkout.sessions", () => {
  it("creates a session, mapping the asset to the API's field, and sends the key", async () => {
    const f = fakeFetch(json(201, { session: SESSION, attachToken: null }));
    const session = await make(f.impl).checkout.sessions.create({
      commitment: "ab".repeat(32),
      kind: InvoiceKind.MULTIPAY,
      asset: Asset.NATIVE,
      title: "T",
      memo: "M",
      clientReference: "R",
      successUrl: "https://s.example",
      cancelUrl: "https://c.example",
      ttlSeconds: 600,
    });
    expect(session).toEqual(SESSION);
    expect(f.seen[0]).toMatchObject({ method: "POST" });
    expect(f.seen[0]?.url.pathname).toBe("/v1/checkout/sessions");
    expect(f.seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(f.seen[0]?.body).toEqual({
      commitment: "ab".repeat(32),
      kind: "multipay",
      token: "NATIVE",
      title: "T",
      memo: "M",
      clientReference: "R",
      successUrl: "https://s.example",
      cancelUrl: "https://c.example",
      ttlSeconds: 600,
    });
  });

  it("sends nothing it was not given", async () => {
    const f = fakeFetch(json(201, { session: SESSION, attachToken: null }));
    await make(f.impl).checkout.sessions.create({ commitment: "ab".repeat(32) });
    expect(f.seen[0]?.body).toEqual({ commitment: "ab".repeat(32) });
  });

  it("returns the one-time attach token on a draft", async () => {
    const f = fakeFetch(
      json(201, {
        session: { ...SESSION, status: "draft", commitment: null },
        attachToken: "at_secret",
      }),
    );
    const draft = await make(f.impl).checkout.sessions.create({ title: "Draft" });
    expect(draft).toMatchObject({ status: "draft", attachToken: "at_secret" });
  });

  it("starts a draft whose invoice the merchant's wallet creates, and returns where to finish it", async () => {
    const formUrl = "https://app.kinko.example/app/invoices#session=cs_1&attach=at_secret";
    const f = fakeFetch(
      json(201, {
        session: { ...SESSION, status: "draft", commitment: null },
        attachToken: "at_secret",
        formUrl,
      }),
    );
    const draft = await make(f.impl).checkout.drafts.create({
      title: "Logo",
      kind: InvoiceKind.DONATION,
      asset: Asset.KUSD,
    });
    expect(draft).toMatchObject({
      attachToken: "at_secret",
      formUrl,
      session: { status: "draft", commitment: null },
    });
    expect(draft.session).not.toHaveProperty("attachToken");
    expect(f.seen[0]?.body).toEqual({ kind: "donation", token: "KUSD", title: "Logo" });
  });

  it("refuses to pretend a draft was made when the backend sent no attach token", async () => {
    const f = fakeFetch(json(201, { session: SESSION, attachToken: null }));
    await expect(make(f.impl).checkout.drafts.create({})).rejects.toThrow(/did not return a draft/);
  });

  it("sends a display amount only when asked", async () => {
    const f = fakeFetch(json(201, { session: SESSION, attachToken: null }));
    await make(f.impl).checkout.sessions.create({
      commitment: "ab".repeat(32),
      displayAmount: 42_500n,
    });
    expect((f.seen[0]?.body as Record<string, unknown>).amount).toBe("42500");
  });

  it("retrieves, lists with a query, and attaches", async () => {
    const f = fakeFetch(
      json(200, { session: SESSION }),
      json(200, { data: [SESSION], nextCursor: "7" }),
      json(200, { session: SESSION }),
    );
    const kinko = make(f.impl);
    expect(await kinko.checkout.sessions.retrieve("cs_1")).toEqual(SESSION);
    expect(
      await kinko.checkout.sessions.list({ status: SessionStatus.PENDING, limit: 5, before: "9" }),
    ).toEqual({ data: [SESSION], nextCursor: "7" });
    expect(f.seen[1]?.url.search).toBe("?status=pending&limit=5&before=9");
    await kinko.checkout.sessions.attach("cs_1", "ab".repeat(32));
    expect(f.seen[2]).toMatchObject({ method: "POST", body: { commitment: "ab".repeat(32) } });
    expect(f.seen[2]?.url.pathname).toBe("/v1/checkout/sessions/cs_1/commitment");
  });

  it("encodes a session id in the path", async () => {
    const f = fakeFetch(json(200, { session: SESSION }));
    await make(f.impl).checkout.sessions.retrieve("a/b c");
    expect(f.seen[0]?.url.pathname).toBe("/v1/checkout/sessions/a%2Fb%20c");
  });

  it("reads the public view without sending the key", async () => {
    const f = fakeFetch(json(200, { session: { id: "cs_1", merchantName: "Acme" } }));
    await make(f.impl).checkout.sessions.publicView("cs_1");
    expect(f.seen[0]?.headers.get("authorization")).toBeNull();
  });
});

describe("checkout.create", () => {
  const ready = (f: ReturnType<typeof fakeFetch>) => make(f.impl);

  it("builds the invoice locally and sends the backend only the commitment and what was chosen", async () => {
    const f = fakeFetch(json(200, CONFIG), json(201, { session: SESSION, attachToken: null }));
    const checkout = await ready(f).checkout.create({
      amount: 42_500n,
      title: "Invoice 12",
      clientReference: "order-9",
    });
    const sent = f.seen[1]?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      commitment: checkout.invoice.commitment,
      kind: "standard",
      token: "KUSD",
      title: "Invoice 12",
      clientReference: "order-9",
    });
    // Everything the payer needs stays here: nothing of the terms, the keys or the salt reaches the backend.
    const wire = JSON.stringify(f.seen.map((s) => s.body));
    for (const secret of [
      checkout.invoice.salt,
      checkout.invoice.ownerSecret,
      MERCHANT.merchantKey,
      PAYOUT_COIN,
      checkout.invoice.linkPayload,
      "42500",
    ])
      expect(wire).not.toContain(secret);
    expect(sent.amount).toBeUndefined();
  });

  it("hands back a hosted checkout URL whose fragment carries the terms the payer needs", async () => {
    const f = fakeFetch(json(200, CONFIG), json(201, { session: SESSION, attachToken: null }));
    const checkout = await ready(f).checkout.create({ amount: 42_500n });
    const url = new URL(checkout.checkoutUrl);
    expect(url.origin + url.pathname + url.search).toBe(
      "https://app.kinko.example/checkout?session=cs_1",
    );
    expect(decodePaymentLink(url.hash)?.terms.amount).toBe(42_500n);
    expect(decodePaymentLink(checkout.paymentLink)?.terms.amount).toBe(42_500n);
  });

  it("stores a display amount only when the merchant opts in", async () => {
    const f = fakeFetch(json(200, CONFIG), json(201, { session: SESSION, attachToken: null }));
    await ready(f).checkout.create({ amount: 42_500n, storeAmount: true });
    expect((f.seen[1]?.body as Record<string, unknown>).amount).toBe("42500");
  });

  it("matches the session lifetime to the invoice's expiry", async () => {
    const f = fakeFetch(json(200, CONFIG), json(201, { session: SESSION, attachToken: null }));
    await ready(f).checkout.create({ amount: 1n, expiresInSeconds: 900 });
    const ttl = (f.seen[1]?.body as { ttlSeconds: number }).ttlSeconds;
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it("asks the backend for its settings once, and not at all when given them", async () => {
    const f = fakeFetch(
      json(200, CONFIG),
      json(201, { session: SESSION, attachToken: null }),
      json(201, { session: SESSION, attachToken: null }),
    );
    const kinko = ready(f);
    await kinko.checkout.create({ amount: 1n });
    await kinko.checkout.create({ amount: 1n });
    expect(f.seen.filter((s) => s.url.pathname === "/v1/config")).toHaveLength(1);
    expect(
      f.seen.find((s) => s.url.pathname === "/v1/config")?.headers.get("authorization"),
    ).toBeNull();

    const offline = fakeFetch(json(201, { session: SESSION, attachToken: null }));
    await make(offline.impl, {
      contractAddress: "cd".repeat(32),
      appUrl: "https://app.kinko.example",
    }).checkout.create({ amount: 1n });
    expect(offline.seen.map((s) => s.url.pathname)).toEqual(["/v1/checkout/sessions"]);
  });

  it("retries a failed settings fetch next time instead of caching the failure", async () => {
    const f = fakeFetch(
      fail(500, "internal_error", "boom"),
      json(200, CONFIG),
      json(201, { session: SESSION, attachToken: null }),
    );
    const kinko = ready(f);
    await expect(kinko.checkout.create({ amount: 1n })).rejects.toBeInstanceOf(KinkoApiError);
    await expect(kinko.checkout.create({ amount: 1n })).resolves.toBeDefined();
  });

  it("will not build an invoice without merchant keys, and says what to pass", async () => {
    const f = fakeFetch(json(200, CONFIG));
    await expect(
      new Kinko({ apiKey: KEY, baseUrl: "https://x.example", fetch: f.impl }).invoices.create({
        amount: 1n,
      }),
    ).rejects.toThrow(/merchant: \{ merchantKey, payoutAddress \}/);
  });

  it("does not create a session when the invoice is invalid", async () => {
    const f = fakeFetch(json(200, CONFIG));
    await expect(ready(f).checkout.create({ amount: 0n })).rejects.toBeInstanceOf(RangeError);
    expect(f.seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
});

describe("errors", () => {
  it("surfaces the backend's code, message, details and request id", async () => {
    const f = fakeFetch(
      fail(400, "invalid_request", "Invalid checkout session. amount: bad", {
        details: [{ path: "amount", message: "bad" }],
      }),
    );
    const error = await make(f.impl)
      .checkout.sessions.create({ commitment: "x" })
      .catch((e: unknown) => e as KinkoApiError);
    expect(error).toBeInstanceOf(KinkoApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "Invalid checkout session. amount: bad",
      details: [{ path: "amount", message: "bad" }],
      requestId: "req_abc12345",
    });
  });

  it("copes with an error that is not JSON", async () => {
    const f = fakeFetch(new Response("<html>Bad gateway</html>", { status: 400 }));
    const error = await make(f.impl)
      .checkout.sessions.retrieve("cs_1")
      .catch((e: unknown) => e as KinkoApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "http_error",
      message: containing("Bad gateway"),
    });
  });

  it("does not retry a write", async () => {
    const f = fakeFetch(
      fail(503, "unavailable", "down"),
      json(201, { session: SESSION, attachToken: null }),
    );
    await expect(
      make(f.impl).checkout.sessions.create({ commitment: "ab".repeat(32) }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.seen).toHaveLength(1);
  });

  it("retries a read after 502 to 504 and after a network error", async () => {
    const f = fakeFetch(
      fail(502, "x", "bad gateway"),
      new Error("ECONNRESET"),
      json(200, { session: SESSION }),
    );
    expect(await make(f.impl).checkout.sessions.retrieve("cs_1")).toEqual(SESSION);
    expect(f.seen).toHaveLength(3);
  });

  it("does not retry a read that failed for a reason retrying cannot fix", async () => {
    const f = fakeFetch(fail(404, "not_found", "no such session"), json(200, { session: SESSION }));
    await expect(make(f.impl).checkout.sessions.retrieve("cs_1")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(f.seen).toHaveLength(1);
  });

  it("gives up after the retries and reports a network failure as one", async () => {
    const f = fakeFetch(new Error("ECONNREFUSED"));
    const error = await make(f.impl, { retries: 1 })
      .checkout.sessions.retrieve("cs_1")
      .catch((e: unknown) => e as KinkoApiError);
    expect(error).toMatchObject({
      status: 0,
      code: "network_error",
      message: containing("ECONNREFUSED"),
    });
    expect(f.seen).toHaveLength(2);
  });

  it("reports a slow backend as a timeout", async () => {
    const slow = ((_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init?.signal?.addEventListener("abort", () => {
          // Rejects with the signal's own reason, as a real fetch does: a TimeoutError here.
          const reason: unknown = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        }),
      )) as typeof fetch;
    const error = await make(slow, { timeoutMs: 30, retries: 0 })
      .checkout.sessions.retrieve("cs_1")
      .catch((e: unknown) => e as KinkoApiError);
    expect(error).toMatchObject({ status: 0, code: "timeout" });
  });
});

describe("waitForSettlement", () => {
  const at = (status: string, extra: Record<string, unknown> = {}) =>
    json(200, { session: { ...SESSION, status, ...extra } });

  it("polls until the session settles", async () => {
    const f = fakeFetch(at("pending"), at("pending"), at("settled", { contributions: 1 }));
    const seen: string[] = [];
    const session = await make(f.impl).checkout.sessions.waitForSettlement("cs_1", {
      intervalMs: 5,
      onPoll: (s) => seen.push(s.status),
    });
    expect(session).toMatchObject({ status: "settled", contributions: 1 });
    expect(seen).toEqual(["pending", "pending", "settled"]);
  });

  it.each(["cancelled", "expired"])("stops at %s too", async (status) => {
    const f = fakeFetch(at("pending"), at(status));
    expect(
      (await make(f.impl).checkout.sessions.waitForSettlement("cs_1", { intervalMs: 5 })).status,
    ).toBe(status);
  });

  it("times out with the last reading", async () => {
    const f = fakeFetch(at("pending"));
    const error = await make(f.impl)
      .checkout.sessions.waitForSettlement("cs_1", { intervalMs: 10, timeoutMs: 40 })
      .catch((e: unknown) => e as WaitTimeoutError);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).session.status).toBe("pending");
  });

  it("can be cancelled", async () => {
    const f = fakeFetch(at("pending"));
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error("stop"));
    }, 20);
    await expect(
      make(f.impl).checkout.sessions.waitForSettlement("cs_1", {
        intervalMs: 500,
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop");
  });
});

describe("telegram", () => {
  it("asks for a link code, lists linked chats and unlinks one, all with the API key", async () => {
    const f = fakeFetch(
      json(201, { code: "K7QM-4XD2-9PTV", expiresAt: "2027-01-15T12:15:00.000Z" }),
      json(200, { chats: [{ chatId: -1001, linkedAt: "2027-01-15T12:00:00.000Z" }] }),
      new Response(null, { status: 204 }),
    );
    const kinko = make(f.impl);
    expect(await kinko.telegram.linkCode()).toEqual({
      code: "K7QM-4XD2-9PTV",
      expiresAt: "2027-01-15T12:15:00.000Z",
    });
    expect(await kinko.telegram.chats()).toEqual([
      { chatId: -1001, linkedAt: "2027-01-15T12:00:00.000Z" },
    ]);
    await expect(kinko.telegram.unlink(-1001)).resolves.toBeUndefined();
    expect(f.seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
      "POST /v1/merchant/telegram/link-codes",
      "GET /v1/merchant/telegram",
      "DELETE /v1/merchant/telegram/-1001",
    ]);
    for (const s of f.seen) expect(s.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("reports an unlink the backend refuses", async () => {
    const f = fakeFetch(fail(404, "not_found", "That chat is not linked to your account."));
    await expect(make(f.impl).telegram.unlink(5)).rejects.toMatchObject({ status: 404 });
  });
});

describe("chain, oracle, registration and webhooks", () => {
  it("reads an invoice's public status without a key", async () => {
    const report = {
      commitment: "ab".repeat(32),
      found: true,
      status: "settled",
      kind: "standard",
      asset: "KUSD",
      expiresAt: null,
      contributions: 1,
    };
    const f = fakeFetch(json(200, report));
    expect(await make(f.impl).chain.invoiceStatus("ab".repeat(32))).toEqual(report);
    expect(f.seen[0]?.headers.get("authorization")).toBeNull();
  });

  it("asks the oracle for a quote and sends base units as a string", async () => {
    const quote = {
      baseAmount: "100",
      convertedAmount: "9",
      fromToken: "NATIVE",
      toToken: "KUSD",
      expiresAt: "1800000120",
      signature: { announcement: { x: "1", y: "2" }, response: "3" },
      publicKey: { x: "4", y: "5" },
    };
    const f = fakeFetch(json(200, { quote }));
    expect(
      await make(f.impl).oracle.quote({ baseAmount: 100n, from: Asset.NATIVE, to: Asset.KUSD }),
    ).toEqual(quote);
    expect(f.seen[0]?.body).toEqual({ baseAmount: "100", fromToken: "NATIVE", toToken: "KUSD" });
  });

  it("registers a merchant, with the operator's token when there is one", async () => {
    const registration = {
      merchant: { id: "mer_1", name: "A", webhookUrl: null },
      apiKey: { id: "key_1", key: KEY },
      webhookSecret: "whsec_x",
    };
    const f = fakeFetch(json(201, registration));
    expect(
      await Kinko.register({
        baseUrl: "https://api.kinko.example",
        name: "A",
        registrationToken: "operator-token",
        fetch: f.impl,
      }),
    ).toEqual(registration);
    expect(f.seen[0]?.headers.get("x-registration-token")).toBe("operator-token");
    expect(f.seen[0]?.headers.get("authorization")).toBeNull();
    expect(f.seen[0]?.body).toEqual({ name: "A" });
  });

  it("verifies webhooks with the secret it was given, and refuses to guess one", () => {
    const body = '{"id":"evt_1","type":"invoice.settled","createdAt":"x","data":{}}';
    const kinko = make(fakeFetch().impl, { webhookSecret: "whsec_mine" });
    expect(kinko.webhooks.verify(body, signWebhookBody(body, "whsec_mine")).valid).toBe(true);
    expect(kinko.webhooks.verify(body, signWebhookBody(body, "whsec_other")).valid).toBe(false);
    expect(kinko.webhooks.constructEvent(body, signWebhookBody(body, "whsec_mine")).id).toBe(
      "evt_1",
    );
    expect(
      kinko.webhooks.verify(body, signWebhookBody(body, "whsec_override"), {
        secret: "whsec_override",
      }).valid,
    ).toBe(true);
    expect(() => make(fakeFetch().impl).webhooks.verify(body, "x")).toThrow(/No webhook secret/);
  });
});

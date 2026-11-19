import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInvoice, shieldedAddressFor, signWebhookBody } from "@kinko/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTool, type ToolContext, type ToolResult } from "../src/tools.ts";

const PAYOUT_ADDRESS = shieldedAddressFor(
  new Uint8Array(32).fill(0x12),
  new Uint8Array(32).fill(0x13),
  "undeployed",
);

/** An asymmetric matcher for a string containing `text`, typed so it can sit inside an expected object. */
const containing = (text: string): string => expect.stringContaining(text) as string;

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const scripted = (...answers: (Response | ((s: Seen) => Response))[]) => {
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
    const a = answers[Math.min(i++, answers.length - 1)];
    return Promise.resolve((typeof a === "function" ? a(request) : (a ?? json(200, {}))).clone());
  }) as typeof fetch;
  return { impl, seen };
};

const ID = `cs_${"1".repeat(32)}`;
const COMMITMENT = "ab".repeat(32);
const SESSION = {
  id: ID,
  status: "pending",
  commitment: COMMITMENT,
  kind: "standard",
  asset: "KUSD",
  title: "Invoice 12",
  memo: null,
  amount: null,
  clientReference: "order-9",
  successUrl: null,
  cancelUrl: null,
  createdAt: "2027-01-15T12:00:00.000Z",
  expiresAt: "2027-01-15T13:00:00.000Z",
  settledAt: null,
  contributions: 0,
  onChain: false,
  late: false,
  checkoutUrl: `https://app.kinko.example/checkout?session=${ID}`,
};
const CONFIG = {
  contractAddress: "cd".repeat(32),
  appUrl: "https://app.kinko.example",
  payPath: "/pay",
  checkoutPath: "/checkout",
  invoicePath: "/app/invoices",
  oracle: false,
  assistant: false,
};
const ENV = {
  KINKO_API_URL: "https://api.kinko.example",
  KINKO_API_KEY: `kk_${"A".repeat(43)}`,
  KINKO_MERCHANT_KEY: "11".repeat(32),
  KINKO_PAYOUT_ADDRESS: PAYOUT_ADDRESS,
  KINKO_WEBHOOK_SECRET: "whsec_mine",
};

/** The permission bits of a file, or the expected value on Windows, which has none. */
const modeOf = (path: string, expected: number): number =>
  process.platform === "win32" ? expected : statSync(path).mode & 0o777;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kinko-mcp-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ctx = (
  fetchImpl: typeof fetch | undefined,
  env: Record<string, string> = ENV,
  over: Partial<ToolContext> = {},
): ToolContext => ({
  env: { KINKO_HOME: home, ...env },
  now: () => Date.UTC(2027, 0, 15, 12, 0, 0),
  pollIntervalMs: 5,
  ...(fetchImpl ? { fetch: fetchImpl } : {}),
  ...over,
});

const call = async (name: string, args: unknown, c: ToolContext): Promise<ToolResult> => {
  const result = await runTool(name, args, c);
  if (!result) throw new Error(`no tool ${name}`);
  return result;
};

describe("kinko_create_invoice", () => {
  const ready = () =>
    scripted(json(200, CONFIG), json(201, { session: SESSION, attachToken: null }));

  it("returns the link for the payer and the facts, and keeps the secrets out of what the model sees", async () => {
    const f = ready();
    const r = await call(
      "kinko_create_invoice",
      { amount: "25.50", title: "Invoice 12", client_reference: "order-9", expires_in_minutes: 30 },
      ctx(f.impl),
    );
    expect(r.isError).toBeUndefined();
    const url = r.data?.checkoutUrl as string;
    expect(new URL(url).searchParams.get("session")).toBe(ID);
    expect(new URL(url).hash.length).toBeGreaterThan(20);
    expect(r.text).toContain(url);
    expect(r.text).toContain("25.50 KUSD");
    expect(r.text).toContain("cannot pay or publish");
    const [file] = readdirSync(join(home, "invoices"));
    const secrets = JSON.parse(readFileSync(join(home, "invoices", file ?? ""), "utf8")) as {
      ownerSecret: string;
      salt: string;
      amount: string;
    };
    expect(secrets.amount).toBe("25500000");
    expect(JSON.stringify(r)).not.toContain(secrets.ownerSecret);
    expect(JSON.stringify(r)).not.toContain(secrets.salt);
    expect(modeOf(join(home, "invoices", file ?? ""), 0o600)).toBe(0o600);
  });

  it("tells the backend only the commitment and what the merchant chose, never the amount", async () => {
    const f = ready();
    await call(
      "kinko_create_invoice",
      {
        amount: "25.50",
        title: "Invoice 12",
        memo: "Hello",
        kind: "multipay",
        asset: "NATIVE",
        expires_in_minutes: 30,
      },
      ctx(f.impl),
    );
    const sent = f.seen[1]?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      kind: "multipay",
      token: "NATIVE",
      title: "Invoice 12",
      memo: "Hello",
    });
    expect(sent.ttlSeconds).toBeGreaterThan(1_790);
    expect(JSON.stringify(f.seen.map((s) => s.body))).not.toMatch(/25500000|25\.50/);
  });

  it("stores the amount with the backend only when asked", async () => {
    const f = ready();
    await call("kinko_create_invoice", { amount: "25.50", store_amount: true }, ctx(f.impl));
    expect((f.seen[1]?.body as Record<string, unknown>).amount).toBe("25500000");
  });

  it.each([
    [{}, '"amount" is required'],
    [{ amount: 25 }, '"amount" must be a string'],
    [{ amount: "abc" }, "is not an amount"],
    [{ amount: "0" }, "greater than zero"],
    [{ amount: "1.0000001" }, "more than 6 decimal places"],
    [{ amount: "5", kind: "weekly" }, '"kind" must be one of'],
    [{ amount: "5", asset: "BTC" }, '"asset" must be one of'],
    [{ amount: "5", expires_in_minutes: 0 }, "at least 1"],
    [{ amount: "5", expires_in_minutes: 1.5 }, "whole number"],
    [{ amount: "5", surprise: true }, '"surprise" is not a known argument'],
    [{ amount: "5", store_amount: "yes" }, "true or false"],
  ])("refuses %j as an error the model can correct", async (args, message) => {
    const f = ready();
    const r = await call("kinko_create_invoice", args, ctx(f.impl));
    expect(r.isError).toBe(true);
    expect(r.text).toContain(message);
    expect(f.seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("names every missing setting rather than failing obscurely", async () => {
    const r = await call("kinko_create_invoice", { amount: "5" }, ctx(undefined, {}));
    expect(r.isError).toBe(true);
    for (const part of ["backend address", "API key", "merchant key", "payout address"])
      expect(r.text).toContain(part);
  });

  it("reports a backend refusal, with the backend's own words", async () => {
    const f = scripted(
      json(200, CONFIG),
      json(409, {
        error: {
          code: "conflict",
          message: "A checkout session already exists for this commitment.",
        },
        requestId: "req_1",
      }),
    );
    const r = await call("kinko_create_invoice", { amount: "5" }, ctx(f.impl));
    expect(r).toMatchObject({ isError: true, text: containing("already exists") });
  });

  it("will not leave secrets behind when the backend refused the session", async () => {
    const f = scripted(
      json(200, CONFIG),
      json(400, { error: { code: "invalid_request", message: "bad" } }),
    );
    await call("kinko_create_invoice", { amount: "5" }, ctx(f.impl));
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("kinko_create_draft", () => {
  it("returns the wallet address and needs no merchant keys or amount", async () => {
    const formUrl = "https://app.kinko.example/app/invoices#session=cs_1&attach=at_x";
    const f = scripted(
      json(201, {
        session: { ...SESSION, status: "draft", commitment: null },
        attachToken: "at_x",
        formUrl,
      }),
    );
    const r = await call(
      "kinko_create_draft",
      { title: "Logo" },
      ctx(f.impl, { KINKO_API_URL: ENV.KINKO_API_URL, KINKO_API_KEY: ENV.KINKO_API_KEY }),
    );
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(formUrl);
    expect(r.text).toContain("one-time token");
    expect(r.data).toMatchObject({ formUrl, sessionId: ID, status: "draft" });
    expect(f.seen).toHaveLength(1);
    expect(existsInvoices(home)).toBe(false);
  });
});

const existsInvoices = (dir: string): boolean => readdirSync(dir).includes("invoices");

describe("kinko_invoice_status", () => {
  const chain = {
    commitment: COMMITMENT,
    found: true,
    status: "settled",
    kind: "standard",
    asset: "KUSD",
    expiresAt: null,
    contributions: 1,
  };

  it("combines the session and the ledger, and says no amount is shown", async () => {
    const f = scripted(
      json(200, { session: { ...SESSION, status: "settled", contributions: 1 } }),
      json(200, chain),
    );
    const r = await call("kinko_invoice_status", { reference: ID }, ctx(f.impl));
    expect(r.text).toContain("settled");
    expect(r.text).toContain("On chain: settled, 1 contribution.");
    expect(r.text).toContain("No amount is shown");
    expect(r.data).toMatchObject({ session: { id: ID }, chain: { status: "settled" } });
  });

  it("reads a bare commitment from the chain alone, and calls an unseen one not published yet", async () => {
    const f = scripted(json(200, { ...chain, found: false, status: "unknown", contributions: 0 }));
    const r = await call(
      "kinko_invoice_status",
      { reference: `0x${COMMITMENT.toUpperCase()}` },
      ctx(f.impl),
    );
    expect(r.text).toContain("Not on chain yet");
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.url.pathname).toBe(`/v1/chain/invoices/${COMMITMENT}`);
  });

  it("refuses a reference that is neither", async () => {
    const r = await call("kinko_invoice_status", { reference: "my invoice" }, ctx(scripted().impl));
    expect(r).toMatchObject({ isError: true, text: containing("session id") });
  });
});

describe("kinko_list_invoices", () => {
  it("lists with a filter and a default page size", async () => {
    const f = scripted(json(200, { data: [SESSION], nextCursor: null }));
    const r = await call("kinko_list_invoices", { status: "pending" }, ctx(f.impl));
    expect(Object.fromEntries(f.seen[0]?.url.searchParams ?? [])).toEqual({
      limit: "10",
      status: "pending",
    });
    expect(r.text).toContain(ID);
    expect(r.text).toContain("Invoice 12");
  });

  it("says when there is nothing, and refuses a bad filter or size", async () => {
    expect(
      (
        await call(
          "kinko_list_invoices",
          {},
          ctx(scripted(json(200, { data: [], nextCursor: null })).impl),
        )
      ).text,
    ).toBe("No invoices.");
    expect(
      (await call("kinko_list_invoices", { status: "weird" }, ctx(scripted().impl))).isError,
    ).toBe(true);
    expect((await call("kinko_list_invoices", { limit: 500 }, ctx(scripted().impl))).isError).toBe(
      true,
    );
  });
});

describe("kinko_wait_for_payment", () => {
  it("returns as soon as the session is final", async () => {
    const f = scripted(
      json(200, { session: SESSION }),
      json(200, { session: { ...SESSION, status: "settled", contributions: 1 } }),
    );
    const r = await call("kinko_wait_for_payment", { session_id: ID }, ctx(f.impl));
    expect(r.text).toContain("settled");
    expect(r.text).toContain("This is final.");
    expect(r.data?.final).toBe(true);
  });

  it("gives up politely after the time, so the model can call again, and never blocks past the cap", async () => {
    const f = scripted(json(200, { session: SESSION }));
    const started = Date.now();
    const r = await call(
      "kinko_wait_for_payment",
      { session_id: ID, timeout_seconds: 55 },
      ctx(f.impl, ENV, { maxWaitMs: 60 }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.text).toContain("Still waiting");
    expect(r.text).toContain("Call again");
    expect(r.data?.final).toBe(false);
  });

  it("validates the id and the timeout", async () => {
    for (const args of [
      {},
      { session_id: "nope" },
      { session_id: ID, timeout_seconds: 0 },
      { session_id: ID, timeout_seconds: 56 },
    ]) {
      expect((await call("kinko_wait_for_payment", args, ctx(scripted().impl))).isError).toBe(true);
    }
  });
});

describe("kinko_decode_payment_link", () => {
  it("reads a link offline", async () => {
    const invoice = buildInvoice(
      { merchantKey: "11".repeat(32), payoutAddress: PAYOUT_ADDRESS },
      { amount: 25_500_000n },
      { contractAddress: "cd".repeat(32), appUrl: "https://app.kinko.example" },
    );
    const r = await call(
      "kinko_decode_payment_link",
      { link: invoice.paymentLink },
      ctx(undefined, {}),
    );
    expect(r.text).toContain("25.50 KUSD, standard, no expiry");
    expect(r.data).toMatchObject({ amount: "25500000", commitment: invoice.commitment });
  });

  it("says plainly when it is not a link", async () => {
    expect(
      await call("kinko_decode_payment_link", { link: "hello" }, ctx(undefined, {})),
    ).toMatchObject({ isError: true });
  });
});

describe("kinko_verify_webhook", () => {
  const body = '{"id":"evt_1","type":"invoice.settled","createdAt":"x","data":{}}';
  const now = Date.UTC(2027, 0, 15, 12, 0, 0);

  it("accepts a genuine delivery, and refuses a forged, altered or stale one", async () => {
    const c = ctx(undefined);
    expect(
      (
        await call(
          "kinko_verify_webhook",
          { body, signature_header: signWebhookBody(body, "whsec_mine", now) },
          c,
        )
      ).data,
    ).toEqual({ valid: true });
    expect(
      (
        await call(
          "kinko_verify_webhook",
          { body, signature_header: signWebhookBody(body, "whsec_other", now) },
          c,
        )
      ).text,
    ).toContain("wrong secret");
    expect(
      (
        await call(
          "kinko_verify_webhook",
          {
            body: body.replace("evt_1", "evt_2"),
            signature_header: signWebhookBody(body, "whsec_mine", now),
          },
          c,
        )
      ).data,
    ).toMatchObject({ valid: false });
    expect(
      (
        await call(
          "kinko_verify_webhook",
          { body, signature_header: signWebhookBody(body, "whsec_mine", now - 3_600_000) },
          c,
        )
      ).text,
    ).toContain("replay");
    expect(
      (await call("kinko_verify_webhook", { body, signature_header: "garbage" }, c)).text,
    ).toContain("malformed");
  });

  it("needs a configured secret", async () => {
    const r = await call(
      "kinko_verify_webhook",
      { body, signature_header: signWebhookBody(body, "x", now) },
      ctx(undefined, { KINKO_API_URL: "https://x" }),
    );
    expect(r).toMatchObject({
      isError: true,
      text: containing("KINKO_WEBHOOK_SECRET"),
    });
  });
});

describe("any tool", () => {
  it("returns undefined for a tool that does not exist", async () => {
    expect(await runTool("nope", {}, ctx(undefined))).toBeUndefined();
  });

  it("treats null or missing arguments as an empty object", async () => {
    expect(
      (
        await call(
          "kinko_list_invoices",
          null,
          ctx(scripted(json(200, { data: [], nextCursor: null })).impl),
        )
      ).isError,
    ).toBeUndefined();
    expect(
      (
        await call(
          "kinko_list_invoices",
          undefined,
          ctx(scripted(json(200, { data: [], nextCursor: null })).impl),
        )
      ).isError,
    ).toBeUndefined();
    expect((await call("kinko_list_invoices", [1], ctx(undefined))).isError).toBe(true);
  });
});

// The SDK, the CLI, the MCP server and the bot, each driven against the real
// backend on a real contract. Their own packages test them against scripted
// backends; this is where they meet the actual one, and where an invoice built
// by the SDK is published on the compiled contract to prove its commitment is
// the one the ledger holds.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpBackend } from "@kinko/bot/backend";
import { KinkoBot } from "@kinko/bot/bot";
import { Notifier } from "@kinko/bot/notifier";
import { MemoryCursorStore } from "@kinko/bot/state";
import { runCli } from "@kinko/cli/cli";
import { fromHex as bytesOf, shieldedAddressFor } from "@kinko/kinko-pay";
import { runTool } from "@kinko/mcp";
import {
  Asset,
  ChainStatus,
  InvoiceKind,
  Kinko,
  type KinkoApiError,
  parseAmount,
  SessionStatus,
} from "@kinko/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { containing, matching } from "./support/fixtures.ts";
import { asTestInvoice, BOT_TOKEN, type LiveApp, startLiveApp } from "./support/live.ts";

const PAYOUT_COIN = "12".repeat(32);
const PAYOUT_ADDRESS = shieldedAddressFor(
  bytesOf(PAYOUT_COIN),
  bytesOf("13".repeat(32)),
  "undeployed",
);
const MERCHANT = { merchantKey: "11".repeat(32), payoutAddress: PAYOUT_ADDRESS };

let live: LiveApp;
beforeEach(async () => {
  live = await startLiveApp();
});
afterEach(async () => {
  await live.stop();
});

const register = async (
  name = "Acme Studio",
): Promise<{ kinko: Kinko; key: string; secret: string; merchantId: string }> => {
  const registration = await Kinko.register({
    baseUrl: live.base,
    name,
    webhookUrl: "https://hooks.example.com/kinko",
  });
  return {
    kinko: new Kinko({
      apiKey: registration.apiKey.key,
      baseUrl: live.base,
      merchant: MERCHANT,
      webhookSecret: registration.webhookSecret,
      now: () => live.clock.now,
    }),
    key: registration.apiKey.key,
    secret: registration.webhookSecret,
    merchantId: registration.merchant.id,
  };
};

describe("@kinko/node against the real backend", () => {
  it("builds an invoice whose commitment is the one the compiled contract stores, then follows it to payment and verifies the webhook", async () => {
    const { kinko, secret } = await register();
    const checkout = await kinko.checkout.create({
      amount: parseAmount("25.50"),
      title: "Invoice 12",
      clientReference: "order-9",
      expiresInSeconds: 3_600,
    });

    // The backend knows a commitment and a title, and nothing else about the invoice.
    expect(checkout.session).toMatchObject({
      status: "pending",
      commitment: checkout.invoice.commitment,
      title: "Invoice 12",
      amount: null,
    });
    expect(await kinko.chain.invoiceStatus(checkout.invoice.commitment)).toMatchObject({
      found: false,
      status: ChainStatus.UNKNOWN,
    });

    // The merchant's wallet publishes it. The contract computes the commitment itself from the same
    // terms, so equality here is the SDK and the contract agreeing.
    await live.sim.create(asTestInvoice(checkout.invoice));
    live.clock.now += 3_000; // past the read cache
    expect(await kinko.chain.invoiceStatus(checkout.invoice.commitment)).toMatchObject({
      found: true,
      status: ChainStatus.OPEN,
      kind: InvoiceKind.STANDARD,
      asset: Asset.KUSD,
      contributions: 0,
    });
    expect(checkout.invoice.expiresAt).toBe(Number(live.sim.now) + 3_600);

    await live.sim.pay(asTestInvoice(checkout.invoice));
    await live.app.deps.watcher.tick();
    const settled = await kinko.checkout.sessions.waitForSettlement(checkout.session.id, {
      intervalMs: 5,
      timeoutMs: 2_000,
    });
    expect(settled).toMatchObject({ status: SessionStatus.SETTLED, contributions: 1, late: false });

    await live.app.deps.dispatcher.tick();
    const delivery = live.deliverer.requests.find(
      (r) => r.headers["Kinko-Event-Type"] === "invoice.settled",
    );
    expect(delivery).toBeDefined();
    const event = kinko.webhooks.constructEvent(
      delivery?.body ?? "",
      delivery?.headers["Kinko-Signature"],
      { now: live.app.deps.clock },
    );
    expect(event).toMatchObject({
      type: "invoice.settled",
      data: {
        sessionId: checkout.session.id,
        commitment: checkout.invoice.commitment,
        clientReference: "order-9",
        title: "Invoice 12",
      },
    });
    expect(
      kinko.webhooks.verify(delivery?.body ?? "", delivery?.headers["Kinko-Signature"], {
        secret: `${secret}x`,
        now: live.app.deps.clock,
      }).valid,
    ).toBe(false);
    expect(delivery?.body).not.toMatch(/25500000|25\.5/);
  });

  it("works for a multipay invoice in NIGHT, and for a donation", async () => {
    const { kinko } = await register();
    for (const [kind, asset] of [
      [InvoiceKind.MULTIPAY, Asset.NATIVE],
      [InvoiceKind.DONATION, Asset.KUSD],
    ] as const) {
      const checkout = await kinko.checkout.create({ amount: 1_000_000n, kind, asset });
      await live.sim.create(asTestInvoice(checkout.invoice));
      live.clock.now += 3_000;
      expect(await kinko.chain.invoiceStatus(checkout.invoice.commitment)).toMatchObject({
        found: true,
        kind,
        asset,
      });
      expect(checkout.session).toMatchObject({ kind, asset });
    }
  });

  it("finishes a draft: attaches the commitment of an invoice the wallet created", async () => {
    const { kinko } = await register();
    const draft = await kinko.checkout.drafts.create({ title: "Retainer" });
    const fragment = new URLSearchParams(new URL(draft.formUrl).hash.slice(1));
    expect(fragment.get("attach")).toBe(draft.attachToken);
    const built = await kinko.invoices.create({ amount: 5_000_000n });
    await live.sim.create(asTestInvoice(built));
    // What the web app does, holding only the token from the fragment.
    const attached = await fetch(
      `${live.base}/v1/checkout/sessions/${draft.session.id}/commitment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${draft.attachToken}`,
        },
        body: JSON.stringify({ commitment: built.commitment }),
      },
    );
    expect(attached.status).toBe(200);
    await live.sim.pay(asTestInvoice(built));
    await live.app.deps.watcher.tick();
    expect((await kinko.checkout.sessions.retrieve(draft.session.id)).status).toBe(
      SessionStatus.SETTLED,
    );
  });

  it("gets a signed quote the contract accepts, for paying a NIGHT invoice in KUSD", async () => {
    const { kinko } = await register();
    const invoice = await kinko.invoices.create({ amount: 1_000_000n, asset: Asset.NATIVE });
    await live.sim.create(asTestInvoice(invoice));
    const quote = await kinko.oracle.quote({
      baseAmount: invoice.amount,
      from: Asset.NATIVE,
      to: Asset.KUSD,
    });
    expect(quote.convertedAmount).toBe("100000");
    const { KinkoPay } = await import("@kinko/kinko-pay");
    await expect(
      live.sim.payConverted(
        asTestInvoice(invoice),
        { token: KinkoPay.TokenKind.KUSD, value: BigInt(quote.convertedAmount) },
        {
          expiresAt: BigInt(quote.expiresAt),
          signature: {
            announcement: {
              x: BigInt(quote.signature.announcement.x),
              y: BigInt(quote.signature.announcement.y),
            },
            response: BigInt(quote.signature.response),
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("raises typed errors for what the backend refuses", async () => {
    const { kinko, key } = await register();
    const first = await kinko.checkout.sessions.create({ commitment: "ab".repeat(32) });
    expect(first.commitment).toBe("ab".repeat(32));
    const duplicate = await kinko.checkout.sessions
      .create({ commitment: "ab".repeat(32) })
      .catch((e: unknown) => e as KinkoApiError);
    expect(duplicate).toMatchObject({
      status: 409,
      code: "conflict",
      details: { sessionId: first.id },
    });
    const invalid = await kinko.checkout.sessions
      .create({ commitment: "short" })
      .catch((e: unknown) => e as KinkoApiError);
    expect(invalid).toMatchObject({
      status: 400,
      code: "invalid_request",
      requestId: matching(/^req_/),
    });
    const stranger = new Kinko({ apiKey: `${key.slice(0, -1)}x`, baseUrl: live.base });
    await expect(stranger.checkout.sessions.list()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await expect(kinko.checkout.sessions.retrieve("cs_missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("pages through sessions with the cursor", async () => {
    const { kinko } = await register();
    for (let i = 1; i <= 5; i++)
      await kinko.checkout.sessions.create({
        commitment: String(i).repeat(64),
        title: `n${String(i)}`,
      });
    const first = await kinko.checkout.sessions.list({ limit: 2 });
    expect(first.data.map((s) => s.title)).toEqual(["n5", "n4"]);
    const second = await kinko.checkout.sessions.list({ limit: 2, before: first.nextCursor ?? "" });
    expect(second.data.map((s) => s.title)).toEqual(["n3", "n2"]);
  });

  it("registers through the operator's token when the backend requires one", async () => {
    const restricted = await startLiveApp({ KINKO_REGISTRATION_TOKEN: "operator-token-1234" });
    try {
      await expect(Kinko.register({ baseUrl: restricted.base, name: "A" })).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        Kinko.register({
          baseUrl: restricted.base,
          name: "A",
          registrationToken: "operator-token-1234",
        }),
      ).resolves.toMatchObject({ merchant: { name: "A" } });
    } finally {
      await restricted.stop();
    }
  });
});

describe("@kinko/cli against the real backend", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kinko-live-cli-"));
    cwd = join(home, "project");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const cli = async (argv: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cwd, { recursive: true });
    const code = await runCli(argv, {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      env: { KINKO_HOME: home, KINKO_API_URL: live.base, ...env },
      cwd,
      now: () => live.clock.now,
      pollIntervalMs: 5,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("registers, makes a link, writes a manifest, and waits for the payment", async () => {
    const registered = await cli(["register", "--name", "Acme", "--save", "--json"]);
    expect(registered.code).toBe(0);
    const keygen = await cli(["keygen", "--save"]);
    expect(keygen.code).toBe(0);
    await cli(["config"], {});
    // The payout address comes from the wallet; here a stand-in.
    const { saveSettings } = await import("@kinko/node");
    await saveSettings({ KINKO_HOME: home }, { payoutAddress: PAYOUT_ADDRESS });

    const made = await cli([
      "link",
      "25.50",
      "--title",
      "Invoice 12",
      "--ref",
      "order-9",
      "--name",
      "invoice-12",
      "--json",
    ]);
    expect(made.code).toBe(0);
    const result = JSON.parse(made.out) as {
      session: { id: string; commitment: string };
      invoice: {
        commitment: string;
        amount: string;
        merchantKey: string;
        payoutKey: string;
        kind: string;
        asset: string;
        expiresAt: number;
      };
      secretsFile: string;
      manifest: string;
    };

    // Publish it from the private secrets file, as a wallet tool would.
    const secrets = JSON.parse(readFileSync(result.secretsFile, "utf8")) as Record<string, string>;
    const { fromHex, ownerTagOf } = await import("@kinko/kinko-pay");
    const { KinkoPay } = await import("@kinko/kinko-pay");
    await live.sim.create({
      commitment: result.invoice.commitment,
      ownerSecret: fromHex(secrets.ownerSecret ?? ""),
      terms: {
        merchantKey: fromHex(secrets.merchantKey ?? ""),
        payout: fromHex(secrets.payoutKey ?? ""),
        amount: BigInt(secrets.amount ?? "0"),
        kind: KinkoPay.InvoiceKind.STANDARD,
        token: KinkoPay.TokenKind.KUSD,
        salt: fromHex(secrets.salt ?? ""),
        owner: ownerTagOf(fromHex(secrets.ownerSecret ?? "")),
        expiresAt: 0n,
      },
    });
    expect((await cli(["status", "invoice-12"])).out).toContain(
      "on chain       open, 0 contributions",
    );

    const waiting = cli(["wait", "invoice-12", "--timeout", "30s"]);
    await live.sim.pay({
      commitment: result.invoice.commitment,
      ownerSecret: fromHex(secrets.ownerSecret ?? ""),
      terms: {
        merchantKey: fromHex(secrets.merchantKey ?? ""),
        payout: fromHex(secrets.payoutKey ?? ""),
        amount: BigInt(secrets.amount ?? "0"),
        kind: KinkoPay.InvoiceKind.STANDARD,
        token: KinkoPay.TokenKind.KUSD,
        salt: fromHex(secrets.salt ?? ""),
        owner: ownerTagOf(fromHex(secrets.ownerSecret ?? "")),
        expiresAt: 0n,
      },
    });
    await live.app.deps.watcher.tick();
    const done = await waiting;
    expect(done.code).toBe(0);
    expect(done.out).toContain("status         settled");

    const manifest = await cli(["manifest"]);
    expect(manifest.out).toContain("Wrote 1 invoice");
    const written = JSON.parse(readFileSync(join(cwd, "kinko.json"), "utf8")) as {
      invoices: { name: string; status: string }[];
    };
    expect(written.invoices[0]).toMatchObject({ name: "invoice-12", status: "settled" });
    expect(readFileSync(join(cwd, "kinko.json"), "utf8")).not.toContain(secrets.ownerSecret ?? "");
    expect(readdirSync(join(home, "invoices"))).toHaveLength(1);
  });

  it("makes a draft and lists it", async () => {
    const registered = JSON.parse((await cli(["register", "--name", "Acme", "--json"])).out) as {
      apiKey: { key: string };
    };
    const env = { KINKO_API_KEY: registered.apiKey.key };
    const draft = await cli(["link", "--draft", "--title", "Retainer", "--json"], env);
    expect(draft.code).toBe(0);
    expect(JSON.parse(draft.out)).toMatchObject({
      formUrl: containing("/app/invoices#session="),
    });
    expect((await cli(["list", "--status", "draft"], env)).out).toContain("Retainer");
  });

  it("explains a refused key", async () => {
    const r = await cli(["list"], { KINKO_API_KEY: `kk_${"z".repeat(43)}` });
    expect(r.code).toBe(1);
    expect(r.err).toContain("kinko config");
  });
});

describe("@kinko/mcp against the real backend", () => {
  it("creates an invoice, reads it back and sees it paid", async () => {
    const registration = await Kinko.register({ baseUrl: live.base, name: "Acme" });
    const home = mkdtempSync(join(tmpdir(), "kinko-live-mcp-"));
    try {
      const ctx = {
        env: {
          KINKO_HOME: home,
          KINKO_API_URL: live.base,
          KINKO_API_KEY: registration.apiKey.key,
          KINKO_MERCHANT_KEY: MERCHANT.merchantKey,
          KINKO_PAYOUT_ADDRESS: MERCHANT.payoutAddress,
        },
        now: () => live.clock.now,
        pollIntervalMs: 5,
      };
      const made = await runTool(
        "kinko_create_invoice",
        { amount: "12.00", title: "Logo", expires_in_minutes: 60 },
        ctx,
      );
      expect(made?.isError).toBeUndefined();
      const sessionId = made?.data?.sessionId as string;
      const commitment = made?.data?.commitment as string;
      expect(sessionId).toMatch(/^cs_/);

      const secrets = JSON.parse(
        readFileSync(join(home, "invoices", `${commitment}.json`), "utf8"),
      ) as Record<string, string>;
      const { fromHex, KinkoPay, ownerTagOf } = await import("@kinko/kinko-pay");
      const invoice = {
        commitment,
        ownerSecret: fromHex(secrets.ownerSecret ?? ""),
        terms: {
          merchantKey: fromHex(secrets.merchantKey ?? ""),
          payout: fromHex(secrets.payoutKey ?? ""),
          amount: BigInt(secrets.amount ?? "0"),
          kind: KinkoPay.InvoiceKind.STANDARD,
          token: KinkoPay.TokenKind.KUSD,
          salt: fromHex(secrets.salt ?? ""),
          owner: ownerTagOf(fromHex(secrets.ownerSecret ?? "")),
          expiresAt: BigInt(secrets.expiresAt ?? "0"),
        },
      };
      await live.sim.create(invoice);
      expect(
        (await runTool("kinko_invoice_status", { reference: sessionId }, ctx))?.text,
      ).toContain("On chain: open");

      await live.sim.pay(invoice);
      await live.app.deps.watcher.tick();
      const waited = await runTool(
        "kinko_wait_for_payment",
        { session_id: sessionId, timeout_seconds: 5 },
        ctx,
      );
      expect(waited?.text).toContain("settled");
      expect(waited?.data?.final).toBe(true);
      expect(JSON.stringify(made)).not.toContain(secrets.ownerSecret ?? "");
      expect((await runTool("kinko_list_invoices", { status: "settled" }, ctx))?.text).toContain(
        sessionId,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("@kinko/bot against the real backend", () => {
  it("links a chat, starts an invoice the wallet finishes, and announces the payment", async () => {
    const { kinko } = await register();
    const { code } = await kinko.telegram.linkCode();

    const sent: { chatId: number; text: string; url?: string }[] = [];
    const telegram = {
      getMe: () => Promise.resolve({ id: 1, username: "KinkoBot" }),
      getUpdates: () => Promise.resolve([]),
      sendMessage: (chatId: number, text: string, buttons?: readonly { url: string }[]) => (
        sent.push({ chatId, text, ...(buttons?.[0] ? { url: buttons[0].url } : {}) }),
        Promise.resolve()
      ),
      setMyCommands: () => Promise.resolve(),
    };
    const backend = new HttpBackend(live.base, BOT_TOKEN);
    const bot = new KinkoBot({ telegram, backend, pollSeconds: 1 });
    await bot.init();
    const say = (id: number, text: string) =>
      bot.processUpdates([
        { update_id: id, message: { message_id: id, chat: { id: 4242, type: "private" }, text } },
      ]);

    await say(1, `/link ${code.toLowerCase()}`);
    expect(sent.at(-1)?.text).toContain("Linked to Acme Studio");
    await say(2, "/newlink Retainer");
    const formUrl = sent.at(-1)?.url ?? "";
    expect(formUrl).toContain("/app/invoices#session=");
    expect(sent.at(-1)?.text).not.toContain("attach=");

    // The notifier starts from the newest event; then the wallet finishes the draft and the payer pays.
    const notifier = new Notifier({
      backend,
      telegram,
      cursor: new MemoryCursorStore(),
      intervalMs: 10,
    });
    await notifier.tick();
    const fragment = new URLSearchParams(new URL(formUrl).hash.slice(1));
    const invoice = await kinko.invoices.create({ amount: 3_000_000n });
    await live.sim.create(asTestInvoice(invoice));
    await fetch(`${live.base}/v1/checkout/sessions/${fragment.get("session") ?? ""}/commitment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fragment.get("attach") ?? ""}`,
      },
      body: JSON.stringify({ commitment: invoice.commitment }),
    });
    await live.sim.pay(asTestInvoice(invoice));
    await live.app.deps.watcher.tick();
    await notifier.tick();
    const messages = sent.filter(
      (s) => s.text.startsWith("Paid") || s.text.startsWith("Payment received"),
    );
    expect(messages.map((m) => m.chatId)).toEqual([4242, 4242]);
    expect(messages.at(-1)?.text).toContain("Paid: Retainer");
    expect(messages.map((m) => m.text).join("\n")).not.toMatch(/3\.00|3000000/);

    await say(3, "/status");
    expect(sent.at(-1)?.text).toMatch(/settled\s+1/);
    await say(4, "/invoice " + invoice.commitment.slice(0, 10));
    expect(sent.at(-1)?.text).toContain("status         settled");
  });
});

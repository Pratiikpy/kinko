import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { signWebhookBody } from "@kinko/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode } from "../src/io.ts";
import { CONFIG, ENV, json, scripted, SESSION, type Workspace, workspace } from "./support.ts";

/** The permission bits of a file, or the expected value on Windows, which has none. */
const modeOf = (path: string, expected: number): number =>
  process.platform === "win32" ? expected : statSync(path).mode & 0o777;

let w: Workspace;
beforeEach(() => {
  w = workspace();
});
afterEach(() => {
  w.cleanup();
});

const draftSession = { ...SESSION, status: "draft", commitment: null };

describe("help and usage", () => {
  it("prints an overview and exits 2 with no command, so a script notices", async () => {
    const r = await w.run([]);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.out).toContain("kinko <command>");
    for (const name of [
      "register",
      "keygen",
      "link",
      "status",
      "wait",
      "list",
      "manifest",
      "decode",
      "webhook",
      "config",
    ])
      expect(r.out).toContain(name);
  });

  it("prints a command's usage with help, and exits 0", async () => {
    for (const args of [
      ["help", "link"],
      ["link", "--help"],
      ["help", "wait"],
    ]) {
      const r = await w.run(args);
      expect(r.code).toBe(ExitCode.OK);
      expect(r.out).toContain("kinko ");
    }
    expect((await w.run(["--version"])).out).toBe("0.1.0");
  });

  it("rejects an unknown command", async () => {
    const r = await w.run(["frobnicate"]);
    expect(r).toMatchObject({ code: ExitCode.USAGE });
    expect(r.err).toContain('Unknown command "frobnicate"');
  });

  it("rejects an unknown flag with the usage, not a stack trace", async () => {
    const r = await w.run(["link", "5", "--nope"]);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toContain("Unknown option '--nope'");
    expect(r.err).toContain("Usage:");
    expect(r.err).not.toContain("    at ");
  });
});

describe("keygen, config and register", () => {
  it("makes a 32-byte key and says what it is for", async () => {
    const r = await w.run(["keygen"]);
    expect(r.out).toMatch(/^[0-9a-f]{64}$/);
    expect(r.err).toContain("Back it up");
  });

  it("keeps the key in the settings file, owner-only, when asked", async () => {
    const r = await w.run(["keygen", "--save", "--json"]);
    const { merchantKey } = JSON.parse(r.out) as { merchantKey: string };
    const file = join(w.home, "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ merchantKey });
    expect(modeOf(file, 0o600)).toBe(0o600);
  });

  it("registers and shows the key and secret once, saving them on request", async () => {
    const registration = {
      merchant: { id: "mer_1", name: "Acme", webhookUrl: null },
      apiKey: { id: "key_1", key: `kk_${"B".repeat(43)}` },
      webhookSecret: "whsec_abc",
    };
    const f = scripted(json(201, registration));
    const r = await w.run(
      ["register", "--name", "Acme", "--webhook-url", "https://hooks.example.com/k", "--save"],
      { env: { KINKO_API_URL: "https://api.kinko.example" }, fetch: f.impl },
    );
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain(registration.apiKey.key);
    expect(r.out).toContain("whsec_abc");
    expect(f.seen[0]?.body).toEqual({ name: "Acme", webhookUrl: "https://hooks.example.com/k" });
    expect(JSON.parse(readFileSync(join(w.home, "config.json"), "utf8"))).toEqual({
      apiUrl: "https://api.kinko.example",
      apiKey: registration.apiKey.key,
      webhookSecret: "whsec_abc",
    });
    // A later run finds the saved settings with nothing in the environment.
    const later = await w.run(["config"]);
    expect(later.out).toContain("api url         https://api.kinko.example");
    expect(later.out).not.toContain("BBBBBBBBBB");
  });

  it("sends the operator's registration token when given one", async () => {
    const f = scripted(
      json(201, {
        merchant: { id: "m", name: "A", webhookUrl: null },
        apiKey: { id: "k", key: "kk_x" },
        webhookSecret: "s",
      }),
    );
    await w.run(["register", "--name", "A", "--registration-token", "operator-token"], {
      env: { KINKO_API_URL: "https://x.example" },
      fetch: f.impl,
    });
    expect(f.seen[0]?.headers.get("x-registration-token")).toBe("operator-token");
  });

  it("needs a name and a backend address, and says so", async () => {
    expect(
      (await w.run(["register"], { env: { KINKO_API_URL: "https://x.example" } })).err,
    ).toContain("--name is required");
    expect((await w.run(["register", "--name", "A"])).err).toContain("backend address");
  });

  it("shows settings with the secrets shortened, and flags win over the environment", async () => {
    const r = await w.run(["config", "--json"], { env: { ...ENV } });
    const view = JSON.parse(r.out) as Record<string, string>;
    expect(view.apiKey).toBe("kk_AAA…AAAA");
    expect(JSON.stringify(view)).not.toContain(ENV.KINKO_API_KEY);
    expect(view.merchantKey).not.toContain(ENV.KINKO_MERCHANT_KEY);
  });

  it("reports a corrupt settings file instead of ignoring it", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(w.home, { recursive: true });
    writeFileSync(join(w.home, "config.json"), "{ not json");
    const r = await w.run(["config"]);
    expect(r.code).toBe(ExitCode.FAILURE);
    expect(r.err).toContain("is not valid JSON");
  });
});

describe("link", () => {
  const happy = () =>
    scripted(json(200, CONFIG), json(201, { session: SESSION, attachToken: null }));

  it("builds the invoice locally and prints a hosted link whose fragment carries the terms", async () => {
    const f = happy();
    const r = await w.run(
      ["link", "25.50", "--title", "Invoice 12", "--ref", "order-9", "--expires", "1h"],
      { env: ENV, fetch: f.impl },
    );
    expect(r.code).toBe(ExitCode.OK);
    const checkout = /checkout\s+(\S+)/.exec(r.out)?.[1] ?? "";
    expect(new URL(checkout).searchParams.get("session")).toBe(SESSION.id);
    expect(new URL(checkout).hash.length).toBeGreaterThan(20);
    expect(r.out).toContain("25.50 KUSD");
    expect(r.out).toContain("the backend was not told");
    const sent = f.seen[1]?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      kind: "standard",
      token: "KUSD",
      title: "Invoice 12",
      clientReference: "order-9",
    });
    expect(sent.amount).toBeUndefined();
    expect(sent.ttlSeconds).toBeGreaterThan(3_500);
  });

  it("keeps the secrets in a private file, out of the output, the manifest and the request", async () => {
    const f = happy();
    const r = await w.run(["link", "25.50", "--json"], { env: ENV, fetch: f.impl });
    const result = JSON.parse(r.out) as {
      invoice: { commitment: string };
      secretsFile: string;
      manifest: string;
    };
    const secrets = JSON.parse(readFileSync(result.secretsFile, "utf8")) as Record<string, string>;
    expect(result.secretsFile).toBe(join(w.home, "invoices", `${result.invoice.commitment}.json`));
    expect(secrets).toMatchObject({
      commitment: result.invoice.commitment,
      amount: "25500000",
      merchantKey: ENV.KINKO_MERCHANT_KEY,
    });
    expect(secrets.ownerSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(modeOf(result.secretsFile, 0o600)).toBe(0o600);
    // The owner secret and the salt appear nowhere but the private file. The amount is the merchant's
    // own and may be printed to their terminal, but not written to the manifest or sent to the backend.
    const everything = [
      r.out,
      readFileSync(result.manifest, "utf8"),
      JSON.stringify(f.seen.map((s) => s.body)),
    ].join("\n");
    for (const secret of [secrets.ownerSecret, secrets.salt])
      expect(everything).not.toContain(secret ?? "");
    const shared = [
      readFileSync(result.manifest, "utf8"),
      JSON.stringify(f.seen.map((s) => s.body)),
    ].join("\n");
    expect(shared).not.toContain("25500000");
  });

  it("writes a manifest line without amounts or secrets, and updates it by name on the next run", async () => {
    await w.run(["link", "5", "--name", "logo"], { env: ENV, fetch: happy().impl });
    const file = join(w.cwd, "kinko.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      invoices: Record<string, unknown>[];
    };
    expect(manifest.version).toBe(1);
    expect(manifest.invoices).toHaveLength(1);
    expect(manifest.invoices[0]).toMatchObject({
      name: "logo",
      sessionId: SESSION.id,
      commitment: SESSION.commitment,
      status: "pending",
      title: "Invoice 12",
    });
    expect(Object.keys(manifest.invoices[0] ?? {})).not.toContain("amount");
    expect(readdirSync(w.cwd).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    const second = { ...SESSION, id: `cs_${"2".repeat(32)}`, commitment: "cd".repeat(32) };
    await w.run(["link", "6", "--name", "poster"], {
      env: ENV,
      fetch: scripted(json(200, CONFIG), json(201, { session: second, attachToken: null })).impl,
    });
    expect(
      (JSON.parse(readFileSync(file, "utf8")) as { invoices: { name: string }[] }).invoices.map(
        (e) => e.name,
      ),
    ).toEqual(["logo", "poster"]);
  });

  it("skips the manifest when told, and uses another file when told", async () => {
    await w.run(["link", "5", "--no-manifest"], { env: ENV, fetch: happy().impl });
    expect(existsSync(join(w.cwd, "kinko.json"))).toBe(false);
    await w.run(["link", "5", "--manifest", "sub/m.json"], { env: ENV, fetch: happy().impl });
    expect(existsSync(join(w.cwd, "sub", "m.json"))).toBe(true);
  });

  it("stores a display amount only with --store-amount, and says so", async () => {
    const f = happy();
    const r = await w.run(["link", "25.50", "--store-amount"], { env: ENV, fetch: f.impl });
    expect((f.seen[1]?.body as Record<string, unknown>).amount).toBe("25500000");
    expect(r.out).toContain("stored with the backend because you asked");
  });

  it("supports multipay and night", async () => {
    const f = happy();
    await w.run(["link", "1", "--kind", "multipay", "--asset", "night"], {
      env: ENV,
      fetch: f.impl,
    });
    expect(f.seen[1]?.body).toMatchObject({ kind: "multipay", token: "NATIVE" });
  });

  it("makes a draft for the wallet to finish, with no amount and no keys needed", async () => {
    const formUrl = "https://app.kinko.example/app/invoices#session=cs_1&attach=at_x";
    const f = scripted(json(201, { session: draftSession, attachToken: "at_x", formUrl }));
    const r = await w.run(["link", "--draft", "--title", "Invoice 12"], {
      env: { KINKO_API_URL: ENV.KINKO_API_URL, KINKO_API_KEY: ENV.KINKO_API_KEY },
      fetch: f.impl,
    });
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain(formUrl);
    expect(r.out).toContain("one-time token");
    expect(f.seen).toHaveLength(1);
    expect((f.seen[0]?.body as Record<string, unknown>).commitment).toBeUndefined();
    expect(
      (
        JSON.parse(readFileSync(join(w.cwd, "kinko.json"), "utf8")) as {
          invoices: { status: string }[];
        }
      ).invoices[0]?.status,
    ).toBe("draft");
    expect(existsSync(join(w.home, "invoices"))).toBe(false);
  });

  it.each([
    [["link"], "Give an amount"],
    [["link", "--draft", "5"], "no amount here"],
    [["link", "5", "--draft", "--store-amount"], "no amount here"],
    [["link", "--draft", "--store-amount"], "needs an amount"],
    [["link", "5", "6"], "Unexpected argument"],
    [["link", "5", "--kind", "weekly"], "--kind must be"],
    [["link", "5", "--asset", "btc"], "--asset must be"],
    [["link", "5", "--expires", "soon"], "--expires must be a duration"],
    [["link", "5", "--expires", "0"], "greater than zero"],
  ])("refuses %j before doing anything", async (args, message) => {
    const f = scripted(json(200, CONFIG));
    const r = await w.run(args, { env: ENV, fetch: f.impl });
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toContain(message);
    expect(f.seen).toHaveLength(0);
  });

  it("refuses amounts that are not amounts", async () => {
    for (const amount of ["abc", "0", "-5", "1.0000001", "99999999999999999999"]) {
      const r = await w.run(["link", amount], { env: ENV, fetch: happy().impl });
      expect(r.code).not.toBe(ExitCode.OK);
    }
  });

  it("names every missing setting at once", async () => {
    const r = await w.run(["link", "5"]);
    expect(r.code).toBe(ExitCode.USAGE);
    for (const part of ["backend address", "API key", "merchant key", "payout address"])
      expect(r.err).toContain(part);
  });

  it("reports the backend's refusal with its request id, and does not leave secrets behind for an invoice that never registered", async () => {
    const f = scripted(
      json(200, CONFIG),
      json(409, {
        error: {
          code: "conflict",
          message: "A checkout session already exists for this commitment.",
        },
        requestId: "req_deadbeef",
      }),
    );
    const r = await w.run(["link", "5"], { env: ENV, fetch: f.impl });
    expect(r.code).toBe(ExitCode.FAILURE);
    expect(r.err).toContain("already exists");
    expect(r.err).toContain("req_deadbeef");
    expect(existsSync(join(w.home, "invoices"))).toBe(false);
  });

  it("points at the API key when the backend says unauthorized", async () => {
    const f = scripted(
      json(401, { error: { code: "unauthorized", message: "That API key is not valid." } }),
    );
    const r = await w.run(["link", "--draft"], { env: ENV, fetch: f.impl });
    expect(r.err).toContain("kinko config");
  });
});

describe("status, wait and list", () => {
  const settled = {
    ...SESSION,
    status: "settled",
    contributions: 1,
    settledAt: "2027-01-15T12:05:00.000Z",
  };
  const chain = {
    commitment: SESSION.commitment,
    found: true,
    status: "settled",
    kind: "standard",
    asset: "KUSD",
    expiresAt: null,
    contributions: 1,
  };

  it("shows a session and what the chain says, for a session id", async () => {
    const f = scripted(json(200, { session: settled }), json(200, chain));
    const r = await w.run(["status", SESSION.id], { env: ENV, fetch: f.impl });
    expect(r.out).toContain("status         settled");
    expect(r.out).toContain("on chain       settled, 1 contribution");
    expect(f.seen[1]?.url.pathname).toBe(`/v1/chain/invoices/${SESSION.commitment}`);
  });

  it("reads the chain alone for a bare commitment, with no key needed for that read", async () => {
    const f = scripted(json(200, { ...chain, found: false, status: "unknown", contributions: 0 }));
    const r = await w.run(["status", SESSION.commitment], { env: ENV, fetch: f.impl });
    expect(r.out).toContain("not on chain yet");
    expect(f.seen).toHaveLength(1);
  });

  it("looks a name up in the manifest", async () => {
    await w.run(["link", "5", "--name", "logo"], {
      env: ENV,
      fetch: scripted(json(200, CONFIG), json(201, { session: SESSION, attachToken: null })).impl,
    });
    const f = scripted(
      json(200, { session: SESSION }),
      json(200, { ...chain, status: "open", contributions: 0 }),
    );
    const r = await w.run(["status", "logo"], { env: ENV, fetch: f.impl });
    expect(r.code).toBe(ExitCode.OK);
    expect(f.seen[0]?.url.pathname).toBe(`/v1/checkout/sessions/${SESSION.id}`);
  });

  it("explains an unknown name, listing the known ones", async () => {
    await w.run(["link", "5", "--name", "logo"], {
      env: ENV,
      fetch: scripted(json(200, CONFIG), json(201, { session: SESSION, attachToken: null })).impl,
    });
    const r = await w.run(["status", "nothing"], { env: ENV, fetch: scripted().impl });
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toContain('Known names: "logo"');
  });

  it("waits through the states and exits 0 when paid", async () => {
    const f = scripted(
      json(200, { session: SESSION }),
      json(200, { session: { ...SESSION, contributions: 0 } }),
      json(200, { session: settled }),
    );
    const r = await w.run(["wait", SESSION.id], { env: ENV, fetch: f.impl, pollIntervalMs: 5 });
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err.split("\n")).toEqual(["pending", "settled (1 contribution)"]);
    expect(r.out).toContain("status         settled");
  });

  it.each(["cancelled", "expired"])("exits 3 when the invoice ends %s", async (status) => {
    const f = scripted(json(200, { session: { ...SESSION, status } }));
    expect(
      (await w.run(["wait", SESSION.id], { env: ENV, fetch: f.impl, pollIntervalMs: 5 })).code,
    ).toBe(ExitCode.NOT_PAID);
  });

  it("exits 4 on timeout, saying how to continue", async () => {
    const f = scripted(json(200, { session: SESSION }));
    const r = await w.run(["wait", SESSION.id, "--timeout", "1s"], {
      env: ENV,
      fetch: f.impl,
      pollIntervalMs: 400,
    });
    expect(r.code).toBe(ExitCode.TIMEOUT);
    expect(r.err).toContain("Run the command again to keep waiting");
  });

  it("will not wait on a bare commitment, which has no session to follow", async () => {
    const r = await w.run(["wait", SESSION.commitment], { env: ENV, fetch: scripted().impl });
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toContain("kinko status");
  });

  it("lists sessions with a filter and a cursor hint", async () => {
    const f = scripted(
      json(200, {
        data: [
          SESSION,
          {
            ...SESSION,
            id: `cs_${"2".repeat(32)}`,
            commitment: null,
            status: "draft",
            title: null,
          },
        ],
        nextCursor: "4",
      }),
    );
    const r = await w.run(["list", "--status", "pending", "--limit", "2"], {
      env: ENV,
      fetch: f.impl,
    });
    expect(Object.fromEntries(f.seen[0]?.url.searchParams ?? [])).toEqual({
      status: "pending",
      limit: "2",
    });
    expect(r.out).toContain("pending");
    expect(r.out).toContain("draft");
    expect(r.out).toContain("kinko list --before 4");
  });

  it("says when there is nothing, and rejects a bad filter or page size", async () => {
    expect(
      (
        await w.run(["list"], {
          env: ENV,
          fetch: scripted(json(200, { data: [], nextCursor: null })).impl,
        })
      ).out,
    ).toBe("No invoices.");
    expect((await w.run(["list", "--status", "weird"], { env: ENV })).code).toBe(ExitCode.USAGE);
    expect((await w.run(["list", "--limit", "500"], { env: ENV })).code).toBe(ExitCode.USAGE);
  });
});

describe("telegram", () => {
  it("prints a link code, and tells the user what to send the bot", async () => {
    const f = scripted(
      json(201, { code: "K7QM-4XD2-9PTV", expiresAt: "2027-01-15T12:15:00.000Z" }),
    );
    const r = await w.run(["telegram", "code"], { env: ENV, fetch: f.impl });
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toBe("K7QM-4XD2-9PTV");
    expect(r.err).toContain("/link K7QM-4XD2-9PTV");
    expect(r.err).toContain("expires at 2027-01-15T12:15:00.000Z");
    expect(f.seen[0]?.method).toBe("POST");
  });

  it("prints the code as JSON when asked", async () => {
    const f = scripted(json(201, { code: "K7QM-4XD2-9PTV", expiresAt: "x" }));
    const r = await w.run(["telegram", "code", "--json"], { env: ENV, fetch: f.impl });
    expect(JSON.parse(r.out)).toEqual({ code: "K7QM-4XD2-9PTV", expiresAt: "x" });
  });

  it("lists linked chats, and says when there are none", async () => {
    const some = scripted(
      json(200, { chats: [{ chatId: 4242, linkedAt: "2027-01-15T12:00:00.000Z" }] }),
    );
    expect((await w.run(["telegram", "chats"], { env: ENV, fetch: some.impl })).out).toBe(
      "4242  linked 2027-01-15T12:00:00.000Z",
    );
    const none = scripted(json(200, { chats: [] }));
    expect((await w.run(["telegram", "chats"], { env: ENV, fetch: none.impl })).out).toBe(
      "No chats are linked.",
    );
  });

  it("unlinks a chat, negative group ids included", async () => {
    const f = scripted(new Response(null, { status: 204 }));
    const r = await w.run(["telegram", "unlink", "-1001"], { env: ENV, fetch: f.impl });
    expect(r.out).toBe("Unlinked -1001.");
    expect(f.seen[0]).toMatchObject({ method: "DELETE" });
    expect(f.seen[0]?.url.pathname).toBe("/v1/merchant/telegram/-1001");
  });

  it.each([
    [["telegram"]],
    [["telegram", "fly"]],
    [["telegram", "unlink"]],
    [["telegram", "unlink", "abc"]],
    [["telegram", "unlink", "0"]],
    [["telegram", "unlink", "1", "2"]],
  ])("refuses %j before calling the backend", async (args) => {
    const f = scripted(json(200, {}));
    const r = await w.run(args, { env: ENV, fetch: f.impl });
    expect(r.code).toBe(ExitCode.USAGE);
    expect(f.seen).toHaveLength(0);
  });
});

describe("manifest, decode and webhook", () => {
  it("writes a manifest from the backend, keeping names already in the file", async () => {
    await w.run(["link", "5", "--name", "logo"], {
      env: ENV,
      fetch: scripted(json(200, CONFIG), json(201, { session: SESSION, attachToken: null })).impl,
    });
    const other = {
      ...SESSION,
      id: `cs_${"2".repeat(32)}`,
      commitment: "cd".repeat(32),
      status: "settled",
      amount: "999",
    };
    const r = await w.run(["manifest"], {
      env: ENV,
      fetch: scripted(json(200, { data: [other, SESSION], nextCursor: null })).impl,
    });
    expect(r.out).toContain("Wrote 2 invoices");
    const written = JSON.parse(readFileSync(join(w.cwd, "kinko.json"), "utf8")) as {
      invoices: { name: string | null; sessionId: string; status: string }[];
    };
    expect(written.invoices.find((e) => e.sessionId === SESSION.id)?.name).toBe("logo");
    expect(written.invoices.find((e) => e.sessionId === other.id)).toMatchObject({
      name: null,
      status: "settled",
    });
    expect(readFileSync(join(w.cwd, "kinko.json"), "utf8")).not.toContain("999");
  });

  it("walks every page up to the limit", async () => {
    const page = (n: number, next: string | null) =>
      json(200, {
        data: [{ ...SESSION, id: `cs_${String(n).repeat(32)}`, commitment: String(n).repeat(64) }],
        nextCursor: next,
      });
    const f = scripted(page(1, "10"), page(2, "5"), page(3, null));
    const r = await w.run(["manifest", "out.json"], { env: ENV, fetch: f.impl });
    expect(r.out).toContain("Wrote 3 invoices");
    expect(f.seen.map((s) => s.url.search)).toEqual([
      "?limit=100",
      "?limit=99&before=10",
      "?limit=98&before=5",
    ]);
  });

  it("refuses a file that is not a manifest rather than overwrite it", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(w.cwd, { recursive: true });
    writeFileSync(join(w.cwd, "kinko.json"), JSON.stringify({ hello: "world" }));
    const r = await w.run(["manifest"], {
      env: ENV,
      fetch: scripted(json(200, { data: [], nextCursor: null })).impl,
    });
    expect(r.code).toBe(ExitCode.FAILURE);
    expect(r.err).toContain("is not a Kinko manifest");
    expect(JSON.parse(readFileSync(join(w.cwd, "kinko.json"), "utf8"))).toEqual({ hello: "world" });
  });

  it("decodes a payment link into what a payer sees, and rejects junk", async () => {
    const made = await w.run(["link", "25.50", "--json", "--no-manifest"], {
      env: ENV,
      fetch: scripted(json(200, CONFIG), json(201, { session: SESSION, attachToken: null })).impl,
    });
    const link = (JSON.parse(made.out) as { paymentLink: string }).paymentLink;
    const r = await w.run(["decode", link]);
    expect(r.out).toContain("25.50 KUSD");
    expect(r.out).toContain("standard");
    expect(r.out).toContain("never");
    expect((await w.run(["decode", "https://app.kinko.example/pay#garbage"])).code).toBe(
      ExitCode.FAILURE,
    );
    expect((await w.run(["decode"])).code).toBe(ExitCode.USAGE);
  });

  describe("webhook verify", () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.settled", createdAt: "x", data: {} });
    const now = Date.UTC(2027, 0, 15, 12, 0, 0);
    const setup = async () => {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(w.cwd, { recursive: true });
      writeFileSync(join(w.cwd, "body.json"), body);
    };

    it("accepts a genuine delivery and names the event", async () => {
      await setup();
      const r = await w.run(
        [
          "webhook",
          "verify",
          "--header",
          signWebhookBody(body, "whsec_s", now),
          "--body-file",
          "body.json",
          "--secret",
          "whsec_s",
        ],
        { now },
      );
      expect(r).toMatchObject({ code: ExitCode.OK, out: "valid: invoice.settled (evt_1)" });
    });

    it("reads the secret from the environment, and refuses a wrong one, an altered body and a replay", async () => {
      await setup();
      const header = signWebhookBody(body, "whsec_s", now);
      const base = ["webhook", "verify", "--header", header, "--body-file", "body.json"];
      expect((await w.run(base, { now, env: { KINKO_WEBHOOK_SECRET: "whsec_s" } })).code).toBe(
        ExitCode.OK,
      );
      const wrong = await w.run(base, { now, env: { KINKO_WEBHOOK_SECRET: "whsec_x" } });
      expect(wrong).toMatchObject({ code: ExitCode.FAILURE });
      expect(wrong.err).toContain("wrong secret");
      const replay = await w.run(base, {
        now: now + 3_600_000,
        env: { KINKO_WEBHOOK_SECRET: "whsec_s" },
      });
      expect(replay.err).toContain("replay");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(w.cwd, "body.json"), body.replace("evt_1", "evt_2"));
      expect((await w.run(base, { now, env: { KINKO_WEBHOOK_SECRET: "whsec_s" } })).code).toBe(
        ExitCode.FAILURE,
      );
    });

    it("needs its inputs", async () => {
      expect((await w.run(["webhook"])).code).toBe(ExitCode.USAGE);
      expect((await w.run(["webhook", "verify"])).code).toBe(ExitCode.USAGE);
      expect(
        (await w.run(["webhook", "verify", "--header", "x", "--body-file", "body.json"])).err,
      ).toContain("webhook secret");
    });
  });
});

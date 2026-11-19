import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildInvoice } from "../src/invoice.ts";
import {
  clientFromSettings,
  kinkoHome,
  MissingSettingsError,
  readSettings,
  resolveSettings,
  saveInvoiceSecrets,
  saveSettings,
  settingsPath,
} from "../src/settings.ts";
import { PAYOUT_ADDRESS, PAYOUT_COIN } from "./payout.ts";

/** The permission bits of a file, or the expected value on Windows, which has none. */
const modeOf = (path: string, expected: number): number =>
  process.platform === "win32" ? expected : statSync(path).mode & 0o777;

let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kinko-settings-"));
  env = { KINKO_HOME: dir };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = `kk_${"A".repeat(43)}`;

describe("where files live", () => {
  it("uses KINKO_HOME, then the home directory", () => {
    expect(kinkoHome({ KINKO_HOME: "/x/kinko" })).toBe("/x/kinko");
    expect(kinkoHome({ HOME: "/home/alice" })).toBe(join("/home/alice", ".config", "kinko"));
    expect(kinkoHome({ USERPROFILE: "C:\\Users\\alice" })).toBe(
      join("C:\\Users\\alice", ".config", "kinko"),
    );
    expect(settingsPath({ KINKO_HOME: "/x" })).toBe(join("/x", "config.json"));
  });
});

describe("settings file", () => {
  it("is empty when absent, and merges updates without losing earlier ones", async () => {
    expect(await readSettings(env)).toEqual({});
    await saveSettings(env, { apiUrl: "https://a.example" });
    await saveSettings(env, { apiKey: KEY });
    expect(await readSettings(env)).toEqual({ apiUrl: "https://a.example", apiKey: KEY });
  });

  it("is readable by its owner only", async () => {
    const path = await saveSettings(env, { apiKey: KEY });
    expect(modeOf(path, 0o600)).toBe(0o600);
    expect(modeOf(dir, 0o700)).toBe(0o700);
  });

  it("fixes loose permissions on an existing file when it is next written", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath(env), "{}", { mode: 0o644 });
    await saveSettings(env, { apiKey: KEY });
    expect(modeOf(settingsPath(env), 0o600)).toBe(0o600);
  });

  it("refuses to guess at a corrupt file", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath(env), "{ nope");
    await expect(readSettings(env)).rejects.toThrow(/is not valid JSON/);
    await expect(saveSettings(env, { apiKey: KEY })).rejects.toThrow(/is not valid JSON/);
    expect(readFileSync(settingsPath(env), "utf8")).toBe("{ nope");
  });
});

describe("resolveSettings", () => {
  it("lets a flag beat the environment, and the environment beat the file", async () => {
    await saveSettings(env, {
      apiUrl: "https://file.example",
      apiKey: "kk_file",
      merchantKey: "ff".repeat(32),
      payoutAddress: PAYOUT_ADDRESS,
      webhookSecret: "whsec_file",
    });
    const fromFile = await resolveSettings(env);
    expect(fromFile).toMatchObject({
      apiUrl: "https://file.example",
      apiKey: "kk_file",
      webhookSecret: "whsec_file",
    });
    const fromEnv = await resolveSettings({
      ...env,
      KINKO_API_URL: "https://env.example",
      KINKO_WEBHOOK_SECRET: "whsec_env",
    });
    expect(fromEnv).toMatchObject({
      apiUrl: "https://env.example",
      apiKey: "kk_file",
      webhookSecret: "whsec_env",
    });
    const fromFlag = await resolveSettings(
      { ...env, KINKO_API_URL: "https://env.example" },
      { apiUrl: "https://flag.example" },
    );
    expect(fromFlag.apiUrl).toBe("https://flag.example");
  });

  it("leaves unset values undefined", async () => {
    expect(await resolveSettings(env)).toEqual({
      apiUrl: undefined,
      apiKey: undefined,
      webhookSecret: undefined,
      merchantKey: undefined,
      payoutAddress: undefined,
    });
  });
});

describe("clientFromSettings", () => {
  const complete = {
    apiUrl: "https://api.example",
    apiKey: KEY,
    webhookSecret: undefined,
    merchantKey: "11".repeat(32),
    payoutAddress: PAYOUT_ADDRESS,
  };

  it("builds a client from complete settings", () => {
    expect(() => clientFromSettings(complete, { needsKeys: true })).not.toThrow();
  });

  it("needs no merchant keys for a read", () => {
    expect(() =>
      clientFromSettings({ ...complete, merchantKey: undefined, payoutAddress: undefined }),
    ).not.toThrow();
  });

  it("names every missing setting at once", () => {
    const error = (() => {
      try {
        clientFromSettings(
          {
            apiUrl: undefined,
            apiKey: undefined,
            webhookSecret: undefined,
            merchantKey: undefined,
            payoutAddress: undefined,
          },
          { needsKeys: true },
        );
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(MissingSettingsError);
    expect((error as MissingSettingsError).missing).toHaveLength(4);
    expect((error as Error).message).toMatch(
      /backend address.*API key.*merchant key.*payout address/,
    );
  });

  it("passes the webhook secret through", () => {
    const kinko = clientFromSettings({ ...complete, webhookSecret: "whsec_x" });
    expect(kinko.webhooks.verify("{}", "t=1,v1=00").valid).toBe(false);
  });
});

describe("saveInvoiceSecrets", () => {
  it("writes the secrets to a private file named for the commitment, and nowhere else", async () => {
    const invoice = buildInvoice(
      { merchantKey: "11".repeat(32), payoutAddress: PAYOUT_ADDRESS },
      { amount: 42_500n },
      { contractAddress: "ab".repeat(32), appUrl: "https://app.example" },
    );
    const path = await saveInvoiceSecrets(env, invoice, Date.UTC(2027, 0, 15));
    expect(path).toBe(join(dir, "invoices", `${invoice.commitment}.json`));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      commitment: invoice.commitment,
      createdAt: "2027-01-15T00:00:00.000Z",
      kind: "standard",
      asset: "KUSD",
      amount: "42500",
      expiresAt: 0,
      merchantKey: "11".repeat(32),
      payoutKey: PAYOUT_COIN,
      payoutAddress: PAYOUT_ADDRESS,
      salt: invoice.salt,
      ownerSecret: invoice.ownerSecret,
      paymentLink: invoice.paymentLink,
    });
    expect(modeOf(path, 0o600)).toBe(0o600);
  });
});

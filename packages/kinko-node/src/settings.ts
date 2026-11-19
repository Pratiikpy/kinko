// Settings shared by everything that runs on a merchant's machine (the CLI and
// the MCP server): where they live, how they are resolved, and where an
// invoice's secrets are kept.
//
// A flag beats an environment variable, which beats the file. The file holds
// the API key and the merchant key, so it is written readable by its owner
// only, and an invoice's secrets get the same treatment in their own files.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Kinko } from "./client.ts";
import type { Invoice } from "./invoice.ts";

/** Everything remembered between runs. */
export interface StoredSettings {
  apiUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
  merchantKey?: string;
  payoutAddress?: string;
}

/** The environment settings are read from. */
export type SettingsEnv = Readonly<Record<string, string | undefined>>;

/** Settings given on the command line. */
export interface SettingsFlags {
  readonly apiUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly merchantKey?: string | undefined;
  readonly payoutAddress?: string | undefined;
}

/** The settings in force. */
export interface ResolvedSettings {
  readonly apiUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly webhookSecret: string | undefined;
  readonly merchantKey: string | undefined;
  readonly payoutAddress: string | undefined;
}

/** Thrown when a command needs settings that are not there. */
export class MissingSettingsError extends Error {
  /** Each missing setting, with how to provide it. */
  readonly missing: readonly string[];
  /**
   * Create the error.
   *
   * @param missing - Each missing setting, with how to provide it.
   */
  constructor(missing: readonly string[]) {
    super(`Missing ${missing.join("; ")}.`);
    this.name = "MissingSettingsError";
    this.missing = missing;
  }
}

/**
 * The directory Kinko keeps its files in: `KINKO_HOME`, or `~/.config/kinko`.
 *
 * @param env - The environment.
 * @returns The directory.
 */
export const kinkoHome = (env: SettingsEnv): string =>
  env.KINKO_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".config", "kinko");

/**
 * Where the settings file lives.
 *
 * @param env - The environment.
 * @returns Its path.
 */
export const settingsPath = (env: SettingsEnv): string => join(kinkoHome(env), "config.json");

/**
 * Read the settings file.
 *
 * @param env - The environment.
 * @returns What it holds, or an empty object when there is none.
 * @throws {Error} When the file exists but is not valid JSON.
 */
export const readSettings = async (env: SettingsEnv): Promise<StoredSettings> => {
  let text: string;
  try {
    text = await readFile(settingsPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text) as StoredSettings;
  } catch (cause) {
    throw new Error(`${settingsPath(env)} is not valid JSON. Fix or delete it.`, { cause });
  }
};

/**
 * Merge settings into the file, creating it private to the user.
 *
 * @param env - The environment.
 * @param update - The settings to set.
 * @returns The path written.
 */
export const saveSettings = async (env: SettingsEnv, update: StoredSettings): Promise<string> => {
  const path = settingsPath(env);
  const merged = { ...(await readSettings(env)), ...update };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

/**
 * Work out the settings in force.
 *
 * @param env - The environment.
 * @param flags - Settings given on the command line.
 * @returns The settings.
 */
export const resolveSettings = async (
  env: SettingsEnv,
  flags: SettingsFlags = {},
): Promise<ResolvedSettings> => {
  const stored = await readSettings(env);
  return {
    apiUrl: flags.apiUrl ?? env.KINKO_API_URL ?? stored.apiUrl,
    apiKey: flags.apiKey ?? env.KINKO_API_KEY ?? stored.apiKey,
    webhookSecret: env.KINKO_WEBHOOK_SECRET ?? stored.webhookSecret,
    merchantKey: flags.merchantKey ?? env.KINKO_MERCHANT_KEY ?? stored.merchantKey,
    payoutAddress: flags.payoutAddress ?? env.KINKO_PAYOUT_ADDRESS ?? stored.payoutAddress,
  };
};

/**
 * Build a client from settings, naming everything that is missing at once.
 *
 * @param settings - The resolved settings.
 * @param options - Whether the caller builds invoices (and so needs the keys), and a fetch to use.
 * @param options.needsKeys - Whether the caller builds invoices and so needs the merchant's keys.
 * @param options.fetch - The fetch to use; injectable for tests.
 * @param options.now - The clock, in milliseconds.
 * @returns The client.
 * @throws {MissingSettingsError} Listing each missing setting and how to set it.
 */
export const clientFromSettings = (
  settings: ResolvedSettings,
  options: {
    readonly needsKeys?: boolean;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  } = {},
): Kinko => {
  const missing: string[] = [];
  if (!settings.apiUrl) missing.push("the backend address (KINKO_API_URL)");
  if (!settings.apiKey)
    missing.push("your API key (KINKO_API_KEY, or run `kinko register --save`)");
  if (options.needsKeys && !settings.merchantKey)
    missing.push("your merchant key (KINKO_MERCHANT_KEY; `kinko keygen` makes one)");
  if (options.needsKeys && !settings.payoutAddress)
    missing.push(
      "your payout address, the shielded address your wallet is paid at (KINKO_PAYOUT_ADDRESS)",
    );
  if (missing.length > 0 || !settings.apiUrl || !settings.apiKey)
    throw new MissingSettingsError(missing);
  return new Kinko({
    apiKey: settings.apiKey,
    baseUrl: settings.apiUrl,
    ...(settings.merchantKey && settings.payoutAddress
      ? { merchant: { merchantKey: settings.merchantKey, payoutAddress: settings.payoutAddress } }
      : {}),
    ...(settings.webhookSecret ? { webhookSecret: settings.webhookSecret } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
};

/** One invoice's private material, as saved. */
export interface InvoiceSecrets {
  readonly commitment: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly asset: string;
  /** Base units. */
  readonly amount: string;
  readonly expiresAt: number;
  readonly merchantKey: string;
  readonly payoutKey: string;
  readonly payoutAddress: string;
  readonly salt: string;
  readonly ownerSecret: string;
  readonly paymentLink: string;
}

/**
 * Save an invoice's secrets to the user's own directory, readable by the owner
 * only. They are what publishes, closes and refunds the invoice, so they are
 * kept out of manifests, logs and anything sent to the backend.
 *
 * @param env - The environment.
 * @param invoice - The invoice built by this SDK.
 * @param nowMs - The time to record.
 * @returns The file written.
 */
export const saveInvoiceSecrets = async (
  env: SettingsEnv,
  invoice: Invoice,
  nowMs: number = Date.now(),
): Promise<string> => {
  const path = join(kinkoHome(env), "invoices", `${invoice.commitment}.json`);
  const secrets: InvoiceSecrets = {
    commitment: invoice.commitment,
    createdAt: new Date(nowMs).toISOString(),
    kind: invoice.kind,
    asset: invoice.asset,
    amount: invoice.amount,
    expiresAt: invoice.expiresAt,
    merchantKey: invoice.merchantKey,
    payoutKey: invoice.payoutKey,
    payoutAddress: invoice.payoutAddress,
    salt: invoice.salt,
    ownerSecret: invoice.ownerSecret,
    paymentLink: invoice.paymentLink,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return path;
};

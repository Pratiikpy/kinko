// Configuration: read once from the environment, validated up front.
//
// A backend that starts half-configured looks alive and answers wrongly, which
// is worse than one that refuses to start. So every value is checked here, and
// a missing or malformed one stops the process with a sentence that names the
// variable and says what to put in it. Optional features (the oracle, the
// assistant, the bot) are the exception: they stay off, report themselves as
// off in /health, and answer 503 rather than pretending.

import { DATA_KEY_HEX } from "./domain/crypto.ts";
import { LogLevel } from "./log.ts";

/** Thrown for any configuration problem; the message is meant for an operator. */
export class ConfigError extends Error {
  /**
   * Create a configuration error.
   *
   * @param message - What is wrong, and how to fix it.
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** How the oracle learns the NIGHT to KUSD rate. */
export type RateSourceConfig =
  | { readonly kind: "static"; readonly kusdPerNight: string }
  | { readonly kind: "http"; readonly url: string; readonly path: string }
  | { readonly kind: "none" };

/** The validated configuration. */
export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly dataKey: string;
  /** Where the web app lives; hosted checkout and bot links point here. */
  readonly appUrl: string;
  /** The web app path where a merchant's wallet creates an invoice; bot links point here. */
  readonly appInvoicePath: string;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: boolean;
  /** When set, `POST /v1/merchants` requires it. */
  readonly registrationToken: string | undefined;
  /** Shared secret the Telegram bot presents; the bot routes answer 503 without it. */
  readonly botToken: string | undefined;
  readonly chain: {
    readonly contractAddress: string;
    readonly indexerUri: string;
    readonly indexerWsUri: string;
    readonly pollMs: number;
    /** How long past its expiry a session is still watched for a late payment. */
    readonly lateSettlementMs: number;
  };
  readonly oracle: {
    readonly secretKey: bigint | undefined;
    readonly rate: RateSourceConfig;
    readonly quoteTtlSeconds: number;
  };
  readonly assistant: { readonly apiKey: string | undefined; readonly model: string };
  readonly webhooks: { readonly allowPrivateTargets: boolean; readonly timeoutMs: number };
  readonly sessionDefaultTtlSeconds: number;
  readonly logLevel: LogLevel;
}

/** The environment a config is read from. */
export type Env = Readonly<Record<string, string | undefined>>;

const DAY_MS = 24 * 60 * 60 * 1000;

const read = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const integer = (env: Env, name: string, fallback: number, min: number, max: number): number => {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} must be a whole number between ${String(min)} and ${String(max)}; got "${raw}".`,
    );
  }
  return value;
};

const flag = (env: Env, name: string): boolean => {
  const raw = read(env, name)?.toLowerCase();
  if (raw === undefined) return false;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(`${name} must be "true" or "false"; got "${raw}".`);
};

const httpUrl = (env: Env, name: string, fallback: string | undefined): string => {
  const raw = read(env, name) ?? fallback;
  if (raw === undefined) throw new ConfigError(`${name} is not set.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL; got "${raw}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must be an http(s) URL; got "${raw}".`);
  }
  return raw.replace(/\/+$/, "");
};

const appInvoicePath = (env: Env): string => {
  const raw = read(env, "KINKO_APP_INVOICE_PATH") ?? "/app/invoices";
  if (!/^\/[A-Za-z0-9/_-]*$/.test(raw))
    throw new ConfigError(
      `KINKO_APP_INVOICE_PATH must be a path such as /app/invoices; got "${raw}".`,
    );
  return raw;
};

const parseRate = (env: Env): RateSourceConfig => {
  const fixed = read(env, "KINKO_ORACLE_KUSD_PER_NIGHT");
  const url = read(env, "KINKO_ORACLE_RATE_URL");
  if (fixed !== undefined && url !== undefined) {
    throw new ConfigError(
      "Set either KINKO_ORACLE_KUSD_PER_NIGHT or KINKO_ORACLE_RATE_URL, not both.",
    );
  }
  if (fixed !== undefined) {
    if (!/^[0-9]+(\.[0-9]{1,9})?$/.test(fixed) || Number(fixed) <= 0) {
      throw new ConfigError(
        `KINKO_ORACLE_KUSD_PER_NIGHT must be a positive decimal with at most 9 places; got "${fixed}".`,
      );
    }
    return { kind: "static", kusdPerNight: fixed };
  }
  if (url !== undefined) {
    const path = read(env, "KINKO_ORACLE_RATE_PATH");
    if (path === undefined) {
      throw new ConfigError(
        'KINKO_ORACLE_RATE_PATH is required with KINKO_ORACLE_RATE_URL, e.g. "data.night.usd".',
      );
    }
    return { kind: "http", url: httpUrl(env, "KINKO_ORACLE_RATE_URL", undefined), path };
  }
  return { kind: "none" };
};

const parseOracleKey = (env: Env): bigint | undefined => {
  const raw = read(env, "KINKO_ORACLE_SECRET_KEY");
  if (raw === undefined) return undefined;
  const hex = raw.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex) || BigInt(`0x${hex}`) === 0n) {
    throw new ConfigError("KINKO_ORACLE_SECRET_KEY must be up to 64 hex characters and not zero.");
  }
  return BigInt(`0x${hex}`);
};

/**
 * Read and validate the configuration.
 *
 * @param env - The environment; a parameter so tests never touch `process.env`.
 * @returns The validated configuration.
 * @throws {ConfigError} Naming the first variable that is missing or malformed.
 */
export const loadConfig = (env: Env = process.env): Config => {
  const dataKey = read(env, "KINKO_DATA_KEY");
  if (dataKey === undefined) {
    throw new ConfigError(
      "KINKO_DATA_KEY is not set. It seals webhook secrets at rest: 64 hex characters, e.g. the output of `openssl rand -hex 32`. Keep it stable and secret; losing it makes stored webhook secrets unreadable.",
    );
  }
  if (!DATA_KEY_HEX.test(dataKey))
    throw new ConfigError("KINKO_DATA_KEY must be exactly 64 hex characters (32 bytes).");

  const contract = read(env, "KINKO_PAY_ADDRESS")?.replace(/^0x/i, "").toLowerCase();
  if (contract === undefined) {
    throw new ConfigError(
      "KINKO_PAY_ADDRESS is not set. It is the deployed kinko_pay contract address (64 hex characters); without it nothing can be watched.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(contract))
    throw new ConfigError("KINKO_PAY_ADDRESS must be 64 hex characters.");

  const indexerUri = httpUrl(env, "KINKO_INDEXER_URL", "http://localhost:8088/api/v4/graphql");
  const wsFallback = indexerUri.replace(/^http/, "ws").concat("/ws");
  const indexerWsUri = read(env, "KINKO_INDEXER_WS_URL") ?? wsFallback;
  if (!/^wss?:\/\//.test(indexerWsUri))
    throw new ConfigError("KINKO_INDEXER_WS_URL must be a ws(s) URL.");

  const botToken = read(env, "KINKO_BOT_TOKEN");
  if (botToken !== undefined && botToken.length < 32) {
    throw new ConfigError(
      "KINKO_BOT_TOKEN must be at least 32 characters; generate one with `openssl rand -hex 32`.",
    );
  }
  const registrationToken = read(env, "KINKO_REGISTRATION_TOKEN");
  if (registrationToken !== undefined && registrationToken.length < 16) {
    throw new ConfigError("KINKO_REGISTRATION_TOKEN must be at least 16 characters.");
  }

  const level = read(env, "KINKO_LOG_LEVEL") ?? LogLevel.INFO;
  if (!Object.values(LogLevel).includes(level as LogLevel)) {
    throw new ConfigError(
      `KINKO_LOG_LEVEL must be one of ${Object.values(LogLevel).join(", ")}; got "${level}".`,
    );
  }

  return {
    host: read(env, "KINKO_HOST") ?? "127.0.0.1",
    port: integer(env, "KINKO_PORT", integer(env, "PORT", 3100, 0, 65535), 0, 65535),
    dbPath: read(env, "KINKO_DB_PATH") ?? "./data/kinko.db",
    dataKey,
    appUrl: httpUrl(env, "KINKO_APP_URL", "http://localhost:5173"),
    appInvoicePath: appInvoicePath(env),
    corsOrigins: (read(env, "KINKO_CORS_ORIGINS") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: flag(env, "KINKO_TRUST_PROXY"),
    registrationToken,
    botToken,
    chain: {
      contractAddress: contract,
      indexerUri,
      indexerWsUri,
      pollMs: integer(env, "KINKO_POLL_MS", 5_000, 1_000, 300_000),
      lateSettlementMs: integer(env, "KINKO_LATE_SETTLEMENT_DAYS", 14, 0, 365) * DAY_MS,
    },
    oracle: {
      secretKey: parseOracleKey(env),
      rate: parseRate(env),
      quoteTtlSeconds: integer(env, "KINKO_ORACLE_QUOTE_TTL_SECONDS", 600, 30, 600),
    },
    assistant: {
      apiKey: read(env, "KINKO_ASSISTANT_API_KEY"),
      model: read(env, "KINKO_ASSISTANT_MODEL") ?? "gemini-2.5-flash",
    },
    webhooks: {
      allowPrivateTargets: flag(env, "KINKO_ALLOW_PRIVATE_WEBHOOKS"),
      timeoutMs: integer(env, "KINKO_WEBHOOK_TIMEOUT_MS", 10_000, 1_000, 60_000),
    },
    sessionDefaultTtlSeconds: integer(env, "KINKO_SESSION_TTL_SECONDS", 3_600, 60, 30 * 24 * 3_600),
    logLevel: level as LogLevel,
  };
};

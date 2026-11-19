// Configuration, and refusing to start half-configured.
//
// A bot that boots without its token, or without a backend to talk to, looks
// alive and answers every message with an error, which is worse than one that
// does not start. So everything is checked once, up front, and a missing value
// is named with where to get it.

/** The validated configuration. */
export interface BotConfig {
  /** The Telegram bot token, as sent by BotFather. */
  readonly telegramToken: string;
  /** The Kinko backend's address. */
  readonly apiUrl: string;
  /** The service token the backend knows this bot by (its `KINKO_BOT_TOKEN`). */
  readonly serviceToken: string;
  /** Where the bot remembers how far through the event feed it has got. */
  readonly statePath: string;
  /** How long one Telegram long poll lasts, in seconds. */
  readonly pollSeconds: number;
  /** How often the backend's event feed is read, in milliseconds. */
  readonly notifyIntervalMs: number;
}

/** Thrown for any configuration problem; the message is meant for an operator. */
export class ConfigError extends Error {
  /**
   * Create a configuration error.
   *
   * @param message - What is wrong, and where to get the right value.
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The environment a config is read from. */
export type Env = Readonly<Record<string, string | undefined>>;

const integer = (env: Env, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} must be a whole number between ${String(min)} and ${String(max)}; got "${raw}".`,
    );
  }
  return value;
};

/**
 * Read and validate the configuration.
 *
 * @param env - The environment; a parameter so tests never touch `process.env`.
 * @returns The configuration.
 * @throws {ConfigError} Naming the first variable that is missing or malformed.
 */
export const loadConfig = (env: Env = process.env): BotConfig => {
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramToken) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN is not set.\nCreate a bot with @BotFather in Telegram; it replies with a token that looks like 123456789:AA… Put it in the environment and start again.",
    );
  }
  // A token is `<digits>:<secret>`. Catching the shape here turns a confusing 404 from Telegram into a sentence.
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(telegramToken)) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN does not look like a bot token. It should be digits, a colon, then a long secret, exactly as @BotFather sent it.",
    );
  }

  const apiUrl = env.KINKO_API_URL?.trim();
  if (!apiUrl)
    throw new ConfigError(
      "KINKO_API_URL is not set. It is the address of the Kinko backend, such as https://api.kinko.example.",
    );
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new ConfigError(`KINKO_API_URL must be an absolute URL; got "${apiUrl}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new ConfigError("KINKO_API_URL must be an http(s) URL.");

  const serviceToken = env.KINKO_BOT_TOKEN?.trim();
  if (!serviceToken) {
    throw new ConfigError(
      "KINKO_BOT_TOKEN is not set. It is the shared secret the backend was started with as KINKO_BOT_TOKEN; without it the backend refuses the bot.",
    );
  }
  if (serviceToken.length < 32)
    throw new ConfigError(
      "KINKO_BOT_TOKEN must be at least 32 characters, the same value the backend uses.",
    );

  const stateFile = env.KINKO_BOT_STATE?.trim();

  return {
    telegramToken,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    serviceToken,
    statePath: stateFile === undefined || stateFile === "" ? "./kinko-bot-state.json" : stateFile,
    pollSeconds: integer(env, "KINKO_BOT_POLL_SECONDS", 50, 1, 50),
    notifyIntervalMs: integer(env, "KINKO_BOT_NOTIFY_MS", 5_000, 1_000, 300_000),
  };
};

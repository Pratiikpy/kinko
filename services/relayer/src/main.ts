// The relayer's entrypoint: `yarn workspace @kinko/relayer start`. Reads the environment
// (and the file named by RELAYER_ENV_FILE, when set), then runs until it is stopped.

import { ConfigError, loadConfig } from "./config.ts";
import type { Logger } from "./ports.ts";
import { startRelayer } from "./runtime.ts";

const logger: Logger = {
  info: (message) => {
    console.log(`${new Date().toISOString()} ${message}`);
  },
  warn: (message) => {
    console.warn(`${new Date().toISOString()} WARN ${message}`);
  },
};

async function main(): Promise<void> {
  const envFile = process.env.RELAYER_ENV_FILE;
  if (envFile !== undefined && envFile !== "") process.loadEnvFile(envFile);

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const relayer = await startRelayer(config, logger);
  const shutdown = (signal: string): void => {
    logger.info(`${signal}: stopping`);
    relayer.stop().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

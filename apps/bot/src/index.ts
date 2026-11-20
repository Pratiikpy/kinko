#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
// The bot process: read configuration, refuse to start if it is wrong, then
// answer messages and watch for payments until told to stop.

import { HttpBackend } from "./backend.ts";
import { KinkoBot } from "./bot.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { Notifier } from "./notifier.ts";
import { FileCursorStore } from "./state.ts";
import { TelegramClient } from "./telegram.ts";

const log = (message: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
};

const main = async (): Promise<void> => {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const telegram = new TelegramClient(config.telegramToken);
  const backend = new HttpBackend(config.apiUrl, config.serviceToken);
  const bot = new KinkoBot({ telegram, backend, pollSeconds: config.pollSeconds, log });
  const notifier = new Notifier({
    backend,
    telegram,
    cursor: new FileCursorStore(config.statePath),
    intervalMs: config.notifyIntervalMs,
    log,
  });

  const username = await bot.init();
  log(`connected as @${username}; backend ${config.apiUrl}`);
  notifier.start();

  const stop = (signal: string): void => {
    log(`${signal} received, stopping`);
    bot.stop();
    void notifier.stop();
  };
  process.on("SIGINT", () => {
    stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });

  await bot.run();
  await notifier.stop();
};

main().catch((error: unknown) => {
  log(`the bot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

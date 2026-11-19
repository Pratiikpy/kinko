// The backend process: read configuration, refuse to start if it is wrong,
// serve until told to stop.

import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";

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

  const app = createApp(config);
  await app.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${signal} received, stopping\n`);
    void app.stop().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        process.stderr.write(
          `stopped with an error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
};

main().catch((error: unknown) => {
  process.stderr.write(
    `the backend failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

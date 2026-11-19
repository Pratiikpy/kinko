// The command dispatcher. `runCli` is the whole tool; `bin.ts` only connects it
// to the process.

import { KinkoApiError } from "@kinko/node";

import { configCommand, keygen, register } from "./commands/account.ts";
import type { Command } from "./commands/common.ts";
import { link } from "./commands/link.ts";
import { list, status, wait } from "./commands/status.ts";
import { telegram } from "./commands/telegram.ts";
import { decode, manifest, webhook } from "./commands/tools.ts";
import { type CliIo, ExitCode, UsageError } from "./io.ts";

/** This package's version, printed by `--version`. */
export const VERSION = "0.1.0";

const COMMANDS: readonly Command[] = [
  register,
  keygen,
  link,
  status,
  wait,
  list,
  manifest,
  decode,
  webhook,
  telegram,
  configCommand,
];

const overview = (): string =>
  [
    "kinko: private invoices on Midnight, from the command line",
    "",
    "Usage: kinko <command> [options]",
    "",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`),
    "",
    "Settings come from flags, then the environment, then ~/.config/kinko/config.json:",
    "  KINKO_API_URL, KINKO_API_KEY, KINKO_MERCHANT_KEY, KINKO_PAYOUT_ADDRESS, KINKO_WEBHOOK_SECRET",
    "",
    "Run `kinko help <command>` for a command's options.",
  ].join("\n");

/**
 * Run the CLI.
 *
 * @param argv - The arguments after the program name.
 * @param io - The CLI's surroundings.
 * @returns The exit code. Never throws: every failure is reported on standard error.
 */
export const runCli = async (argv: readonly string[], io: CliIo): Promise<ExitCode> => {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    const target = COMMANDS.find((c) => c.name === rest[0]);
    io.out(target ? `${target.summary}\n\n${target.usage}` : overview());
    return name === undefined ? ExitCode.USAGE : ExitCode.OK;
  }
  if (name === "--version" || name === "-v") {
    io.out(VERSION);
    return ExitCode.OK;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    io.err(`Unknown command "${name}". Run \`kinko help\` for the list.`);
    return ExitCode.USAGE;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(`${command.summary}\n\n${command.usage}`);
    return ExitCode.OK;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\nUsage:\n${command.usage}`);
      return ExitCode.USAGE;
    }
    if (error instanceof KinkoApiError) {
      io.err(`${error.message}${error.requestId ? `  (request ${error.requestId})` : ""}`);
      if (error.code === "unauthorized")
        io.err("Check your API key: `kinko config` shows what is in force.");
      return ExitCode.FAILURE;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return ExitCode.FAILURE;
  }
};

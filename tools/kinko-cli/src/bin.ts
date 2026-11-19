#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
// Connects the CLI to the process: real streams, real environment, real clock.

import { runCli } from "./cli.ts";

const code = await runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
  now: Date.now,
});
process.exitCode = code;

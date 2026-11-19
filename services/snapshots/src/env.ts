// The environment the entry point reads: the repository's env file (`KINKO_ENV_FILE`, `.env` by
// default), then the process environment, which wins.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

/** @returns The merged environment. */
export function loadEnv(): Record<string, string | undefined> {
  return { ...readEnvFile(resolve(ROOT, process.env.KINKO_ENV_FILE ?? ".env")), ...process.env };
}

// A CLI wired to a temporary directory and a scripted backend.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shieldedAddressFor } from "@kinko/node";

import { runCli } from "../src/cli.ts";
import type { ExitCode } from "../src/io.ts";

/** One request the CLI made. */
export interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A response, or a function that makes one from the request. */
export type Answer = Response | ((seen: Seen) => Response);

/** A JSON response. */
export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch that answers from a queue and records what it was asked. */
export const scripted = (...answers: Answer[]) => {
  const seen: Seen[] = [];
  let i = 0;
  const impl = ((input: URL | string, init?: RequestInit): Promise<Response> => {
    const request: Seen = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    };
    seen.push(request);
    const answer = answers[Math.min(i++, answers.length - 1)];
    return Promise.resolve(
      (typeof answer === "function" ? answer(request) : (answer ?? json(200, {}))).clone(),
    );
  }) as typeof fetch;
  return { impl, seen };
};

/** The result of one run. */
export interface Run {
  readonly code: ExitCode;
  readonly out: string;
  readonly err: string;
}

/** A workspace: a home directory, a working directory, and a way to run the CLI in them. */
export interface Workspace {
  readonly home: string;
  readonly cwd: string;
  run(
    argv: string[],
    options?: {
      env?: Record<string, string>;
      fetch?: typeof fetch;
      now?: number;
      pollIntervalMs?: number;
    },
  ): Promise<Run>;
  cleanup(): void;
}

/** Create a workspace in a fresh temporary directory. */
export const workspace = (): Workspace => {
  const root = mkdtempSync(join(tmpdir(), "kinko-cli-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  return {
    home,
    cwd,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
    async run(argv, options = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const { mkdirSync } = await import("node:fs");
      mkdirSync(cwd, { recursive: true });
      const code = await runCli(argv, {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
        env: { KINKO_HOME: home, ...options.env },
        cwd,
        now: () => options.now ?? Date.UTC(2027, 0, 15, 12, 0, 0),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
  };
};

/** A session as the backend returns it. */
export const SESSION = {
  id: `cs_${"1".repeat(32)}`,
  status: "pending",
  commitment: "ab".repeat(32),
  kind: "standard",
  asset: "KUSD",
  title: "Invoice 12",
  memo: null,
  amount: null,
  clientReference: "order-9",
  successUrl: null,
  cancelUrl: null,
  createdAt: "2027-01-15T12:00:00.000Z",
  expiresAt: "2027-01-15T13:00:00.000Z",
  settledAt: null,
  contributions: 0,
  onChain: false,
  late: false,
  checkoutUrl: `https://app.kinko.example/checkout?session=cs_${"1".repeat(32)}`,
};

/** What `/v1/config` answers. */
export const CONFIG = {
  contractAddress: "cd".repeat(32),
  appUrl: "https://app.kinko.example",
  payPath: "/pay",
  checkoutPath: "/checkout",
  invoicePath: "/app/invoices",
  oracle: false,
  assistant: false,
};

/** A complete set of settings, for commands that need them. */
export const ENV = {
  KINKO_API_URL: "https://api.kinko.example",
  KINKO_API_KEY: `kk_${"A".repeat(43)}`,
  KINKO_MERCHANT_KEY: "11".repeat(32),
  KINKO_PAYOUT_ADDRESS: shieldedAddressFor(
    new Uint8Array(32).fill(0x12),
    new Uint8Array(32).fill(0x13),
    "undeployed",
  ),
};

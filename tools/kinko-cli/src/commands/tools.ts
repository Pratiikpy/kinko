// `kinko manifest`, `kinko decode` and `kinko webhook verify`.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  constructWebhookEvent,
  decodeInvoiceLink,
  formatAmount,
  SignatureFailure,
  verifyWebhookSignature,
} from "@kinko/node";

import { DEFAULT_MANIFEST, entryOf, readManifest, upsertEntries, writeManifest } from "../files.ts";
import { type CliIo, ExitCode, UsageError } from "../io.ts";
import { type Command, connect, CONNECTION_OPTIONS, parse, printJson } from "./common.ts";
import { allSessions } from "./status.ts";

/** `kinko manifest`. */
export const manifest: Command = {
  name: "manifest",
  summary: "Write kinko.json: your invoices, without any secret",
  usage: "kinko manifest [file] [--limit 100] [--json]",
  async run(argv, io) {
    const { values, positionals } = parse(argv, {
      ...CONNECTION_OPTIONS,
      limit: { type: "string" },
    } as const);
    if (positionals.length > 1) throw new UsageError("Give at most one file name.");
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new UsageError(
        `--limit must be a whole number from 1 to 1000; got "${values.limit ?? ""}".`,
      );
    const { kinko, config } = await connect(values, io);
    const file = positionals[0] ?? DEFAULT_MANIFEST;
    const sessions = await allSessions(kinko, limit);
    const existing = await readManifest(io, file, config.apiUrl ?? "");
    const names = new Map(existing.invoices.map((e) => [e.sessionId, e.name]));
    const path = await writeManifest(
      io,
      file,
      upsertEntries(
        { ...existing, apiUrl: config.apiUrl ?? existing.apiUrl },
        sessions.map((s) => entryOf(s, names.get(s.id) ?? null)),
      ),
    );
    if (values.json) printJson(io, { path, invoices: sessions.length });
    else
      io.out(
        `Wrote ${String(sessions.length)} invoice${sessions.length === 1 ? "" : "s"} to ${path}. It holds no amounts and no secrets, so it is safe to commit.`,
      );
    return ExitCode.OK;
  },
};

/**
 * Read a payment link and print what it says. Needs no network, so it is not asynchronous.
 *
 * @param argv - The arguments after the command name.
 * @param io - The CLI's surroundings.
 * @returns The exit code.
 * @throws {UsageError} When no single link is given.
 */
const decodeLink = (argv: readonly string[], io: CliIo): ExitCode => {
  const { values, positionals } = parse(argv, {
    json: { type: "boolean", default: false },
  } as const);
  const [link] = positionals;
  if (link === undefined || positionals.length > 1)
    throw new UsageError("Give one payment link (or just the part after the #).");
  const facts = decodeInvoiceLink(link);
  if (!facts) {
    io.err("That is not a Kinko payment link. Quote the whole link, including the part after #.");
    return ExitCode.FAILURE;
  }
  if (values.json) printJson(io, facts);
  else {
    io.out(`  amount       ${formatAmount(BigInt(facts.amount))} ${facts.asset}`);
    io.out(`  kind         ${facts.kind}`);
    io.out(
      `  expires      ${facts.expiresAt === 0 ? "never" : new Date(facts.expiresAt * 1000).toISOString()}`,
    );
    io.out(`  commitment   ${facts.commitment}`);
    io.out(`  contract     ${facts.contractAddress}`);
  }
  return ExitCode.OK;
};

/** `kinko decode`. */
export const decode: Command = {
  name: "decode",
  summary: "Read the terms in a payment link",
  usage: "kinko decode <link> [--json]",
  // Wrapped so a usage error rejects, as it does for every other command.
  run: (argv, io) =>
    new Promise((resolve) => {
      resolve(decodeLink(argv, io));
    }),
};

/** `kinko webhook verify`. */
export const webhook: Command = {
  name: "webhook",
  summary: "Check a webhook delivery's signature",
  usage:
    "kinko webhook verify --header <Kinko-Signature value> --body-file <file> [--secret S] [--tolerance 300] [--json]",
  async run(argv, io) {
    const [subcommand, ...rest] = argv;
    if (subcommand !== "verify")
      throw new UsageError("Usage: kinko webhook verify --header … --body-file …");
    const { values } = parse(rest, {
      header: { type: "string" },
      "body-file": { type: "string" },
      secret: { type: "string" },
      tolerance: { type: "string" },
      json: { type: "boolean", default: false },
    } as const);
    if (!values.header || !values["body-file"])
      throw new UsageError("--header and --body-file are required.");
    const secret = values.secret ?? io.env.KINKO_WEBHOOK_SECRET;
    if (!secret)
      throw new UsageError("Give the webhook secret with --secret or KINKO_WEBHOOK_SECRET.");
    const tolerance = values.tolerance === undefined ? undefined : Number(values.tolerance);
    if (tolerance !== undefined && (!Number.isInteger(tolerance) || tolerance < 0))
      throw new UsageError("--tolerance must be a whole number of seconds.");
    // The file is read as bytes: re-encoding the body would change what was signed.
    const body = await readFile(resolve(io.cwd, values["body-file"]));
    const options = {
      ...(tolerance === undefined ? {} : { toleranceSeconds: tolerance }),
      now: io.now,
    };
    const result = verifyWebhookSignature(body, values.header, secret, options);
    if (values.json) printJson(io, result.valid ? { valid: true } : result);
    else if (result.valid) {
      const event = constructWebhookEvent(body, values.header, secret, options);
      io.out(`valid: ${event.type} (${event.id})`);
    } else {
      const why: Record<SignatureFailure, string> = {
        [SignatureFailure.MALFORMED_HEADER]: "the header is missing or malformed",
        [SignatureFailure.TIMESTAMP_OUTSIDE_TOLERANCE]:
          "the timestamp is outside the window: a replay, or a clock that is off",
        [SignatureFailure.MISMATCH]:
          "the signature does not match: wrong secret, or the body was altered",
      };
      io.err(`invalid: ${why[result.reason]}`);
    }
    return result.valid ? ExitCode.OK : ExitCode.FAILURE;
  },
};

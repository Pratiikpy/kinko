// `kinko status`, `kinko wait` and `kinko list`: watching invoices.

import {
  type CheckoutSession,
  type InvoiceStatusReport,
  type Kinko,
  SessionStatus,
  WaitTimeoutError,
} from "@kinko/node";

import { parseDuration } from "../duration.ts";
import { ExitCode, UsageError } from "../io.ts";
import {
  type Command,
  connect,
  CONNECTION_OPTIONS,
  parse,
  printJson,
  resolveRef,
} from "./common.ts";

const describe = (s: CheckoutSession): string[] => [
  `  session        ${s.id}`,
  `  status         ${s.status}${s.late ? " (paid after the session expired)" : ""}`,
  `  commitment     ${s.commitment ?? "(draft: no invoice attached yet)"}`,
  `  kind / asset   ${s.kind} / ${s.asset}`,
  `  contributions  ${String(s.contributions)}`,
  ...(s.title ? [`  title          ${s.title}`] : []),
  ...(s.clientReference ? [`  reference      ${s.clientReference}`] : []),
  `  expires        ${s.expiresAt}`,
  ...(s.settledAt ? [`  settled        ${s.settledAt}`] : []),
  `  checkout       ${s.checkoutUrl}`,
];

const chainLine = (r: InvoiceStatusReport): string =>
  r.found
    ? `${r.status}, ${String(r.contributions)} contribution${r.contributions === 1 ? "" : "s"}`
    : "not on chain yet";

const STATUS_OPTIONS = { ...CONNECTION_OPTIONS, manifest: { type: "string" } } as const;

/** `kinko status`. */
export const status: Command = {
  name: "status",
  summary: "Show where an invoice stands",
  usage: "kinko status <session-id | commitment | name> [--manifest kinko.json] [--json]",
  async run(argv, io) {
    const { values, positionals } = parse(argv, STATUS_OPTIONS);
    const [ref] = positionals;
    if (ref === undefined || positionals.length > 1)
      throw new UsageError("Give one reference: a session id, a commitment or a manifest name.");
    const { kinko, config } = await connect(values, io);
    const target = await resolveRef(io, ref, values.manifest, config.apiUrl ?? "");
    const session = target.sessionId
      ? await kinko.checkout.sessions.retrieve(target.sessionId)
      : undefined;
    const commitment = session?.commitment ?? target.commitment;
    const onChain = commitment ? await kinko.chain.invoiceStatus(commitment) : undefined;
    if (values.json) printJson(io, { session: session ?? null, chain: onChain ?? null });
    else {
      if (session) for (const line of describe(session)) io.out(line);
      if (onChain) io.out(`  on chain       ${chainLine(onChain)}`);
      if (!session && !onChain) io.out("  nothing to report");
    }
    return ExitCode.OK;
  },
};

const WAIT_OPTIONS = {
  ...STATUS_OPTIONS,
  timeout: { type: "string" },
  interval: { type: "string" },
} as const;

const exitFor = (s: CheckoutSession): ExitCode =>
  s.status === SessionStatus.SETTLED ? ExitCode.OK : ExitCode.NOT_PAID;

/** `kinko wait`. */
export const wait: Command = {
  name: "wait",
  summary: "Poll an invoice until it is paid, cancelled or expired",
  usage:
    "kinko wait <session-id | name> [--timeout 10m] [--interval 2s] [--manifest kinko.json] [--json]\nExits 0 when paid, 3 when cancelled or expired, 4 on timeout.",
  async run(argv, io) {
    const { values, positionals } = parse(argv, WAIT_OPTIONS);
    const [ref] = positionals;
    if (ref === undefined || positionals.length > 1)
      throw new UsageError("Give one reference: a session id or a manifest name.");
    const { kinko, config } = await connect(values, io);
    const target = await resolveRef(io, ref, values.manifest, config.apiUrl ?? "");
    if (!target.sessionId)
      throw new UsageError(
        "wait follows a session. A commitment alone has none; use `kinko status` to read it once.",
      );
    const timeoutMs =
      values.timeout === undefined ? 600_000 : parseDuration(values.timeout, "--timeout") * 1000;
    const intervalMs =
      io.pollIntervalMs ??
      (values.interval === undefined ? 2_000 : parseDuration(values.interval, "--interval") * 1000);
    let last: SessionStatus | undefined;
    try {
      const final = await kinko.checkout.sessions.waitForSettlement(target.sessionId, {
        timeoutMs,
        intervalMs,
        onPoll: (s) => {
          if (s.status !== last && !values.json)
            io.err(
              `${s.status}${s.contributions > 0 ? ` (${String(s.contributions)} contribution${s.contributions === 1 ? "" : "s"})` : ""}`,
            );
          last = s.status;
        },
      });
      if (values.json) printJson(io, { session: final });
      else for (const line of describe(final)) io.out(line);
      return exitFor(final);
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      if (values.json) printJson(io, { session: error.session, timedOut: true });
      else
        io.err(
          `Still ${error.session.status} after ${String(timeoutMs / 1000)} seconds. Run the command again to keep waiting.`,
        );
      return ExitCode.TIMEOUT;
    }
  },
};

const LIST_OPTIONS = {
  ...CONNECTION_OPTIONS,
  status: { type: "string" },
  limit: { type: "string" },
  before: { type: "string" },
} as const;

/**
 * Read a page-size flag.
 *
 * @param text - What the user typed, or undefined.
 * @returns The page size, defaulting to 25.
 * @throws {UsageError} For anything but a whole number from 1 to 100.
 */
const parseLimit = (text: string | undefined): number => {
  if (text === undefined) return 25;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw new UsageError(`--limit must be a whole number from 1 to 100; got "${text}".`);
  return n;
};

/**
 * Read a status filter flag.
 *
 * @param text - What the user typed, or undefined.
 * @returns The status to filter by, or undefined for all.
 * @throws {UsageError} For a word that is not a status.
 */
const parseStatus = (text: string | undefined): SessionStatus | undefined => {
  if (text === undefined) return undefined;
  const wanted = text.toLowerCase();
  const found = Object.values(SessionStatus).find((s) => (s as string) === wanted);
  if (!found)
    throw new UsageError(
      `--status must be one of ${Object.values(SessionStatus).join(", ")}; got "${text}".`,
    );
  return found;
};

/** `kinko list`. */
export const list: Command = {
  name: "list",
  summary: "List your recent invoices",
  usage: `kinko list [--status ${Object.values(SessionStatus).join("|")}] [--limit 25] [--before <cursor>] [--json]`,
  async run(argv, io) {
    const { values } = parse(argv, LIST_OPTIONS);
    const { kinko } = await connect(values, io);
    const filter = parseStatus(values.status);
    const page = await kinko.checkout.sessions.list({
      limit: parseLimit(values.limit),
      ...(filter === undefined ? {} : { status: filter }),
      ...(values.before === undefined ? {} : { before: values.before }),
    });
    if (values.json) printJson(io, page);
    else if (page.data.length === 0) io.out("No invoices.");
    else {
      for (const s of page.data)
        io.out(
          `${s.id}  ${s.status.padEnd(9)}  ${s.kind.padEnd(8)}  ${s.asset.padEnd(6)}  ${(s.commitment ?? "draft").slice(0, 12).padEnd(12)}  ${s.title ?? ""}`.trimEnd(),
        );
      if (page.nextCursor) io.out(`\nMore: kinko list --before ${page.nextCursor}`);
    }
    return ExitCode.OK;
  },
};

/**
 * Read sessions page after page, up to a limit. Exported so the manifest command can walk every page.
 *
 * @param kinko - The client.
 * @param max - The most sessions to read.
 * @returns The sessions, newest first.
 */
export const allSessions = async (kinko: Kinko, max: number): Promise<CheckoutSession[]> => {
  const out: CheckoutSession[] = [];
  let before: string | undefined;
  while (out.length < max) {
    const page = await kinko.checkout.sessions.list({
      limit: Math.min(100, max - out.length),
      ...(before === undefined ? {} : { before }),
    });
    out.push(...page.data);
    if (!page.nextCursor) break;
    before = page.nextCursor;
  }
  return out;
};

// What every command shares.

import { parseArgs, type ParseArgsConfig } from "node:util";

import { Asset, InvoiceKind, type Kinko } from "@kinko/node";

import { type ConfigFlags, makeClient, resolveConfig, type ResolvedConfig } from "../config.ts";
import { DEFAULT_MANIFEST, readManifest } from "../files.ts";
import { type CliIo, type ExitCode, UsageError } from "../io.ts";

/** A command: its name, a line of help, and what it does. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /**
   * Run the command.
   *
   * @param argv - The arguments after the command name.
   * @param io - The CLI's surroundings.
   * @returns The exit code.
   * @throws {UsageError} When the command line is wrong.
   */
  run(argv: readonly string[], io: CliIo): Promise<ExitCode>;
}

/** Flags every command that talks to the backend accepts. */
export const CONNECTION_OPTIONS = {
  "api-url": { type: "string" },
  "api-key": { type: "string" },
  json: { type: "boolean", default: false },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

/**
 * Parse a command's arguments, turning the parser's complaints into usage errors.
 *
 * @param argv - The arguments after the command name.
 * @param options - The flags the command accepts.
 * @returns The parsed flags and positionals.
 * @throws {UsageError} For an unknown flag or a flag missing its value.
 */
export const parse = <O extends NonNullable<ParseArgsConfig["options"]>>(
  argv: readonly string[],
  options: O,
) => {
  try {
    return parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(
      error instanceof Error
        ? error.message.replace(/\. To specify a positional.*$/, ".")
        : String(error),
    );
  }
};

/**
 * Print a value as JSON on standard output.
 *
 * @param io - The CLI's surroundings.
 * @param value - What to print.
 */
export const printJson = (io: CliIo, value: unknown): void => {
  io.out(JSON.stringify(value, null, 2));
};

/**
 * Build the SDK client for a command, from flags, environment and the settings file.
 *
 * @param flags - The connection flags the command was given.
 * @param io - The CLI's surroundings.
 * @param needsKeys - Whether the command builds invoices.
 * @returns The client and the settings it was built from.
 */
export const connect = async (
  flags: ConfigFlags,
  io: CliIo,
  needsKeys = false,
): Promise<{ kinko: Kinko; config: ResolvedConfig }> => {
  const config = await resolveConfig(io, flags);
  return { kinko: makeClient(config, io, needsKeys), config };
};

const KIND_NAMES: Readonly<Record<string, InvoiceKind>> = {
  standard: InvoiceKind.STANDARD,
  multipay: InvoiceKind.MULTIPAY,
  donation: InvoiceKind.DONATION,
};

const ASSET_NAMES: Readonly<Record<string, Asset>> = {
  kusd: Asset.KUSD,
  usd: Asset.KUSD,
  native: Asset.NATIVE,
  night: Asset.NATIVE,
};

/**
 * Read an invoice kind from a flag.
 *
 * @param value - What the user typed, or undefined.
 * @returns The kind, defaulting to standard.
 * @throws {UsageError} For a name that is not a kind.
 */
export const parseKind = (value: string | undefined): InvoiceKind => {
  if (value === undefined) return InvoiceKind.STANDARD;
  const kind = KIND_NAMES[value.toLowerCase()];
  if (!kind) throw new UsageError(`--kind must be standard, multipay or donation; got "${value}".`);
  return kind;
};

/**
 * Read an asset from a flag.
 *
 * @param value - What the user typed, or undefined.
 * @returns The asset, defaulting to KUSD.
 * @throws {UsageError} For a name that is not an asset.
 */
export const parseAsset = (value: string | undefined): Asset => {
  if (value === undefined) return Asset.KUSD;
  const asset = ASSET_NAMES[value.toLowerCase()];
  if (!asset) throw new UsageError(`--asset must be kusd or night; got "${value}".`);
  return asset;
};

/** What a reference can be. */
export interface Reference {
  readonly sessionId?: string;
  readonly commitment?: string;
}

/**
 * Work out what the user meant by `<ref>`: a session id, a commitment, or a
 * name from the manifest in the working directory.
 *
 * @param io - The CLI's surroundings.
 * @param ref - What was typed.
 * @param manifestFile - The manifest to look names up in.
 * @param apiUrl - The backend address, for reading a manifest.
 * @returns The session id or the commitment.
 * @throws {UsageError} When it is none of those.
 */
export const resolveRef = async (
  io: CliIo,
  ref: string,
  manifestFile: string | undefined,
  apiUrl: string,
): Promise<Reference> => {
  if (/^cs_[0-9a-f]{32}$/.test(ref)) return { sessionId: ref };
  const hex = ref.replace(/^0x/i, "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return { commitment: hex };
  const manifest = await readManifest(io, manifestFile ?? DEFAULT_MANIFEST, apiUrl);
  const entry = manifest.invoices.find((e) => e.name === ref);
  if (!entry) {
    const known = manifest.invoices.flatMap((e) => (e.name ? [`"${e.name}"`] : []));
    throw new UsageError(
      `"${ref}" is not a session id (cs_…), a commitment (64 hex characters) or a name in ${manifestFile ?? DEFAULT_MANIFEST}${known.length > 0 ? `. Known names: ${known.join(", ")}` : ""}.`,
    );
  }
  return { sessionId: entry.sessionId };
};

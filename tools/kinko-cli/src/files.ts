// The manifest: a shareable record of a project's invoices.
//
// It is meant to be committed next to the code that sells things, so it holds
// only what is already public or the merchant's own labels. The secrets that
// publish and close an invoice live in the user's own directory (see the SDK's
// `saveInvoiceSecrets`), never here.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CheckoutSession } from "@kinko/node";

import type { CliIo } from "./io.ts";

/** One line of the manifest. Nothing in it is secret. */
export interface ManifestEntry {
  /** A label of the merchant's choosing, for looking the invoice up by name. */
  name: string | null;
  sessionId: string;
  commitment: string | null;
  kind: string;
  asset: string;
  status: string;
  title: string | null;
  clientReference: string | null;
  /** The hosted checkout page, without the terms fragment. */
  checkoutUrl: string;
  createdAt: string;
  expiresAt: string;
}

/** The manifest file. */
export interface Manifest {
  version: 1;
  generatedAt: string;
  apiUrl: string;
  invoices: ManifestEntry[];
}

/**
 * Turn a session into a manifest line.
 *
 * @param session - The backend's view of it.
 * @param name - The merchant's label, if any.
 * @returns The entry. The display amount is left out on purpose.
 */
export const entryOf = (session: CheckoutSession, name: string | null): ManifestEntry => ({
  name,
  sessionId: session.id,
  commitment: session.commitment,
  kind: session.kind,
  asset: session.asset,
  status: session.status,
  title: session.title,
  clientReference: session.clientReference,
  checkoutUrl: session.checkoutUrl,
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
});

/** The manifest's default file name, in the working directory. */
export const DEFAULT_MANIFEST = "kinko.json";

/**
 * Read a manifest, or an empty one when the file does not exist.
 *
 * @param io - The CLI's surroundings.
 * @param file - A path, relative to the working directory.
 * @param apiUrl - The backend address, for a new manifest.
 * @returns The manifest.
 * @throws {Error} When the file exists but is not a manifest.
 */
export const readManifest = async (io: CliIo, file: string, apiUrl: string): Promise<Manifest> => {
  const path = resolve(io.cwd, file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, generatedAt: new Date(io.now()).toISOString(), apiUrl, invoices: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, { cause });
  }
  const manifest = parsed as Partial<Manifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.invoices))
    throw new Error(`${path} is not a Kinko manifest (expected version 1 with an invoices list).`);
  return manifest as Manifest;
};

/**
 * Write a manifest atomically, so a crash never leaves half a file.
 *
 * @param io - The CLI's surroundings.
 * @param file - A path, relative to the working directory.
 * @param manifest - What to write.
 * @returns The absolute path written.
 */
export const writeManifest = async (
  io: CliIo,
  file: string,
  manifest: Manifest,
): Promise<string> => {
  const path = resolve(io.cwd, file);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    temporary,
    `${JSON.stringify({ ...manifest, generatedAt: new Date(io.now()).toISOString() }, null, 2)}\n`,
  );
  await rename(temporary, path);
  return path;
};

/**
 * Add or replace entries, keyed by session id.
 *
 * @param manifest - The manifest to change.
 * @param entries - The entries to put in.
 * @returns A new manifest; the old one is untouched.
 */
export const upsertEntries = (manifest: Manifest, entries: readonly ManifestEntry[]): Manifest => {
  const bySession = new Map(manifest.invoices.map((e) => [e.sessionId, e]));
  for (const entry of entries)
    bySession.set(entry.sessionId, {
      ...entry,
      name: entry.name ?? bySession.get(entry.sessionId)?.name ?? null,
    });
  return { ...manifest, invoices: [...bySession.values()] };
};

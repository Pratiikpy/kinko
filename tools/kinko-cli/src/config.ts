// The CLI's view of the shared settings: flag names in place of option names,
// and usage errors in place of library ones.

import {
  clientFromSettings,
  type Kinko,
  MissingSettingsError,
  readSettings,
  type ResolvedSettings,
  resolveSettings,
  saveSettings,
  settingsPath,
  type StoredSettings,
} from "@kinko/node";

import { type CliIo, UsageError } from "./io.ts";

/** Everything the CLI remembers between runs. */
export type StoredConfig = StoredSettings;

/** The settings in force for one run. */
export type ResolvedConfig = ResolvedSettings;

/** Settings given on the command line, which win over everything else. */
export interface ConfigFlags {
  readonly "api-url"?: string | undefined;
  readonly "api-key"?: string | undefined;
  readonly "merchant-key"?: string | undefined;
  readonly "payout-address"?: string | undefined;
}

/**
 * Where the settings file lives.
 *
 * @param io - The CLI's surroundings.
 * @returns The file's path.
 */
export const configPath = (io: CliIo): string => settingsPath(io.env);

/**
 * Read the settings file; empty when there is none.
 *
 * @param io - The CLI's surroundings.
 * @returns What the file holds.
 */
export const readStoredConfig = (io: CliIo): Promise<StoredConfig> => readSettings(io.env);

/**
 * Merge settings into the file, owner-only.
 *
 * @param io - The CLI's surroundings.
 * @param update - The settings to set.
 * @returns The path written.
 */
export const saveStoredConfig = (io: CliIo, update: StoredConfig): Promise<string> =>
  saveSettings(io.env, update);

/**
 * Work out the settings: a flag beats an environment variable beats the file.
 *
 * @param io - The CLI's surroundings.
 * @param flags - Settings given on the command line.
 * @returns The settings in force.
 */
export const resolveConfig = (io: CliIo, flags: ConfigFlags = {}): Promise<ResolvedConfig> =>
  resolveSettings(io.env, {
    apiUrl: flags["api-url"],
    apiKey: flags["api-key"],
    merchantKey: flags["merchant-key"],
    payoutAddress: flags["payout-address"],
  });

/**
 * Build an SDK client from the settings, saying exactly what is missing.
 *
 * @param config - The resolved settings.
 * @param io - The CLI's surroundings.
 * @param needsKeys - Whether the command builds invoices and so needs the merchant's keys.
 * @returns The client.
 * @throws {UsageError} Naming each missing setting and how to set it.
 */
export const makeClient = (config: ResolvedConfig, io: CliIo, needsKeys: boolean): Kinko => {
  try {
    return clientFromSettings(config, {
      needsKeys,
      now: io.now,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
  } catch (error) {
    if (error instanceof MissingSettingsError)
      throw new UsageError(
        `${error.message} Flags --api-url, --api-key, --merchant-key and --payout-address also work.`,
      );
    throw error;
  }
};

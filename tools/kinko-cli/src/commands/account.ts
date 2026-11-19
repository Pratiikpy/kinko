// Setting up: `kinko keygen`, `kinko register` and `kinko config`.

import { randomBytes } from "node:crypto";

import { Kinko } from "@kinko/node";

import { configPath, readStoredConfig, resolveConfig, saveStoredConfig } from "../config.ts";
import { ExitCode, UsageError } from "../io.ts";
import { type Command, parse, printJson } from "./common.ts";

/** `kinko keygen`. */
export const keygen: Command = {
  name: "keygen",
  summary: "Make a merchant identity key",
  usage: "kinko keygen [--save]",
  async run(argv, io) {
    const { values } = parse(argv, {
      save: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    } as const);
    const key = randomBytes(32).toString("hex");
    if (values.save) await saveStoredConfig(io, { merchantKey: key });
    if (values.json) printJson(io, { merchantKey: key, saved: values.save });
    else {
      io.out(key);
      io.err(
        `\nThis identifies you on every invoice you make. Back it up: nothing else holds a copy.\n${
          values.save
            ? `Saved to ${configPath(io)}.`
            : "Run with --save to keep it in your settings file, or set KINKO_MERCHANT_KEY."
        }\nYour payout address is different: it is the shielded address of the wallet you want to be paid at (mn_shield-addr_…), and comes from that wallet.`,
      );
    }
    return ExitCode.OK;
  },
};

/** `kinko register`. */
export const register: Command = {
  name: "register",
  summary: "Register as a merchant and get an API key",
  usage:
    "kinko register --name <name> [--webhook-url <https url>] [--registration-token T] [--api-url U] [--save] [--json]",
  async run(argv, io) {
    const { values } = parse(argv, {
      name: { type: "string" },
      "webhook-url": { type: "string" },
      "registration-token": { type: "string" },
      "api-url": { type: "string" },
      save: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    } as const);
    if (!values.name) throw new UsageError("--name is required.");
    const config = await resolveConfig(io, { "api-url": values["api-url"] });
    if (!config.apiUrl)
      throw new UsageError("Missing the backend address (--api-url, KINKO_API_URL).");
    const token = values["registration-token"] ?? io.env.KINKO_REGISTRATION_TOKEN;
    const registration = await Kinko.register({
      baseUrl: config.apiUrl,
      name: values.name,
      ...(values["webhook-url"] === undefined ? {} : { webhookUrl: values["webhook-url"] }),
      ...(token === undefined ? {} : { registrationToken: token }),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    const saved = values.save
      ? await saveStoredConfig(io, {
          apiUrl: config.apiUrl,
          apiKey: registration.apiKey.key,
          webhookSecret: registration.webhookSecret,
        })
      : undefined;
    if (values.json) printJson(io, { ...registration, savedTo: saved ?? null });
    else {
      io.out(`Registered ${registration.merchant.name} (${registration.merchant.id}).\n`);
      io.out(`  API key         ${registration.apiKey.key}`);
      io.out(`  webhook secret  ${registration.webhookSecret}\n`);
      io.out(
        "Both are shown once. The backend keeps only a hash of the key and a sealed copy of the secret.",
      );
      io.out(
        saved
          ? `Saved to ${saved} (owner-only).`
          : "Run again with --save to keep them in your settings file, or put them in KINKO_API_KEY and KINKO_WEBHOOK_SECRET.",
      );
    }
    return ExitCode.OK;
  },
};

/**
 * Show a secret as its first and last characters only.
 *
 * @param value - The secret, if there is one.
 * @returns A shortened form, or a word saying whether it is set.
 */
const redact = (value: string | undefined): string =>
  value === undefined
    ? "(not set)"
    : value.length <= 10
      ? "(set)"
      : `${value.slice(0, 6)}…${value.slice(-4)}`;

/** `kinko config`. */
export const configCommand: Command = {
  name: "config",
  summary: "Show the settings in force and where they come from",
  usage: "kinko config [--json]",
  async run(argv, io) {
    const { values } = parse(argv, { json: { type: "boolean", default: false } } as const);
    const effective = await resolveConfig(io);
    const stored = await readStoredConfig(io);
    const view = {
      file: configPath(io),
      fileExists: Object.keys(stored).length > 0,
      apiUrl: effective.apiUrl ?? null,
      apiKey: redact(effective.apiKey),
      webhookSecret: redact(effective.webhookSecret),
      merchantKey: redact(effective.merchantKey),
      payoutAddress: effective.payoutAddress ?? null,
    };
    if (values.json) printJson(io, view);
    else {
      io.out(`settings file   ${view.file}${view.fileExists ? "" : " (none yet)"}`);
      io.out(`api url         ${view.apiUrl ?? "(not set)"}`);
      io.out(`api key         ${view.apiKey}`);
      io.out(`webhook secret  ${view.webhookSecret}`);
      io.out(`merchant key    ${view.merchantKey}`);
      io.out(`payout address  ${view.payoutAddress ?? "(not set)"}`);
    }
    return ExitCode.OK;
  },
};

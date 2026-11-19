// `kinko link`: make a payment link for an invoice.
//
// Two ways, depending on who holds the invoice's secrets.
//
//   kinko link 25.50 …   The invoice is built here, with your keys. You get the
//                        links straight away and the secrets go to a private file
//                        that the Kinko app publishes with your wallet.
//   kinko link --draft … A draft is registered and you get an address in the web
//                        app where your wallet creates the invoice itself. No
//                        secret ever passes through this tool.

import { formatAmount, parseAmount, saveInvoiceSecrets } from "@kinko/node";

import { parseDuration } from "../duration.ts";
import { DEFAULT_MANIFEST, entryOf, readManifest, upsertEntries, writeManifest } from "../files.ts";
import { ExitCode, UsageError } from "../io.ts";
import {
  type Command,
  connect,
  CONNECTION_OPTIONS,
  parse,
  parseAsset,
  parseKind,
  printJson,
} from "./common.ts";

const OPTIONS = {
  ...CONNECTION_OPTIONS,
  "merchant-key": { type: "string" },
  "payout-address": { type: "string" },
  kind: { type: "string" },
  asset: { type: "string" },
  title: { type: "string" },
  memo: { type: "string" },
  ref: { type: "string" },
  name: { type: "string" },
  expires: { type: "string" },
  "success-url": { type: "string" },
  "cancel-url": { type: "string" },
  "store-amount": { type: "boolean", default: false },
  draft: { type: "boolean", default: false },
  manifest: { type: "string" },
  "no-manifest": { type: "boolean", default: false },
} as const;

/** `kinko link`. */
export const link: Command = {
  name: "link",
  summary: "Create an invoice and a hosted payment link",
  usage: `kinko link <amount> [--kind standard|multipay|donation] [--asset kusd|night] [--title T] [--memo M]
                  [--ref R] [--name N] [--expires 1h] [--success-url U] [--cancel-url U]
                  [--store-amount] [--manifest kinko.json | --no-manifest] [--json]
kinko link --draft [--title T] [--memo M] [--kind K] [--asset A] [--expires 1h] [--name N]`,
  async run(argv, io) {
    const { values, positionals } = parse(argv, OPTIONS);
    const [amountText, ...extra] = positionals;
    if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0] ?? ""}".`);
    const draft = values.draft;
    if (draft && amountText !== undefined)
      throw new UsageError(
        "A draft has no amount here: your wallet sets it in the web app. Drop the amount, or drop --draft.",
      );
    if (!draft && amountText === undefined)
      throw new UsageError("Give an amount, such as `kinko link 25.50`, or use --draft.");
    if (draft && values["store-amount"])
      throw new UsageError("--store-amount needs an amount, so it cannot be used with --draft.");

    const { kinko, config } = await connect(values, io, !draft);
    const kind = parseKind(values.kind);
    const asset = parseAsset(values.asset);
    const expiresInSeconds =
      values.expires === undefined ? undefined : parseDuration(values.expires, "--expires");
    const text = {
      ...(values.title === undefined ? {} : { title: values.title }),
      ...(values.memo === undefined ? {} : { memo: values.memo }),
      ...(values.ref === undefined ? {} : { clientReference: values.ref }),
      ...(values["success-url"] === undefined ? {} : { successUrl: values["success-url"] }),
      ...(values["cancel-url"] === undefined ? {} : { cancelUrl: values["cancel-url"] }),
    };

    let result: Record<string, unknown>;
    let sessionEntry;
    if (draft) {
      const made = await kinko.checkout.drafts.create({
        kind,
        asset,
        ...text,
        ...(expiresInSeconds === undefined ? {} : { ttlSeconds: expiresInSeconds }),
      });
      sessionEntry = entryOf(made.session, values.name ?? null);
      result = { session: made.session, formUrl: made.formUrl };
      if (!values.json) {
        io.out(
          "Draft created. Open this address in the Kinko web app with your wallet to create the invoice:\n",
        );
        io.out(`  ${made.formUrl}\n`);
        io.out(`  session  ${made.session.id}`);
        io.out(`  expires  ${made.session.expiresAt}\n`);
        io.out(
          `The address carries a one-time token in its fragment; treat it like a password. Then: kinko wait ${made.session.id}`,
        );
      }
    } else {
      const units = parseAmount(amountText ?? "");
      const checkout = await kinko.checkout.create({
        amount: units,
        kind,
        asset,
        storeAmount: values["store-amount"],
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        ...text,
      });
      const secretsFile = await saveInvoiceSecrets(io.env, checkout.invoice, io.now());
      sessionEntry = entryOf(checkout.session, values.name ?? null);
      const { ownerSecret: _ownerSecret, salt: _salt, ...publicInvoice } = checkout.invoice;
      result = {
        checkoutUrl: checkout.checkoutUrl,
        paymentLink: checkout.paymentLink,
        session: checkout.session,
        invoice: publicInvoice,
        secretsFile,
      };
      if (!values.json) {
        io.out("Invoice link ready.\n");
        io.out(`  checkout    ${checkout.checkoutUrl}`);
        io.out(`  pay link    ${checkout.paymentLink}`);
        io.out(`  session     ${checkout.session.id}`);
        io.out(`  commitment  ${checkout.invoice.commitment}`);
        io.out(
          `  amount      ${formatAmount(units)} ${asset}  (kept on this machine${values["store-amount"] ? ", and stored with the backend because you asked" : "; the backend was not told"})`,
        );
        io.out(`  expires     ${checkout.session.expiresAt}\n`);
        io.out(
          `The invoice's secrets, needed to publish and close it, were saved to ${secretsFile} (owner-only).`,
        );
        io.out(
          "They are not shown and not sent anywhere. The link carries the terms in its fragment, which a browser never sends to a server.",
        );
        io.out(
          `\nPublish it with your wallet: open ${new URL("/app/invoices", checkout.checkoutUrl).toString()} and choose that file under "Publish an invoice made elsewhere". Then: kinko wait ${checkout.session.id}`,
        );
      }
    }

    if (!values["no-manifest"]) {
      const file = values.manifest ?? DEFAULT_MANIFEST;
      const apiUrl = config.apiUrl ?? "";
      const path = await writeManifest(
        io,
        file,
        upsertEntries(await readManifest(io, file, apiUrl), [sessionEntry]),
      );
      if (!values.json) io.out(`Manifest updated: ${path}`);
      result = { ...result, manifest: path };
    }
    if (values.json) printJson(io, result);
    return ExitCode.OK;
  },
};

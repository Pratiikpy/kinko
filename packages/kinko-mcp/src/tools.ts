// The tools an assistant can call.
//
// What an assistant is told is a design decision. It is a third party: whatever
// a tool returns has left the machine. So no tool returns an invoice's owner
// secret or salt, which are saved to a private file instead, and `kinko_create_draft`
// exists for the cases where even the invoice's terms should not pass through
// the assistant: the wallet in the web app makes the invoice and the assistant
// sees only a one-time address. None of these tools can pay, publish or move
// funds, and that is deliberate: an autonomous agent should not be handed the
// ability to spend on someone's behalf by default.

import {
  type Asset,
  type CheckoutSession,
  clientFromSettings,
  decodeInvoiceLink,
  formatAmount,
  type InvoiceKind,
  type Kinko,
  MissingSettingsError,
  parseAmount,
  resolveSettings,
  saveInvoiceSecrets,
  SessionStatus,
  SignatureFailure,
  verifyWebhookSignature,
  WaitTimeoutError,
} from "@kinko/node";

import { type ObjectSchema, ToolInputError, validateArgs } from "./schema.ts";

/** What tools need from the process. */
export interface ToolContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly now: () => number;
  /** Longest a single `kinko_wait_for_payment` may block, in milliseconds. */
  readonly maxWaitMs?: number;
  /** How often a wait looks, in milliseconds. */
  readonly pollIntervalMs?: number;
}

/** What a tool returns: text for the model, the same facts as data, and whether it failed. */
export interface ToolResult {
  readonly text: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

/** A tool as `tools/list` shows it. */
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ObjectSchema;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

interface Tool extends ToolDefinition {
  readonly run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const LOCAL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const KIND = {
  type: "string",
  enum: ["standard", "multipay", "donation"],
  description:
    "standard settles on the first payment; multipay and donation take many payments until you close them. Defaults to standard.",
} as const;
const ASSET = {
  type: "string",
  enum: ["KUSD", "NATIVE"],
  description: "KUSD is Kinko's dollar; NATIVE is NIGHT. Defaults to KUSD.",
} as const;
const EXPIRES = {
  type: "integer",
  minimum: 1,
  maximum: 43_200,
  description:
    "Minutes until the invoice stops accepting payment. Omit for the hosted page's default of one hour.",
} as const;
const TITLE = {
  type: "string",
  maxLength: 120,
  description: "A short name the merchant will recognise, shown to the payer.",
} as const;
const MEMO = {
  type: "string",
  maxLength: 500,
  description: "A longer note shown to the payer.",
} as const;

const settings = async (ctx: ToolContext) => resolveSettings(ctx.env);

const connect = async (ctx: ToolContext, needsKeys: boolean): Promise<Kinko> => {
  try {
    return clientFromSettings(await settings(ctx), {
      needsKeys,
      now: ctx.now,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
  } catch (error) {
    if (error instanceof MissingSettingsError) {
      throw new ToolInputError(
        `${error.message} Set them in the server's environment (KINKO_API_URL, KINKO_API_KEY, KINKO_MERCHANT_KEY, KINKO_PAYOUT_ADDRESS) or run \`kinko register --save\` and \`kinko keygen --save\`.`,
      );
    }
    throw error;
  }
};

const describeSession = (s: CheckoutSession): string =>
  [
    `session ${s.id}: ${s.status}${s.late ? " (paid after it expired)" : ""}`,
    `${s.kind} invoice in ${s.asset}, ${String(s.contributions)} payment${s.contributions === 1 ? "" : "s"}`,
    s.title ? `title: ${s.title}` : undefined,
    s.clientReference ? `reference: ${s.clientReference}` : undefined,
    `expires ${s.expiresAt}`,
    s.commitment ? `commitment ${s.commitment}` : "no invoice attached yet (draft)",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

const minutes = (m: unknown): number | undefined => (typeof m === "number" ? m * 60 : undefined);

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);

const TOOLS: readonly Tool[] = [
  {
    name: "kinko_create_invoice",
    title: "Create an invoice",
    description:
      "Create a private invoice and a hosted checkout link. The amount and the merchant's keys are never sent to the Kinko backend: " +
      "they travel only inside the link's fragment, which a browser does not send to a server. The link is returned for you to give to the payer. " +
      "The invoice still has to be published on chain with the merchant's wallet before it can be paid: the merchant opens the Kinko app's Invoices page and chooses the saved invoice file. This tool cannot pay or publish anything. " +
      "Note that the link contains the invoice's terms, so the assistant sees them; use kinko_create_draft to avoid that.",
    annotations: WRITES,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["amount"],
      properties: {
        amount: {
          type: "string",
          maxLength: 24,
          description:
            'Whole units as a decimal string, for example "25.50". Up to six decimal places.',
        },
        kind: KIND,
        asset: ASSET,
        title: TITLE,
        memo: MEMO,
        client_reference: {
          type: "string",
          maxLength: 200,
          description:
            "The merchant's own reference, such as an order number. Not shown to the payer.",
        },
        expires_in_minutes: EXPIRES,
        store_amount: {
          type: "boolean",
          description:
            "Also store the amount with the backend, for its hosted page to display. Default false: the backend is told nothing about the amount.",
        },
      },
    },
    async run(args, ctx) {
      const kinko = await connect(ctx, true);
      let units: bigint;
      try {
        units = parseAmount(String(args.amount));
      } catch (error) {
        throw new ToolInputError(error instanceof Error ? error.message : "Invalid amount.");
      }
      const checkout = await kinko.checkout.create({
        amount: units,
        ...optional("kind", args.kind as InvoiceKind | undefined),
        ...optional("asset", args.asset as Asset | undefined),
        ...optional("title", args.title as string | undefined),
        ...optional("memo", args.memo as string | undefined),
        ...optional("clientReference", args.client_reference as string | undefined),
        ...optional("expiresInSeconds", minutes(args.expires_in_minutes)),
        storeAmount: args.store_amount === true,
      });
      const secretsFile = await saveInvoiceSecrets(ctx.env, checkout.invoice, ctx.now());
      const { invoice, session } = checkout;
      return {
        text: [
          `Checkout link for the payer: ${checkout.checkoutUrl}`,
          `Direct payment link: ${checkout.paymentLink}`,
          "",
          `${formatAmount(units)} ${invoice.asset}, ${invoice.kind}. Session ${session.id}, commitment ${invoice.commitment}.`,
          `Expires ${session.expiresAt}.`,
          "",
          `Next: the merchant publishes the invoice with their wallet at ${new URL("/app/invoices", checkout.checkoutUrl).toString()}, choosing the saved file under "Publish an invoice made elsewhere" (this tool cannot pay or publish anything). Then check kinko_invoice_status or kinko_wait_for_payment.`,
          `The invoice's secrets were saved to a private file on the merchant's machine (${secretsFile}) and are not shown here.`,
        ].join("\n"),
        data: {
          checkoutUrl: checkout.checkoutUrl,
          paymentLink: checkout.paymentLink,
          sessionId: session.id,
          commitment: invoice.commitment,
          status: session.status,
          expiresAt: session.expiresAt,
        },
      };
    },
  },
  {
    name: "kinko_create_draft",
    title: "Start an invoice the wallet will create",
    description:
      "Start a checkout whose invoice the merchant's wallet creates in the Kinko web app. Returns a one-time address to open; " +
      "the amount is entered there, so it never passes through the assistant or this server. Use this when the invoice's terms should stay private from the assistant.",
    annotations: WRITES,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: TITLE,
        memo: MEMO,
        kind: KIND,
        asset: ASSET,
        client_reference: {
          type: "string",
          maxLength: 200,
          description: "The merchant's own reference.",
        },
        expires_in_minutes: EXPIRES,
      },
    },
    async run(args, ctx) {
      const kinko = await connect(ctx, false);
      const made = await kinko.checkout.drafts.create({
        ...optional("kind", args.kind as InvoiceKind | undefined),
        ...optional("asset", args.asset as Asset | undefined),
        ...optional("title", args.title as string | undefined),
        ...optional("memo", args.memo as string | undefined),
        ...optional("clientReference", args.client_reference as string | undefined),
        ...optional("ttlSeconds", minutes(args.expires_in_minutes)),
      });
      return {
        text: [
          `Open this address in the Kinko web app with the merchant's wallet to create the invoice: ${made.formUrl}`,
          "It carries a one-time token; treat it like a password.",
          `Session ${made.session.id} stays a draft until the invoice exists, then follow it with kinko_invoice_status.`,
        ].join("\n"),
        data: {
          sessionId: made.session.id,
          formUrl: made.formUrl,
          status: made.session.status,
          expiresAt: made.session.expiresAt,
        },
      };
    },
  },
  {
    name: "kinko_invoice_status",
    title: "Check an invoice",
    description:
      "Read an invoice's state from the backend and the chain: open, settled, cancelled or expired, and how many payments it has had. No amount is ever returned, because the chain holds none. Give a session id (cs_…) or a 64-character commitment.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["reference"],
      properties: {
        reference: {
          type: "string",
          maxLength: 80,
          description: "A session id (cs_…) or a 64-character hex commitment.",
        },
      },
    },
    async run(args, ctx) {
      const kinko = await connect(ctx, false);
      const reference = String(args.reference).trim();
      let session: CheckoutSession | undefined;
      let commitment: string | undefined;
      if (/^cs_[0-9a-f]{32}$/.test(reference)) {
        session = await kinko.checkout.sessions.retrieve(reference);
        commitment = session.commitment ?? undefined;
      } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(reference)) {
        commitment = reference.replace(/^0x/i, "").toLowerCase();
      } else {
        throw new ToolInputError(
          "reference must be a session id (cs_ and 32 hex characters) or a commitment (64 hex characters).",
        );
      }
      const chain = commitment ? await kinko.chain.invoiceStatus(commitment) : undefined;
      const lines = [
        ...(session ? [describeSession(session)] : []),
        ...(chain
          ? [
              chain.found
                ? `On chain: ${chain.status}, ${String(chain.contributions)} contribution${chain.contributions === 1 ? "" : "s"}.`
                : "Not on chain yet: the invoice has not been published, or the indexer has not seen it.",
            ]
          : []),
        "No amount is shown because the chain holds none.",
      ];
      return { text: lines.join("\n"), data: { session: session ?? null, chain: chain ?? null } };
    },
  },
  {
    name: "kinko_list_invoices",
    title: "List invoices",
    description:
      "List the merchant's recent invoices, newest first, with their status. Optionally filter by status.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: Object.values(SessionStatus),
          description: "Only invoices in this state.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many to return. Default 10.",
        },
      },
    },
    async run(args, ctx) {
      const kinko = await connect(ctx, false);
      const page = await kinko.checkout.sessions.list({
        limit: typeof args.limit === "number" ? args.limit : 10,
        ...optional("status", args.status as SessionStatus | undefined),
      });
      const text =
        page.data.length === 0
          ? "No invoices."
          : page.data
              .map(
                (s) =>
                  `${s.id}  ${s.status}  ${s.kind}  ${s.asset}  ${s.title ?? "(untitled)"}  ${(s.commitment ?? "draft").slice(0, 12)}`,
              )
              .join("\n");
      return { text, data: { invoices: page.data, nextCursor: page.nextCursor } };
    },
  },
  {
    name: "kinko_wait_for_payment",
    title: "Wait for a payment",
    description:
      "Watch a session for up to a minute and report when it is paid, cancelled or expired. If it is still waiting when the time is up, say so and call again. The wait ends as soon as the state is final.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session_id"],
      properties: {
        session_id: { type: "string", maxLength: 40, description: "The session id (cs_…)." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 55,
          description: "How long to wait this call. Default 30.",
        },
      },
    },
    async run(args, ctx) {
      const kinko = await connect(ctx, false);
      const id = String(args.session_id).trim();
      if (!/^cs_[0-9a-f]{32}$/.test(id))
        throw new ToolInputError("session_id must be a session id (cs_ and 32 hex characters).");
      const requested =
        (typeof args.timeout_seconds === "number" ? args.timeout_seconds : 30) * 1000;
      const timeoutMs = Math.min(requested, ctx.maxWaitMs ?? 55_000);
      try {
        const final = await kinko.checkout.sessions.waitForSettlement(id, {
          timeoutMs,
          intervalMs: ctx.pollIntervalMs ?? 2_000,
        });
        return {
          text: `${describeSession(final)}\nThis is final.`,
          data: { session: final, final: true },
        };
      } catch (error) {
        if (!(error instanceof WaitTimeoutError)) throw error;
        return {
          text: `${describeSession(error.session)}\nStill waiting after ${String(timeoutMs / 1000)} seconds. Call again to keep watching.`,
          data: { session: error.session, final: false },
        };
      }
    },
  },
  {
    name: "kinko_decode_payment_link",
    title: "Read a payment link",
    description:
      "Read what a Kinko payment link contains: amount, asset, kind, expiry and the invoice's commitment. This works offline and never contacts any server.",
    annotations: LOCAL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["link"],
      properties: {
        link: {
          type: "string",
          maxLength: 4_000,
          description: "A full payment link, or just the part after the #.",
        },
      },
    },
    run(args) {
      const facts = decodeInvoiceLink(String(args.link));
      if (!facts)
        return Promise.resolve({
          text: "That is not a Kinko payment link. Pass the whole link, including the part after #.",
          isError: true,
        });
      return Promise.resolve({
        text: `${formatAmount(BigInt(facts.amount))} ${facts.asset}, ${facts.kind}, ${facts.expiresAt === 0 ? "no expiry" : `expires ${new Date(facts.expiresAt * 1000).toISOString()}`}.\nCommitment ${facts.commitment}.`,
        data: { ...facts },
      });
    },
  },
  {
    name: "kinko_verify_webhook",
    title: "Verify a webhook",
    description:
      "Check that a webhook delivery really came from Kinko, using the merchant's webhook secret. Pass the exact request body and the Kinko-Signature header. Works offline.",
    annotations: LOCAL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["body", "signature_header"],
      properties: {
        body: {
          type: "string",
          maxLength: 65_536,
          description: "The exact request body, byte for byte.",
        },
        signature_header: {
          type: "string",
          maxLength: 1_000,
          description: "The value of the Kinko-Signature header.",
        },
        tolerance_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86_400,
          description: "How far the timestamp may be from now. Default 300.",
        },
      },
    },
    async run(args, ctx) {
      const secret = (await settings(ctx)).webhookSecret;
      if (!secret)
        throw new ToolInputError(
          "No webhook secret is configured. Set KINKO_WEBHOOK_SECRET in the server's environment.",
        );
      const result = verifyWebhookSignature(
        String(args.body),
        String(args.signature_header),
        secret,
        {
          now: ctx.now,
          ...optional("toleranceSeconds", args.tolerance_seconds as number | undefined),
        },
      );
      if (result.valid)
        return { text: "Valid: the delivery is authentic and fresh.", data: { valid: true } };
      const why: Record<SignatureFailure, string> = {
        [SignatureFailure.MALFORMED_HEADER]: "the header is missing or malformed",
        [SignatureFailure.TIMESTAMP_OUTSIDE_TOLERANCE]:
          "the timestamp is outside the allowed window (a replay, or a clock that is off)",
        [SignatureFailure.MISMATCH]:
          "the signature does not match (wrong secret, or the body was altered)",
      };
      return {
        text: `Invalid: ${why[result.reason]}.`,
        data: { valid: false, reason: result.reason },
      };
    },
  },
];

/** The tools, as `tools/list` shows them. */
export const toolDefinitions: readonly ToolDefinition[] = TOOLS.map(
  ({ run: _run, ...definition }) => definition,
);

/**
 * Run a tool.
 *
 * @param name - The tool's name.
 * @param input - The arguments the client sent.
 * @param ctx - The process's surroundings.
 * @returns The result, or undefined when there is no such tool.
 */
export const runTool = async (
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult | undefined> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return undefined;
  try {
    return await tool.run(validateArgs(tool.inputSchema, input), ctx);
  } catch (error) {
    // A tool's failure is a result the model reads and acts on, not a protocol fault.
    return {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
};

// The assistant, and the line it is not allowed to cross.
//
// A helper that answers questions about Kinko is useful, and it raises a
// problem. A model is a third party: anything sent to it has left the machine,
// and what Kinko exists to protect (amounts, merchant keys, who paid whom)
// lives in the user's own browser. An assistant that "knows your invoices"
// would ship them to its provider.
//
// The resolution is a whitelist enforced on the way out. The browser may attach
// only the fields in PUBLIC_CONTEXT_FIELDS, each of which is already readable
// by anyone with the chain. Anything else is rejected before a request is
// built, not filtered out of one: a silent filter would let a mistake ship
// quietly, while a rejection shows up the first time it is tried. What the user
// types is theirs to write and is sent as typed; the interface says so.
//
// Without a provider key the endpoint answers 503. It never returns canned text
// dressed up as an answer.

import { ErrorCode } from "./domain/enums.ts";
import { ApiError, badRequest, notConfigured } from "./http/errors.ts";

/** The only context a browser may attach. Adding a field is a privacy decision. */
export const PUBLIC_CONTEXT_FIELDS = [
  "contractAddress",
  "networkId",
  "invoiceCount",
  "openCount",
  "settledCount",
  "cancelledCount",
  "currentPage",
  "walletConnected",
] as const;

/** Public context from the user's session. */
export type PublicContext = Partial<
  Record<(typeof PUBLIC_CONTEXT_FIELDS)[number], string | number | boolean | null>
>;

/** Who said a message. */
export enum ChatRole {
  USER = "user",
  ASSISTANT = "assistant",
}

/** One turn of a conversation. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/** The assistant's answer. */
export interface AssistantReply {
  readonly text: string;
  readonly model: string;
}

const MAX_MESSAGES = 40;
const MAX_CONTENT = 4_000;

/**
 * Reject a context that carries anything off the whitelist.
 *
 * @param context - The untrusted context object.
 * @returns The context, typed.
 * @throws {ApiError} 400 naming every refused field.
 */
export const assertPublicContext = (context: unknown): PublicContext => {
  if (context === undefined || context === null) return {};
  if (typeof context !== "object" || Array.isArray(context))
    throw badRequest("context must be an object.");
  const allowed = new Set<string>(PUBLIC_CONTEXT_FIELDS);
  const refused = Object.keys(context).filter((k) => !allowed.has(k));
  if (refused.length > 0) {
    throw badRequest(
      `context may only carry public fields. Refused: ${refused.join(", ")}. Allowed: ${PUBLIC_CONTEXT_FIELDS.join(", ")}.`,
    );
  }
  for (const [key, value] of Object.entries(context)) {
    // A whitelisted key holding a nested object could smuggle anything.
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw badRequest(`context.${key} must be a string, number, boolean or null.`);
    }
    if (typeof value === "string" && value.length > 200)
      throw badRequest(`context.${key} is too long.`);
  }
  return context;
};

/**
 * Validate a conversation: shape, size, and that it is not empty.
 *
 * @param messages - The untrusted messages.
 * @returns The messages, typed.
 * @throws {ApiError} 400 describing the first problem.
 */
export const assertMessages = (messages: unknown): ChatMessage[] => {
  if (!Array.isArray(messages) || messages.length === 0)
    throw badRequest("messages must be a non-empty array.");
  if (messages.length > MAX_MESSAGES)
    throw badRequest("The conversation is too long; start a new one.");
  return messages.map((raw: unknown, i) => {
    const m = (raw ?? {}) as { role?: unknown; content?: unknown };
    if (m.role !== ChatRole.USER && m.role !== ChatRole.ASSISTANT) {
      throw badRequest(`messages[${String(i)}].role must be "user" or "assistant".`);
    }
    if (typeof m.content !== "string" || m.content.trim() === "") {
      throw badRequest(`messages[${String(i)}].content must be a non-empty string.`);
    }
    if (m.content.length > MAX_CONTENT) {
      throw badRequest(
        `messages[${String(i)}].content is too long (at most ${String(MAX_CONTENT)} characters).`,
      );
    }
    return { role: m.role, content: m.content };
  });
};

const SYSTEM_PROMPT = `You are the assistant inside Kinko, a private dollar account on the Midnight blockchain.

Answer only from the facts below. Never invent numbers, fees, dates or features. If you do not know, say so.

WHAT KINKO IS
A user deposits USDC on Ethereum and holds the same amount on Midnight as KUSD, a shielded token backed one to one by that USDC in a vault. They pay privately with invoices, payment links, tags, batch pay, gift cards and a PIN card, and withdraw back to USDC when they like. Anyone can compare the USDC in the vault on Ethereum with the total KUSD minted on Midnight on the public backing page.

HOW MONEY MOVES
Deposit: the user sends USDC to their deposit address, starts the deposit, a relayer carries the request through its permissionless steps (including the signature from Sig Network's MPC), and the user completes it to mint KUSD to their shielded address. Withdraw: the user burns KUSD, minus a flat fee, with an Ethereum destination; the MPC signs a USDC transfer from the vault; the user completes it, and a failed transfer re-mints their KUSD.

PAYMENTS
An invoice is recorded on chain as a commitment with its status, kind (standard, multipay or donation), asset (KUSD or NIGHT), expiry and a count of contributions. A payer settles with a shielded coin worth exactly the committed amount; the contract forwards it to the merchant, shielded. Paying a tag resolves a public name to receiving keys. Refunds, revenue attestations and batch settlement exist in the payments contract.

WHAT IS PUBLIC
Each USDC deposit and withdrawal on Ethereum, each KUSD mint and burn amount (so total supply), tag names and the keys behind them, invoice status, kind, asset, expiry and contribution counts, and disclosure log entries.

WHAT IS PRIVATE
Who holds KUSD and how much, every payment between users, invoice amounts, merchants and payers, and the contents of any disclosed record.

TRUST
The MPC network holds the vault's Ethereum key collectively and signs only what vault circuits request. The relayer carries steps but cannot move user funds. The fee sponsor pays Midnight fees for allow-listed circuits. This backend stores merchant records, checkout sessions and webhook settings, and never sees a private key, a witness or an amount it was not given.

WHAT YOU CANNOT SEE
You have no access to any amount, key or invoice term, and you never will: the product does not send them to you. If asked for one, explain that, and point to the user's own dashboard, where that data lives.

STYLE
Short and plain. No marketing language. State limitations as limitations.`;

const contextBlock = (context: PublicContext): string => {
  const entries = Object.entries(context).filter(([, v]) => v !== null);
  if (entries.length === 0) return "";
  return `\n\nPUBLIC CONTEXT FROM THE USER'S SESSION (all readable on chain by anyone):\n${entries.map(([k, v]) => `- ${k}: ${String(v)}`).join("\n")}`;
};

/** Options for {@link Assistant}. */
export interface AssistantOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  /** Injectable so tests never reach the network. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Asks a hosted model, within the limits above. */
export class Assistant {
  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /** Counts only. Never a prompt, never a reply. */
  readonly stats = { requests: 0, failures: 0 };

  /**
   * Create the assistant.
   *
   * @param options - The provider key and model, and an optional fetch and timeout.
   */
  constructor(options: AssistantOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Whether the assistant can answer at all. The UI asks before offering it.
   *
   * @returns True when a provider key is configured.
   */
  get configured(): boolean {
    return this.#apiKey !== undefined;
  }

  /**
   * The model name, for the status route.
   *
   * @returns The provider's model identifier.
   */
  get model(): string {
    return this.#model;
  }

  /**
   * Ask the model.
   *
   * @param messages - A validated conversation.
   * @param context - Validated public context.
   * @returns The model's answer.
   * @throws {ApiError} 503 without a provider key; 502 when the provider fails.
   */
  async chat(
    messages: readonly ChatMessage[],
    context: PublicContext = {},
  ): Promise<AssistantReply> {
    if (this.#apiKey === undefined) {
      throw notConfigured(
        "The assistant is not configured. Set KINKO_ASSISTANT_API_KEY on the backend to enable it.",
      );
    }
    this.stats.requests++;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT + contextBlock(context) }] },
      contents: messages.map((m) => ({
        role: m.role === ChatRole.ASSISTANT ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
    };
    let response: Response;
    try {
      response = await this.#fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.#model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.#apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      this.stats.failures++;
      throw new ApiError(
        502,
        ErrorCode.UPSTREAM_FAILED,
        `Could not reach the model: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      this.stats.failures++;
      // The provider's error body can echo the key back, so it is not passed on.
      throw new ApiError(
        502,
        ErrorCode.UPSTREAM_FAILED,
        `The model returned ${String(response.status)}.`,
      );
    }
    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      this.stats.failures++;
      throw new ApiError(502, ErrorCode.UPSTREAM_FAILED, "The model returned an empty answer.");
    }
    return { text, model: this.#model };
  }
}

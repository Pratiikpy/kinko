// What the bot can say.
//
// The obvious bot would hold each merchant's keys and create invoices on their
// behalf. That is the wrong design here: an invoice's amount and keys are what
// Kinko exists to keep private, and a chat log is plaintext to Telegram. So
// this bot never holds a key and never learns an amount. It reads what the
// backend knows (titles, statuses, counts), starts invoices by handing the
// merchant an address where their own wallet creates them, and tells them when
// one is paid.
//
// The router is a function of (message, backend), so the whole surface is
// tested without a token, a network or a chain.

import { type Backend, BackendError, type SessionView } from "./backend.ts";
import { describeSession, shortCommitment, STATUS_LABEL } from "./format.ts";
import type { InlineButton, TelegramMessage } from "./telegram.ts";

/** What to send back. */
export interface Reply {
  readonly text: string;
  readonly buttons?: readonly InlineButton[];
}

/** The commands, as Telegram's menu shows them. */
export const COMMANDS: readonly { readonly command: string; readonly description: string }[] = [
  { command: "start", description: "What this bot does" },
  { command: "link", description: "Link this chat to your merchant account" },
  { command: "unlink", description: "Stop receiving messages here" },
  { command: "status", description: "Your invoices at a glance" },
  { command: "invoices", description: "List your recent invoices" },
  { command: "invoice", description: "Show one invoice" },
  { command: "newlink", description: "Start a new invoice and payment link" },
  { command: "privacy", description: "What this bot never sees" },
];

const HELP = [
  "Kinko: private payments on Midnight. This bot tells you when your invoices are paid and helps you start new ones.",
  "",
  "  /link <code>           link this chat to your account",
  "  /status                your invoices at a glance",
  "  /invoices [status]     recent invoices (pending, settled, cancelled, expired, draft)",
  "  /invoice <ref>         one invoice, by session id or commitment",
  "  /newlink [kind] [title]  start an invoice; kind is standard, multipay or donation",
  "  /unlink                stop receiving messages here",
  "",
  "To link: in the Kinko dashboard, or with `kinko` or the API, ask for a Telegram link code, then send /link followed by the code.",
  "What it never does: hold your keys, create an invoice itself, or learn an amount. /privacy explains.",
].join("\n");

const PRIVACY = [
  "What this bot never sees:",
  "",
  "  the amount of any invoice",
  "  your merchant or payout keys",
  "  an invoice's salt or owner secret",
  "  who paid, or from where",
  "",
  "It knows what the Kinko backend knows: an invoice's title and reference if you gave one, its status, and how many payments it has had.",
  "To start an invoice, /newlink gives you an address that opens in the Kinko web app, where your own wallet sets the amount and creates it. A bot that created invoices would have to hold their terms, and every message it sent you would put them in a chat log.",
  "Telegram itself can read this chat, so nothing sensitive is ever put in a message.",
].join("\n");

const KINDS = new Set(["standard", "multipay", "donation"]);
const STATUSES = new Set(["draft", "pending", "settled", "cancelled", "expired"]);

const NOT_LINKED =
  "This chat is not linked to a merchant account yet. Ask for a Telegram link code (in the dashboard, with `kinko`, or through the API), then send /link followed by the code.";

/** Where the chat stands, so commands can refuse with a useful sentence. */
export interface CommandContext {
  readonly backend: Backend;
  /** The bot's own username, so `/cmd@OtherBot` in a shared chat is ignored. */
  readonly username: string;
}

/**
 * Parse a message into a command.
 *
 * @param text - The message text.
 * @param username - This bot's username, without the @.
 * @returns The command and its argument text, or undefined when it is not for this bot.
 */
export const parseCommand = (
  text: string,
  username: string,
): { command: string; args: string } | undefined => {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  if (match[2] && match[2].toLowerCase() !== username.toLowerCase()) return undefined;
  return { command: match[1].toLowerCase(), args: (match[3] ?? "").trim() };
};

/**
 * Answer a message.
 *
 * @param message - The Telegram message.
 * @param ctx - The backend and the bot's name.
 * @returns A reply, or undefined when there is nothing to say (not a command, or addressed to another bot).
 */
export const handleMessage = async (
  message: TelegramMessage,
  ctx: CommandContext,
): Promise<Reply | undefined> => {
  if (!message.text) return undefined;
  const parsed = parseCommand(message.text, ctx.username);
  if (!parsed) {
    return message.text.startsWith("/")
      ? undefined
      : { text: "I only understand commands. /start lists them." };
  }
  // Anyone in a group could run a merchant's commands, so only private chats are served.
  if (message.chat.type !== "private")
    return {
      text: "I work in a private chat only: anyone in a group could act as the merchant. Message me directly.",
    };
  const chatId = message.chat.id;
  try {
    switch (parsed.command) {
      case "start":
      case "help":
        return { text: HELP };
      case "privacy":
        return { text: PRIVACY };
      case "link":
        return await link(parsed.args, chatId, ctx);
      case "unlink":
        return (await ctx.backend.unlink(chatId))
          ? { text: "Unlinked. You will not get messages here any more." }
          : { text: "This chat was not linked." };
      case "status":
        return await status(chatId, ctx);
      case "invoices":
        return await invoices(parsed.args, chatId, ctx);
      case "invoice":
        return await invoice(parsed.args, chatId, ctx);
      case "newlink":
        return await newLink(parsed.args, chatId, ctx);
      default:
        return { text: `I do not know /${parsed.command}. /start lists what I can do.` };
    }
  } catch (error) {
    if (error instanceof BackendError) {
      if (error.status === 404 && /not linked/i.test(error.message)) return { text: NOT_LINKED };
      if (error.status === 0 || error.status >= 500)
        return { text: "I could not reach Kinko just now. Try again in a minute." };
      return { text: error.message };
    }
    throw error;
  }
};

const link = async (args: string, chatId: number, ctx: CommandContext): Promise<Reply> => {
  if (!args) return { text: "Send /link followed by the code, for example /link K7QM-4XD2-9PTV." };
  const merchant = await ctx.backend.link(args, chatId);
  return {
    text: `Linked to ${merchant.name}. You will get a message here when an invoice is paid.\n\nThe code has been used. You can delete your message with it.`,
  };
};

const status = async (chatId: number, ctx: CommandContext): Promise<Reply> => {
  const account = await ctx.backend.account(chatId);
  if (!account) return { text: NOT_LINKED };
  const counts = account.sessions;
  const lines = Object.keys(STATUS_LABEL).map((s) => `  ${s.padEnd(10)} ${String(counts[s] ?? 0)}`);
  return { text: `${account.merchant.name}\n\n${lines.join("\n")}` };
};

const invoices = async (args: string, chatId: number, ctx: CommandContext): Promise<Reply> => {
  if (args && !STATUSES.has(args.toLowerCase()))
    return { text: `Status must be one of ${[...STATUSES].join(", ")}.` };
  if (!(await ctx.backend.account(chatId))) return { text: NOT_LINKED };
  const list = await ctx.backend.listSessions(chatId, {
    limit: 10,
    ...(args ? { status: args.toLowerCase() } : {}),
  });
  if (list.length === 0)
    return {
      text: args ? `No ${args.toLowerCase()} invoices.` : "No invoices yet. /newlink starts one.",
    };
  return { text: list.map(oneLine).join("\n") };
};

const oneLine = (s: SessionView): string =>
  `${STATUS_LABEL[s.status] ?? s.status}  ${s.title ?? "(untitled)"}  ${shortCommitment(s)}  ${s.id}`;

const invoice = async (args: string, chatId: number, ctx: CommandContext): Promise<Reply> => {
  if (!args)
    return {
      text: "Send /invoice followed by a session id (cs_…) or at least eight characters of its commitment.",
    };
  if (!(await ctx.backend.account(chatId))) return { text: NOT_LINKED };
  const session = await ctx.backend.findSession(chatId, args.split(/\s+/)[0] ?? args);
  if (!session)
    return {
      text: "None of your invoices matches that. Use a session id (cs_…), or eight or more characters of the commitment.",
    };
  const buttons: InlineButton[] = session.commitment
    ? [
        {
          text: "Open in Kinko",
          url: `${await ctx.backend.appUrl()}/app/invoices/${session.commitment}`,
        },
      ]
    : [];
  return { text: describeSession(session), buttons };
};

const newLink = async (args: string, chatId: number, ctx: CommandContext): Promise<Reply> => {
  if (!(await ctx.backend.account(chatId))) return { text: NOT_LINKED };
  const [first, ...rest] = args.split(/\s+/).filter(Boolean);
  const hasKind = first !== undefined && KINDS.has(first.toLowerCase());
  const title = (
    hasKind ? rest : [first, ...rest].filter((w): w is string => w !== undefined)
  ).join(" ");
  if (title.length > 120) return { text: "Keep the title under 120 characters." };
  const { session, formUrl } = await ctx.backend.createDraft(chatId, {
    ...(title ? { title } : {}),
    ...(hasKind ? { kind: first.toLowerCase() } : {}),
  });
  return {
    text: [
      "Ready. Open this in the Kinko web app with your wallet to set the amount and create the invoice:",
      "",
      "The address carries a one-time token, so do not forward it. It lapses if you leave it unused.",
      `Once the invoice exists I will tell you when it is paid. (session ${session.id})`,
    ].join("\n"),
    buttons: [{ text: "Create the invoice", url: formUrl }],
  };
};

// `kinko telegram`: link a chat to your account so the Kinko bot can tell you
// when an invoice is paid.

import { ExitCode, UsageError } from "../io.ts";
import { type Command, connect, CONNECTION_OPTIONS, parse, printJson } from "./common.ts";

/** `kinko telegram`. */
export const telegram: Command = {
  name: "telegram",
  summary: "Link a Telegram chat so the Kinko bot tells you about payments",
  usage: `kinko telegram code [--json]      get a code to send the bot as /link <code>
kinko telegram chats [--json]     list the chats linked to your account
kinko telegram unlink <chat id>   stop messages to a chat`,
  async run(argv, io) {
    const [action, ...rest] = argv;
    if (action !== "code" && action !== "chats" && action !== "unlink") {
      throw new UsageError("Say what to do: code, chats or unlink.");
    }
    // A negative chat id (a group's) would be read as a flag, so numbers are set aside first.
    const numbers = rest.filter((a) => /^-\d+$/.test(a));
    const { values, positionals } = parse(
      rest.filter((a) => !numbers.includes(a)),
      CONNECTION_OPTIONS,
    );
    const { kinko } = await connect(values, io);

    if (action === "code") {
      const { code, expiresAt } = await kinko.telegram.linkCode();
      if (values.json) printJson(io, { code, expiresAt });
      else {
        io.out(code);
        io.err(
          `\nOpen a private chat with the Kinko bot and send:\n\n  /link ${code}\n\nThe code works once and expires at ${expiresAt}.`,
        );
      }
      return ExitCode.OK;
    }

    if (action === "chats") {
      const chats = await kinko.telegram.chats();
      if (values.json) printJson(io, { chats });
      else if (chats.length === 0) io.out("No chats are linked.");
      else for (const chat of chats) io.out(`${String(chat.chatId)}  linked ${chat.linkedAt}`);
      return ExitCode.OK;
    }

    const candidates = [...positionals, ...numbers];
    const [chat] = candidates;
    const chatId = Number(chat);
    if (
      chat === undefined ||
      candidates.length > 1 ||
      !Number.isSafeInteger(chatId) ||
      chatId === 0
    ) {
      throw new UsageError("Give the chat id to unlink, as `kinko telegram chats` shows it.");
    }
    await kinko.telegram.unlink(chatId);
    if (values.json) printJson(io, { unlinked: chatId });
    else io.out(`Unlinked ${String(chatId)}.`);
    return ExitCode.OK;
  },
};

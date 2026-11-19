# @kinko/bot

A Telegram bot for merchants. It links a chat to a merchant account, lists their invoices, starts new ones, and sends a message when an invoice is paid.

It never holds a key and never learns an amount. It talks only to the Kinko backend, with one service token, and names a chat; the backend decides which merchant that chat belongs to. To start an invoice it hands the merchant an address in the web app where their own wallet sets the amount and creates it.

## Run it

Requires Node 22.18 or newer and a running `@kinko/backend` started with a `KINKO_BOT_TOKEN`.

1. Create a bot with @BotFather in Telegram and copy its token.
2. Configure the bot's environment (see `.env.example`):

   | Variable | Meaning |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | The token from BotFather. |
   | `KINKO_API_URL` | The backend's address. |
   | `KINKO_BOT_TOKEN` | The same value the backend was started with. |
   | `KINKO_BOT_STATE` | Where the bot remembers its place in the event feed. Default `./kinko-bot-state.json`. |
   | `KINKO_BOT_POLL_SECONDS` | Telegram long-poll length, 1 to 50. Default 50. |
   | `KINKO_BOT_NOTIFY_MS` | How often the event feed is read, 1000 or more. Default 5000. |

3. Start it:

   ```sh
   yarn workspace @kinko/bot start
   ```

With no `TELEGRAM_BOT_TOKEN` the process prints what is missing and exits with code 2. It uses long polling, so it needs no public address.

## Using it

Open a private chat with the bot.

- `/link <code>` links the chat. Get a code from your merchant account (`POST /v1/merchant/telegram/link-codes`, or `kinko` once it has the call); a code works once and expires after fifteen minutes.
- `/status` shows how many invoices are pending, settled, cancelled or expired.
- `/invoices [status]` lists recent invoices. `/invoice <ref>` shows one by session id, commitment, or at least eight characters of a commitment.
- `/newlink [standard|multipay|donation] [title]` starts an invoice. The reply carries a button to the web app, where your wallet creates it. Once it exists the bot tells you when it is paid.
- `/unlink` stops messages to the chat. `/privacy` says what the bot never sees.

The bot answers in private chats only: in a group, anyone could act as the merchant.

## Notifications

The backend records each payment, settlement, cancellation and expiry as an event. The bot reads that feed from a saved position, sends each message, and only then moves on, so a restart repeats at most the last message and never skips one. On first start it begins at the newest event rather than replaying history. A chat that has blocked the bot is unlinked automatically. Telegram's rate limits are respected.

Messages say which invoice changed and how many payments it has had. They never carry an amount.

## Test

```sh
yarn workspace @kinko/bot test
yarn workspace @kinko/bot build   # type-checks
```

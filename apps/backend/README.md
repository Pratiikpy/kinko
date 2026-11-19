# @kinko/backend

The merchant backend for Kinko: API keys, hosted checkout sessions, signed webhooks, a chain watcher, the conversion oracle's signer, the assistant endpoint and the service routes the Telegram bot uses.

It never holds a private key, a witness, or an invoice amount it was not given. A checkout session stores an invoice's public commitment and whatever the merchant chose to attach (a title, a memo, a reference, optionally a display amount). The invoice's terms live in the payment link's fragment, which a browser does not send to a server, and the API refuses any URL that carries a fragment so they cannot arrive by accident.

## Run it

Requires Node 22.18 or newer. From the repository root:

```sh
yarn install
cp apps/backend/.env.example apps/backend/.env   # then fill it in
yarn workspace @kinko/backend start
```

`start` reads `apps/backend/.env` if it exists. The process refuses to start when a required value is missing or malformed, and says which.

| Variable | Required | Meaning |
|---|---|---|
| `KINKO_DATA_KEY` | yes | 64 hex characters. Seals webhook secrets at rest. `openssl rand -hex 32`. Keep it stable: losing it makes stored webhook secrets unreadable. |
| `KINKO_PAY_ADDRESS` | yes | The deployed `kinko_pay` contract address, 64 hex characters. |
| `KINKO_INDEXER_URL` | no | Midnight indexer GraphQL URL. Default `http://localhost:8088/api/v4/graphql`. |
| `KINKO_INDEXER_WS_URL` | no | Derived from the indexer URL when unset. |
| `KINKO_APP_URL` | no | The web app's address; hosted checkout and bot links point there. Default `http://localhost:5173`. |
| `KINKO_APP_INVOICE_PATH` | no | The web app path where a merchant's wallet creates an invoice. Default `/app/invoices`. |
| `KINKO_HOST`, `KINKO_PORT` | no | Bind address (default `127.0.0.1`) and port (default 3100). |
| `KINKO_DB_PATH` | no | The SQLite file. Default `./data/kinko.db`. |
| `KINKO_CORS_ORIGINS` | no | Comma-separated origins allowed cross-origin, or `*`. Default none. |
| `KINKO_TRUST_PROXY` | no | `true` behind a proxy that appends the caller's address to `X-Forwarded-For`. |
| `KINKO_REGISTRATION_TOKEN` | no | When set, `POST /v1/merchants` needs it in `X-Registration-Token`. |
| `KINKO_BOT_TOKEN` | no | Shared secret for the Telegram bot's service routes (32 characters or more). Without it they answer 503. |
| `KINKO_ORACLE_SECRET_KEY` | no | The conversion oracle's signing scalar, hex. Without it the oracle answers 503. |
| `KINKO_ORACLE_KUSD_PER_NIGHT` | no | A fixed rate, for example `0.0913`. |
| `KINKO_ORACLE_RATE_URL`, `KINKO_ORACLE_RATE_PATH` | no | A JSON price feed and the dot path to the number in it. Use one rate source or the other. |
| `KINKO_ORACLE_QUOTE_TTL_SECONDS` | no | How long a quote stays valid. 30 to 600, default 120. |
| `KINKO_ASSISTANT_API_KEY`, `KINKO_ASSISTANT_MODEL` | no | Provider key and model for the assistant. Without a key the endpoint answers 503. |
| `KINKO_ALLOW_PRIVATE_WEBHOOKS` | no | `true` allows http and private-network webhook targets. Development only. |
| `KINKO_POLL_MS` | no | How often the chain is read. Default 5000. |
| `KINKO_LATE_SETTLEMENT_DAYS` | no | How long after expiry a session is still watched for a late payment. Default 14. |
| `KINKO_SESSION_TTL_SECONDS` | no | Default life of a checkout session. Default 3600. |
| `KINKO_LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. |

Logs are one JSON object per line. Fields named like credentials are redacted, and request bodies and query strings are never logged.

## API

All routes are under `/v1` and answer JSON. Errors look like `{ "error": { "code", "message", "details"? }, "requestId" }`. Authenticated routes take `Authorization: Bearer <API key>`.

**Merchants**

- `POST /v1/merchants` registers a merchant: `{ name, webhookUrl? }`. Returns the merchant, an API key and a webhook secret, each shown once.
- `GET /v1/merchant`, `PATCH /v1/merchant` read and change the name and webhook URL.
- `GET`/`POST /v1/merchant/api-keys`, `DELETE /v1/merchant/api-keys/:id` manage keys. Keys are stored as hashes; the last active key cannot be revoked.
- `POST /v1/merchant/webhook/secret` rotates the signing secret. `POST /v1/merchant/webhook/test` sends a signed test event now. `GET /v1/merchant/webhook/deliveries` shows delivery state.
- `POST /v1/merchant/telegram/link-codes`, `GET /v1/merchant/telegram`, `DELETE /v1/merchant/telegram/:chatId` link and unlink Telegram chats.

**Checkout sessions**

- `POST /v1/checkout/sessions` creates one. With a `commitment` it is `pending`; without, it is a `draft` and the answer carries a one-time `attachToken` and a `formUrl` to open in the web app. Fields: `commitment?`, `kind?` (`standard`, `multipay`, `donation`), `token?` (`KUSD`, `NATIVE`), `title?`, `memo?`, `amount?` (base units, only if you want it stored), `clientReference?`, `successUrl?`, `cancelUrl?`, `ttlSeconds?`.
- `GET /v1/checkout/sessions` lists yours, newest first (`status`, `limit`, `before`).
- `GET /v1/checkout/sessions/:id` is public and returns what the hosted checkout page needs. With your API key it returns the full record.
- `POST /v1/checkout/sessions/:id/commitment` attaches a commitment to a draft, authorised by the attach token or your API key. Safe to repeat.

Session statuses: `draft`, `pending`, `settled`, `cancelled`, `expired`. A payment that arrives after a session expired still settles it, flagged `late`, for as long as `KINKO_LATE_SETTLEMENT_DAYS` allows.

**Chain, oracle, assistant**

- `GET /v1/config` publishes what a client needs to build links (contract address, app URL, paths).
- `GET /v1/chain` and `GET /v1/chain/invoices/:commitment` read the ledger: status, kind, asset, expiry and contribution count. There is no amount, because the ledger holds none.
- `GET /v1/oracle` reports the oracle's key and whether it matches the key sealed into the contract. `POST /v1/oracle/quote` takes `{ baseAmount, fromToken, toToken }` and returns a signed quote for `settle_invoice_converted`.
- `GET /v1/assistant` and `POST /v1/assistant/chat`. The chat accepts only the public context fields listed in the source and rejects anything else before it is forwarded.
- `GET /health` reports the store, the chain, the watcher, webhooks and which optional features are configured.

**Bot service routes** (`/v1/bot/*`, authenticated with `KINKO_BOT_TOKEN`) link chats, list and create invoices for a chat's merchant, and serve the event feed the bot polls.

## Webhooks

Each delivery is a JSON body and a header:

```
Kinko-Signature: t=1767225600,v1=5257a869e7ec…
```

`v1` is the hex HMAC-SHA256, keyed with your webhook secret, of `<t>.<raw body>`. Verify it against the raw bytes, in constant time, and refuse timestamps more than five minutes from your clock. `@kinko/node` does this for you.

Other headers: `Kinko-Event-Id` (stable across retries, use it to deduplicate), `Kinko-Event-Type`, `Kinko-Delivery-Attempt`.

Events: `invoice.payment_received` (once per pass with new payments, carrying the running count), `invoice.settled`, `invoice.cancelled`, `invoice.expired`, `webhook.test`. A payload is `{ id, type, createdAt, data }`; `data` holds the session id, commitment, status, kind, asset, title, client reference, contribution count and a `late` flag. It never holds an amount.

Delivery is at least once. A non-2xx answer, a timeout or a network error is retried ten times over about 23 hours (10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h). Targets must be public https hosts; the check runs on the address the name resolves to at connect time, not only on the URL as written.

## How the watcher reads the chain

Every `KINKO_POLL_MS` the backend asks the indexer for `kinko_pay`'s current state (one request however many sessions are waiting), decodes it with the compiled contract's own `ledger()` accessor, and compares each waiting session's invoice with what the ledger says. A change and the events it announces are written in one transaction. The pass is skipped entirely when nothing is waiting, and an unreachable indexer is recorded and retried rather than fatal.

## Test

```sh
yarn workspace @kinko/backend test
yarn workspace @kinko/backend build   # type-checks
```

The suite runs the real compiled contract in-process and serves its state through a fake indexer, so the watcher and the clients are tested against genuine ledger bytes.

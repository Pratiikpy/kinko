# @kinko/node

The Node SDK for Kinko merchants. Build an invoice, register a hosted checkout for it, follow it to payment and verify the webhooks.

What happens where: an invoice is built on your machine with your keys, because its amount and keys are what Kinko keeps private. The backend is told only the invoice's commitment (a hash) and what you choose to attach: a title, a memo, a reference, where to send the payer, and, if you ask, a display amount. This SDK never signs, proves or moves funds. Publishing an invoice on chain and paying it happen in a wallet.

Requires Node 22.18 or newer. In this repository it runs from source; it depends on `@kinko/kinko-pay` for the invoice commitment and the payment link, computed by the same compiled circuits the contract uses.

## Create a checkout

```ts
import { Kinko, parseAmount } from "@kinko/node";

const kinko = new Kinko({
  apiKey: process.env.KINKO_API_KEY,
  baseUrl: "https://api.kinko.example",
  merchant: { merchantKey: process.env.KINKO_MERCHANT_KEY, payoutAddress: process.env.KINKO_PAYOUT_ADDRESS },
  webhookSecret: process.env.KINKO_WEBHOOK_SECRET,
});

const checkout = await kinko.checkout.create({
  amount: parseAmount("25.50"), // base units; six decimals for KUSD and NIGHT
  title: "Invoice 12",
  clientReference: "order-9", // echoed in webhooks, never shown to the payer
  expiresInSeconds: 3600,
});

checkout.checkoutUrl; // give this to the payer: the hosted page, with the terms in its fragment
checkout.paymentLink; // or a direct payment link
checkout.invoice; // the invoice, including its secrets: keep it, and publish it with your wallet
```

An invoice built here exists only on your machine until a wallet publishes it. Save it with `saveInvoiceSecrets()` (the CLI and the MCP server do this for you), then open the Kinko app's Invoices page and choose the file under "Publish an invoice made elsewhere". The app checks that the terms match the commitment before it signs.

`merchantKey` is your identity key (`kinko keygen` makes one) and `payoutAddress` is the shielded address of the wallet you are paid at (`mn_shield-addr_…`). It carries the key your payments are sent to and the key they are encrypted to. Both stay in your process.

Register a merchant, if you have no API key yet:

```ts
const { apiKey, webhookSecret } = await Kinko.register({ baseUrl, name: "Acme", webhookUrl: "https://hooks.acme.example/kinko" });
```

## Let the wallet create the invoice

If the invoice's secrets should never pass through your code, start a draft instead and let the web app create it:

```ts
const { session, formUrl } = await kinko.checkout.drafts.create({ title: "Retainer" });
// Open formUrl with your wallet. The web app creates the invoice and attaches its commitment.
```

## Follow it

```ts
await kinko.checkout.sessions.retrieve(id); // your full record
await kinko.checkout.sessions.list({ status: "settled", limit: 20 }); // newest first; pass nextCursor as `before`
await kinko.checkout.sessions.waitForSettlement(id, { timeoutMs: 600_000 }); // resolves when paid, cancelled or expired
await kinko.chain.invoiceStatus(commitment); // the ledger's own view; there is never an amount in it
```

Statuses: `draft`, `pending`, `settled`, `cancelled`, `expired`. A payment that arrives after a session expired still settles it, with `late: true`.

## Verify webhooks

```ts
import { constructWebhookEvent, SIGNATURE_HEADER } from "@kinko/node";

// Use the raw request body, not a re-serialised one.
const event = kinko.webhooks.constructEvent(rawBody, request.headers[SIGNATURE_HEADER.toLowerCase()]);
if (event.type === "invoice.settled") fulfil(event.data.clientReference);
```

`constructEvent` throws `WebhookSignatureError` (with a `reason`) unless the delivery is authentic and within five minutes of your clock. Deliveries are at least once: deduplicate on `event.id`.

The signature header is `Kinko-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256, keyed with your webhook secret, of `<t>.<raw body>`. In another language: recompute that HMAC, compare in constant time, and refuse old timestamps.

## Other calls

- `kinko.oracle.quote({ baseAmount, from, to })` returns a quote signed by the conversion oracle, to present to the contract when paying an invoice in the other asset.
- `kinko.telegram.linkCode()` gives a code to send the Kinko bot as `/link <code>`; `chats()` and `unlink(chatId)` manage the links.
- `parseAmount("25.50")` and `formatAmount(25_500_000n)` convert between decimals and base units.
- `decodeInvoiceLink(link)` reads what a payment link says.

Every failure from the backend is a `KinkoApiError` with `status`, `code`, `message`, `details` and the `requestId` to quote when asking for help. Reads are retried after a network error or a 502 to 504; writes are not.

`@kinko/node` also reads the settings the CLI and the MCP server share (`resolveSettings`, `clientFromSettings`, `saveInvoiceSecrets`): environment variables, then `~/.config/kinko/config.json`, written readable by its owner only.

## Test

```sh
yarn workspace @kinko/node test
yarn workspace @kinko/node build   # type-checks
```

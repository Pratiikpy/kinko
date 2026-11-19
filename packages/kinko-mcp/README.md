# @kinko/mcp

An MCP server that lets an AI assistant create Kinko invoices and check their status through the Kinko backend.

It cannot pay an invoice, publish one on chain, or move funds, and that is deliberate: an autonomous agent should not be handed the ability to spend on someone's behalf by default. It speaks MCP over standard input and output.

Requires Node 22.18 or newer.

## Connect it

Add it to your MCP client's configuration. For example, in a client that takes a command and an environment:

```json
{
  "mcpServers": {
    "kinko": {
      "command": "yarn",
      "args": ["workspace", "@kinko/mcp", "start"],
      "cwd": "/path/to/kinko",
      "env": {
        "KINKO_API_URL": "https://api.kinko.example",
        "KINKO_API_KEY": "kk_…",
        "KINKO_MERCHANT_KEY": "…",
        "KINKO_PAYOUT_ADDRESS": "mn_shield-addr_…",
        "KINKO_WEBHOOK_SECRET": "whsec_…"
      }
    }
  }
}
```

The settings are the ones the CLI and the SDK use, and are also read from `~/.config/kinko/config.json` (`kinko register --save`, `kinko keygen --save`). Only `KINKO_API_URL` and `KINKO_API_KEY` are needed to read invoices; creating one needs the merchant key and the payout address too, and verifying webhooks needs the webhook secret. A missing setting is reported to the assistant as an error that names it.

## Tools

| Tool | What it does |
|---|---|
| `kinko_create_invoice` | Builds an invoice on this machine and registers a hosted checkout for it. Returns the link to give the payer. |
| `kinko_create_draft` | Starts a checkout whose invoice the merchant's wallet creates in the web app. Returns the address to open; the amount is entered there. |
| `kinko_invoice_status` | Reads an invoice from the backend and the chain, by session id or commitment. |
| `kinko_list_invoices` | Lists recent invoices, optionally by status. |
| `kinko_wait_for_payment` | Watches a session for up to a minute and reports when it is paid, cancelled or expired. |
| `kinko_decode_payment_link` | Reads what a payment link says. Offline. |
| `kinko_verify_webhook` | Checks a webhook delivery's signature. Offline. |

Each tool has a strict input schema; an unknown or malformed argument is returned to the assistant as an error it can correct.

## What the assistant sees

An assistant is a third party, so what it is told matters.

- `kinko_create_invoice` returns the checkout link, and the link contains the invoice's terms (amount, salt, keys) in its fragment, so the assistant sees them. The invoice's owner secret is never returned: it is saved to a private file on the merchant's machine, `~/.config/kinko/invoices/<commitment>.json`. The backend is told only the commitment and the title, memo and reference given, and the amount only if `store_amount` is true.
- `kinko_create_draft` is for when even the terms should stay out of the assistant's view. It returns only a one-time address.
- Status and listing tools return no amount, because neither the chain nor the backend holds one unless the merchant stored it.

## Test

```sh
yarn workspace @kinko/mcp test
yarn workspace @kinko/mcp build   # type-checks
```

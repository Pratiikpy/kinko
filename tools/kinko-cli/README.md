# @kinko/cli

The Kinko command line for merchants: make an invoice link, watch it until it is paid, and keep a manifest of your invoices.

Requires Node 22.18 or newer. From the repository root:

```sh
yarn workspace @kinko/cli start <command> [options]
```

The examples below write `kinko` for that command. The `bin` entry is `src/bin.ts`, which carries a `node` shebang, so a linked `kinko` runs the same file.

## Set up

```sh
kinko register --name "Acme" --webhook-url https://hooks.acme.example/kinko --api-url https://api.kinko.example --save
kinko keygen --save
export KINKO_PAYOUT_ADDRESS=<the shielded address of the wallet you are paid at, mn_shield-addr_…>
```

Settings come from flags, then the environment, then `~/.config/kinko/config.json`, which `--save` writes readable by its owner only (`KINKO_HOME` moves it):

| Setting | Flag | Variable |
|---|---|---|
| Backend address | `--api-url` | `KINKO_API_URL` |
| API key | `--api-key` | `KINKO_API_KEY` |
| Merchant key | `--merchant-key` | `KINKO_MERCHANT_KEY` |
| Payout address | `--payout-address` | `KINKO_PAYOUT_ADDRESS` |
| Webhook secret | | `KINKO_WEBHOOK_SECRET` |

`kinko config` shows what is in force, with secrets shortened.

## Make a link

```sh
kinko link 25.50 --title "Invoice 12" --ref order-9 --name invoice-12 --expires 1h
```

The invoice is built on your machine. You get a hosted checkout link whose fragment carries the terms (a browser never sends a fragment to a server), a direct payment link, and a line in `kinko.json`. The invoice's secrets, which publish and close it, are saved to `~/.config/kinko/invoices/<commitment>.json`, readable by you only, and are never printed or sent anywhere. The amount is not told to the backend unless you pass `--store-amount`.

Options: `--kind standard|multipay|donation`, `--asset kusd|night`, `--memo`, `--success-url`, `--cancel-url`, `--manifest <file>` or `--no-manifest`, `--json`.

To keep the secrets out of the CLI entirely, start a draft and let your wallet create the invoice in the web app:

```sh
kinko link --draft --title "Retainer"
```

## Watch it

```sh
kinko status invoice-12                 # a session id (cs_…), a commitment, or a name from the manifest
kinko wait invoice-12 --timeout 30m     # polls until paid, cancelled or expired
kinko list --status pending
```

`wait` exits 0 when the invoice is paid, 3 when it was cancelled or expired, and 4 when the time ran out, so a script can act on it.

## The manifest

`kinko link` adds each invoice to `kinko.json` in the current directory. `kinko manifest [file]` rewrites it from the backend, keeping the names you gave. It holds the session id, commitment, kind, asset, status, title, reference and the hosted page address, and no amounts or secrets, so it is safe to commit.

## Other commands

- `kinko decode <link>` reads what a payment link says. It works offline.
- `kinko webhook verify --header <Kinko-Signature value> --body-file <file> [--secret S]` checks a captured delivery.
- `kinko telegram code` gives a code to send the Kinko bot as `/link <code>`; `kinko telegram chats` and `kinko telegram unlink <chat id>` manage links.

`kinko help <command>` shows a command's options.

## Test

```sh
yarn workspace @kinko/cli test
yarn workspace @kinko/cli build   # type-checks
```

# Kinko 金庫

**A private dollar account on Midnight, backed one to one by USDC that anyone can count.**

You put USDC into a vault on Ethereum and hold the same amount of KUSD on Midnight, where only you can see it. You pay invoices, pay people by `@name`, and take your dollars back out as USDC whenever you like. The backing is public: every KUSD in circulation is matched by USDC in the vault, and any browser can check both chains directly, without trusting Kinko.

Built for the Midnight Buildathon on Midnight's Night Mode: the vault is a Midnight contract that controls an Ethereum account through Sig Network's MPC.

## Why

Two things usually go wrong with money held on someone else's books. Either it is private but you have to trust that it exists, or it is provable but every payment is public. Exchanges and custodial stablecoins ask for trust; a dollar on a public chain broadcasts every salary, supplier price and donation.

Kinko splits the two:

| Public, for everyone to check | Private, for the people involved |
|---|---|
| USDC held by the vault on Ethereum | Who holds KUSD, and how much |
| Total KUSD minted and burned, from the vault's own counters | Every payment between people |
| Each deposit and withdrawal on Ethereum | Invoice amounts, merchants and payers |

KUSD can only be minted by the vault contract, and only after Sig Network's signers attest that the matching USDC arrived. A mint without that attestation is refused by the contract itself.

## What works today

Every flow below runs in a real browser, against a real Midnight node, indexer and proof server, a forked Ethereum, Sig's MPC test network, Kinko's deployed contracts, the relayer and the backend. Each test checks the result on both chains, not just the screen.

| Flow | What the test does | Status |
|---|---|---|
| Deposit | $50 of USDC reaches a deposit address by an ordinary transfer; the app starts the deposit, the relayer carries it, the user mints $50 of KUSD. Checks the shielded balance, the vault's USDC and the public backing page. | Passing |
| Invoice payment | A merchant creates a $12.50 request; a customer opens the link in another browser and pays from their private balance. Checks both wallets' balances and the merchant's invoice status. | Passing |
| Hosted checkout | A merchant's server starts a draft through the SDK; the merchant's wallet creates the invoice from the draft link; a customer pays on the hosted checkout page. Checks that the backend sees the session settle from the chain, and the merchant's balance. | Passing |
| Refund | A customer pays, then gives the merchant their refund code; the merchant refunds from the invoice page. Checks both balances return to where they started and that a second refund is refused. | Passing |
| Invoices from the SDK, CLI or MCP server | An invoice built on the merchant's machine is published from the app's Invoices page and paid from its own link. Checks the merchant's balance and the invoice status. | Passing |
| Batch pay | A payer pastes a payroll file; the page names its bad line and refuses to pay, then pays the corrected file in one private transfer. Checks the recipient's balance. | Passing |
| Examiner disclosure | An account holder files a sealed statement; the operator registers an examiner; the examiner opens a case naming it; after one keyholder's approval the record stays sealed, after a second it opens and is checked against its on-chain anchor. | Passing |
| Gift card | An issuer funds a $2.50 card and sends its link; the recipient opens it with no wallet, sees it is genuine and what it holds, then moves it into their own account. Checks the card's balance on chain before and after, and the recipient's balance. | Passing |
| PIN card | An owner makes a card loaded with $3; someone holding the card and its PIN pays a $1.25 invoice with no wallet, Kinko's sponsor paying the fee; the owner's wrong PIN is refused; freezing moves the remaining $1.75 back. Checks the merchant's, the card's and the owner's balances on chain. | Passing |
| Invoice priced in NIGHT | The SDK prices an invoice at 40 NIGHT; the customer pays the KUSD Kinko's oracle quotes from NIGHT's live USD price, rounded up to a whole cent, and the contract verifies the oracle's signature inside the proof. NIGHT exists only unshielded, so this is how such an invoice is paid. Checks both KUSD balances move by the quoted price. | Passing |
| Pay by @tag | A merchant claims a tag; a customer pays $3 to it by name. Checks the merchant's balance. | Passing |
| Withdraw | A user withdraws $10 of KUSD to a fresh Ethereum address. Checks the USDC that arrives, the KUSD burned with the fee, and the backing page. | Passing |

Run them yourself with `yarn workspace @kinko/web e2e:live` once the local stack is up (below). The suite lives in [`apps/web/e2e/live`](apps/web/e2e/live).

Also in the product, tested in the contract simulator and unit suites: multi-payer and donation invoices, receipts and receipt proofs, revenue attestations, the merchant SDK, CLI and MCP server for AI assistants, and the Telegram bot.

On Midnight preprod, with real Sepolia and Sig Network's testnet MPC, against Kinko's own contracts deployed there ([`deployments/preprod.json`](deployments/preprod.json)), all twelve flows pass on the current code: deposit, withdraw, invoice, hosted checkout, refund, SDK invoices, batch pay, examiner disclosure, gift card, PIN card, NIGHT-priced invoice and @tag. The deposit and withdraw flows move real testnet USDC through the MPC and read it on Sepolia, where the vault's USDC is held: the last withdraw ran as $1 (set by `KINKO_LIVE_WITHDRAW_USDC`) because the test wallet held under $11, and an earlier $10 withdrawal was confirmed on Sepolia directly. Those two flows take 25 minutes each, waiting on the MPC; the rest take one to three. The preprod run is described under [Run it on preprod](#run-it-on-preprod).

A new card opens in seconds. On preprod the gift card flow went from 23.6 minutes to 1.8 and the PIN card flow from 2.3 hours to 2.7, because a card starts from the chain's tree at its birth instead of replaying every event (see [Opening a card fast](#how-it-works)). The tests read each card's balance two ways, from that snapshot and by replaying the chain from the first event, and the two agree.

Not finished, and not claimed:

- A hosted public URL. The preprod build is served from the developer's machine, with the backend, relayer, sponsor and snapshot service beside it.
- A fast open for a card with no birth. A recovery phrase pasted alone, or a card made before births were stamped, still replays the chain's shielded history: about 15 minutes in Chromium and over an hour in Firefox on preprod. A phrase pasted with the card's birth after it opens fast, and the card's page shows the birth beside the phrase; the PIN card flow checks that on preprod.
- The deposit flow on Sig's stagenet. Sig retired its stagenet MPC on 2026-11-11, so no deposit there can be signed; preprod is where the flows run.

## How it works

```
 Ethereum                         Midnight
 ┌──────────────┐   attests   ┌──────────────────────┐
 │ vault account│◀──────────▶│ vault contract       │  mints KUSD on an attested deposit,
 │ (held by MPC)│  Sig MPC    │ (Night Mode)         │  burns it on withdrawal, counts both
 └──────────────┘             └──────────────────────┘
        ▲                          │ KUSD (shielded)
        │ USDC                     ▼
   deposit address       ┌──────────────────────┐
   (derived, keyless)    │ kinko_pay, tags,     │  invoices, receipts, refunds,
                         │ gift                 │  @names, gift card registry
                         └──────────────────────┘
                         ┌──────────────────────┐
                         │ kinko_disclosure     │  records sealed to an examiner key,
                         └──────────────────────┘  opened only with two of three keyholders
```

- **Deposit.** USDC goes to an address the MPC derives from the user's private identity; nobody holds its key. The user signs `startDeposit`; the relayer carries the request through the vault queue, the signers sweep the USDC into the vault and attest it; the user signs `completeDeposit` and receives KUSD under a fresh nonce that cannot be linked to the deposit.
- **Pay.** Settling an invoice proves, in zero knowledge, that the coin is worth exactly the committed amount and is KUSD, then forwards it to the merchant's key sealed in the invoice. The chain records that the invoice was paid, not the amount, the payer or the merchant.
- **Withdraw.** The user burns KUSD and names an Ethereum address; the signers send the USDC from the vault. If the transfer fails, closing the withdrawal mints the KUSD back.
- **Cards.** A gift card or PIN card is a Midnight wallet whose 24-word phrase comes from the card (and, for a PIN card, the PIN, stretched with scrypt). It pays any invoice with real proofs but holds no DUST, so it binds its transaction with only its own value balanced and hands it to a fee payer: Kinko's sponsor at a checkout, or the holder's own wallet when moving the balance into their account. The sponsor can add a fee and nothing else.
- **Opening a card fast.** A wallet that has never synced replays every shielded event the chain has recorded, which on a public network is millions. A card is new, so nothing can have been paid to it before it was made, and it needs no event before that. The card's link carries its birth: the last event the snapshot service's published tree had applied when the card was made, and the chain's identity. The service (`services/snapshots`) follows the chain with a wallet that holds no coin and publishes its commitment tree; a card opened with a birth starts from the newest published tree at or before it and replays only what came after. The tree is public data with the keys swapped for the card's, and the wallet refuses a tree that does not match the chain, so a bad snapshot cannot show a wrong balance; after 45 seconds without progress the card starts again from the first event. A card with no birth still opens the slow way. A recovery phrase can carry the birth as a 25th item after the 24 words (the card's page shows it beside the phrase, and other wallets take the 24 words alone), and the unlock field reads it; a phrase pasted without it replays the chain.
- **Examine.** A merchant can file records sealed to an examiner key. An examiner opens a case naming specific records; two of three keyholders must approve before anything opens, and every disclosure is logged on chain.

More: [architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT-MODEL.md).

## Repository

| Path | What it is |
|---|---|
| `apps/web` | The web app: landing page, account, deposit, pay, request, invoices, batch pay, gift cards, PIN card, withdraw, merchant dashboard, hosted checkout, backing page, examiner view, docs |
| `apps/backend` | Merchant records, hosted checkout sessions, webhooks, the conversion oracle, notifications |
| `apps/bot` | Telegram notifications for merchants |
| `contracts/kinko-pay` | `kinko_pay`, `kinko_tags`, `kinko_gift` in Compact, with their TypeScript helpers |
| `packages/kinko-card` | Card wallets: open a gift card or PIN card from its secret, read its balance, spend it, hand the fee to a payer |
| `services/sponsor` | Kinko's fee sponsor: pays the DUST when a card pays an invoice, under an allowlist, a fee cap, a budget and a rate limit |
| `services/snapshots` | Publishes the chain's shielded commitment tree at recent events, so a brand-new card opens in seconds instead of replaying the whole chain |
| `contracts/kinko-disclosure` | The examiner disclosure contract, its key ceremony and the examiner's opening procedure |
| `engine/vault` | The ERC20 vault contract and its deploy and integration tooling, with mint and burn counters added for public backing |
| `services/relayer` | Carries vault requests through their permissionless steps; holds no user key |
| `packages/kinko-node` | The merchant SDK |
| `packages/kinko-mcp` | The MCP server that lets an AI assistant create and track invoices |
| `tools/kinko-cli` | The merchant CLI |
| `tools/deploy` | Deploys Kinko's contracts and runs payment and card smoke tests from Node |
| `packages/lib`, `packages/test-harness` | Shared Midnight plumbing and the local stack's test harness |

## Run it locally

You need Docker, Node 22, Yarn 4 and the Compact compiler 0.36.0 (`compact update 0.36.0`).

```bash
yarn install
yarn compile:zk                      # compiles every contract with its proving keys (about 2 GB)
yarn setup-local:erc20-vault         # starts the local stack, deploys the Signet signer, responder and vault, writes .env
yarn workspace @kinko/deploy deploy  # deploys Kinko's contracts and writes the app's environment
```

Then start the services, each in its own terminal:

```bash
RELAYER_ENV_FILE=.secrets/undeployed/relayer.env yarn workspace @kinko/relayer start
yarn workspace @kinko/backend start
yarn workspace @kinko/sponsor fund                                     # once: creates and funds the sponsor's wallet
SPONSOR_BUDGET_SPECK=10000000000000000 yarn workspace @kinko/sponsor start
yarn workspace @kinko/snapshots start                                 # lets new cards open in seconds; without it they replay the chain
yarn workspace @kinko/web dev
```

Signing in with an Ethereum wallet through 1AM's vault also needs `yarn workspace @kinko/web vault`, which serves NightKit's vault on its own origin.

`yarn workspace @kinko/deploy smoke:pay` creates and pays a $1 invoice from Node, with real proofs, as a quick check that the stack and contracts are healthy. `smoke:card` funds a fresh card, pays an invoice from it through the sponsor and sweeps it back.

## Run it on preprod

Sig Network's MPC signs for Midnight preprod and real Sepolia, and `@sig-net/midnight` publishes the Signet signer and responder it watches there, so a preprod vault needs no Sig addresses of its own. Preprod's node and indexer are served by Blockfrost. Every entrypoint reads the env file `KINKO_ENV_FILE` names (`.env` by default), so a preprod profile sits beside the local one. Put it in `.env.preprod` (gitignored):

```bash
NETWORK_ID=preprod
BLOCKFROST_PROJECT_ID=<a "Midnight preprod" project from blockfrost.io>
ROOT_SEED=<32 bytes of hex>              # fund its NIGHT address from https://midnight-tmnight-preprod.nethermind.dev
DEPLOYER_SEED=<the same seed>
MAINTENANCE_SIGNING_KEY=<32 bytes of hex, kept>
EVM_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
RESPOND_OUTPUT_SOURCE=mpc-cache          # read attested outputs from the MPC's published cache
ERC20_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
EVM_ALLOWED_TOKENS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238   # the vault refuses deposits of any other ERC20
VAULT_FEE_WITHDRAW=100000                # and VAULT_FEE_SWAP, _SUPPLY, _REDEEM, in USDC base units
```

Then, with only the proof server running locally:

```bash
export KINKO_ENV_FILE=.env.preprod
yarn deploy-initialise:erc20-vault       # the vault: base deploy, 28 circuit installs, initialise
# append MIDNIGHT_VAULT_CONTRACT_ADDRESS and EVM_VAULT_ADDRESS it prints to .env.preprod
yarn workspace @kinko/deploy deploy      # Kinko's contracts; writes apps/web/.env.preprod.local
yarn workspace @kinko/deploy fund-roles  # seeds and NIGHT for the relayer and the test parties
yarn workspace @kinko/sponsor fund
```

Before deploying anywhere public, open [Sig's explorer](https://sig-net.github.io/explorer/) on that network and check recent requests were signed: Sig retired its stagenet MPC on 11 November 2026, and a vault on a network the MPC no longer watches deploys fine and never completes a deposit.

A fresh wallet on a public network replays every DUST event in the chain's history before it can pay a fee. Each wallet keeps a cache of its synced state, checked against the wallet and the chain before it is restored, so only the first sync is slow. The cache lives in `.wallet-cache-<network>-<role>-<id>.json` at the repository root, or wherever `<ROLE>_WALLET_CACHE_PATH` names (`RELAYER_WALLET_CACHE_PATH`, `SPONSOR_WALLET_CACHE_PATH`, `DEPLOYER_WALLET_CACHE_PATH`); outside a git checkout, with no path named, a wallet syncs from scratch every time. Card wallets skip all of that: they hold only shielded tokens and never pay a fee, so they never start their DUST or unshielded wallets and talk only to the indexer and the proof server. A card with a birth starts from the tree `services/snapshots` published at that point and syncs in seconds; one without replays the shielded history from the first event, which on preprod takes about fifteen minutes in Chromium and over an hour in Firefox. Start the service beside the others (`SNAPSHOTS_PORT=4400` in the preprod profile); on a new deployment `SNAPSHOTS_BOOTSTRAP` points it at any synced wallet cache that holds no coin, so its first tree is ready at once instead of after a full replay.

Two things a public deployment needs that the local stack hides:

- **A Sepolia account for each side of the vault.** A deposit's sweep is paid by the deposit address, which the relayer tops up when `RELAYER_EVM_PRIVATE_KEY` is set. A withdrawal's transfer is paid by the vault's own Sepolia account, and the network refuses to broadcast it unless that account holds the transaction's whole fee ceiling: its gas limit times the vault's `maxFeePerGas` (0.03 ETH at 200,000 gas and 150 gwei). The local fork funds that account for you; on preprod you send it Sepolia ETH, or lower the ceiling with the vault's gas-settings circuit.
- **A deposit gas limit that fits the real USDC.** The first transfer into an empty vault writes its balance slot for the first time and costs about 140,000 gas on Sepolia's USDC, more than the 100,000 the example app signed it with, and a signed transaction that reverts cannot be retried. The app now signs deposit sweeps with 200,000; later transfers cost about 43,000.

The live suite runs against preprod the same way: `KINKO_ENV_FILE=.env.preprod yarn workspace @kinko/web e2e:live`, with the backend, relayer, sponsor and snapshot service started from their preprod profiles. It builds the app for preprod and serves it on port 4174. Steps wait for real blocks and finality, so a flow takes minutes: deposit and withdraw wait on the MPC, up to half an hour. The PIN card's holder is a Firefox with no wallet, which pays by uploading the circuit's 90 MB proving key to the proof server, a request that crashes Playwright's own Chromium connection. Each test wallet's cache is written to the path its `<ROLE>_WALLET_CACHE_PATH` names, so a rerun starts synced. A flow that needs more KUSD than its test wallet holds is skipped and says so, rather than passing. Setting `KINKO_LIVE_FULL_REPLAY=1` makes the tests read card balances by replaying the whole chain, to check them against the snapshot start.

## Tests

```bash
yarn test                            # unit, simulator and integration suites across the workspace
yarn workspace @kinko/web e2e        # every page in four looks, with a mocked chain
yarn workspace @kinko/web e2e:live   # the real flows above, against the local stack
yarn lint
```

## Security

Every defence Kinko relies on is listed in the [threat model](docs/THREAT-MODEL.md) next to the test that proves it. What Kinko cannot protect against is stated there too: collusion of a threshold of the MPC signers, a compromised device, and network-level metadata.

This is experimental software built for a hackathon. It has not been audited. Do not use it with funds you cannot afford to lose.

## Credits

Kinko is built on other people's work, used under their licences or with their owners' permission.

| Source | What Kinko uses |
|---|---|
| [Sig Network, midnight-examples](https://github.com/sig-net/midnight-examples) (MIT) | The ERC20 vault contract and its deploy, relayer-facing and test tooling, the shared Midnight plumbing in `packages/`, the local stack, and the workspace layout. The vault comes from its 0.26 line (stable ledger-9, the split Signet signer and responder), with Kinko's supply counters added. Night Mode itself: `@sig-net/midnight`, `@sig-net/midnight-signer`, `@sig-net/midnight-contract-deploy`, including its wallet cache. |
| [NullPay](https://github.com/geekofdhruv/NullPay) by Dhruv | The product Kinko's payments layer is modelled on: invoices and their lifecycle, receipts, batch pay, gift cards, the PIN card, hosted checkout, the merchant dashboard, the SDK, CLI, MCP server and bot, and the interface design. Used with the author's permission. |
| Mask | The earlier port of NullPay's contracts to Compact that Kinko's payment contracts started from. |
| [Stock & Foil](https://gitlab.com/RaYYeR220/stock-and-foil) (Apache-2.0) | The disclosure design: records sealed in-circuit to an examiner key, two-of-three keyholder approval, case-scoped shares and the disclosure log. The fee sponsor in `services/sponsor` (policy, service, HTTP server and their tests) is adapted from its sponsor, modified for Kinko's contracts, wire format and wallet. |
| [Midnight examples: private-party](https://github.com/midnightntwrk/midnight-examples) (Apache-2.0) | The DUST sponsorship pattern the card wallet and sponsor follow: the user binds a transaction balancing only its own value, and the sponsor balances DUST alone. |
| [NightKit](https://nightkit.1am.xyz) by 1AM | Wallet connection for Midnight wallets and Ethereum sign-in, and fee sponsorship for its accounts. |
| [Midnight](https://github.com/midnightntwrk) | Compact, midnight-js, the wallet SDK and the DApp Connector API, and the example applications studied for browser wiring. |

Studied for ideas, with no code taken: zk.money (Aztec), USDCx (Aleo), Railgun's Private Proofs of Innocence, Chainlink Proof of Reserve, exchange proof-of-reserve pages, and the wallet birthday that Zcash and Bitcoin light wallets use to skip the history from before a wallet existed, which the card's birth and `services/snapshots` carry over to Midnight's shielded tree.

## Licence

Apache-2.0. See [LICENSE](LICENSE).

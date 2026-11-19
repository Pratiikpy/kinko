# Kinko architecture

Kinko is a private dollar account on Midnight. A user deposits USDC on Ethereum and holds the same amount as a shielded token on Midnight, pays with it privately, and withdraws it back to USDC. This document describes how the pieces fit, who does what in each flow, and what each piece is trusted for.

## Components

| Component | Where | Role |
|---|---|---|
| Vault contract | `engine/vault/contract` | Owns an Ethereum account through Sig Network's MPC. Mints the shielded dollar (KUSD) on an attested USDC deposit, burns it on withdrawal, and can lend idle balance on Aave. |
| Signet singleton | npm `@sig-net/midnight-contract` | The protocol contract the MPC watches for signature requests and posts attestations to. |
| MPC network | Sig Network (a local fakenet in development) | Holds the vault's Ethereum key collectively. Signs the transactions the vault requests and attests their outcome back to Midnight. |
| Payments contract | `contracts/kinko-pay` (`kinko_pay`) | Invoices (standard, multipay, donation), shielded settlement in KUSD or NIGHT, receipts, a historic receipt tree, revenue attestations, batch settlement, refunds, expiry. |
| Gift card registry | `contracts/kinko-pay` (`kinko_gift`) | Records a commitment per issued gift card so a recipient can check it is genuine and not voided. Holds no value: the card's KUSD sits in the card's own wallet. |
| Card wallets | `packages/kinko-card` | A gift card or PIN card is a Midnight wallet: its 24-word phrase is derived from the card (and, for a PIN card, the PIN through scrypt). It syncs from the indexer, spends with real proofs, balances only its own value, and hands a bound transaction to a fee payer. |
| Tag registry | `contracts/kinko-pay` (`kinko_tags`) | Maps a public `@name` to receiving keys so people pay a name instead of an address. |
| Disclosure contract | `contracts/kinko-disclosure` | Records sealed in-circuit to a disclosure key; examiner cases scoped to named records; two of three keyholders approve; every disclosure logged. |
| Relayer | `services/relayer` | Carries vault requests through their permissionless steps: flushes, sends, polls the MPC, broadcasts signed Ethereum transactions, queues attestations. Holds no user key and cannot move user funds. |
| Fee sponsor | `services/sponsor` | Pays the DUST when a card pays an invoice, so a card holder needs no wallet. Allowlisted contract and circuit, per-transaction cap, total budget, per-client rate limit, a privacy-preserving ledger of what it paid. |
| Card snapshots | `services/snapshots` | Follows the chain with a wallet that holds no coin and publishes its commitment tree at recent events, so a new card starts from where it was made instead of replaying every event. Serves public data only. |
| NightKit's sponsor | NightKit (`nightkit-vault`) | Pays fees for accounts opened through NightKit. |
| Backend | `apps/backend` | Merchant records, hosted checkout sessions, webhooks, notifications, the AI assistant endpoint. Never sees a private key, an amount it was not given, or a witness. |
| Web app | `apps/web` | Landing page, account, deposit, pay, request, invoices, batch pay, gift cards, PIN cards, a card page that opens any card without a wallet, card payment at every invoice and checkout, withdraw, merchant dashboard, hosted checkout, backing page, examiner view, docs. |
| Merchant CLI | `tools/kinko-cli` | Registers a merchant, builds invoices locally, makes payment and checkout links, waits for payment. |
| Deploy tooling | `tools/deploy` | Deploys Kinko's contracts, records their addresses for every service, and runs a payment smoke test from Node. |
| SDK and MCP server | `packages/kinko-node`, `packages/kinko-mcp` | The merchant SDK, and the MCP server through which an AI assistant creates and tracks invoices. |

## Flows

### Deposit (USDC in, KUSD out)

1. The user sends USDC to their deposit address on Ethereum. The address is derived by the MPC from the user's identity commitment; nobody holds its key.
2. The user calls `startDeposit` on the vault (their wallet proves and submits).
3. The relayer flushes the request, calls `sendDeposit`, waits for the MPC's signature, broadcasts the signed sweep from the deposit address to the vault's Ethereum account, waits for the MPC's attestation and queues it.
4. The user calls `completeDeposit`. The vault verifies the attestation and mints KUSD to the user's shielded address.

The user signs two Midnight transactions and one Ethereum transfer. Everything in between is permissionless and carried by the relayer.

### Pay

A payer settles an invoice in `kinko_pay` with a KUSD coin. The circuit checks the coin's value equals the committed amount and its colour equals the sealed KUSD colour, records a nullifier and a receipt, and forwards the coin to the merchant, all shielded. Paying a tag resolves the tag's receiving keys from `kinko_tags` and sends a shielded transfer.

### Withdraw (KUSD in, USDC out)

The user calls `startWithdraw` with a KUSD coin (burned, minus a flat fee) and an Ethereum destination. The relayer carries the request; the MPC signs a USDC transfer from the vault's account; the user calls `completeWithdraw`, which re-mints on a failed transfer.

### Examination

A holder files sealed records to `kinko-disclosure`. An examiner registered by the operator opens a case naming records. Two keyholders approve by posting decryption shares sealed to the examiner. The examiner combines them off-chain and decrypts exactly those records, each verified against its on-chain anchor.

## What is public, what is private

| Public | Private |
|---|---|
| Each USDC deposit and withdrawal on Ethereum (address, amount) | Who holds KUSD on Midnight and how much |
| Each KUSD mint and burn amount, so total supply | Every payment between users |
| The vault's USDC balance on Ethereum | Invoice amounts, merchants and payers |
| Tag names and the receiving keys behind them | Which payments reached which tag |
| Disclosure log entries (case, scope hash, time) | The contents of any record |

## Trust

| Party | Trusted for | Not able to |
|---|---|---|
| MPC network | Signing only what vault circuits request, and attesting outcomes honestly | Mint KUSD (only the vault does, on a verified attestation); see Midnight balances |
| Relayer | Liveness | Steal, redirect or mint: every step it submits is a public circuit whose arguments the user fixed |
| Fee sponsor | Paying fees | Change a transaction it sponsors, or spend a card |
| Backend | Availability of merchant records | Read private amounts or keys |
| Operator and keyholders | Registering examiners; approving disclosures (two of three) | Open any record alone |

## Networks

- Development: the local stack in `docker-compose.yaml` (Midnight node, indexer, proof server, an Ethereum fork of Sepolia with real USDC, and the MPC fakenet).
- Public: Midnight preprod with Ethereum Sepolia, where Sig Network's MPC runs (its stagenet MPC was retired on 11 November 2026).
- Mainnet: when Night Mode opens on Midnight mainnet.

## Toolchain

Compact compiler 0.36.0 for every contract in the repository, the version the vault is pinned to; the npm stack is the stable ledger-9 set Midnight mainnet runs (`@midnightntwrk/ledger-v9` 1.0.1, `@midnight-ntwrk/midnight-js` 5.0.0, `@midnight-ntwrk/compact-runtime` 0.21.0, wallet SDK 5.0.0) with `@sig-net/midnight` 0.26, which splits Signet into a signer the vault notifies and a responder the MPC answers on. The local stack runs node 2.1.101, indexer 4.4.101 and proof server 9.0.1. Contracts move together when the vault moves.

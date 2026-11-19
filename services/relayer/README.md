# Kinko relayer

Carries a vault request through every step that needs no user key, so the user signs only
their start circuit, their complete circuit and one Ethereum transfer.

```
user                         relayer                              MPC network
startDeposit ──────────────▶ flush ▶ send ──────────────────────▶ signs the sweep
(USDC to deposit address)    broadcast the signed sweep ◀───────── signature response
                             queue the attestation ◀───────────── attests the outcome
                             flush the attestation  ▶ ready
completeDeposit ───────────▶ (the request leaves the vault: completed)
```

Withdrawals take the same path from `startWithdraw` to `completeWithdraw`.

The relayer holds its own Midnight wallet (`RELAYER_SEED`) and pays the fees. Every circuit it
submits (`flushQueue`, `sendDeposit`, `sendWithdraw`, `queueAttestation`) is permissionless and
fixes its effect from arguments the user already committed to, so a relayer cannot steal,
redirect or mint. What it can do is stall: if it stops, a user can run the same steps
themselves.

## Stages

`queued → flushed → sent → signed → broadcast → attested → ready → completed`, or `failed` with
a reason. A stage is derived from the vault's ledger wherever the ledger shows it, so a
restart, a repeated tick or a step that half-landed all converge on the same stage. State is
persisted to `RELAYER_STATE_FILE` after every change.

Each tick reads the vault once and starts the step each request waits on. Reads are
single-shot and run for every request in parallel. Midnight writes share one wallet and run
one at a time, and every request that needs a flush shares one flush transaction.

## API

| Request | Answer |
|---|---|
| `GET /health` | `{ ok, network, vaultContractAddress, evmVaultAddress, usdcAddress, evmChainId }` |
| `GET /deposit-address?commitment=<64 hex>` | `{ evmAddress }`, the deposit address the MPC derives for an identity commitment |
| `POST /requests` `{ kind: "deposit" \| "withdraw", requestId }` | `202 { requestId }` once the vault holds the request |
| `GET /requests/<requestId>` | `{ kind, stage, evmTxHash?, error?, updatedAt }` |
| `GET /backing` | `{ usdcInVault, kusdMinted, kusdBurned, vaultContractAddress, evmVaultAddress, usdcAddress, ethereumBlock, midnightBlock, updatedAt }`, amounts as strings of base units |

Errors are `{ "error": { "code", "message" } }`. Codes: `invalid_json`, `invalid_body`,
`invalid_kind`, `invalid_request_id`, `invalid_commitment`, `request_not_found`,
`kind_mismatch`, `payload_too_large`, `rate_limited`, `chain_unavailable`, `method_not_allowed`,
`not_found`, `internal_error`.

A deposit's request id is known from the moment `startDeposit` queued it, so it can be
registered at once. A withdrawal's id depends on the vault nonce its flush assigns, so it exists
only after a flush: the relayer flushes and sends every queued deposit and withdrawal it sees
(`RELAYER_SERVE_UNREGISTERED`), and a withdrawal is registered once its id is on the ledger.
Registering a request is what puts it on the relayer's books for the steps after the send.

`/backing` reads the vault's USDC balance on Ethereum and the vault's public supply counters:
`kusdMinted - kusdBurned` is the KUSD in circulation, fee coins included.

## Run

```
cp services/relayer/.env.example .env      # fill in, then:
yarn workspace @kinko/relayer start
```

`.env.example` documents every variable. On startup the relayer refuses to run if the vault is
not initialised, if `EVM_CHAIN_ID` is not the chain the vault is pinned to, or if
`MPC_SECP256K1_PUBKEY` does not derive the vault's own Ethereum account.

## Gas top-up and what it trusts

A deposit's sweep is sent from the user's deposit address, which needs ETH. With
`RELAYER_EVM_PRIVATE_KEY` set the relayer sends that address the shortfall of the sweep's gas
ceiling, no more, within `RELAYER_GAS_MAX_PER_ADDRESS_WEI` and `RELAYER_GAS_MAX_PER_DAY_WEI`,
which survive restarts.

This makes the relayer's Ethereum key a spender of real ETH for strangers: anyone who can queue
a deposit can make it fund the address that deposit derives. The limits are the whole defence,
and the most the account can lose to others in a day is the per-day limit, so fund it with
little more than that. The key never touches Midnight, USDC or a user key, and only deposits
are funded.

## Tests

`yarn workspace @kinko/relayer test` runs the offline suite: the stage machine against in-memory
chains, persistence, configuration, the HTTP layer, the EVM adapter and gas limits, and the
vault view against the compiled contract run in-process.

`RUN_INTEGRATION_TESTS=1 yarn workspace @kinko/relayer test tests/live.test.ts` runs the live
suite against the local stack (`docker compose up -d`, then `yarn setup-local:erc20-vault`):
two deposits, one of them from an address with no ETH, and a withdrawal, each carried by the
relayer, with the balances on both chains and `/backing` checked against what the user did.

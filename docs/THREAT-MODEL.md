# Threat model

What Kinko defends against, what it does not, and where each defence lives. Every defence Kinko implements has a test, named in the last column of its row. Defences provided by a dependency say so.

## Assets

1. USDC held in the vault's Ethereum account.
2. Users' shielded KUSD on Midnight, including KUSD held on gift cards and PIN cards.
3. Privacy: who holds what, who paid whom, and how much.
4. Disclosed records, which must open only to the examiner a case names.

## Actors

| Actor | Capability |
|---|---|---|
| Any Midnight user | Calls any circuit, reads all public ledger state and transactions |
| Any Ethereum user | Sends transactions, reads the chain |
| The relayer | Submits permissionless vault circuits and Ethereum broadcasts |
| Kinko's fee sponsor (`services/sponsor`) | Adds DUST to a card's bound transaction when the card pays an invoice |
| NightKit's fee sponsor | Adds DUST to transactions of accounts opened through NightKit |
| Whoever holds a card | Spends a gift card from its link; spends a PIN card with its link and PIN |
| The MPC network | Signs Ethereum transactions the vault requests, posts attestations |
| The backend | Stores merchant records and checkout sessions |
| The operator and keyholders | Register examiners; approve disclosures |

## Minting and withdrawing

| Threat | Defence | Tested in |
|---|---|---|
| Minting KUSD without depositing USDC | The vault mints only in `completeDeposit`, after verifying an MPC attestation over the executed sweep against the response key pinned at initialise. Attestations below the start height or for another request are rejected. | `engine/vault/contract/tests/erc20-vault.test.ts` (completeDeposit settle), `engine/vault/integration-tests/tests/happy-day-e2e.test.ts` |
| Replaying an attestation | Each request is consumed on completion; a stale attestation (block height not above the request's last seen height) is rejected. | `engine/vault/contract/tests/erc20-vault.test.ts` (completeDeposit settle), `engine/vault/integration-tests/tests/false-claimer.test.ts` |
| Claiming someone else's deposit | Completion is depositor-only: the claimant must answer the identity witness that produced the request. | `engine/vault/integration-tests/tests/false-claimer.test.ts`, `engine/vault/integration-tests/tests/deposit-claimant-not-caller.test.ts` |
| Withdrawing with a foreign token | `startWithdraw` checks the coin's colour is the vault token for that ERC20. | `engine/vault/contract/tests/erc20-vault.test.ts` (withdraw validation), `engine/vault/integration-tests/tests/allowed-tokens-e2e.test.ts` |
| Losing funds when an Ethereum transaction fails | Complete circuits settle every verdict the MPC can attest (executed, failed, unviable); failed and unviable withdrawals re-mint the principal. | `engine/vault/contract/tests/erc20-vault.test.ts` (completeWithdraw settle), `engine/vault/integration-tests/tests/deposit-withdrawal-failure-refund.test.ts` |
| Supply drifting from reserves unnoticed | The vault counts minted and burned amounts per token in public ledger state; the backing page compares circulating supply with the USDC balance of the vault's Ethereum account. | `engine/vault/contract/tests/erc20-vault.test.ts` (supply counters), `apps/web/src/lib/vault.test.ts` |

## The relayer and the fee sponsor

| Threat | Defence | Tested in |
|---|---|---|
| A malicious relayer redirects funds | It cannot: every circuit it submits is permissionless and carries arguments the user fixed at start; the MPC signs only what the vault's ledger records. | `services/relayer/tests/engine.test.ts`, `engine/vault/integration-tests/tests/deposit-claimant-not-caller.test.ts` |
| A relayer stops working | Every step it performs can be performed by anyone, including the user; the app shows the stage and the next action. | `services/relayer/tests/engine.test.ts`, `services/relayer/tests/store.test.ts` |
| Kinko's sponsor alters a card's transaction | The card proves, balances its own value only, signs and binds before anything is sent; the sponsor balances `['dust']` and nothing else, and a transaction it changed would fail its binding on chain. | `tools/deploy/src/smoke-card.ts` (live), `apps/web/e2e/live/11-card.spec.ts` |
| A stranger drains Kinko's sponsor | It pays only for calls to Kinko's pay contract and only `settle_invoice`, read from the transaction it deserialized, never from the request; a per-transaction fee cap; a total budget, reserved synchronously so concurrent requests cannot pass it together; a per-client rate limit keyed on the socket, or on `X-Forwarded-For` only from named proxies. It refuses before any DUST moves. | `services/sponsor/test/policy.test.ts`, `service.test.ts`, `http.test.ts`, `server.test.ts` |
| Kinko's sponsor leaks what it paid for | It logs the contract, circuit names, fee and transaction id; never the transaction bytes, addresses, amounts or upstream error text, which can quote a transaction. Callers get a fixed sentence per refusal. | `services/sponsor/test/privacy.test.ts` |
| Either sponsor runs out of DUST | The sponsor refuses with `SPONSOR_OUT_OF_DUST` before anything is spent; a card can still pay with a connected wallet covering the fee, and NightKit accounts holding DUST pay their own. | `services/sponsor/test/service.test.ts`; NightKit (`nightkit-vault`), outside this repository |

## Payments

| Threat | Defence | Tested in |
|---|---|---|
| Underpaying an invoice | The settlement circuit asserts the coin value equals the committed amount, with both private. | `contracts/kinko-pay/test/kinko-pay.test.ts` (wrong amount, salt, token or payout key) |
| Paying in a worthless token | The coin colour must equal the sealed KUSD colour. An invoice priced in NIGHT is paid in KUSD at a rate the oracle signs; the circuit verifies the signature against the key sealed at deployment, the quote's expiry, and that the coin is exactly the quoted KUSD. | `contracts/kinko-pay/test/kusd-colour.test.ts`, `contracts/kinko-pay/test/settlement-asset.test.ts`, `apps/web/src/lib/quote.test.ts`, `apps/web/e2e/live/12-night.spec.ts` |
| Paying twice, or replaying a payment | A nullifier per invoice, payer and index; spent nullifiers are rejected. | `contracts/kinko-pay/test/kinko-pay.test.ts` (second settlement, replay, same index) |
| Linking invoices by their terms | A single domain-separated hash over the full preimage with an undisclosed salt; no additive structure to subtract. | `contracts/kinko-pay/test/privacy-observer.test.ts` |
| Cancelling someone else's invoice | Close and cancel require the per-invoice owner secret, which is never part of the payment link. | `contracts/kinko-pay/test/kinko-pay.test.ts` (caller without the invoice terms) |

## Cards

| Threat | Defence | Tested in |
|---|---|---|
| Someone finds a printed PIN card | The card's keys come from its 32 bytes and the PIN together, through scrypt (N = 2^17, r = 8: 128 MiB and about half a second per guess). PINs are six to twelve digits; repeated and running digits are refused. No check value is printed, so a guessed PIN can only be confirmed by syncing its wallet against the chain. The owner freezes the card by moving its balance back. | `packages/kinko-card/test/seed.test.ts`, `apps/web/e2e/live/11-card.spec.ts` (wrong PIN refused, freeze) |
| A card's keys differ between issuer and holder | One derivation, shared by the app, the tests and Node tools: a card is the Midnight wallet its 24-word phrase opens. Version-1 gift cards, whose keys were not a wallet's, are refused rather than opened to the wrong keys. | `packages/kinko-card/test/seed.test.ts` (same address as a wallet derives), `contracts/kinko-pay/test/kinko-gift.test.ts` |
| A forged gift card | The recipient checks the card's commitment in the issuer's registry and its void flag before accepting it. | `contracts/kinko-pay/test/kinko-gift.test.ts`, `apps/web/e2e/live/10-gift.spec.ts` |
| The snapshot service gives a card a wrong tree | The app starts a card from a published commitment tree only if the snapshot is for its network and format, carries no coin and does not defer its coin check (a deferred check would let a tree carry coins the card then displays), and was taken at or before the card's birth (a later tree would skip the events that funded the card and show nothing). A tree that does not match the chain's makes the wallet refuse the events that follow ("values inserted non-linearly into zswap commitment tree"), so it never syncs; after 45 seconds without progress the card starts again from the chain's first event, and "Read the whole chain" on the card page does so on demand. Published trees carry placeholder keys, so they name no wallet and give no one an address to send a coin to; the service's own wallet key is drawn on first start and never published. Not covered: a forged tree of the right size whose hashes are wrong, which the wallet's checks may not catch before a spend fails (NOT VERIFIED on a live chain), and a service that stamps a later birth on a card being made, which shows as an empty card until it is read the whole way. | `packages/kinko-card/test/snapshot.test.ts`, `services/snapshots/test/snapshots.test.ts`, `apps/web/src/lib/card-snapshot.test.ts`, `apps/web/e2e/live/10-gift.spec.ts`, `apps/web/e2e/live/11-card.spec.ts`; the wrong-tree fallback was run by hand against the local chain |
| The snapshot service learns who opens which card | It sees the caller's address and the time of two requests, one when a card is made (`/latest`) and one when it is opened (`?birth=`), and the indexer sees the event a card starts from, which dates the card. It sees no key, amount or balance. Cards made from the same snapshot share a birth, which blurs the link; a service operator could still match a maker's request to an opener's by address and time. Not defended; run the service yourself to remove the third party. | `services/snapshots/test/snapshots.test.ts` (what is served) |

Not defended, by design: a gift card is cash, and whoever holds its link can spend it. Someone holding a PIN card with enough computing power can search the PIN space offline; the stretch makes that slow, and freezing is the remedy. A card proves through the configured proof server, which sees the spend's private inputs, as with any Midnight wallet that proves remotely; a local proof server keeps them on the holder's machine.

## Disclosure

| Threat | Defence | Tested in |
|---|---|---|
| One keyholder opening records alone | Two distinct keyholder shares are required; repeats and a third approval are rejected. | `contracts/kinko-disclosure/test/cases.test.ts` (ALREADY_APPROVED, THRESHOLD_REACHED, NOT_KEYHOLDER) |
| An examiner reading outside the case | Shares are bound to the records named in the case's scope hash. | `contracts/kinko-disclosure/test/cases.test.ts` (BAD_SCOPE, one share per record in scope) |
| A forged or altered record | Each record is anchored at filing; the examiner verifies the decrypted record against its anchor. | `contracts/kinko-disclosure/test/filing.test.ts` (the anchor catches any altered slot) |
| A rogue disclosure key at deployment | The key ceremony is validated in-circuit at deployment. | `contracts/kinko-disclosure/test/ceremony.test.ts` (BAD_DISCLOSURE_KEY, BAD_KEY_SHARING) |

## Out of scope, stated plainly

- Collusion of a threshold of the MPC network's signers, which could move the vault's USDC.
- A compromised user device, which holds the user's keys and witnesses.
- Network-level metadata (IP addresses, timing) outside the chain.
- Deposits and withdrawals are public on Ethereum by design; privacy covers what happens between them.

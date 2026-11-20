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
| A malicious relayer redirects funds | Every circuit it submits is permissionless and carries arguments the user fixed at start, and the MPC signs only what the vault's ledger records. The two things a user takes on trust from a relayer are checked in the browser instead: a build that pins the vault (`VITE_VAULT_CONTRACT_ADDRESS`, `VITE_USDC_ADDRESS`, `VITE_EVM_VAULT_ADDRESS`) believes the pin and turns vault features off if the relayer reports otherwise, and a build that also pins the MPC's published key (`VITE_MPC_PUBLIC_KEY`) derives the deposit address itself and refuses a different one. The backing page reads USDC from the Ethereum account the Midnight ledger names, not the one a relayer or build file supplies. A build that pins nothing, or pins only some of the variables, believes the relayer for these, which is for local development only; Settings says which case a build is in. The Ethereum chain id comes from the build, never the relayer. | `services/relayer/tests/engine.test.ts`, `engine/vault/integration-tests/tests/deposit-claimant-not-caller.test.ts`, `apps/web/src/lib/deposit-address.test.ts` |
| A relayer stops working | Every step it performs can be performed by anyone, including the user; the app shows the stage and the next action. | `services/relayer/tests/engine.test.ts`, `services/relayer/tests/store.test.ts` |
| Kinko's sponsor alters a card's transaction | The card proves, balances its own value only, signs and binds before anything is sent; the sponsor balances `['dust']` and nothing else, and a transaction it changed would fail its binding on chain. | `tools/deploy/src/smoke-card.ts` (live), `apps/web/e2e/live/11-card.spec.ts` |
| A stranger drains Kinko's sponsor | It pays only for calls to Kinko's pay contract and only `settle_invoice`, read from the transaction it deserialized, never from the request (the contract actions are what is limited: the shielded and unshielded offers bundled with the call are not, so one allowed call can carry other transfers up to the per-transaction fee cap, which is why that cap is small); a per-transaction fee cap; a total budget for the life of the process (a restart restores it, as the ledger is not read back), reserved synchronously so concurrent requests cannot pass it together; a transaction the node has already been sent (compared after ignoring `0x` and letter case) is refused before it can cost any budget, but only until the process restarts, and a transaction refused before submission may be retried; a per-client rate limit keyed on the socket, or on `X-Forwarded-For` only from named proxies. It refuses before any DUST moves. | `services/sponsor/test/policy.test.ts`, `service.test.ts`, `http.test.ts`, `server.test.ts` |
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
| A forged gift card | The recipient checks the card's commitment in the issuer's registry and its void flag before accepting it. The registry entry is looked up under the issuer id carried in the card's own link, so a forger's own issuer can make a card show as genuine: it proves the card was issued by that issuer, not that the issuer is who the recipient expects. The balance shown is read from the chain and is real either way. | `contracts/kinko-pay/test/kinko-gift.test.ts`, `apps/web/e2e/live/10-gift.spec.ts` |
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

## Known limits that need a contract change

These were found by independent reviews; the first two are fixed in the deployed contract and the others are not.

- **(Fixed in the pay contract deployed 2026-11-19.) An invoice's link could be used before the merchant published it.** The commitment now includes the owner tag, so only the holder of the owner secret can publish the invoice a link names; someone who creates the same terms with their own owner secret gets a different commitment that no link points at (`contracts/kinko-pay/test/kinko-pay.test.ts`, "invoice squatting"). Links and receipt proofs made for the earlier contract carry no owner tag and are refused. Publishing before sharing the link is still the right habit, but it is no longer what keeps the invoice yours. The expiry is not in the commitment, so it is only the owner's to set, not bound to the link.
- **(Fixed in the pay contract deployed 2026-11-20.) An invoice priced in NIGHT and paid in KUSD could not be refunded.** `refund_payment` returns the invoice's own asset and amount, and the app pays NIGHT invoices only by converting KUSD, so the refund it built (a KUSD coin) was refused. `refund_converted` returns the asset that was paid, to the refund key bound into the receipt, and shares the refunded set with `refund_payment`, so one payment is refunded once through either. A first version let the refund amount come from the payer's refund code and let any receipt through, which an independent review found: a payer could edit the code to ask for more, a merchant could return less and still mark the payment refunded, and a payment made directly in KUSD could be "refunded" in the wrong asset, which also blocked its full refund. Settlement now records a digest of the receipt, the payer's secret key, the amount paid and the asset (`converted_payments`), and a mark of the receipt (`converted_marks`); `refund_converted` recomputes the digest and refuses anything that does not match, and `refund_payment` refuses a marked receipt, so the amount and the route are checked by the contract and the merchant cannot pick the cheaper of two refunds. The amount is hidden from anyone who sees only the ledger, because the payer's key is in the hash; it is not hidden from anyone who holds that key (the payer, anyone given a receipt-proof link or a refund code) or from the merchant, who received the coin. A payer's code that names the wrong amount makes the merchant's refund fail rather than pay out. Refund codes from before this deployment carry no paid amount, so refunding a NIGHT invoice asks the payer for a new one. (`contracts/kinko-pay/test/refund-converted.test.ts`.)
- **A receipt-proof link can be used to waste a refund.** The link carries the payer's key, refund key and index, which is also what names a payment for a refund. The encryption key in a refund code is not bound to the receipt, so a holder of the link can write a refund code with their own encryption key. The merchant's refund then goes to the payer's refund key, encrypted to a key the payer does not hold, and the refunded tag is spent. The payer's wallet cannot read that coin. Binding the encryption key into the receipt would close it but changes the receipt digest, every receipt consumer and every proof link; it has not been done. The Receipts page now tells a payer that a proof link carries this, and it can show the payer's refund code again, so the payer gives the merchant the right one. Give a proof link only to someone you trust not to do this.
- **Two identical deposits started before the first is swept** get the same request identity. Start the next deposit after the first has moved on.

## Witness reads in the pay contract

A witness is a private input the prover answers each time a circuit asks for it, and nothing ties two answers together. Until the source was changed, `settle_invoice` read the invoice amount and the payout key once to build the commitment and again to check and forward the coin, `settle_invoice_converted` read the amount twice (commitment, then the oracle's quote) and the payout twice, and `refund_payment` read the amount twice. A payer controlling the prover could answer the first read honestly and the second with a smaller amount or their own key, and the invoice would settle while the merchant received less, or nothing. `attest_revenue_at_least` read the merchant key five times (once per payment and once for the digest), so the commitments could name one merchant and the digest another. The source now reads each witness once per circuit and passes the value down, and `contracts/kinko-pay/test/witness-single-read.test.ts` asserts the exact read count of every witness in every circuit, batch and attestation included, so it fails if a circuit asks twice (it fails on the earlier source, and on a mutant that puts the attestation read back). A second review confirmed the compiled circuits use one input for both the commitment and the coin check. The exploit was reproduced in the contract simulator, not with real proofs on a chain. The pay contract deployed on preprod on 2026-11-20 has the fixed source.

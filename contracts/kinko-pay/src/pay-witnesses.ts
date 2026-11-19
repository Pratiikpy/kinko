// Private-state witnesses for kinko_pay.
//
// A witness is a value the contract asks the caller's own machine for. None is
// transmitted: each is a private input to the proof, and the compiler refuses
// to let any reach the public ledger without an explicit disclose().
//
// This is the single definition. The tests, the app and any headless client
// import it, so a witness added to the contract is added here once and a
// missing one fails the type check rather than a transaction.

import type { MerkleTreePath } from "@midnight-ntwrk/compact-runtime";

import type { Ledger, Witnesses } from "./managed/kinko_pay/contract/index.js";

/** A zswap coin public key as the contract takes it. */
export interface CoinPublicKey {
  readonly bytes: Uint8Array;
}

/** Everything a Kinko Pay caller keeps on their own machine. Never transmitted. */
export interface PayPrivateState {
  /** The merchant's identity key. Carried in the payment link, so it is not an authority. */
  readonly merchantKey: Uint8Array;
  /** Where the merchant is paid. Part of the commitment, so a payer cannot redirect the coin. */
  readonly merchantPayout: CoinPublicKey;
  /** Per-invoice randomness. Publishing it would make equal invoices linkable. */
  readonly salt: Uint8Array;
  /** The invoice amount in base units of its asset. Never disclosed. */
  readonly amount: bigint;
  /** The payer's per-payment secret. Fresh for every payment. */
  readonly payerKey: Uint8Array;
  /** Where a refund of this payment goes. Bound into the receipt. */
  readonly payerRefund: CoinPublicKey;
  /** Distinguishes deliberate repeat contributions from replays. Pinned to 0 for STANDARD. */
  readonly paymentIndex: bigint;
  /** Per-invoice ownership secret. Authorises close, cancel and refund; never in a payment link. */
  readonly ownerSecret: Uint8Array;
  /** Amount actually handed over when settling in the other asset. */
  readonly convertedAmount: bigint;
  /** The invoice's public owner tag, as its payment link carries it. A payer's copy; never a secret. */
  readonly invoiceOwner: Uint8Array;
  /** Evidence backing a revenue attestation. Receipts are derived from it, never given. */
  readonly attestedAmounts: readonly bigint[];
  readonly attestedSalts: readonly Uint8Array[];
  readonly attestedOwners: readonly Uint8Array[];
  readonly attestedPayouts: readonly Uint8Array[];
  readonly attestedPayers: readonly Uint8Array[];
  readonly attestedRefunds: readonly Uint8Array[];
  readonly attestedIndices: readonly bigint[];
  readonly attestedPaths: readonly MerkleTreePath<Uint8Array>[];
  /** Four invoices paid under one proof. */
  readonly batchAmounts: readonly bigint[];
  readonly batchSalts: readonly Uint8Array[];
  readonly batchOwners: readonly Uint8Array[];
  readonly batchMerchants: readonly Uint8Array[];
  readonly batchPayouts: readonly CoinPublicKey[];
  readonly batchIndices: readonly bigint[];
}

const ZERO32 = new Uint8Array(32);

/**
 * A private state with every field zeroed or empty. The app overlays the
 * fields a given call needs; a circuit reading a field nobody set reads zeros,
 * which reproduce no real commitment and so fail closed.
 *
 * @returns A fresh empty private state.
 */
export const emptyPayPrivateState = (): PayPrivateState => ({
  merchantKey: ZERO32,
  merchantPayout: { bytes: ZERO32 },
  salt: ZERO32,
  amount: 0n,
  payerKey: ZERO32,
  payerRefund: { bytes: ZERO32 },
  paymentIndex: 0n,
  ownerSecret: ZERO32,
  convertedAmount: 0n,
  invoiceOwner: ZERO32,
  attestedAmounts: [],
  attestedSalts: [],
  attestedOwners: [],
  attestedPayouts: [],
  attestedPayers: [],
  attestedRefunds: [],
  attestedIndices: [],
  attestedPaths: [],
  batchAmounts: [],
  batchSalts: [],
  batchOwners: [],
  batchMerchants: [],
  batchPayouts: [],
  batchIndices: [],
});

type Field = keyof PayPrivateState;

/**
 * Read one field of the private state as a witness result, unchanged.
 *
 * @param key - The private-state field the witness returns.
 * @returns The witness implementation.
 */
const read =
  <K extends Field>(key: K) =>
  ({ privateState }: { privateState: PayPrivateState }): [PayPrivateState, PayPrivateState[K]] => [
    privateState,
    privateState[key],
  ];

/** The vector width of every batched witness in kinko_pay. */
const VECTOR = 4;

/** The private-state fields that feed a vector witness. */
type VectorField = {
  [K in Field]: PayPrivateState[K] extends readonly unknown[] ? K : never;
}[Field];
type ElementOf<K extends VectorField> = PayPrivateState[K] extends readonly (infer T)[] ? T : never;

/**
 * Read a vector field. The contract's vector is exactly four wide, so a
 * shorter or longer array is refused here with the field's name instead of
 * failing inside proof construction.
 *
 * @param key - The private-state field the witness returns.
 * @returns The witness implementation.
 */
const readVector =
  <K extends VectorField>(key: K) =>
  ({ privateState }: { privateState: PayPrivateState }): [PayPrivateState, ElementOf<K>[]] => {
    const value = privateState[key] as readonly ElementOf<K>[];
    if (value.length !== VECTOR) {
      throw new Error(
        `${key} must hold exactly ${String(VECTOR)} entries, got ${String(value.length)}`,
      );
    }
    return [privateState, [...value]];
  };

/** Witness implementations for kinko_pay, typed against the generated shape. */
export const payWitnesses: Witnesses<PayPrivateState> = {
  merchant_key: read("merchantKey"),
  merchant_payout: read("merchantPayout"),
  invoice_salt: read("salt"),
  invoice_amount: read("amount"),
  payer_key: read("payerKey"),
  payer_refund: read("payerRefund"),
  payment_index: read("paymentIndex"),
  owner_secret: read("ownerSecret"),
  converted_amount: read("convertedAmount"),
  invoice_owner: read("invoiceOwner"),
  attested_amounts: readVector("attestedAmounts"),
  attested_salts: readVector("attestedSalts"),
  attested_owners: readVector("attestedOwners"),
  attested_payouts: readVector("attestedPayouts"),
  attested_payers: readVector("attestedPayers"),
  attested_refunds: readVector("attestedRefunds"),
  attested_indices: readVector("attestedIndices"),
  attested_paths: readVector("attestedPaths"),
  batch_amounts: readVector("batchAmounts"),
  batch_salts: readVector("batchSalts"),
  batch_owners: readVector("batchOwners"),
  batch_merchants: readVector("batchMerchants"),
  batch_payouts: readVector("batchPayouts"),
  batch_indices: readVector("batchIndices"),
};

/** The ledger view the witnesses are typed against, re-exported for callers. */
export type PayLedger = Ledger;

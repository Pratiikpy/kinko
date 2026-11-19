// The seams between the stage machine and the chains. The engine talks only to these
// interfaces, so its tests run offline against fakes and the live adapters live apart.

import type { RespondBidirectionalEvent, Secp256k1Point } from "@sig-net/midnight";
import type { FlushItems } from "@sig-net/midnight-examples-erc20-vault-contract";
import type { Transaction } from "ethers";

import type { RequestKind } from "./types.ts";

/** Where the vault holds a request. */
export enum VaultPosition {
  /** In no buffer and no request map: never sent, or already settled. */
  Absent = "absent",
  /** Queued in the input buffer, waiting for a flush. */
  Queued = "queued",
  /** Flushed into the output buffer, waiting for its send circuit. */
  Flushed = "flushed",
  /** Sent: its signature request sits in the action's request map. */
  Open = "open",
}

/** Where the attestation of an open request stands in the vault. */
export enum AttestationPosition {
  /** No attestation is queued or flushed. */
  None = "none",
  /** Queued in the input attestation buffer, waiting for a flush. */
  Queued = "queued",
  /** Flushed: the user's complete circuit can consume it. */
  Flushed = "flushed",
}

/** Everything the vault's ledger says about one request. */
export interface RequestPosition {
  /** Which buffer or map holds the request. */
  readonly vault: VaultPosition;
  /** The input buffer index, while {@link VaultPosition.Queued} or {@link VaultPosition.Flushed}. */
  readonly inIndex?: bigint;
  /** The output buffer index, while {@link VaultPosition.Flushed}. */
  readonly outIndex?: Uint8Array;
  /** The attestation's place, while {@link VaultPosition.Open}. */
  readonly attestation: AttestationPosition;
}

/** A flushed request nobody has sent yet. */
export interface UnsentRequest {
  /** Deposit or withdraw. */
  readonly kind: RequestKind;
  /** Its output buffer index. */
  readonly outIndex: Uint8Array;
}

/** A request the vault has sent and not yet settled. */
export interface OpenRequest {
  /** Deposit or withdraw. */
  readonly kind: RequestKind;
  /** Its request id, 64 lowercase hex characters. */
  readonly requestId: string;
}

/** Work waiting in the vault whether or not anyone registered it with the relayer. */
export interface WaitingWork {
  /** Every deposit and withdrawal in the vault's request maps. */
  readonly open: readonly OpenRequest[];
  /** Input buffer indexes of queued requests, of any action. */
  readonly queuedInIndexes: readonly bigint[];
  /** Request ids of queued attestations. */
  readonly queuedAttestationIds: readonly Uint8Array[];
  /** Flushed deposits and withdrawals with no send yet. */
  readonly unsent: readonly UnsentRequest[];
}

/** One read of the vault's ledger, queried per request. */
export interface VaultView {
  /** The key every attestation must verify against. */
  readonly mpcResponseKey: Secp256k1Point;
  /** Work waiting in the vault right now. */
  readonly waiting: WaitingWork;
  /**
   * Where the vault holds a request.
   *
   * @param kind - Deposit or withdraw.
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The request's position, {@link VaultPosition.Absent} when the vault holds none.
   */
  position(kind: RequestKind, requestId: string): RequestPosition;
}

/** Thrown by {@link VaultPort.queueAttestation} when the vault's circuit refuses this attestation. */
export class AttestationRejectedError extends Error {
  /** The circuit's refusal. */
  readonly reason: string;

  /**
   * Wrap the circuit's refusal.
   *
   * @param reason - The circuit's assert message.
   */
  constructor(reason: string) {
    super(`the vault refused the attestation: ${reason}`);
    this.name = "AttestationRejectedError";
    this.reason = reason;
  }
}

/** The relayer's Midnight side: reads the vault and submits its permissionless circuits. */
export interface VaultPort {
  /**
   * Read the vault's ledger once.
   *
   * @returns A view to query every tracked request against.
   * @throws {Error} When the indexer cannot be reached or the vault has no state.
   */
  readView(): Promise<VaultView>;
  /**
   * Flush waiting items, `first` ahead of the rest, in one transaction. A flush that
   * loses a race to another flush lands as a no-op: the caller's next read shows it.
   *
   * @param first - The items the caller waits for.
   * @returns How many slots the flush filled, 0 when nothing would move.
   * @throws {Error} When the transaction fails for a reason other than a lost race.
   */
  flush(first: FlushItems): Promise<number>;
  /**
   * Run the send circuit of a flushed request. Succeeds when it was already sent.
   *
   * @param kind - Deposit or withdraw.
   * @param outIndex - The request's output buffer index.
   * @throws {Error} When the transaction fails.
   */
  send(kind: RequestKind, outIndex: Uint8Array): Promise<void>;
  /**
   * Queue an MPC attestation. Succeeds when it was already queued or flushed.
   *
   * @param event - The attestation, as posted on the Signet contract.
   * @throws {AttestationRejectedError} When the vault's circuit refuses this attestation.
   * @throws {Error} When the transaction fails for any other reason.
   */
  queueAttestation(event: RespondBidirectionalEvent): Promise<void>;
}

/** A verified MPC attestation and a stable identity for it. */
export interface AttestationCandidate {
  /** Identifies the post, so a refused one is not offered again. */
  readonly fingerprint: string;
  /** The attestation. */
  readonly event: RespondBidirectionalEvent;
}

/** The relayer's view of the MPC network, through the Signet contract's emitted events. */
export interface MpcPort {
  /**
   * Single-shot read of the MPC's signature response for a request.
   *
   * @param kind - Deposit or withdraw.
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The signed Ethereum transaction, or undefined while no valid signature has posted.
   * @throws {Error} When the indexer cannot be reached.
   */
  signedTransaction(kind: RequestKind, requestId: string): Promise<Transaction | undefined>;
  /**
   * Single-shot read of the attestations posted for a request that verify against the
   * vault's response key, in post order.
   *
   * @param kind - Deposit or withdraw.
   * @param requestId - The request id, 64 lowercase hex characters.
   * @param responseKey - The vault's pinned MPC response key.
   * @returns The verified attestations, none while nothing verifying has posted.
   * @throws {Error} When the indexer cannot be reached.
   */
  attestations(
    kind: RequestKind,
    requestId: string,
    responseKey: Secp256k1Point,
  ): Promise<AttestationCandidate[]>;
}

/** What the Ethereum chain said to a submitted transaction. */
export enum BroadcastOutcome {
  /** The node took the transaction. */
  Accepted = "accepted",
  /** The node already had this exact transaction. */
  AlreadyKnown = "already-known",
  /** The sender's nonce passed this transaction's: it mined, or another transaction took the slot. */
  NonceConsumed = "nonce-consumed",
  /** The sender cannot pay for the transaction. */
  InsufficientFunds = "insufficient-funds",
}

/** The relayer's Ethereum side. */
export interface EvmPort {
  /**
   * Whether a transaction has mined, succeeded or reverted.
   *
   * @param hash - The transaction hash.
   * @returns True once a receipt exists.
   * @throws {Error} When the node cannot be reached.
   */
  isMined(hash: string): Promise<boolean>;
  /**
   * An account's native balance.
   *
   * @param address - The account.
   * @returns Its balance in wei.
   * @throws {Error} When the node cannot be reached.
   */
  balance(address: string): Promise<bigint>;
  /**
   * Submit a signed transaction.
   *
   * @param transaction - The MPC-signed transaction.
   * @returns What the node answered.
   * @throws {Error} When the node cannot be reached or refuses for a reason not named by {@link BroadcastOutcome}.
   */
  broadcast(transaction: Transaction): Promise<BroadcastOutcome>;
}

/** Thrown by {@link GasSponsor.topUp} when a limit forbids the transfer. */
export class GasTopUpRefusedError extends Error {
  /**
   * Name the limit that refused.
   *
   * @param reason - Which limit, and its figures.
   */
  constructor(reason: string) {
    super(`gas top-up refused: ${reason}`);
    this.name = "GasTopUpRefusedError";
  }
}

/** Funds the gas of a deposit sweep, within limits. */
export interface GasSponsor {
  /**
   * Send an account enough ETH to cover a shortfall, if the limits allow.
   *
   * @param address - The deposit address that must pay for its sweep.
   * @param shortfallWei - The most the sweep needs beyond the account's balance.
   * @returns The wei sent, once the transfer is mined.
   * @throws {GasTopUpRefusedError} When a per-address or per-day limit forbids it.
   * @throws {Error} When the transfer fails.
   */
  topUp(address: string, shortfallWei: bigint): Promise<bigint>;
}

/** Where the engine reports. */
export interface Logger {
  /**
   * Report normal progress.
   *
   * @param message - What happened.
   */
  info(message: string): void;
  /**
   * Report something that will be retried or ignored.
   *
   * @param message - What went wrong.
   */
  warn(message: string): void;
}

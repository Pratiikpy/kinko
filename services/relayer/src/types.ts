// The relayer's domain types: what it tracks, the stages a request moves through and
// the shapes the HTTP layer reports. Nothing here touches a chain.

/** The vault actions the relayer carries: the two that move money across chains. */
export enum RequestKind {
  Deposit = "deposit",
  Withdraw = "withdraw",
}

/**
 * Where a tracked request stands. Stages only move forward, except into
 * {@link RequestStage.Failed}, and each is derived from the vault's ledger where the
 * ledger shows it, so a restarted relayer lands on the same stage.
 */
export enum RequestStage {
  /** The user's start circuit queued it in the input buffer. */
  Queued = "queued",
  /** A flush moved it into the output buffer. */
  Flushed = "flushed",
  /** The send circuit recorded its signature request and notified the MPC. */
  Sent = "sent",
  /** The MPC's signature response arrived and was verified. */
  Signed = "signed",
  /** The signed Ethereum transaction was submitted to the chain. */
  Broadcast = "broadcast",
  /** The MPC's attestation of the outcome was queued in the vault. */
  Attested = "attested",
  /** The attestation was flushed: the user's complete circuit can now settle the request. */
  Ready = "ready",
  /** The request left the vault, settled by the user's complete circuit. */
  Completed = "completed",
  /** The relayer gave up on the request. {@link TrackedRequest.error} says why. */
  Failed = "failed",
}

/** The stages in the order a healthy request visits them, the order {@link stageRank} reads. */
const STAGE_ORDER: readonly RequestStage[] = [
  RequestStage.Queued,
  RequestStage.Flushed,
  RequestStage.Sent,
  RequestStage.Signed,
  RequestStage.Broadcast,
  RequestStage.Attested,
  RequestStage.Ready,
  RequestStage.Completed,
];

/**
 * A stage's position on the healthy path.
 *
 * @param stage - The stage to place.
 * @returns Its index from {@link RequestStage.Queued}, or -1 for {@link RequestStage.Failed}.
 */
export function stageRank(stage: RequestStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/**
 * Whether a request in this stage needs no more work from the relayer.
 *
 * @param stage - The stage to classify.
 * @returns True for {@link RequestStage.Completed} and {@link RequestStage.Failed}.
 */
export function isTerminal(stage: RequestStage): boolean {
  return stage === RequestStage.Completed || stage === RequestStage.Failed;
}

/** What the relayer persists and tracks for one request. Times are epoch milliseconds. */
export interface TrackedRequest {
  /** Deposit or withdraw. */
  readonly kind: RequestKind;
  /** The Signet request id, 64 lowercase hex characters. */
  readonly requestId: string;
  /** Where the request stands. */
  readonly stage: RequestStage;
  /** When the relayer first tracked it. */
  readonly createdAt: number;
  /** When its stage or evidence last changed. */
  readonly updatedAt: number;
  /** When it entered its current stage: the clock its stage timeout runs on. */
  readonly stageEnteredAt: number;
  /** How many steps in a row failed with a retryable error. A success resets it. */
  readonly consecutiveFailures: number;
  /** The Ethereum transaction hash of the MPC-signed transaction, once the signature arrived. */
  readonly evmTxHash?: string;
  /** The signed Ethereum transaction, serialised, kept from {@link RequestStage.Signed} until broadcast settles. */
  readonly signedTransaction?: string;
  /** When the signed transaction was last submitted, for resubmission. */
  readonly lastBroadcastAt?: number;
  /** Why the relayer failed the request, set with {@link RequestStage.Failed}. */
  readonly error?: string;
}

/** What `GET /requests/<id>` reports. */
export interface RequestStatus {
  /** Deposit or withdraw. */
  readonly kind: RequestKind;
  /** Where the request stands. */
  readonly stage: RequestStage;
  /** The Ethereum transaction hash, once the MPC's signature arrived. */
  readonly evmTxHash?: string;
  /** Why the relayer failed the request, only for {@link RequestStage.Failed}. */
  readonly error?: string;
  /** When the request last changed, ISO 8601. */
  readonly updatedAt: string;
}

/**
 * The public view of a tracked request.
 *
 * @param request - The tracked request.
 * @returns Its status, without the relayer's internal bookkeeping.
 */
export function toStatus(request: TrackedRequest): RequestStatus {
  return {
    kind: request.kind,
    stage: request.stage,
    ...(request.evmTxHash === undefined ? {} : { evmTxHash: request.evmTxHash }),
    ...(request.error === undefined ? {} : { error: request.error }),
    updatedAt: new Date(request.updatedAt).toISOString(),
  };
}

/** A Signet request id as the API takes it: 64 hex characters. */
export const REQUEST_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

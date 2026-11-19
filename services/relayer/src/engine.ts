// The stage machine. Each tick reads the vault's ledger once, derives every tracked
// request's stage from it, and starts the one step each request is waiting on. Reads are
// single-shot and run for all requests in parallel; the steps that write to Midnight run
// one at a time through a single lane, because they share one wallet. Only flushes touch
// the vault's shared cells, and a tick folds every request's flush into one transaction.
// Every step is idempotent and the stage is re-derived from the ledger, so a restart, a
// repeated tick or a step that half-landed all converge on the same state.

import { bytesToHex, hexToBytes, type Secp256k1Point } from "@sig-net/midnight";
import { Transaction } from "ethers";

import type { EngineConfig } from "./config.ts";
import {
  AttestationPosition,
  AttestationRejectedError,
  BroadcastOutcome,
  type EvmPort,
  type GasSponsor,
  GasTopUpRefusedError,
  type Logger,
  type MpcPort,
  type RequestPosition,
  type VaultPort,
  VaultPosition,
  type VaultView,
} from "./ports.ts";
import type { StateStore } from "./store.ts";
import { isTerminal, RequestKind, RequestStage, stageRank, type TrackedRequest } from "./types.ts";

/** What a tick starts for one request. */
enum StepKind {
  Idle = "idle",
  Flush = "flush",
  Send = "send",
  PollSignature = "poll-signature",
  Broadcast = "broadcast",
  PollAttestation = "poll-attestation",
}

type Step =
  | { readonly kind: StepKind.Idle }
  | { readonly kind: StepKind.Flush; readonly inIndex?: bigint; readonly attestationId?: string }
  | { readonly kind: StepKind.Send; readonly outIndex: Uint8Array }
  | { readonly kind: StepKind.PollSignature }
  | { readonly kind: StepKind.Broadcast }
  | { readonly kind: StepKind.PollAttestation; readonly responseKey: Secp256k1Point };

/** Thrown when a request id the relayer tracks as one kind is registered as the other. */
export class RequestKindMismatchError extends Error {
  /**
   * Name the clash.
   *
   * @param requestId - The request id.
   * @param tracked - The kind the relayer tracks it as.
   * @param asked - The kind it was registered as.
   */
  constructor(requestId: string, tracked: RequestKind, asked: RequestKind) {
    super(`request ${requestId} is tracked as a ${tracked}, not a ${asked}`);
    this.name = "RequestKindMismatchError";
  }
}

/** The collaborators a {@link RelayerEngine} runs against. */
export interface EngineDeps {
  /** The Midnight side. */
  readonly vault: VaultPort;
  /** The MPC network's posted responses. */
  readonly mpc: MpcPort;
  /** The Ethereum side. */
  readonly evm: EvmPort;
  /** Funds the gas of deposit sweeps, when the operator enabled it. */
  readonly gas?: GasSponsor;
  /** Where requests are persisted. */
  readonly store: StateStore;
  /** Timeouts and policy. */
  readonly options: EngineConfig;
  /** Where progress is reported. */
  readonly logger: Logger;
  /** The current time in epoch milliseconds. */
  readonly clock: () => number;
}

// The stage a ledger position proves the request has reached.
function evidenceStage(position: RequestPosition): RequestStage | undefined {
  switch (position.vault) {
    case VaultPosition.Absent:
      return undefined;
    case VaultPosition.Queued:
      return RequestStage.Queued;
    case VaultPosition.Flushed:
      return RequestStage.Flushed;
    case VaultPosition.Open:
      if (position.attestation === AttestationPosition.Flushed) return RequestStage.Ready;
      if (position.attestation === AttestationPosition.Queued) return RequestStage.Attested;
      return RequestStage.Sent;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The relayer's stage machine over the requests registered with it.
 *
 * Drive it with {@link RelayerEngine.tick} on a timer. A tick returns once it has read
 * the chains and started this round's steps; the steps finish in the background, and
 * {@link RelayerEngine.idle} waits for them.
 */
export class RelayerEngine {
  private readonly deps: EngineDeps;
  private readonly startedAt: number;
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly refusedAttestations = new Map<string, Set<string>>();
  private lane: Promise<void> = Promise.resolve();

  /**
   * Build an engine over its collaborators. Requests already in the store resume.
   *
   * @param deps - What the engine runs against.
   */
  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.startedAt = deps.clock();
  }

  /**
   * Start tracking a request, or report where it stands if the relayer already tracks it.
   * A failed request is tracked afresh, so a user can ask the relayer to try again.
   *
   * @param kind - Deposit or withdraw.
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The tracked request, or undefined when the vault holds no such request.
   * @throws {RequestKindMismatchError} When the request is already tracked as the other kind.
   * @throws {Error} When the vault cannot be read.
   */
  async register(kind: RequestKind, requestId: string): Promise<TrackedRequest | undefined> {
    const existing = this.deps.store.get(requestId);
    if (existing !== undefined && existing.kind !== kind) {
      throw new RequestKindMismatchError(requestId, existing.kind, kind);
    }
    if (existing !== undefined && existing.stage !== RequestStage.Failed) return existing;

    const view = await this.deps.vault.readView();
    const stage = evidenceStage(view.position(kind, requestId));
    if (stage === undefined) return existing;
    const now = this.deps.clock();
    const request: TrackedRequest = {
      kind,
      requestId,
      stage,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      stageEnteredAt: now,
      consecutiveFailures: 0,
    };
    this.deps.store.put(request);
    this.deps.logger.info(`${kind} ${requestId}: tracking from stage ${stage}`);
    return request;
  }

  /**
   * One tracked request.
   *
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The request, or undefined when the relayer does not track it.
   */
  status(requestId: string): TrackedRequest | undefined {
    return this.deps.store.get(requestId);
  }

  /**
   * Read the chains and start the step every tracked request is waiting on. Returns
   * without waiting for the steps, which run in the background.
   *
   * @returns Once this round's steps are started.
   */
  async tick(): Promise<void> {
    const { store, options, vault } = this.deps;
    store.prune(this.deps.clock() - options.retentionMs);
    const active = store.active();
    if (active.length === 0 && !options.serveUnregistered) return;

    let view: VaultView;
    try {
      view = await vault.readView();
    } catch (error) {
      this.deps.logger.warn(`could not read the vault: ${describeError(error)}`);
      return;
    }

    const now = this.deps.clock();
    const flushing: { inIndexes: bigint[]; attestationIds: string[]; requesters: string[] } = {
      inIndexes: [],
      attestationIds: [],
      requesters: [],
    };
    for (const request of active) {
      const { request: current, step } = this.plan(request, view, now);
      this.start(current, step, flushing);
    }

    const waiting = view.waiting;
    if (options.serveUnregistered) {
      this.adopt(view, now);
      for (const unsent of waiting.unsent) {
        this.startSend(unsent.kind, unsent.outIndex, undefined);
      }
    }
    const foreignFlush =
      options.serveUnregistered &&
      (waiting.queuedInIndexes.length > 0 || waiting.queuedAttestationIds.length > 0);
    if (flushing.requesters.length > 0 || foreignFlush) this.startFlush(flushing);
  }

  // Takes on every request the vault has sent that nobody registered, so a request is
  // carried whether or not its owner told the relayer. Settled requests the store already
  // forgot are not in the vault's maps, so nothing returns from the dead.
  private adopt(view: VaultView, now: number): void {
    for (const { kind, requestId } of view.waiting.open) {
      if (this.deps.store.get(requestId) !== undefined) continue;
      const stage = evidenceStage(view.position(kind, requestId));
      if (stage === undefined) continue;
      this.deps.store.put({
        kind,
        requestId,
        stage,
        createdAt: now,
        updatedAt: now,
        stageEnteredAt: now,
        consecutiveFailures: 0,
      });
      this.deps.logger.info(
        `${kind} ${requestId}: found in the vault, tracking from stage ${stage}`,
      );
    }
  }

  /**
   * Wait for every started step to finish.
   *
   * @returns Once nothing is running.
   */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ---- Planning: pure decisions over one ledger read, each persisted before any step starts.

  private plan(
    request: TrackedRequest,
    view: VaultView,
    now: number,
  ): { request: TrackedRequest; step: Step } {
    const position = view.position(request.kind, request.requestId);
    const idle = (current: TrackedRequest): { request: TrackedRequest; step: Step } => ({
      request: current,
      step: { kind: StepKind.Idle },
    });

    const evidence = evidenceStage(position);
    if (evidence === undefined) {
      return idle(
        stageRank(request.stage) >= stageRank(RequestStage.Sent)
          ? this.move(request, RequestStage.Completed)
          : this.fail(request, "the request left the vault before it was sent"),
      );
    }

    let current = request;
    if (stageRank(evidence) > stageRank(current.stage)) current = this.move(current, evidence);

    const waitingSince = Math.max(current.stageEnteredAt, this.startedAt);
    if (
      current.stage !== RequestStage.Ready &&
      now - waitingSince > this.deps.options.stageTimeoutMs
    ) {
      return idle(
        this.fail(
          current,
          `timed out after ${String(Math.round((now - waitingSince) / 1000))}s in stage ${current.stage}`,
        ),
      );
    }

    switch (current.stage) {
      case RequestStage.Queued:
        return {
          request: current,
          step:
            position.inIndex === undefined
              ? { kind: StepKind.Idle }
              : { kind: StepKind.Flush, inIndex: position.inIndex },
        };
      case RequestStage.Flushed:
        return {
          request: current,
          step:
            position.outIndex === undefined
              ? { kind: StepKind.Idle }
              : { kind: StepKind.Send, outIndex: position.outIndex },
        };
      case RequestStage.Sent:
        return { request: current, step: { kind: StepKind.PollSignature } };
      case RequestStage.Signed:
        return { request: current, step: { kind: StepKind.Broadcast } };
      case RequestStage.Broadcast:
        return {
          request: current,
          step: { kind: StepKind.PollAttestation, responseKey: view.mpcResponseKey },
        };
      case RequestStage.Attested:
        return {
          request: current,
          step: { kind: StepKind.Flush, attestationId: current.requestId },
        };
      case RequestStage.Ready:
      case RequestStage.Completed:
      case RequestStage.Failed:
        return idle(current);
    }
  }

  // ---- Starting steps.

  private start(
    request: TrackedRequest,
    step: Step,
    flushing: { inIndexes: bigint[]; attestationIds: string[]; requesters: string[] },
  ): void {
    switch (step.kind) {
      case StepKind.Idle:
        return;
      case StepKind.Flush:
        if (step.inIndex !== undefined) flushing.inIndexes.push(step.inIndex);
        if (step.attestationId !== undefined) flushing.attestationIds.push(step.attestationId);
        flushing.requesters.push(request.requestId);
        return;
      case StepKind.Send:
        this.startSend(request.kind, step.outIndex, request.requestId);
        return;
      case StepKind.PollSignature:
        this.dispatch(`request:${request.requestId}`, request.requestId, () =>
          this.pollSignature(request),
        );
        return;
      case StepKind.Broadcast:
        this.dispatch(`request:${request.requestId}`, request.requestId, () =>
          this.broadcast(request),
        );
        return;
      case StepKind.PollAttestation:
        this.dispatch(`request:${request.requestId}`, request.requestId, () =>
          this.pollAttestation(request, step.responseKey),
        );
        return;
    }
  }

  private startSend(kind: RequestKind, outIndex: Uint8Array, requester: string | undefined): void {
    this.dispatch(`send:${bytesToHex(outIndex)}`, requester, async () => {
      await this.exclusive(() => this.deps.vault.send(kind, outIndex));
      this.deps.logger.info(`${kind} sent from output index ${bytesToHex(outIndex).slice(0, 8)}`);
    });
  }

  private startFlush(flushing: {
    inIndexes: bigint[];
    attestationIds: string[];
    requesters: string[];
  }): void {
    this.dispatchFor("flush", flushing.requesters, async () => {
      const carried = await this.exclusive(() =>
        this.deps.vault.flush({
          inIndexes: flushing.inIndexes,
          requestIds: flushing.attestationIds.map((id) => hexToBytes(id)),
        }),
      );
      if (carried > 0) this.deps.logger.info(`flushed ${String(carried)} item(s)`);
    });
  }

  // Run `job` unless a job with this key is already running; a failure counts against `requester`.
  private dispatch(key: string, requester: string | undefined, job: () => Promise<void>): void {
    this.dispatchFor(key, requester === undefined ? [] : [requester], job);
  }

  private dispatchFor(key: string, requesters: readonly string[], job: () => Promise<void>): void {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const running = job()
      .then(() => {
        for (const requester of requesters) this.noteSuccess(requester);
      })
      .catch((error: unknown) => {
        const message = describeError(error);
        this.deps.logger.warn(`${key}: ${message}`);
        for (const requester of requesters) this.noteFailure(requester, message);
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.pending.delete(running);
      });
    this.pending.add(running);
  }

  // Midnight writes share one wallet, so they run one at a time.
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = this.lane.then(job);
    this.lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---- Steps.

  private async pollSignature(request: TrackedRequest): Promise<void> {
    const transaction = await this.deps.mpc.signedTransaction(request.kind, request.requestId);
    if (transaction === undefined) return;
    if (transaction.hash === null) throw new Error("the MPC's signed transaction has no hash");
    this.move(request, RequestStage.Signed, {
      evmTxHash: transaction.hash,
      signedTransaction: transaction.serialized,
    });
  }

  private async broadcast(request: TrackedRequest): Promise<void> {
    const serialized = request.signedTransaction;
    if (serialized === undefined) throw new Error("the signed transaction was not persisted");
    const transaction = Transaction.from(serialized);
    if (transaction.hash === null) throw new Error("the signed transaction has no hash");

    if (await this.deps.evm.isMined(transaction.hash)) {
      this.move(request, RequestStage.Broadcast);
      return;
    }
    if (!(await this.fundGas(request, transaction))) return;

    const outcome = await this.deps.evm.broadcast(transaction);
    switch (outcome) {
      case BroadcastOutcome.Accepted:
      case BroadcastOutcome.AlreadyKnown:
        this.move(request, RequestStage.Broadcast, { lastBroadcastAt: this.deps.clock() });
        return;
      case BroadcastOutcome.NonceConsumed:
        // Mined, or another transaction took the nonce, which the MPC attests as unviable.
        // Either way the MPC's verdict is what the user settles on.
        this.deps.logger.warn(
          `${request.kind} ${request.requestId}: the sender's nonce is spent, awaiting the MPC's verdict`,
        );
        this.move(request, RequestStage.Broadcast, { lastBroadcastAt: this.deps.clock() });
        return;
      case BroadcastOutcome.InsufficientFunds:
        this.deps.logger.warn(
          `${request.kind} ${request.requestId}: ${transaction.from ?? "the sender"} cannot pay for the sweep yet`,
        );
        return;
    }
  }

  // Tops up the sender when the operator enabled it. Returns false while the sweep cannot be funded.
  private async fundGas(request: TrackedRequest, transaction: Transaction): Promise<boolean> {
    const { gas, evm, logger } = this.deps;
    if (gas === undefined || request.kind !== RequestKind.Deposit || transaction.from === null) {
      return true;
    }
    const required =
      transaction.gasLimit * (transaction.maxFeePerGas ?? transaction.gasPrice ?? 0n);
    const balance = await evm.balance(transaction.from);
    if (balance >= required) return true;
    try {
      const sent = await gas.topUp(transaction.from, required - balance);
      logger.info(`${request.requestId}: sent ${String(sent)} wei of gas to ${transaction.from}`);
      return true;
    } catch (error) {
      if (!(error instanceof GasTopUpRefusedError)) throw error;
      logger.warn(`${request.requestId}: ${error.message}`);
      return false;
    }
  }

  private async pollAttestation(
    request: TrackedRequest,
    responseKey: Secp256k1Point,
  ): Promise<void> {
    await this.resubmitIfStuck(request);

    const candidates = await this.deps.mpc.attestations(
      request.kind,
      request.requestId,
      responseKey,
    );
    const refused = this.refusedAttestations.get(request.requestId) ?? new Set<string>();
    for (const candidate of candidates) {
      if (refused.has(candidate.fingerprint)) continue;
      try {
        await this.exclusive(() => this.deps.vault.queueAttestation(candidate.event));
      } catch (error) {
        if (!(error instanceof AttestationRejectedError)) throw error;
        refused.add(candidate.fingerprint);
        this.refusedAttestations.set(request.requestId, refused);
        this.deps.logger.warn(`${request.kind} ${request.requestId}: ${error.message}`);
        continue;
      }
      this.move(request, RequestStage.Attested);
      return;
    }
  }

  // Submits the signed transaction again when it was broadcast long ago and has not mined.
  private async resubmitIfStuck(request: TrackedRequest): Promise<void> {
    const { signedTransaction: serialized, lastBroadcastAt } = request;
    if (serialized === undefined) return;
    const now = this.deps.clock();
    if (
      lastBroadcastAt !== undefined &&
      now - lastBroadcastAt < this.deps.options.rebroadcastIntervalMs
    ) {
      return;
    }
    const transaction = Transaction.from(serialized);
    if (transaction.hash === null || (await this.deps.evm.isMined(transaction.hash))) return;
    await this.deps.evm.broadcast(transaction);
    this.update(request.requestId, { lastBroadcastAt: now });
    this.deps.logger.info(
      `${request.kind} ${request.requestId}: resubmitted the signed transaction`,
    );
  }

  // ---- Bookkeeping.

  private noteSuccess(requestId: string): void {
    const current = this.deps.store.get(requestId);
    if (current !== undefined && current.consecutiveFailures > 0) {
      this.update(requestId, { consecutiveFailures: 0 });
    }
  }

  private noteFailure(requestId: string, message: string): void {
    const current = this.deps.store.get(requestId);
    if (current === undefined || isTerminal(current.stage)) return;
    const failures = current.consecutiveFailures + 1;
    if (failures >= this.deps.options.maxConsecutiveFailures) {
      this.fail(current, `${String(failures)} failures in a row, the last: ${message}`);
    } else {
      this.update(requestId, { consecutiveFailures: failures });
    }
  }

  private update(requestId: string, patch: Partial<TrackedRequest>): TrackedRequest | undefined {
    const current = this.deps.store.get(requestId);
    if (current === undefined) return undefined;
    const next: TrackedRequest = { ...current, ...patch, updatedAt: this.deps.clock() };
    this.deps.store.put(next);
    return next;
  }

  // Move a request forward to `stage`, never backwards, and never out of a terminal stage.
  private move(
    request: TrackedRequest,
    stage: RequestStage,
    patch: Partial<TrackedRequest> = {},
  ): TrackedRequest {
    const current = this.deps.store.get(request.requestId) ?? request;
    if (isTerminal(current.stage) || stageRank(stage) < stageRank(current.stage)) return current;
    const now = this.deps.clock();
    // A completed request needs no signed transaction any more.
    const { signedTransaction: dropped, ...rest } = { ...current, ...patch };
    const next: TrackedRequest = {
      ...rest,
      ...(stage === RequestStage.Completed || dropped === undefined
        ? {}
        : { signedTransaction: dropped }),
      stage,
      consecutiveFailures: 0,
      updatedAt: now,
      stageEnteredAt: stage === current.stage ? current.stageEnteredAt : now,
    };
    this.deps.store.put(next);
    if (stage !== current.stage) {
      this.deps.logger.info(`${current.kind} ${current.requestId}: ${current.stage} -> ${stage}`);
    }
    return next;
  }

  private fail(request: TrackedRequest, reason: string): TrackedRequest {
    const current = this.deps.store.get(request.requestId) ?? request;
    if (isTerminal(current.stage)) return current;
    const now = this.deps.clock();
    const { signedTransaction: _discarded, ...kept } = current;
    const next: TrackedRequest = {
      ...kept,
      stage: RequestStage.Failed,
      error: reason,
      updatedAt: now,
      stageEnteredAt: now,
    };
    this.deps.store.put(next);
    this.deps.logger.warn(`${current.kind} ${current.requestId}: failed: ${reason}`);
    return next;
  }
}

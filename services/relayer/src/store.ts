// The relayer's persisted state: every tracked request and the gas it has sent. One JSON
// document, written atomically after each change, so a restart resumes where it stopped.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isTerminal, RequestKind, RequestStage, type TrackedRequest } from "./types.ts";

/** One field of a persisted record, as `JSON.parse` yields it: checked before it is trusted. */
type RawField = string | number | boolean | null | object | undefined;

/** A persisted record, field by field as `JSON.parse` yields it. */
type RawRecord = Record<string, RawField>;

/** One ETH transfer the relayer made to fund a deposit sweep. */
export interface GasTopUp {
  /** The deposit address that received it. */
  readonly address: string;
  /** What was sent, in wei. */
  readonly amountWei: bigint;
  /** When it was sent, epoch milliseconds. */
  readonly at: number;
}

/** Where the state document lives. */
export interface StatePersistence {
  /**
   * Read the document.
   *
   * @returns Its text, or undefined when none was written yet.
   * @throws {Error} When the document exists but cannot be read.
   */
  read(): string | undefined;
  /**
   * Replace the document.
   *
   * @param contents - The new text.
   * @throws {Error} When the document cannot be written.
   */
  write(contents: string): void;
}

/** A state document in a file, replaced atomically so a crash never leaves half of one. */
export class FilePersistence implements StatePersistence {
  private readonly path: string;

  /**
   * Point at a state file. Nothing is touched until the first read or write.
   *
   * @param path - The file, created with its directory on first write.
   */
  constructor(path: string) {
    this.path = path;
  }

  /** @inheritdoc */
  read(): string | undefined {
    try {
      return readFileSync(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** @inheritdoc */
  write(contents: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const staging = `${this.path}.tmp`;
    writeFileSync(staging, contents, { mode: 0o600 });
    renameSync(staging, this.path);
  }
}

/** A state document in memory, for tests that restart a store without touching disk. */
export class MemoryPersistence implements StatePersistence {
  private contents: string | undefined;

  /** @inheritdoc */
  read(): string | undefined {
    return this.contents;
  }

  /** @inheritdoc */
  write(contents: string): void {
    this.contents = contents;
  }
}

const STATE_VERSION = 1;

const STAGES: readonly string[] = Object.values(RequestStage);
const KINDS: readonly string[] = Object.values(RequestKind);

function isRecord(value: RawField): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: RawRecord, name: string): string {
  const value = record[name];
  if (typeof value !== "string") throw new Error(`"${name}" must be a string`);
  return value;
}

function numberField(record: RawRecord, name: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${name}" must be a number`);
  }
  return value;
}

function optionalString(record: RawRecord, name: string): string | undefined {
  return record[name] === undefined ? undefined : stringField(record, name);
}

function optionalNumber(record: RawRecord, name: string): number | undefined {
  return record[name] === undefined ? undefined : numberField(record, name);
}

function parseRequest(value: RawField): TrackedRequest {
  if (!isRecord(value)) throw new Error("a request must be an object");
  const kind = stringField(value, "kind");
  const stage = stringField(value, "stage");
  const requestId = stringField(value, "requestId");
  if (!KINDS.includes(kind)) throw new Error(`unknown request kind "${kind}"`);
  if (!STAGES.includes(stage)) throw new Error(`unknown request stage "${stage}"`);
  if (!/^[0-9a-f]{64}$/.test(requestId)) throw new Error(`malformed request id "${requestId}"`);
  const evmTxHash = optionalString(value, "evmTxHash");
  const signedTransaction = optionalString(value, "signedTransaction");
  const lastBroadcastAt = optionalNumber(value, "lastBroadcastAt");
  const error = optionalString(value, "error");
  return {
    kind: kind as RequestKind,
    requestId,
    stage: stage as RequestStage,
    createdAt: numberField(value, "createdAt"),
    updatedAt: numberField(value, "updatedAt"),
    stageEnteredAt: numberField(value, "stageEnteredAt"),
    consecutiveFailures: numberField(value, "consecutiveFailures"),
    ...(evmTxHash === undefined ? {} : { evmTxHash }),
    ...(signedTransaction === undefined ? {} : { signedTransaction }),
    ...(lastBroadcastAt === undefined ? {} : { lastBroadcastAt }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseGasTopUp(value: RawField): GasTopUp {
  if (!isRecord(value)) throw new Error("a gas top-up must be an object");
  const amount = stringField(value, "amountWei");
  if (!/^\d+$/.test(amount)) throw new Error(`malformed gas amount "${amount}"`);
  return {
    address: stringField(value, "address"),
    amountWei: BigInt(amount),
    at: numberField(value, "at"),
  };
}

/**
 * The relayer's tracked requests and gas ledger, held in memory and written through to a
 * {@link StatePersistence} after every change.
 */
export class StateStore {
  private readonly persistence: StatePersistence;
  private readonly requests = new Map<string, TrackedRequest>();
  private topUps: GasTopUp[] = [];

  /**
   * Load the state a previous run left.
   *
   * @param persistence - Where the document lives.
   * @throws {Error} When the document exists but is not a state document this version wrote:
   *   it is left untouched, since overwriting it would lose requests.
   */
  constructor(persistence: StatePersistence) {
    this.persistence = persistence;
    const text = persistence.read();
    if (text === undefined) return;
    let document: RawField;
    try {
      document = JSON.parse(text) as RawField;
    } catch (error) {
      throw new Error(`the state file is not JSON: ${String(error)}`, { cause: error });
    }
    if (!isRecord(document) || document.version !== STATE_VERSION) {
      throw new Error(`the state file is not a version ${String(STATE_VERSION)} state document`);
    }
    const { requests, gasTopUps } = document;
    if (!Array.isArray(requests) || !Array.isArray(gasTopUps)) {
      throw new Error('the state file needs "requests" and "gasTopUps" arrays');
    }
    for (const request of (requests as RawField[]).map(parseRequest)) {
      this.requests.set(request.requestId, request);
    }
    this.topUps = (gasTopUps as RawField[]).map(parseGasTopUp);
  }

  /**
   * One tracked request.
   *
   * @param requestId - The request id, 64 lowercase hex characters.
   * @returns The request, or undefined when it is not tracked.
   */
  get(requestId: string): TrackedRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Record a request, replacing any earlier record of it.
   *
   * @param request - The request as it now stands.
   * @throws {Error} When the state file cannot be written.
   */
  put(request: TrackedRequest): void {
    this.requests.set(request.requestId, request);
    this.save();
  }

  /**
   * The requests that still need the relayer: everything not completed or failed.
   *
   * @returns The tracked requests in registration order.
   */
  active(): TrackedRequest[] {
    return [...this.requests.values()].filter((request) => !isTerminal(request.stage));
  }

  /**
   * Forget finished requests nobody needs to ask about any more.
   *
   * @param finishedBefore - Drop completed and failed requests last changed before this time.
   * @returns How many were dropped.
   * @throws {Error} When the state file cannot be written.
   */
  prune(finishedBefore: number): number {
    let dropped = 0;
    for (const [requestId, request] of this.requests) {
      if (isTerminal(request.stage) && request.updatedAt < finishedBefore) {
        this.requests.delete(requestId);
        dropped += 1;
      }
    }
    if (dropped > 0) this.save();
    return dropped;
  }

  /**
   * Every gas top-up on record.
   *
   * @returns The top-ups, oldest first.
   */
  gasTopUps(): readonly GasTopUp[] {
    return this.topUps;
  }

  /**
   * Record gas the relayer sent.
   *
   * @param topUp - The transfer.
   * @throws {Error} When the state file cannot be written.
   */
  recordGasTopUp(topUp: GasTopUp): void {
    this.topUps = [...this.topUps, topUp];
    this.save();
  }

  private save(): void {
    this.persistence.write(
      JSON.stringify({
        version: STATE_VERSION,
        requests: [...this.requests.values()],
        gasTopUps: this.topUps.map((topUp) => ({
          ...topUp,
          amountWei: topUp.amountWei.toString(),
        })),
      }),
    );
  }
}

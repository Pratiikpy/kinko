// The fee sponsor's wire format, and reading the contract calls back out of a
// transaction. Shared by the card wallet (the client) and services/sponsor
// (the payer), so both sides read a transaction the same way.
//
// The sponsor decides what to pay for from the transaction it deserialized
// itself, never from anything the request says about it. An allowlist that
// trusts a label the caller sent is not an allowlist.

import * as ledger from "@midnightntwrk/ledger-v9";

/** Bumped when the wire shape changes; the sponsor refuses a request it does not understand. */
export const SPONSOR_PROTOCOL_VERSION = 1;

/** The path the sponsor serves and the client posts to. */
export const SPONSOR_PATH = "/v1/sponsor";

/** What a client sends. */
export interface SponsorRequest {
  readonly protocol: number;
  /** The holder's bound, proven, fee-less transaction, hex. */
  readonly tx: string;
  /** What the client believes it is calling. Cross-checked, never trusted. */
  readonly circuit?: string;
  /** A label for the sponsor's log. Never decides anything, and never the rate-limit bucket. */
  readonly caller?: string;
}

/** What the sponsor answers when it paid. */
export interface SponsorResponse {
  readonly protocol: number;
  /** The submitted transaction's identifier, as the indexer reports it. */
  readonly txId: string;
  /** DUST the sponsor paid, in SPECK. */
  readonly feeSpeck: string;
  readonly circuits: readonly string[];
  readonly contractAddress?: string;
}

/** Every reason the sponsor refuses, each with a fixed meaning a client can branch on. */
export type SponsorRefusalCode =
  | "BAD_REQUEST"
  | "UNSUPPORTED_PROTOCOL"
  | "UNREADABLE_TRANSACTION"
  | "NOT_A_CONTRACT_CALL"
  | "CONTRACT_NOT_ALLOWED"
  | "CIRCUIT_NOT_ALLOWED"
  | "CIRCUIT_MISMATCH"
  | "FEE_TOO_LARGE"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "SPONSOR_OUT_OF_DUST"
  | "DUPLICATE_TRANSACTION"
  | "SUBMIT_FAILED";

/** What the sponsor answers when it refused. */
export interface SponsorErrorBody {
  readonly protocol: number;
  readonly error: string;
  readonly code: SponsorRefusalCode;
  readonly retryAfterSeconds?: number;
}

/** A refusal, or a failure to reach the sponsor at all (`TRANSPORT`). */
export class SponsorError extends Error {
  /**
   * @param message - What the holder is told.
   * @param code - The refusal, or TRANSPORT when the sponsor was not reached.
   * @param retryAfterSeconds - When a rate-limited request may be tried again.
   */
  constructor(
    message: string,
    readonly code: SponsorRefusalCode | "TRANSPORT",
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SponsorError";
  }
}

/** One contract action read out of a transaction. */
export interface TransactionAction {
  readonly kind: "call" | "deploy" | "maintenance" | "unknown";
  readonly contractAddress?: string;
  /** The entry point's name when it decodes to printable ASCII, as circuit names do. */
  readonly entryPoint?: string;
}

/** The contract calls a transaction makes, read from the transaction itself. */
export interface TransactionDescription {
  readonly actions: readonly TransactionAction[];
  /** Entry points of every call, in order. */
  readonly circuits: readonly string[];
  /** Distinct contract addresses touched. */
  readonly contracts: readonly string[];
  /** True when it deploys a contract or changes one's maintenance authority. */
  readonly hasAdministrativeAction: boolean;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function entryPointName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) return undefined;
  const end = value.indexOf(0);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    end === -1 ? value : value.subarray(0, end),
  );
  return /^[\x20-\x7e]+$/.test(text) ? text : `0x${hex(value)}`;
}

/**
 * Read the contract actions out of a transaction.
 *
 * Structural rather than `instanceof`: the ledger classes come from a WASM
 * module a caller may load through another specifier, and a failed
 * `instanceof` would classify a real call as unknown, which for an allowlist
 * fails open. Tagging on the object's shape cannot.
 *
 * @param tx - A transaction.
 * @returns What it calls.
 */
export function describeTransaction(tx: unknown): TransactionDescription {
  const actions: TransactionAction[] = [];
  const intents = (tx as { intents?: Map<number, { actions?: unknown[] }> }).intents;
  for (const intent of intents?.values() ?? []) {
    for (const action of intent.actions ?? []) {
      const a = action as {
        address?: unknown;
        entryPoint?: unknown;
        initialState?: unknown;
        updates?: unknown;
      };
      const contractAddress = typeof a.address === "string" ? a.address : undefined;
      if (a.entryPoint !== undefined) {
        actions.push({ kind: "call", contractAddress, entryPoint: entryPointName(a.entryPoint) });
      } else if (a.initialState !== undefined) {
        actions.push({ kind: "deploy", contractAddress });
      } else if (a.updates !== undefined) {
        actions.push({ kind: "maintenance", contractAddress });
      } else {
        actions.push({ kind: "unknown", contractAddress });
      }
    }
  }
  return {
    actions,
    circuits: actions.filter((a) => a.kind === "call").map((a) => a.entryPoint ?? "(unreadable)"),
    contracts: [
      ...new Set(actions.map((a) => a.contractAddress).filter((a): a is string => a !== undefined)),
    ],
    hasAdministrativeAction: actions.some((a) => a.kind === "deploy" || a.kind === "maintenance"),
  };
}

/**
 * Deserialize the hex a holder hands the sponsor.
 *
 * @param txHex - A bound, proven, signed transaction.
 * @returns The transaction.
 * @throws {SponsorError} UNREADABLE_TRANSACTION when it is not one.
 */
export function deserializeBound(txHex: string): ledger.FinalizedTransaction {
  const clean = txHex.startsWith("0x") ? txHex.slice(2) : txHex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new SponsorError("the transaction is not hex.", "UNREADABLE_TRANSACTION");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  try {
    return ledger.Transaction.deserialize(
      "signature",
      "proof",
      "binding",
      bytes,
    ) as unknown as ledger.FinalizedTransaction;
  } catch {
    throw new SponsorError(
      "the transaction is not a signed, proven, bound transaction. Balance its own value only, sign it and bind it first.",
      "UNREADABLE_TRANSACTION",
    );
  }
}

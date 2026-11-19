// Client for the Kinko relayer.
//
// The relayer carries a vault request through the steps anyone may perform:
// flushing the vault's queue, sending the request to the MPC, broadcasting the
// signed Ethereum transaction and queueing the attestation. It holds no user
// key and cannot move funds; every step it submits is a public circuit whose
// arguments the user fixed when they signed the start of the request.
//
// Every response is validated here before the UI sees it. A relayer that
// answers with something unexpected is reported as unavailable, never shown.

import { RELAYER_URL } from "./config.ts";

/** The two kinds of vault request the relayer carries. */
export type RequestKind = "deposit" | "withdraw";

/** Every stage the relayer reports, in order, then the failure stage. */
export const STAGES = [
  "queued",
  "flushed",
  "sent",
  "signed",
  "broadcast",
  "attested",
  "ready",
  "completed",
  "failed",
] as const;

/** One stage of a relayed request. */
export type Stage = (typeof STAGES)[number];

/** The stages a healthy request passes through, in order. */
export const PROGRESS_STAGES: readonly Exclude<Stage, "failed">[] = [
  "queued",
  "flushed",
  "sent",
  "signed",
  "broadcast",
  "attested",
  "ready",
  "completed",
];

/** The relayer's answer to /health: which vault it carries requests for. */
export interface RelayerHealth {
  readonly ok: true;
  readonly network: string;
  readonly vaultContractAddress: string;
  readonly evmVaultAddress: string;
  readonly usdcAddress: string;
  readonly evmChainId: number;
}

/** Where one request is, as the relayer last saw it. */
export interface RequestStatus {
  readonly kind: RequestKind;
  readonly stage: Stage;
  readonly evmTxHash?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

/** The relayer's reading of both chains: USDC held, KUSD minted and burned. */
export interface Backing {
  readonly usdcInVault: bigint;
  readonly kusdMinted: bigint;
  readonly kusdBurned: bigint;
  readonly vaultContractAddress: string;
  readonly evmVaultAddress: string;
  readonly usdcAddress: string;
  readonly ethereumBlock: number;
  readonly midnightBlock: number;
  readonly updatedAt: string;
}

/** Why a relayer call did not produce a usable answer. */
export class RelayerError extends Error {
  readonly kind: "unconfigured" | "unreachable" | "http" | "invalid" | "not-found";
  readonly status?: number;

  /**
   * @param kind - What went wrong.
   * @param message - The sentence the UI shows.
   * @param status - The HTTP status, when there was one.
   */
  constructor(kind: RelayerError["kind"], message: string, status?: number) {
    super(message);
    this.name = "RelayerError";
    this.kind = kind;
    this.status = status;
  }
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX32_IN = /^(0x)?[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UNITS = /^\d+$/;
const DEFAULT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Json, key: string, test?: RegExp): string {
  const v = o[key];
  if (typeof v !== "string" || (test && !test.test(v))) {
    throw new RelayerError("invalid", `The relayer sent an unexpected value for "${key}".`);
  }
  return v;
}

function int(o: Json, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new RelayerError("invalid", `The relayer sent an unexpected value for "${key}".`);
  }
  return v;
}

const optionalStr = (o: Json, key: string, test?: RegExp): string | undefined =>
  o[key] === undefined || o[key] === null ? undefined : str(o, key, test);

const normaliseHex32 = (v: string): string => v.replace(/^0x/i, "").toLowerCase();

/**
 * Validate a 64-hex request id or identity commitment.
 *
 * @param value - The value, with or without 0x, in either case.
 * @param what - What it is, for the error message.
 * @returns The value lowercased, without a prefix.
 * @throws {RelayerError} When it is not 32 bytes of hex.
 */
export function assertHex32(value: string, what: string): string {
  const v = normaliseHex32(value);
  if (!HEX32.test(v)) throw new RelayerError("invalid", `${what} must be 32 bytes of hex.`);
  return v;
}

/**
 * Validate a /health answer.
 *
 * @param body - The parsed JSON.
 * @returns The relayer's vault and network.
 * @throws {RelayerError} When the relayer is unhealthy or the answer is malformed.
 */
export function parseHealth(body: unknown): RelayerHealth {
  if (!isObject(body) || body.ok !== true)
    throw new RelayerError("invalid", "The relayer reports it is not healthy.");
  return {
    ok: true,
    network: str(body, "network"),
    vaultContractAddress: normaliseHex32(str(body, "vaultContractAddress", HEX32_IN)),
    evmVaultAddress: str(body, "evmVaultAddress", EVM_ADDRESS),
    usdcAddress: str(body, "usdcAddress", EVM_ADDRESS),
    evmChainId: int(body, "evmChainId"),
  };
}

/**
 * Validate a request status answer.
 *
 * @param body - The parsed JSON.
 * @returns The request's stage and details.
 * @throws {RelayerError} When the answer is malformed or names an unknown stage.
 */
export function parseRequestStatus(body: unknown): RequestStatus {
  if (!isObject(body))
    throw new RelayerError("invalid", "The relayer sent an unreadable request status.");
  const kind = str(body, "kind");
  if (kind !== "deposit" && kind !== "withdraw")
    throw new RelayerError("invalid", "Unknown request kind.");
  const stage = str(body, "stage");
  if (!(STAGES as readonly string[]).includes(stage)) {
    throw new RelayerError("invalid", `The relayer reported an unknown stage "${stage}".`);
  }
  return {
    kind,
    stage: stage as Stage,
    evmTxHash: optionalStr(body, "evmTxHash", EVM_TX_HASH),
    error: optionalStr(body, "error"),
    updatedAt: str(body, "updatedAt"),
  };
}

/**
 * Validate a /backing answer.
 *
 * @param body - The parsed JSON.
 * @returns The figures, amounts as bigints.
 * @throws {RelayerError} When the answer is malformed.
 */
export function parseBacking(body: unknown): Backing {
  if (!isObject(body))
    throw new RelayerError("invalid", "The relayer sent unreadable backing figures.");
  return {
    usdcInVault: BigInt(str(body, "usdcInVault", UNITS)),
    kusdMinted: BigInt(str(body, "kusdMinted", UNITS)),
    kusdBurned: BigInt(str(body, "kusdBurned", UNITS)),
    vaultContractAddress: normaliseHex32(str(body, "vaultContractAddress", HEX32_IN)),
    evmVaultAddress: str(body, "evmVaultAddress", EVM_ADDRESS),
    usdcAddress: str(body, "usdcAddress", EVM_ADDRESS),
    ethereumBlock: int(body, "ethereumBlock"),
    midnightBlock: int(body, "midnightBlock"),
    updatedAt: str(body, "updatedAt"),
  };
}

/**
 * KUSD in circulation: everything minted minus everything burned.
 *
 * @param b - Minted and burned totals.
 * @returns Base units in circulation.
 */
export const kusdInCirculation = (b: Pick<Backing, "kusdMinted" | "kusdBurned">): bigint =>
  b.kusdMinted - b.kusdBurned;

/**
 * How well the vault covers circulation, in basis points (10000 is exactly one to one).
 *
 * @param b - The vault's USDC and the KUSD totals.
 * @returns Basis points, or null when nothing circulates and a ratio means nothing.
 */
export function coverageBps(
  b: Pick<Backing, "usdcInVault" | "kusdMinted" | "kusdBurned">,
): bigint | null {
  const circulating = kusdInCirculation(b);
  if (circulating <= 0n) return null;
  return (b.usdcInVault * 10_000n) / circulating;
}

/** The relayer's five endpoints, validated. */
export interface RelayerClient {
  readonly baseUrl: string;
  readonly health: () => Promise<RelayerHealth>;
  readonly depositAddress: (commitment: string) => Promise<string>;
  readonly register: (kind: RequestKind, requestId: string) => Promise<string>;
  readonly status: (requestId: string) => Promise<RequestStatus>;
  readonly backing: () => Promise<Backing>;
}

/**
 * Build a client for a relayer.
 *
 * @param baseUrl - The relayer's base URL.
 * @param fetchImpl - The fetch to use; the page's own by default.
 * @param timeoutMs - How long one call may take before it is reported unreachable.
 * @returns The client.
 */
export function createRelayerClient(
  baseUrl: string,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): RelayerClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal });
    } catch {
      throw new RelayerError("unreachable", "The relayer could not be reached.");
    } finally {
      clearTimeout(timer);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 404) {
      throw new RelayerError("not-found", "The relayer has no record of that.", 404);
    }
    if (!response.ok) {
      const detail = isObject(body) && typeof body.error === "string" ? `: ${body.error}` : "";
      throw new RelayerError(
        "http",
        `The relayer refused the request (HTTP ${String(response.status)})${detail}`,
        response.status,
      );
    }
    return body;
  }

  return {
    baseUrl: base,
    health: async () => parseHealth(await call("/health")),
    depositAddress: async (commitment) => {
      const c = assertHex32(commitment, "The identity commitment");
      const body = await call(`/deposit-address?commitment=${c}`);
      if (!isObject(body))
        throw new RelayerError("invalid", "The relayer sent no deposit address.");
      return str(body, "evmAddress", EVM_ADDRESS);
    },
    register: async (kind, requestId) => {
      const id = assertHex32(requestId, "The request id");
      const body = await call("/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, requestId: id }),
      });
      if (!isObject(body))
        throw new RelayerError("invalid", "The relayer did not confirm the request.");
      const echoed = assertHex32(str(body, "requestId"), "The confirmed request id");
      if (echoed !== id)
        throw new RelayerError("invalid", "The relayer confirmed a different request.");
      return echoed;
    },
    status: async (requestId) =>
      parseRequestStatus(await call(`/requests/${assertHex32(requestId, "The request id")}`)),
    backing: async () => parseBacking(await call("/backing")),
  };
}

/** The configured relayer, or null when this build names none. */
export const relayer: RelayerClient | null = RELAYER_URL ? createRelayerClient(RELAYER_URL) : null;

// ---------------------------------------------------------------------------
// What each stage means to a person, and roughly how long it takes
// ---------------------------------------------------------------------------

/** How a stage is described to a person. */
export interface StageCopy {
  readonly title: string;
  readonly detail: string;
  /** An estimate of how long this stage takes, for "about N minutes left". Not a measurement. */
  readonly typicalSeconds: number;
}

const COMMON: Record<"queued" | "flushed" | "sent" | "signed" | "attested", StageCopy> = {
  queued: {
    title: "Accepted by the relayer",
    detail: "Your request is on Midnight and the relayer has picked it up.",
    typicalSeconds: 10,
  },
  flushed: {
    title: "Moved through the vault queue",
    detail: "The vault orders requests so two people never collide. Yours has its place.",
    typicalSeconds: 30,
  },
  sent: {
    title: "Sent to the signers",
    detail: "The vault asked Sig Network's signers to sign the Ethereum transfer it composed.",
    typicalSeconds: 30,
  },
  signed: {
    title: "Signed by the network",
    detail: "The signers produced a signature. No single signer holds the key.",
    typicalSeconds: 45,
  },
  attested: {
    title: "Outcome attested",
    detail: "The signers confirmed on Midnight what happened on Ethereum.",
    typicalSeconds: 60,
  },
};

/** Every stage's description, for each kind of request. */
export const STAGE_COPY: Record<RequestKind, Record<Stage, StageCopy>> = {
  deposit: {
    ...COMMON,
    broadcast: {
      title: "USDC moved into the vault",
      detail: "The signed sweep from your deposit address to the vault was sent on Ethereum.",
      typicalSeconds: 30,
    },
    ready: {
      title: "Ready to mint",
      detail: "The attestation is in the vault. Sign once more to receive your private dollars.",
      typicalSeconds: 30,
    },
    completed: {
      title: "Private dollars received",
      detail: "KUSD was minted to your shielded address. Only you can see the balance.",
      typicalSeconds: 0,
    },
    failed: {
      title: "Stopped",
      detail: "The relayer could not carry this step. Nothing has been lost; see below.",
      typicalSeconds: 0,
    },
  },
  withdraw: {
    ...COMMON,
    broadcast: {
      title: "USDC sent on Ethereum",
      detail: "The vault's signed transfer to your Ethereum address was broadcast.",
      typicalSeconds: 30,
    },
    ready: {
      title: "Ready to settle",
      detail: "The attestation is in the vault. Sign once more to close the withdrawal.",
      typicalSeconds: 30,
    },
    completed: {
      title: "Withdrawal settled",
      detail: "The USDC is at your Ethereum address and the request is closed.",
      typicalSeconds: 0,
    },
    failed: {
      title: "Stopped",
      detail: "The relayer could not carry this step. Your dollars are recoverable; see below.",
      typicalSeconds: 0,
    },
  },
};

/**
 * Seconds left on the healthy path from a stage, for an overall estimate.
 *
 * @param kind - Deposit or withdrawal.
 * @param stage - Where the request is.
 * @returns The estimated seconds still to go.
 */
export function remainingSeconds(kind: RequestKind, stage: Stage): number {
  if (stage === "failed" || stage === "completed") return 0;
  const from = PROGRESS_STAGES.indexOf(stage);
  return PROGRESS_STAGES.slice(from).reduce(
    (sum, s) => sum + STAGE_COPY[kind][s].typicalSeconds,
    0,
  );
}

/**
 * Whether the person must sign for the request to move on.
 *
 * @param stage - Where the request is.
 * @returns True at the last signature.
 */
export const awaitsUser = (stage: Stage): boolean => stage === "ready";

/**
 * Whether polling can stop.
 *
 * @param stage - Where the request is.
 * @returns True once the request has completed or failed.
 */
export const isTerminal = (stage: Stage): boolean => stage === "completed" || stage === "failed";

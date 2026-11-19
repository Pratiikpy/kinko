// SPDX-License-Identifier: Apache-2.0
//
// In-process harness: the compiled contract runs on @midnight-ntwrk/compact-runtime with no node,
// no indexer and no proving. Each call is made by one party, with that party's private state
// only, against the current public state at the harness clock.

import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  type JubjubPoint,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  type Ceremony,
  constructorArgs,
  Contract,
  type DeploymentConfig,
  type DisclosurePrivateState,
  generateExaminerKey,
  type KeyholderIndex,
  type Ledger,
  ledger,
  type PaymentStatement,
  pureCircuits,
  randomBytes32,
  runCeremony,
  type Statement,
  toStatement,
  witnesses,
} from "../src/index.ts";

export const CPK = "c0".repeat(32);
export const ADDRESS = sampleContractAddress();
/** 2027-01-15, in Unix seconds. */
export const T0 = 1_800_000_000n;
export const DAY = 86_400n;
export const ZERO32 = new Uint8Array(32);

type Result = CircuitResults<DisclosurePrivateState, unknown>;
type State = Parameters<typeof ledger>[0];
type CircuitName =
  "file_record" | "register_examiner" | "revoke_examiner" | "open_case" | "approve_case";
type AnyCircuit = (
  context: CircuitContext<DisclosurePrivateState>,
  ...args: unknown[]
) => Promise<Result>;

/**
 * Element `i` of a list, or a test failure naming what was missing. A length assertion does not
 * narrow the index read that follows it, so reads go through here.
 */
export function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`expected an element at index ${String(i)}`);
  return item;
}

/** The pattern a refusal with this code throws. */
export const refusal = (code: string): RegExp => new RegExp(`\\b${code}\\b`);

/** Deploys a contract from a deployment config and returns its public state. */
export async function deployConfig(config: DeploymentConfig): Promise<State> {
  const contract = new Contract<DisclosurePrivateState>(witnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext<DisclosurePrivateState>({}, CPK),
    ...constructorArgs(config),
  );
  return currentContractState.data;
}

export interface Examiner {
  readonly scalar: bigint;
  readonly publicKey: JubjubPoint;
  readonly id: Uint8Array;
}

export const newExaminer = (): Examiner => {
  const key = generateExaminerKey();
  return { ...key, id: pureCircuits.examinerIdOf(key.publicKey) };
};

/** A deployed contract, a clock, and one method per party action. */
export class Deployment {
  readonly contract = new Contract<DisclosurePrivateState>(witnesses);
  now: bigint = T0;

  private constructor(
    public state: State,
    readonly ceremony: Ceremony,
  ) {}

  static async create(): Promise<Deployment> {
    const ceremony = runCeremony();
    return new Deployment(await deployConfig(ceremony.config), ceremony);
  }

  ledger(): Ledger {
    return ledger(this.state);
  }

  /** Runs one circuit as one party and adopts the resulting public state. */
  async call(name: CircuitName, ps: DisclosurePrivateState, ...args: unknown[]): Promise<Result> {
    const ctx = createCircuitContext<DisclosurePrivateState>({
      circuitId: name,
      contractAddress: ADDRESS,
      coinPublicKeyOrZswapState: CPK,
      contractState: this.state,
      privateState: ps,
      time: Number(this.now),
    });
    const circuits = this.contract.circuits as unknown as Record<CircuitName, AnyCircuit>;
    const res = await circuits[name](ctx, ...args);
    this.state = res.context.callContext.currentQueryContext.state;
    return res;
  }

  // ---- parties ------------------------------------------------------------------------------

  get operator(): DisclosurePrivateState {
    return { secretKey: this.ceremony.operatorSecret };
  }

  keyholder(index: KeyholderIndex): DisclosurePrivateState {
    const share = this.ceremony.keyholders[index];
    return { scalar: share.scalar, bindingScalar: share.bindingScalar };
  }

  // ---- actions ------------------------------------------------------------------------------

  async file(
    filerSecret: Uint8Array,
    statement: Statement | PaymentStatement,
    extra: Partial<DisclosurePrivateState> = {},
  ): Promise<{ recordId: Uint8Array; res: Result; statement: Statement }> {
    const s = "salt" in statement ? statement : toStatement(statement);
    const res = await this.call("file_record", { secretKey: filerSecret, statement: s, ...extra });
    return { recordId: res.result as Uint8Array, res, statement: s };
  }

  registerExaminer(
    pk: JubjubPoint,
    ps: DisclosurePrivateState = this.operator,
    at: bigint = this.now,
  ): Promise<Result> {
    return this.call("register_examiner", ps, pk, at);
  }

  revokeExaminer(
    id: Uint8Array,
    ps: DisclosurePrivateState = this.operator,
    at: bigint = this.now,
  ): Promise<Result> {
    return this.call("revoke_examiner", ps, id, at);
  }

  async openCase(
    examiner: Examiner,
    recordIds: readonly Uint8Array[],
    options: {
      expiry?: bigint;
      nonce?: Uint8Array;
      scalar?: bigint;
      count?: bigint;
      at?: bigint;
    } = {},
  ): Promise<{ caseId: Uint8Array; res: Result }> {
    const ids = [...recordIds, ZERO32, ZERO32, ZERO32, ZERO32].slice(0, 4);
    const res = await this.call(
      "open_case",
      { scalar: options.scalar ?? examiner.scalar },
      examiner.publicKey,
      ids,
      options.count ?? BigInt(recordIds.length),
      options.expiry ?? this.now + 30n * DAY,
      options.nonce ?? randomBytes32(),
      options.at ?? this.now,
    );
    return { caseId: res.result as Uint8Array, res };
  }

  approve(
    index: KeyholderIndex,
    caseId: Uint8Array,
    options: { ps?: DisclosurePrivateState; slotIndex?: bigint; at?: bigint } = {},
  ): Promise<Result> {
    return this.call(
      "approve_case",
      options.ps ?? this.keyholder(index),
      caseId,
      options.slotIndex ?? BigInt(index),
      options.at ?? this.now,
    );
  }
}

/** A realistic payment statement with distinctive values. */
export const statementOf = (overrides: Partial<PaymentStatement> = {}): PaymentStatement => ({
  amount: 1_234_567_890n,
  time: T0 - 3n * DAY,
  direction: "sent",
  counterparty: 0x51a7_e5c0_ffee_0042_1337_beefn,
  reference: "INV-2026-11-0457",
  memo: "Kitchen fit-out, second stage payment as agreed",
  ...overrides,
});

// ---- transcript inspection ------------------------------------------------------------------

/**
 * Every value cell the call put in its public transcript, as hex. A call reveals exactly its
 * transcript: the ledger operations it ran, with the keys and values in the clear, plus its
 * return value. Arguments and witnesses that never reach an operation are not in it.
 */
export function transcriptCells(res: Result): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.value) && Array.isArray(rec.alignment)) {
      for (const cell of rec.value as Uint8Array[]) out.add(Buffer.from(cell).toString("hex"));
      return;
    }
    Object.values(rec).forEach(walk);
  };
  for (const call of res.context.callProofDataTrace) {
    walk(call.publicTranscript);
    walk(call.output);
  }
  return out;
}

/** A field value as the transcript carries it: little-endian with trailing zero bytes trimmed. */
export function leHex(value: bigint): string {
  let out = "";
  for (let rest = value; rest > 0n; rest >>= 8n)
    out += Number(rest & 0xffn)
      .toString(16)
      .padStart(2, "0");
  return out;
}

/** A byte string as the transcript carries it: trailing zero bytes trimmed. */
export const bytesHex = (b: Uint8Array): string =>
  Buffer.from(b)
    .toString("hex")
    .replace(/(?:00)+$/, "");

/** Every bigint and byte string reachable from a value, for scanning ledger views. */
export function collectValues(root: unknown): { ints: Set<bigint>; bytes: Set<string> } {
  const ints = new Set<bigint>();
  const bytes = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (typeof v === "bigint") ints.add(v);
    else if (v instanceof Uint8Array) bytes.add(Buffer.from(v).toString("hex"));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(root);
  return { ints, bytes };
}

/** A full snapshot of the public ledger: every map entry, every field. */
export function ledgerSnapshot(l: Ledger): unknown {
  return {
    operatorCommitment: l.operatorCommitment,
    disclosurePk: l.disclosurePk,
    keyholderPks: l.keyholderPks,
    bindingPk: l.bindingPk,
    threshold: l.threshold,
    records: [...l.records],
    usedEphemerals: [...l.usedEphemerals],
    examiners: [...l.examiners],
    cases: [...l.cases],
    shares: [...l.shares],
    disclosureLog: [...l.disclosureLog],
    logLength: l.logLength,
  };
}

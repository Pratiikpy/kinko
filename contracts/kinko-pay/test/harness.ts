// In-process harness shared by every Kinko Pay contract suite.
//
// The compiled contract runs on @midnight-ntwrk/compact-runtime with no node,
// no indexer and no proving, so the behavioural suites finish in seconds. What
// is tested here is the contract logic, which is where the security properties
// live. Each call is made by one party, with that party's private state only,
// against the current public state at the harness clock.

import {
  type ChargedState,
  type CircuitContext,
  type CircuitResults,
  type ContractState,
  createCircuitContext,
  type EncodedZswapLocalState,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

/** The coin public key every simulated caller signs transactions with. */
export const CPK = "c0".repeat(32);

/** 2027-01-15, in seconds since the epoch: the clock every deployment starts at. */
export const T0 = 1_800_000_000n;

export const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Serialise anything the way an observer reading raw bytes would see it. */
export const serialise = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) => {
    if (typeof val === "bigint") return val.toString();
    if (val instanceof Uint8Array) return Buffer.from(val).toString("hex");
    if (val instanceof Map) return [...(val as Map<unknown, unknown>).entries()];
    if (val instanceof Set) return [...(val as Set<unknown>).values()];
    return val;
  }).toLowerCase();

/**
 * The first element of a collection, failing the test with what was missing
 * when there is none. Ledger collections are iterables, and an index read is
 * not narrowed by an earlier length assertion.
 */
export const first = <T>(items: Iterable<T>, what: string): T => {
  for (const item of items) return item;
  throw new Error(`expected at least one ${what}`);
};

/** Fail the test with `message`; usable where an expression is expected. */
export const fail = (message: string): never => {
  throw new Error(message);
};

/** Element `i` of an array, failing the test when it is absent. */
export const nth = <T>(items: readonly T[], i: number): T => {
  const item = items[i];
  if (item === undefined) throw new Error(`expected an element at index ${String(i)}`);
  return item;
};

type AnyCircuit<PS> = (
  ctx: CircuitContext<PS>,
  ...args: never[]
) => Promise<CircuitResults<PS, unknown>>;

/** Everything after the context in a circuit's parameter list. */
type ArgsOf<F> = F extends (ctx: never, ...args: infer A) => unknown ? A : never;
type ResultOf<F> = F extends (...args: never[]) => Promise<CircuitResults<unknown, infer R>>
  ? R
  : never;

/** What one call left behind, for tests that inspect a single transaction. */
export interface CallRecord {
  readonly circuit: string;
  /** The public transcript and outputs of every call in the trace, serialised. */
  readonly transcript: string;
  /** The contract's claimed effects (nullifiers, coin commitments, mints), serialised. */
  readonly effects: string;
  /** The zswap outputs this call produced, which a wallet encrypts to recipients. */
  readonly zswapOutputs: EncodedZswapLocalState["outputs"];
}

/**
 * A deployed contract, its public state, a clock, and the private state of
 * whoever is calling next.
 */
export class Harness<PS, C extends Record<string, AnyCircuit<PS>>> {
  readonly address = sampleContractAddress();
  /** Block time in seconds that the next call sees. */
  now: bigint = T0;
  readonly calls: CallRecord[] = [];

  constructor(
    readonly circuits: C,
    public state: ContractState | ChargedState,
    public privateState: PS,
  ) {}

  /**
   * Overlay the private state. This is how another party is modelled:
   * identity here IS the private state.
   */
  as(over: Partial<PS>): this {
    this.privateState = { ...this.privateState, ...over };
    return this;
  }

  at(seconds: bigint): this {
    this.now = seconds;
    return this;
  }

  /**
   * Run one circuit as a transaction. On success the public state advances;
   * on failure it is untouched, exactly as a transaction whose proof cannot be
   * built never reaches the chain.
   */
  async call<K extends keyof C & string>(
    circuit: K,
    ...args: ArgsOf<C[K]>
  ): Promise<ResultOf<C[K]>> {
    const ctx = createCircuitContext<PS>({
      circuitId: circuit,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: CPK,
      contractState: this.state,
      privateState: this.privateState,
      time: Number(this.now),
    });
    const fn = this.circuits[circuit] as unknown as (
      c: CircuitContext<PS>,
      ...a: unknown[]
    ) => Promise<CircuitResults<PS, unknown>>;
    const res = await fn(ctx, ...(args as unknown[]));
    const after = res.context.callContext;
    this.state = after.currentQueryContext.state;
    if (after.currentPrivateState !== undefined) this.privateState = after.currentPrivateState;
    this.calls.push({
      circuit,
      transcript: serialise(
        res.context.callProofDataTrace.map((t) => ({
          public: t.publicTranscript,
          output: t.output,
        })),
      ),
      effects: serialise(after.currentQueryContext.effects),
      zswapOutputs: after.currentZswapLocalState?.outputs ?? [],
    });
    return res.result as ResultOf<C[K]>;
  }

  /** The record of the last call, or of the last call to `circuit`. */
  last(circuit?: string): CallRecord {
    const record = [...this.calls]
      .reverse()
      .find((c) => circuit === undefined || c.circuit === circuit);
    if (!record) throw new Error(`no call${circuit ? ` to ${circuit}` : ""} has been made yet`);
    return record;
  }

  /** The public state as the generated `ledger()` accessor takes it. */
  charged(): ChargedState {
    return "data" in this.state ? this.state.data : this.state;
  }

  /** The raw public state, in its serialised form, as a node stores it. */
  rawState(): string {
    const value = this.charged().state;
    return `${value.toString(false)}\n${serialise(value.encode())}`.toLowerCase();
  }

  /**
   * Everything a chain observer can read: every call's public transcript,
   * outputs and effects, plus the whole public state in serialised form.
   */
  observerView(): string {
    return [...this.calls.flatMap((c) => [c.transcript, c.effects]), this.rawState()].join("\n");
  }
}

/**
 * The coins a call sent to user keys: zswap outputs whose recipient is a coin
 * public key. Outputs to a contract (the payer's coin entering the contract on
 * its way through) are left out, so this is exactly who got paid.
 */
export const paidTo = (
  outputs: EncodedZswapLocalState["outputs"],
): { to: string; value: bigint; color: string }[] =>
  outputs
    .filter((o) => o.recipient.is_left)
    .map((o) => ({
      to: hex(o.recipient.left.bytes),
      value: o.coinInfo.value,
      color: hex(o.coinInfo.color),
    }));

/** Every encoding a number could take in serialised ledger data. */
export const encodings = (v: bigint): string[] => {
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  const le = (h.match(/../g) ?? []).reverse().join("");
  const out = [v.toString(10), h, le];
  for (const w of [8, 16, 32]) {
    out.push(h.padStart(w * 2, "0"));
    out.push(le.padEnd(w * 2, "0"));
  }
  return out;
};

/** The encodings of `v` that occur in `haystack`. Empty means not found. */
export const found = (haystack: string, v: bigint): string[] =>
  encodings(v).filter((e) => haystack.includes(e));

// The backend's window onto the chain: read-only, and only what is public.
//
// The watcher and the public status route read `kinko_pay`'s ledger through
// this interface. The real implementation asks a Midnight indexer for the
// contract's state and decodes it with the compiled contract's own `ledger()`
// accessor, so the layout is never re-implemented here. Tests substitute a
// fake reader; nothing else in the backend knows an indexer exists.

import { fromHex, KinkoPay, toHex } from "@kinko/kinko-pay";

import { ChainInvoiceStatus, InvoiceKindName, TokenName } from "../domain/enums.ts";

/** What the chain says about one invoice. Never an amount: the ledger holds none. */
export interface ChainInvoice {
  readonly status: ChainInvoiceStatus;
  readonly kind: InvoiceKindName;
  readonly token: TokenName;
  /** The invoice's own expiry in milliseconds, or null when it never expires. */
  readonly expiresAt: number | null;
  /** How many settlements have landed. */
  readonly contributions: number;
}

/** A consistent read of the contract at one moment. */
export interface ChainSnapshot {
  /** The invoice with this commitment, or undefined when the chain has none. */
  invoice(commitment: string): ChainInvoice | undefined;
  /** Invoices ever created on the contract: the one aggregate the ledger publishes. */
  readonly created: bigint;
  /** The oracle key sealed into the contract at deployment. */
  readonly oraclePublicKey: { readonly x: bigint; readonly y: bigint };
  /** The KUSD colour sealed into the contract, as hex. */
  readonly kusdColor: string;
}

/** Options for a snapshot request. */
export interface SnapshotOptions {
  /** Skip the short-lived cache. The watcher always asks for a fresh read. */
  readonly fresh?: boolean;
}

/** Reads `kinko_pay`'s public state. */
export interface ChainReader {
  /**
   * Read the contract's public state.
   *
   * @param options - Whether to skip the short-lived cache.
   * @returns A consistent view of the contract at one moment.
   * @throws {ChainError} When the indexer cannot be reached or holds no such contract.
   */
  snapshot(options?: SnapshotOptions): Promise<ChainSnapshot>;
}

/** The chain could not be read, or the address holds no contract. */
export class ChainError extends Error {
  /**
   * Create a chain error.
   *
   * @param message - What could not be read.
   * @param options - Standard error options.
   * @param options.cause - The underlying failure.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainError";
  }
}

const KIND_NAMES: Readonly<Record<number, InvoiceKindName>> = {
  [KinkoPay.InvoiceKind.STANDARD]: InvoiceKindName.STANDARD,
  [KinkoPay.InvoiceKind.MULTIPAY]: InvoiceKindName.MULTIPAY,
  [KinkoPay.InvoiceKind.DONATION]: InvoiceKindName.DONATION,
};

const TOKEN_NAMES: Readonly<Record<number, TokenName>> = {
  [KinkoPay.TokenKind.NATIVE]: TokenName.NATIVE,
  [KinkoPay.TokenKind.KUSD]: TokenName.KUSD,
};

const STATUS_NAMES: Readonly<Record<number, ChainInvoiceStatus>> = {
  [KinkoPay.InvoiceStatus.OPEN]: ChainInvoiceStatus.OPEN,
  [KinkoPay.InvoiceStatus.SETTLED]: ChainInvoiceStatus.SETTLED,
  [KinkoPay.InvoiceStatus.CANCELLED]: ChainInvoiceStatus.CANCELLED,
};

/**
 * Wrap a decoded ledger as a snapshot.
 *
 * @param ledger - The compiled contract's ledger accessor output.
 * @returns A snapshot answering by commitment.
 */
export const snapshotOf = (ledger: KinkoPay.Ledger): ChainSnapshot => ({
  created: ledger.created,
  oraclePublicKey: { x: ledger.oracle_pk.x, y: ledger.oracle_pk.y },
  kusdColor: toHex(ledger.kusd_color),
  invoice(commitment: string): ChainInvoice | undefined {
    const key = fromHex(commitment);
    if (!ledger.invoices.member(key)) return undefined;
    const state = ledger.invoices.lookup(key);
    const kind = KIND_NAMES[state.kind];
    const token = TOKEN_NAMES[state.token];
    const status = STATUS_NAMES[state.status];
    if (kind === undefined || token === undefined || status === undefined) {
      throw new ChainError(
        `the ledger holds an invoice with an unknown kind, asset or status (${String(state.kind)}/${String(state.token)}/${String(state.status)})`,
      );
    }
    return {
      status,
      kind,
      token,
      expiresAt: state.expires_at === 0n ? null : Number(state.expires_at) * 1000,
      contributions: Number(state.contributions),
    };
  },
});

/** What the reader needs of Midnight's public data provider: the contract's current state. */
export interface StateProvider {
  /**
   * Fetch a contract's current state.
   *
   * @param address - The contract address, 64 hex characters.
   * @returns The state, or null when the indexer holds no contract at the address.
   */
  queryContractState(
    address: string,
  ): Promise<{ readonly data: Parameters<typeof KinkoPay.ledger>[0] } | null>;
}

/** Options for {@link IndexerChainReader}. */
export interface IndexerReaderOptions {
  /** The kinko_pay contract address, 64 hex characters. */
  readonly contractAddress: string;
  readonly provider: StateProvider;
  /** How long a read may be reused by API calls. The watcher bypasses it. */
  readonly cacheMs?: number;
  /**
   * The longest to wait for the indexer. The provider retries a refused
   * connection on its own schedule, so without a bound a down indexer would
   * stall every caller for as long as it keeps trying.
   */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Reads `kinko_pay` from a Midnight indexer. */
export class IndexerChainReader implements ChainReader {
  readonly #address: string;
  readonly #provider: StateProvider;
  readonly #cacheMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #cached: { at: number; snapshot: ChainSnapshot } | undefined;
  #inflight: Promise<ChainSnapshot> | undefined;

  /**
   * Create a reader.
   *
   * @param options - The contract address, the data provider, and the cache and timeout settings.
   */
  constructor(options: IndexerReaderOptions) {
    this.#address = options.contractAddress;
    this.#provider = options.provider;
    this.#cacheMs = options.cacheMs ?? 2_000;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /** @inheritdoc */
  async snapshot(options: SnapshotOptions = {}): Promise<ChainSnapshot> {
    const cached = this.#cached;
    if (!options.fresh && cached && this.#now() - cached.at < this.#cacheMs) return cached.snapshot;
    // Concurrent callers share one request rather than each hitting the indexer.
    this.#inflight ??= this.#read().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #read(): Promise<ChainSnapshot> {
    let state;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${String(this.#timeoutMs)} ms`));
        }, this.#timeoutMs);
      });
      state = await Promise.race([this.#provider.queryContractState(this.#address), deadline]);
    } catch (cause) {
      throw new ChainError(
        `the indexer could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!state) {
      throw new ChainError(
        `the indexer holds no contract at ${this.#address}: wrong address, or wrong network`,
      );
    }
    let snapshot: ChainSnapshot;
    try {
      snapshot = snapshotOf(KinkoPay.ledger(state.data));
    } catch (cause) {
      throw new ChainError(
        `the state at ${this.#address} is not a kinko_pay ledger: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    this.#cached = { at: this.#now(), snapshot };
    return snapshot;
  }
}

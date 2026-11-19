// The backing figures `/backing` reports, and a cache so a busy page does not turn into
// a stream of chain reads.

/** One reading of what backs the dollar. */
export interface BackingReading {
  /** The USDC the vault's Ethereum account holds, in USDC base units. */
  readonly usdcInVault: bigint;
  /** KUSD the vault has minted, in base units. */
  readonly kusdMinted: bigint;
  /** KUSD the vault has burned, principal only, in base units. */
  readonly kusdBurned: bigint;
  /** The vault's Ethereum account, 0x-prefixed. */
  readonly evmVaultAddress: string;
  /** The Ethereum block the USDC balance was read at or after. */
  readonly ethereumBlock: number;
  /** The Midnight block the counters were read at or after. */
  readonly midnightBlock: number;
}

/** Reads what backs the dollar. */
export interface BackingPort {
  /**
   * Read the vault's USDC and its minted and burned KUSD.
   *
   * @returns The reading.
   * @throws {Error} When either chain cannot be read.
   */
  read(): Promise<BackingReading>;
}

/** A reading and when it was taken. */
export interface TimedBackingReading {
  /** The figures. */
  readonly reading: BackingReading;
  /** When they were read, epoch milliseconds. */
  readonly readAt: number;
}

/** Reuses a reading for a while, and shares one read among callers that arrive together. */
export class CachedBacking {
  private readonly source: BackingPort;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private cached: TimedBackingReading | undefined;
  private reading: Promise<TimedBackingReading> | undefined;

  /**
   * Wrap a source.
   *
   * @param source - Where readings come from.
   * @param ttlMs - How long a reading is reused, 0 to read every time.
   * @param clock - The current time in epoch milliseconds.
   */
  constructor(source: BackingPort, ttlMs: number, clock: () => number) {
    this.source = source;
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  /**
   * The latest reading, fresh enough.
   *
   * @returns The reading and when it was taken.
   * @throws {Error} When a read is needed and fails.
   */
  async get(): Promise<TimedBackingReading> {
    const now = this.clock();
    if (this.cached !== undefined && now - this.cached.readAt < this.ttlMs) return this.cached;
    this.reading ??= this.source
      .read()
      .then((reading) => {
        this.cached = { reading, readAt: this.clock() };
        return this.cached;
      })
      .finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }
}

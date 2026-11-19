// A whole backend running against fakes: an in-memory SQLite file, a clock the
// test moves, a chain it edits, and a webhook receiver that records what it was
// sent. Requests go over a real socket, so every route is exercised through the
// same pipeline production uses.

import { expect } from "vitest";

import { type App, type AppOverrides, createApp } from "../../src/app.ts";
import type { ChainInvoice, ChainReader, ChainSnapshot } from "../../src/chain/reader.ts";
import { ChainError } from "../../src/chain/reader.ts";
import { type Config, type Env, loadConfig } from "../../src/config.ts";
import { ChainInvoiceStatus, InvoiceKindName, TokenName } from "../../src/domain/enums.ts";
import { createLogger, LogLevel } from "../../src/log.ts";
import { SqliteStore } from "../../src/store/sqlite.ts";
import type {
  Deliverer,
  DeliveryRequest,
  DeliveryResponse,
} from "../../src/webhooks/http-deliverer.ts";

/** A clock the test controls. */
export class TestClock {
  #now: number;
  constructor(start = Date.UTC(2027, 0, 15, 12, 0, 0)) {
    this.#now = start;
  }
  now = (): number => this.#now;
  /** Move time forward. */
  advance(ms: number): void {
    this.#now += ms;
  }
}

/** A chain the test edits by hand. */
export class FakeChain implements ChainReader {
  readonly invoices = new Map<string, ChainInvoice>();
  created = 0n;
  oracleKey = { x: 1n, y: 2n };
  /** When set, every read fails as an unreachable indexer would. */
  failing = false;
  reads = 0;

  /** Add an open invoice. */
  open(commitment: string, over: Partial<ChainInvoice> = {}): void {
    this.invoices.set(commitment, {
      status: ChainInvoiceStatus.OPEN,
      kind: InvoiceKindName.STANDARD,
      token: TokenName.KUSD,
      expiresAt: null,
      contributions: 0,
      ...over,
    });
    this.created += 1n;
  }

  /** Change an invoice already on the chain. */
  update(commitment: string, over: Partial<ChainInvoice>): void {
    const current = this.invoices.get(commitment);
    if (!current) throw new Error(`no invoice ${commitment} on the fake chain`);
    this.invoices.set(commitment, { ...current, ...over });
  }

  snapshot(): Promise<ChainSnapshot> {
    this.reads++;
    if (this.failing)
      return Promise.reject(new ChainError("the indexer could not be reached: connection refused"));
    const copy = new Map(this.invoices);
    return Promise.resolve({
      created: this.created,
      kusdColor: "c1".repeat(32),
      oraclePublicKey: this.oracleKey,
      invoice: (commitment: string) => copy.get(commitment),
    });
  }
}

/** A webhook receiver that records requests and answers as told. */
export class FakeDeliverer implements Deliverer {
  readonly requests: DeliveryRequest[] = [];
  /** The status to answer with; a function lets a test vary by attempt. */
  respond: (attempt: number, request: DeliveryRequest) => number | Error = () => 200;

  deliver(request: DeliveryRequest): Promise<DeliveryResponse> {
    this.requests.push(request);
    const answer = this.respond(this.requests.length, request);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ status: answer });
  }
}

/** The environment every test starts from. */
export const baseEnv = (over: Env = {}): Env => ({
  KINKO_DATA_KEY: "ab".repeat(32),
  KINKO_PAY_ADDRESS: "cd".repeat(32),
  KINKO_PORT: "0",
  KINKO_APP_URL: "https://app.kinko.example",
  ...over,
});

/** A request to the test backend. */
export interface CallOptions {
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly key?: string;
  readonly headers?: Record<string, string>;
}

/** What came back. The body is parsed JSON, read with {@link field} rather than trusted to have a shape. */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/**
 * Read a value out of parsed JSON by path, such as `session.items[0].id`.
 *
 * @param value - Parsed JSON.
 * @param path - Dot-separated keys, with `[n]` for array positions.
 * @returns What is there, or undefined when any step is missing.
 */
export const field = (value: unknown, path: string): unknown =>
  path
    .split(/\.|(?=\[)/)
    .filter(Boolean)
    .reduce<unknown>((node, step) => {
      if (node === null || typeof node !== "object") return undefined;
      const index = /^\[(\d+)\]$/.exec(step);
      return (node as Record<string, unknown>)[index?.[1] ?? step];
    }, value);

/** An asymmetric matcher for a string containing `text`, typed so it can sit inside an expected object. */
export const containing = (text: string): string => expect.stringContaining(text) as string;

/** An asymmetric matcher for a string matching `pattern`. */
export const matching = (pattern: RegExp): string => expect.stringMatching(pattern) as string;

/** A started backend and the handles a test needs. */
export interface TestApp {
  readonly app: App;
  readonly config: Config;
  readonly clock: TestClock;
  readonly chain: FakeChain;
  readonly deliverer: FakeDeliverer;
  readonly logs: string[];
  readonly base: string;
  call(method: string, path: string, options?: CallOptions): Promise<Reply>;
  /** Register a merchant and return their credentials. */
  register(
    name?: string,
    webhookUrl?: string,
  ): Promise<{ id: string; key: string; secret: string }>;
  stop(): Promise<void>;
}

/** Options for {@link startTestApp}. */
export interface StartOptions {
  readonly env?: Env;
  readonly overrides?: AppOverrides;
}

/**
 * Start a backend on an ephemeral port with every outside dependency faked and
 * the background loops off.
 *
 * @param options - Extra environment and overrides.
 * @returns The running backend.
 */
export const startTestApp = async (options: StartOptions = {}): Promise<TestApp> => {
  const config = loadConfig(baseEnv(options.env));
  const clock = new TestClock();
  const chain = new FakeChain();
  const deliverer = new FakeDeliverer();
  const logs: string[] = [];
  const app = createApp(config, {
    clock: clock.now,
    chain,
    deliverer,
    store: new SqliteStore(":memory:"),
    log: createLogger(
      (line) => logs.push(line),
      LogLevel.DEBUG,
      {},
      () => new Date(clock.now()),
    ),
    ...options.overrides,
  });
  const port = await app.start({ background: false });
  const base = `http://127.0.0.1:${String(port)}`;

  const call = async (method: string, path: string, opts: CallOptions = {}): Promise<Reply> => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] ??= "application/json";
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as unknown) : {},
    };
  };

  return {
    app,
    config,
    clock,
    chain,
    deliverer,
    logs,
    base,
    call,
    async register(name = "Acme Studio", webhookUrl = "https://hooks.example.com/kinko") {
      const reply = await call("POST", "/v1/merchants", { body: { name, webhookUrl } });
      if (reply.status !== 201)
        throw new Error(`registration failed: ${JSON.stringify(reply.body)}`);
      return {
        id: field(reply.body, "merchant.id") as string,
        key: field(reply.body, "apiKey.key") as string,
        secret: field(reply.body, "webhookSecret") as string,
      };
    },
    stop: () => app.stop(),
  };
};

/** A commitment-shaped value for tests that do not need a real one. */
export const fakeCommitment = (seed: number): string =>
  seed.toString(16).padStart(2, "0").repeat(32).slice(0, 64);

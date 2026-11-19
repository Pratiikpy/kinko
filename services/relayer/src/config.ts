// The relayer's configuration, read from the environment once at startup. Every problem is
// collected and reported together, so an operator fixes the environment in one pass.

import { type DeployedNetwork, getResponderContractAddress } from "@sig-net/midnight";
import { getMidnightNodeConfig, type MidnightNodeConfig } from "@sig-net/midnight-contract-deploy";

/** Limits on the ETH the relayer sends to fund deposit sweeps. */
export interface GasTopUpConfig {
  /** Private key of the Ethereum account that pays. Its balance is the relayer's whole exposure. */
  readonly privateKey: string;
  /** The most ETH, in wei, one deposit address may ever receive. */
  readonly maxPerAddressWei: bigint;
  /** The most ETH, in wei, the relayer sends in any rolling 24 hours, across all addresses. */
  readonly maxPerDayWei: bigint;
}

/** The HTTP server's settings. */
export interface HttpConfig {
  /** The interface to listen on. */
  readonly host: string;
  /** The port to listen on. */
  readonly port: number;
  /** Origins allowed to call the API from a browser. Empty allows none. */
  readonly corsOrigins: readonly string[];
  /** Requests one client address may make in a minute. */
  readonly rateLimitPerMinute: number;
  /** Whether to take the client address from `X-Forwarded-For`, for a relayer behind a proxy. */
  readonly trustProxy: boolean;
}

/** The stage machine's settings. */
export interface EngineConfig {
  /** How often the relayer reads the chains. */
  readonly pollIntervalMs: number;
  /** How long a request may sit in one waiting stage before the relayer fails it. */
  readonly stageTimeoutMs: number;
  /** How many retryable failures in a row fail a request. */
  readonly maxConsecutiveFailures: number;
  /** How long a broadcast transaction may stay unmined before it is submitted again. */
  readonly rebroadcastIntervalMs: number;
  /** Whether to flush and send other users' deposits and withdrawals the relayer was not asked about. */
  readonly serveUnregistered: boolean;
  /** How long finished requests stay queryable. */
  readonly retentionMs: number;
}

/** Everything the relayer reads from its environment. */
export interface RelayerConfig {
  /** The Midnight network and its endpoints. */
  readonly node: MidnightNodeConfig;
  /** The seed of the relayer's own Midnight wallet, which pays every fee. */
  readonly relayerSeed: string;
  /** The vault contract's address, bare hex. */
  readonly vaultContractAddress: string;
  /** The signet responder's address, bare hex: the contract the MPC posts its responses to. */
  readonly responderContractAddress: string;
  /** The Ethereum JSON-RPC endpoint. */
  readonly evmRpcUrl: string;
  /** The Ethereum chain id the vault is pinned to. */
  readonly evmChainId: bigint;
  /** The USDC contract the vault backs its dollar with, 0x-prefixed. */
  readonly usdcAddress: string;
  /** The MPC network's secp256k1 public key, SEC1 hex. */
  readonly mpcPublicKey: string;
  /** The state file. */
  readonly stateFile: string;
  /** How long a `/backing` reading is reused. */
  readonly backingCacheMs: number;
  /** The HTTP server. */
  readonly http: HttpConfig;
  /** The stage machine. */
  readonly engine: EngineConfig;
  /** Gas top-ups, or undefined when the relayer does not fund gas. */
  readonly gasTopUp?: GasTopUpConfig;
}

/** Thrown when the environment cannot configure a relayer. */
export class ConfigError extends Error {
  /** Every problem found, one per line of the message. */
  readonly problems: readonly string[];

  /**
   * Collect the problems into one error.
   *
   * @param problems - What is wrong with the environment.
   */
  constructor(problems: readonly string[]) {
    super(
      `invalid relayer configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Reads and validates variables, remembering every problem instead of stopping at the first. */
class Reader {
  readonly problems: string[] = [];
  private readonly env: Environment;

  constructor(env: Environment) {
    this.env = env;
  }

  optional(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  }

  required(name: string, description: string): string {
    const value = this.optional(name);
    if (value === undefined) {
      this.problems.push(`${name} is required: ${description}`);
      return "";
    }
    return value;
  }

  hex(name: string, bytes: number, description: string, fallback?: string): string {
    const defaulted = fallback !== undefined && this.optional(name) === undefined;
    const value = (defaulted ? fallback : this.required(name, description)).replace(/^0x/, "");
    if (value !== "" && !new RegExp(`^[0-9a-fA-F]{${String(bytes * 2)}}$`).test(value)) {
      this.problems.push(`${name} must be ${String(bytes)} bytes of hex; got "${value}"`);
    }
    return value.toLowerCase();
  }

  integer(name: string, fallback: number, minimum: number, maximum: number): number {
    const text = this.optional(name);
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || value < minimum || value > maximum) {
      this.problems.push(
        `${name} must be a whole number from ${String(minimum)} to ${String(maximum)}; got "${text}"`,
      );
      return fallback;
    }
    return value;
  }

  positive(name: string, description: string): bigint {
    const text = this.required(name, description);
    if (text !== "" && !/^[1-9]\d*$/.test(text)) {
      this.problems.push(`${name} must be a positive whole number; got "${text}"`);
      return 0n;
    }
    return text === "" ? 0n : BigInt(text);
  }

  wei(name: string, description: string): bigint {
    const text = this.required(name, description);
    if (text !== "" && !/^\d+$/.test(text)) {
      this.problems.push(`${name} must be a whole number of wei; got "${text}"`);
      return 0n;
    }
    return text === "" ? 0n : BigInt(text);
  }

  flag(name: string, fallback: boolean): boolean {
    const text = this.optional(name)?.toLowerCase();
    if (text === undefined) return fallback;
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
    this.problems.push(`${name} must be true or false; got "${text}"`);
    return fallback;
  }

  url(name: string, description: string): string {
    const value = this.required(name, description);
    if (value !== "") {
      try {
        new URL(value);
      } catch {
        this.problems.push(`${name} must be a URL; got "${value}"`);
      }
    }
    return value;
  }
}

/**
 * The signet responder the SDK publishes for a network.
 *
 * @param networkId - The configured network, when it was readable.
 * @returns The responder's address, or undefined for a network the SDK publishes none for.
 */
function publishedResponder(networkId: string | undefined): string | undefined {
  if (networkId === undefined) return undefined;
  try {
    return getResponderContractAddress(networkId as DeployedNetwork);
  } catch {
    return undefined;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Read the relayer's configuration.
 *
 * @param env - The environment, normally `process.env`.
 * @returns The validated configuration.
 * @throws {ConfigError} Naming every variable that is missing or malformed.
 */
export function loadConfig(env: Environment): RelayerConfig {
  const reader = new Reader(env);

  let node: MidnightNodeConfig | undefined;
  try {
    node = getMidnightNodeConfig(env);
  } catch (error) {
    reader.problems.push(error instanceof Error ? error.message : String(error));
  }

  const relayerSeed = reader.required(
    "RELAYER_SEED",
    "the seed (hex or mnemonic) of the relayer's own Midnight wallet, funded with NIGHT to pay fees",
  );
  const vaultContractAddress = reader.hex(
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
    32,
    "the deployed vault contract's address",
  );
  const networkId = node?.networkId ?? reader.optional("NETWORK_ID");
  const publishedResponderAddress = publishedResponder(networkId);
  const responderContractAddress = reader.hex(
    "MIDNIGHT_RESPONDER_CONTRACT_ADDRESS",
    32,
    "the signet responder's address, which the MPC posts its responses to",
    publishedResponderAddress,
  );
  if (
    publishedResponderAddress !== undefined &&
    /^[0-9a-f]{64}$/.test(responderContractAddress) &&
    responderContractAddress !== publishedResponderAddress
  ) {
    reader.problems.push(
      `MIDNIGHT_RESPONDER_CONTRACT_ADDRESS is ${responderContractAddress} but the SDK publishes ` +
        `${publishedResponderAddress} for ${networkId ?? ""}; unset it to use the published one`,
    );
  }
  const evmRpcUrl = reader.url("EVM_RPC_URL", "the Ethereum JSON-RPC endpoint");
  const evmChainId = reader.positive("EVM_CHAIN_ID", "the chain id the vault is pinned to");
  const usdcAddress = `0x${reader.hex("USDC_ADDRESS", 20, "the USDC contract the vault holds")}`;
  const mpcPublicKey = reader.required(
    "MPC_SECP256K1_PUBKEY",
    "the MPC network's secp256k1 public key, which derives every deposit address",
  );

  const privateKey = reader.optional("RELAYER_EVM_PRIVATE_KEY");
  let gasTopUp: GasTopUpConfig | undefined;
  if (privateKey !== undefined) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
      reader.problems.push("RELAYER_EVM_PRIVATE_KEY must be 32 bytes of hex");
    }
    gasTopUp = {
      privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
      maxPerAddressWei: reader.wei(
        "RELAYER_GAS_MAX_PER_ADDRESS_WEI",
        "the most wei one deposit address may receive, required when RELAYER_EVM_PRIVATE_KEY is set",
      ),
      maxPerDayWei: reader.wei(
        "RELAYER_GAS_MAX_PER_DAY_WEI",
        "the most wei sent in any rolling 24 hours, required when RELAYER_EVM_PRIVATE_KEY is set",
      ),
    };
    if (
      gasTopUp.maxPerAddressWei === 0n ||
      gasTopUp.maxPerDayWei === 0n ||
      gasTopUp.maxPerAddressWei > gasTopUp.maxPerDayWei
    ) {
      reader.problems.push(
        "RELAYER_GAS_MAX_PER_ADDRESS_WEI and RELAYER_GAS_MAX_PER_DAY_WEI must be positive, " +
          "with the per-address limit no larger than the per-day limit",
      );
    }
  }

  const http: HttpConfig = {
    host: reader.optional("RELAYER_HOST") ?? "127.0.0.1",
    port: reader.integer("RELAYER_PORT", 3200, 1, 65535),
    corsOrigins: (reader.optional("RELAYER_CORS_ORIGINS") ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    rateLimitPerMinute: reader.integer("RELAYER_RATE_LIMIT_PER_MINUTE", 120, 1, 1_000_000),
    trustProxy: reader.flag("RELAYER_TRUST_PROXY", false),
  };
  for (const origin of http.corsOrigins) {
    if (origin !== "*" && !/^https?:\/\/[^/\s]+$/.test(origin)) {
      reader.problems.push(
        `RELAYER_CORS_ORIGINS entries must be an origin such as https://app.example, or *; got "${origin}"`,
      );
    }
  }

  const engine: EngineConfig = {
    pollIntervalMs: reader.integer("RELAYER_POLL_INTERVAL_MS", 3_000, 100, HOUR_MS),
    stageTimeoutMs: reader.integer("RELAYER_STAGE_TIMEOUT_MS", 25 * MINUTE_MS, 1_000, 7 * DAY_MS),
    maxConsecutiveFailures: reader.integer("RELAYER_MAX_CONSECUTIVE_FAILURES", 8, 1, 1000),
    rebroadcastIntervalMs: reader.integer(
      "RELAYER_REBROADCAST_INTERVAL_MS",
      5 * MINUTE_MS,
      1_000,
      DAY_MS,
    ),
    serveUnregistered: reader.flag("RELAYER_SERVE_UNREGISTERED", true),
    retentionMs: reader.integer("RELAYER_RETENTION_MS", 7 * DAY_MS, 1_000, 365 * DAY_MS),
  };

  const stateFile = reader.optional("RELAYER_STATE_FILE") ?? "relayer-state.json";
  const backingCacheMs = reader.integer("RELAYER_BACKING_CACHE_MS", 15_000, 0, HOUR_MS);

  if (reader.problems.length > 0 || node === undefined) throw new ConfigError(reader.problems);

  return {
    node,
    relayerSeed,
    vaultContractAddress,
    responderContractAddress,
    evmRpcUrl,
    evmChainId,
    usdcAddress,
    mpcPublicKey,
    stateFile,
    backingCacheMs,
    http,
    engine,
    ...(gasTopUp === undefined ? {} : { gasTopUp }),
  };
}

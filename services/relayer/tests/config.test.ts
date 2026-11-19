// Startup configuration: what a good environment yields, and that a bad one is refused
// with every problem named at once.

import { getResponderContractAddress, MidnightNetwork } from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.ts";

const VALID_ENV: Record<string, string> = {
  RELAYER_SEED: "00".repeat(32),
  MIDNIGHT_VAULT_CONTRACT_ADDRESS: "11".repeat(32),
  MIDNIGHT_RESPONDER_CONTRACT_ADDRESS: "22".repeat(32),
  EVM_RPC_URL: "http://127.0.0.1:8545",
  EVM_CHAIN_ID: "11155111",
  USDC_ADDRESS: `0x${"aa".repeat(20)}`,
  MPC_SECP256K1_PUBKEY: `04${"bb".repeat(64)}`,
};

// A deployed network, on endpoints of the operator's own.
const PREPROD_ENV: Record<string, string> = {
  NETWORK_ID: "preprod",
  MIDNIGHT_NODE_URL: "http://127.0.0.1:9944",
  MIDNIGHT_NODE_INDEXER_URL: "http://127.0.0.1:8088/api/v4/graphql",
};

describe("loadConfig", () => {
  it("reads a minimal environment and fills every default", () => {
    const config = loadConfig(VALID_ENV);

    expect(config).toMatchObject({
      relayerSeed: VALID_ENV.RELAYER_SEED,
      vaultContractAddress: VALID_ENV.MIDNIGHT_VAULT_CONTRACT_ADDRESS,
      evmChainId: 11155111n,
      usdcAddress: VALID_ENV.USDC_ADDRESS,
      stateFile: "relayer-state.json",
      backingCacheMs: 15_000,
      http: {
        host: "127.0.0.1",
        port: 3200,
        corsOrigins: [],
        rateLimitPerMinute: 120,
        trustProxy: false,
      },
      engine: {
        pollIntervalMs: 3_000,
        stageTimeoutMs: 1_500_000,
        maxConsecutiveFailures: 8,
        rebroadcastIntervalMs: 300_000,
        serveUnregistered: true,
      },
    });
    expect(config.node.networkId).toBe("undeployed");
    expect(config.responderContractAddress).toBe("22".repeat(32));
    expect(config.gasTopUp).toBeUndefined();
  });

  it("takes the responder the SDK publishes for a deployed network when none is named", () => {
    const { MIDNIGHT_RESPONDER_CONTRACT_ADDRESS: _unset, ...rest } = VALID_ENV;

    const config = loadConfig({ ...rest, ...PREPROD_ENV });

    expect(config.responderContractAddress).toBe(
      getResponderContractAddress(MidnightNetwork.Preprod),
    );
  });

  it("refuses a responder that disagrees with the one the SDK publishes", () => {
    expect(() => loadConfig({ ...VALID_ENV, ...PREPROD_ENV })).toThrow(
      /MIDNIGHT_RESPONDER_CONTRACT_ADDRESS is 2{64} but the SDK publishes [0-9a-f]{64} for preprod/,
    );
  });

  it("reads every override", () => {
    const config = loadConfig({
      ...VALID_ENV,
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: `0x${"AB".repeat(32)}`,
      RELAYER_HOST: "0.0.0.0",
      RELAYER_PORT: "9000",
      RELAYER_CORS_ORIGINS: "https://kinko.app, http://localhost:3000",
      RELAYER_RATE_LIMIT_PER_MINUTE: "30",
      RELAYER_TRUST_PROXY: "true",
      RELAYER_SERVE_UNREGISTERED: "false",
      RELAYER_STATE_FILE: "/var/lib/relayer/state.json",
      RELAYER_EVM_PRIVATE_KEY: "cd".repeat(32),
      RELAYER_GAS_MAX_PER_ADDRESS_WEI: "1000",
      RELAYER_GAS_MAX_PER_DAY_WEI: "5000",
    });

    expect(config.vaultContractAddress).toBe("ab".repeat(32));
    expect(config.http).toEqual({
      host: "0.0.0.0",
      port: 9000,
      corsOrigins: ["https://kinko.app", "http://localhost:3000"],
      rateLimitPerMinute: 30,
      trustProxy: true,
    });
    expect(config.engine.serveUnregistered).toBe(false);
    expect(config.stateFile).toBe("/var/lib/relayer/state.json");
    expect(config.gasTopUp).toEqual({
      privateKey: `0x${"cd".repeat(32)}`,
      maxPerAddressWei: 1000n,
      maxPerDayWei: 5000n,
    });
  });

  it.each([
    { variable: "RELAYER_SEED", problem: /RELAYER_SEED is required/ },
    {
      variable: "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
      problem: /MIDNIGHT_VAULT_CONTRACT_ADDRESS is required/,
    },
    {
      variable: "MIDNIGHT_RESPONDER_CONTRACT_ADDRESS",
      problem: /MIDNIGHT_RESPONDER_CONTRACT_ADDRESS is required/,
    },
    { variable: "EVM_RPC_URL", problem: /EVM_RPC_URL is required/ },
    { variable: "EVM_CHAIN_ID", problem: /EVM_CHAIN_ID is required/ },
    { variable: "USDC_ADDRESS", problem: /USDC_ADDRESS is required/ },
    { variable: "MPC_SECP256K1_PUBKEY", problem: /MPC_SECP256K1_PUBKEY is required/ },
  ])("refuses an environment without $variable, saying what it is for", ({ variable, problem }) => {
    const { [variable]: _removed, ...rest } = VALID_ENV;

    expect(() => loadConfig(rest)).toThrow(problem);
  });

  it.each([
    {
      name: "a vault address that is too short",
      env: { MIDNIGHT_VAULT_CONTRACT_ADDRESS: "abcd" },
      problem: /must be 32 bytes of hex/,
    },
    {
      name: "a USDC address that is not hex",
      env: { USDC_ADDRESS: "0xnothex" },
      problem: /USDC_ADDRESS must be 20 bytes of hex/,
    },
    {
      name: "an RPC endpoint that is not a URL",
      env: { EVM_RPC_URL: "localhost" },
      problem: /EVM_RPC_URL must be a URL/,
    },
    {
      name: "a chain id of zero",
      env: { EVM_CHAIN_ID: "0" },
      problem: /EVM_CHAIN_ID must be a positive whole number/,
    },
    {
      name: "a port out of range",
      env: { RELAYER_PORT: "70000" },
      problem: /RELAYER_PORT must be a whole number from 1 to 65535/,
    },
    {
      name: "a flag that is neither true nor false",
      env: { RELAYER_TRUST_PROXY: "maybe" },
      problem: /RELAYER_TRUST_PROXY must be true or false/,
    },
    {
      name: "a CORS origin with a path",
      env: { RELAYER_CORS_ORIGINS: "https://kinko.app/app" },
      problem: /RELAYER_CORS_ORIGINS entries must be an origin/,
    },
    { name: "an unknown network", env: { NETWORK_ID: "moonbase" }, problem: /moonbase/ },
    {
      name: "a gas key without limits",
      env: { RELAYER_EVM_PRIVATE_KEY: "cd".repeat(32) },
      problem: /RELAYER_GAS_MAX_PER_ADDRESS_WEI is required/,
    },
    {
      name: "a per-address gas limit above the per-day limit",
      env: {
        RELAYER_EVM_PRIVATE_KEY: "cd".repeat(32),
        RELAYER_GAS_MAX_PER_ADDRESS_WEI: "9",
        RELAYER_GAS_MAX_PER_DAY_WEI: "5",
      },
      problem: /per-address limit no larger than the per-day limit/,
    },
    {
      name: "a gas key that is not 32 bytes",
      env: {
        RELAYER_EVM_PRIVATE_KEY: "abcd",
        RELAYER_GAS_MAX_PER_ADDRESS_WEI: "1",
        RELAYER_GAS_MAX_PER_DAY_WEI: "2",
      },
      problem: /RELAYER_EVM_PRIVATE_KEY must be 32 bytes of hex/,
    },
  ])("refuses $name", ({ env, problem }) => {
    expect(() => loadConfig({ ...VALID_ENV, ...env })).toThrow(problem);
  });

  it("reports every problem in one error, so the operator fixes the environment once", () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig({ RELAYER_PORT: "nope" });
    } catch (error) {
      if (error instanceof ConfigError) caught = error;
    }

    expect(caught?.problems.length).toBeGreaterThanOrEqual(8);
    expect(caught?.message).toContain("RELAYER_SEED is required");
    expect(caught?.message).toContain("RELAYER_PORT must be a whole number");
    expect(caught?.message).toContain("MPC_SECP256K1_PUBKEY is required");
  });
});

import { Action, SupplyCounter } from "@sig-net/midnight-examples-erc20-vault-contract";
import { describe, expect, it } from "vitest";

import { fromHex } from "./format.ts";
import {
  DEPOSIT_GAS,
  DEPOSIT_GAS_CEILING_WEI,
  depositRequestId,
  identityCommitment,
  isFlushed,
  kusdSupply,
  kusdTokenType,
  withdrawRequestId,
} from "./vault.ts";

const VAULT = "7c".repeat(32);
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// The slice of the vault ledger the request-id derivations read.
function fakeState(
  opts: { inQueue?: bigint[]; flushed?: { inIndex: bigint; nonce: bigint }[] } = {},
) {
  const outputs = (opts.flushed ?? []).map(
    (f) =>
      [
        new Uint8Array(32),
        { entry: { action: Action.withdraw, inIndex: f.inIndex, evmNonce: f.nonce } },
      ] as const,
  );
  const args = new Map(
    (opts.flushed ?? []).map((f) => [
      f.inIndex,
      {
        gas: {
          gasLimit: 120_000n,
          maxFeePerGas: 150_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        },
      },
    ]),
  );
  return {
    evmChainId: 11155111n,
    vaultEvmAddress: fromHex("0x" + "ab".repeat(20)),
    inputRequestBuffer: { member: (i: bigint) => (opts.inQueue ?? []).includes(i) },
    outputRequestBuffer: outputs,
    withdrawArgsMap: { member: (i: bigint) => args.has(i), lookup: (i: bigint) => args.get(i) },
  } as never;
}

describe("identity", () => {
  it("commits a secret deterministically, and differently per secret", () => {
    const a = identityCommitment(new Uint8Array(32).fill(1));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(identityCommitment(new Uint8Array(32).fill(1))).toBe(a);
    expect(identityCommitment(new Uint8Array(32).fill(2))).not.toBe(a);
  });
});

describe("KUSD token type", () => {
  it("depends on both the vault and the token", () => {
    const t = kusdTokenType(USDC, VAULT);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(kusdTokenType(USDC, "7d".repeat(32))).not.toBe(t);
    expect(kusdTokenType("0x" + "99".repeat(20), VAULT)).not.toBe(t);
  });
});

describe("deposit request id", () => {
  const base = {
    vaultContractAddress: VAULT,
    state: fakeState(),
    commitmentHex: "11".repeat(32),
    usdcAddress: USDC,
    amount: 100_000_000n,
    evmNonce: 0n,
  };

  it("is fixed by the sweep's fields", () => {
    const id = depositRequestId(base);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(depositRequestId(base)).toBe(id);
  });

  it("changes with the amount, the nonce and the identity", () => {
    const id = depositRequestId(base);
    expect(depositRequestId({ ...base, amount: 100_000_001n })).not.toBe(id);
    expect(depositRequestId({ ...base, evmNonce: 1n })).not.toBe(id);
    expect(depositRequestId({ ...base, commitmentHex: "12".repeat(32) })).not.toBe(id);
  });

  it("budgets gas the deposit address must hold", () => {
    expect(DEPOSIT_GAS_CEILING_WEI).toBe(DEPOSIT_GAS.gasLimit * DEPOSIT_GAS.maxFeePerGas);
  });
});

describe("withdraw request id", () => {
  const p = {
    vaultContractAddress: VAULT,
    inIndex: 42n,
    usdcAddress: USDC,
    amount: 40_000_000n,
    destination: "0x" + "cd".repeat(20),
  };

  it("does not exist before the flush assigns a nonce", () => {
    const state = fakeState({ inQueue: [42n] });
    expect(isFlushed(state, 42n)).toBe(false);
    expect(withdrawRequestId({ ...p, state })).toBeNull();
  });

  it("covers the nonce the flush assigned", () => {
    const a = withdrawRequestId({
      ...p,
      state: fakeState({ flushed: [{ inIndex: 42n, nonce: 7n }] }),
    });
    const b = withdrawRequestId({
      ...p,
      state: fakeState({ flushed: [{ inIndex: 42n, nonce: 8n }] }),
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
    expect(isFlushed(fakeState({ flushed: [{ inIndex: 42n, nonce: 7n }] }), 42n)).toBe(true);
  });
});

describe("supply counters", () => {
  // The vault keeps each counter as four 16-bit limbs; limb 1 carries 2^16.
  const LIMBS: Record<number, readonly bigint[]> = {
    [SupplyCounter.minted]: [10n, 1n, 0n, 0n],
    [SupplyCounter.burned]: [3n, 0n, 0n, 0n],
    [SupplyCounter.feesMinted]: [1n, 0n, 0n, 0n],
  };
  const ledger = (allowed: boolean) =>
    ({
      allowedTokens: { member: () => allowed },
      supplyCounters: {
        lookup: (key: { counter: SupplyCounter; limb: bigint }) => ({
          read: () => LIMBS[key.counter]?.[Number(key.limb)] ?? 0n,
        }),
      },
    }) as never;

  it("is reported as absent when the vault does not hold the token, never as zero", () => {
    expect(kusdSupply(ledger(false), USDC)).toBeNull();
  });

  it("sums each counter's limbs and derives circulating supply", () => {
    expect(kusdSupply(ledger(true), USDC)).toEqual({
      minted: 65_546n,
      burned: 3n,
      feesMinted: 1n,
      circulating: 65_543n,
    });
  });
});

// The stage machine against in-memory chains: every transition, retries, failure,
// timeouts, the write rules and a restart from persisted state.

import { bytesToHex } from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import type { EngineConfig } from "../src/config.ts";
import { RelayerEngine, RequestKindMismatchError } from "../src/engine.ts";
import {
  AttestationPosition,
  BroadcastOutcome,
  type RequestPosition,
  VaultPosition,
} from "../src/ports.ts";
import { MemoryPersistence, StateStore } from "../src/store.ts";
import { RequestKind, RequestStage } from "../src/types.ts";
import {
  attestation,
  FakeEvm,
  FakeGas,
  FakeMpc,
  FakeVault,
  idOf,
  RecordingLogger,
  signedSweep,
} from "./fakes.ts";

const OPTIONS: EngineConfig = {
  pollIntervalMs: 1_000,
  stageTimeoutMs: 600_000,
  maxConsecutiveFailures: 3,
  rebroadcastIntervalMs: 300_000,
  serveUnregistered: true,
  retentionMs: 86_400_000,
};

const DEPOSIT_ID = idOf("a");
const WITHDRAW_ID = idOf("b");

const QUEUED: RequestPosition = {
  vault: VaultPosition.Queued,
  inIndex: 7n,
  attestation: AttestationPosition.None,
};
const FLUSHED: RequestPosition = {
  vault: VaultPosition.Flushed,
  inIndex: 7n,
  outIndex: Uint8Array.of(7),
  attestation: AttestationPosition.None,
};
const OPEN: RequestPosition = { vault: VaultPosition.Open, attestation: AttestationPosition.None };

/** One engine over fresh fakes, sharing `persistence` when a test restarts it. */
function arrange(
  options: Partial<EngineConfig> = {},
  persistence = new MemoryPersistence(),
  startAt = 1_000_000,
) {
  const time = { now: startAt };
  const vault = new FakeVault();
  const mpc = new FakeMpc();
  const evm = new FakeEvm();
  const gas = new FakeGas();
  const logger = new RecordingLogger();
  const store = new StateStore(persistence);
  const engine = new RelayerEngine({
    vault,
    mpc,
    evm,
    gas,
    store,
    options: { ...OPTIONS, ...options },
    logger,
    clock: () => time.now,
  });
  return { time, vault, mpc, evm, gas, logger, store, engine, persistence };
}

type Arranged = ReturnType<typeof arrange>;

/** One tick and everything it started. */
async function round(arranged: Arranged): Promise<void> {
  await arranged.engine.tick();
  await arranged.engine.idle();
}

const stageOf = (arranged: Arranged, requestId: string): RequestStage | undefined =>
  arranged.engine.status(requestId)?.stage;

/** Rounds until the request reaches `stage`, failing after `limit`. */
async function roundsUntil(
  arranged: Arranged,
  requestId: string,
  stage: RequestStage,
  limit = 20,
): Promise<void> {
  for (let count = 0; count < limit && stageOf(arranged, requestId) !== stage; count += 1) {
    await round(arranged);
  }
  expect(stageOf(arranged, requestId)).toBe(stage);
}

/**
 * Run `rounds` rounds and return the stages the request went through, from the one it was
 * registered at, read off the engine's own transition log: a stage entered and left within
 * one round never shows in a sample of the status.
 */
async function journey(
  arranged: Arranged,
  requestId: string,
  rounds: number,
): Promise<RequestStage[]> {
  for (let count = 0; count < rounds; count += 1) await round(arranged);
  const stages: string[] = [];
  for (const line of arranged.logger.infos) {
    const registered = new RegExp(`${requestId}: tracking from stage (\\w+)`).exec(line);
    const moved = new RegExp(`${requestId}: \\w+ -> (\\w+)`).exec(line);
    const stage = registered?.[1] ?? moved?.[1];
    if (stage !== undefined) stages.push(stage);
  }
  return stages.map((stage) => stage as RequestStage);
}

describe("a deposit's journey", () => {
  it("carries a queued deposit to ready, funds its sweep's gas, and completes once the user settles it", async () => {
    const arranged = arrange();
    const { vault, mpc, evm, gas, engine } = arranged;
    const sweep = await signedSweep(0);
    vault.set(RequestKind.Deposit, DEPOSIT_ID, QUEUED);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);

    mpc.signed.set(DEPOSIT_ID, sweep);
    mpc.attestationPosts.set(DEPOSIT_ID, [attestation(DEPOSIT_ID, 101n)]);
    const stages = await journey(arranged, DEPOSIT_ID, 12);

    // The user's complete circuit is the one step the relayer never takes.
    expect(stages).toEqual([
      RequestStage.Queued,
      RequestStage.Flushed,
      RequestStage.Sent,
      RequestStage.Signed,
      RequestStage.Broadcast,
      RequestStage.Attested,
      RequestStage.Ready,
    ]);
    expect(evm.broadcasts).toEqual([sweep.hash]);
    expect(gas.requests).toEqual([
      { address: sweep.from, shortfallWei: 100_000n * 30_000_000_000n },
    ]);
    expect(engine.status(DEPOSIT_ID)?.evmTxHash).toBe(sweep.hash);

    vault.remove(RequestKind.Deposit, DEPOSIT_ID);
    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Completed);
    expect(engine.status(DEPOSIT_ID)?.signedTransaction).toBeUndefined();
  });

  it("carries a withdrawal registered after its send, and never funds its gas", async () => {
    const arranged = arrange();
    const { vault, mpc, evm, gas, engine } = arranged;
    const transaction = await signedSweep(5);
    vault.set(RequestKind.Withdraw, WITHDRAW_ID, OPEN);
    await engine.register(RequestKind.Withdraw, WITHDRAW_ID);
    mpc.signed.set(WITHDRAW_ID, transaction);
    mpc.attestationPosts.set(WITHDRAW_ID, [attestation(WITHDRAW_ID, 102n)]);

    const stages = await journey(arranged, WITHDRAW_ID, 10);

    expect(stages).toEqual([
      RequestStage.Sent,
      RequestStage.Signed,
      RequestStage.Broadcast,
      RequestStage.Attested,
      RequestStage.Ready,
    ]);
    expect(evm.broadcasts).toEqual([transaction.hash]);
    expect(gas.requests).toEqual([]);
  });

  it("waits in sent until the MPC's signature appears, then moves on", async () => {
    const arranged = arrange();
    const { vault, mpc, engine } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);

    await round(arranged);
    await round(arranged);
    expect(stageOf(arranged, DEPOSIT_ID)).toBe(RequestStage.Sent);
    expect(mpc.signatureReads).toBe(2);

    mpc.signed.set(DEPOSIT_ID, await signedSweep(0));
    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Signed);
  });
});

describe("broadcasting the signed transaction", () => {
  interface BroadcastCase {
    readonly name: string;
    readonly outcome: BroadcastOutcome;
    readonly alreadyMined: boolean;
    readonly stage: RequestStage;
    readonly broadcasts: number;
  }

  const CASES: readonly BroadcastCase[] = [
    {
      name: "a node that takes it",
      outcome: BroadcastOutcome.Accepted,
      alreadyMined: false,
      stage: RequestStage.Broadcast,
      broadcasts: 1,
    },
    {
      name: "a node that already has it",
      outcome: BroadcastOutcome.AlreadyKnown,
      alreadyMined: false,
      stage: RequestStage.Broadcast,
      broadcasts: 1,
    },
    {
      name: "a spent nonce, which the MPC attests as unviable",
      outcome: BroadcastOutcome.NonceConsumed,
      alreadyMined: false,
      stage: RequestStage.Broadcast,
      broadcasts: 1,
    },
    {
      name: "a sender that cannot pay yet, which keeps it waiting",
      outcome: BroadcastOutcome.InsufficientFunds,
      alreadyMined: false,
      stage: RequestStage.Signed,
      broadcasts: 1,
    },
    {
      name: "a transaction that mined already, which needs no broadcast",
      outcome: BroadcastOutcome.Accepted,
      alreadyMined: true,
      stage: RequestStage.Broadcast,
      broadcasts: 0,
    },
  ];

  it.each(CASES)("handles $name", async ({ outcome, alreadyMined, stage, broadcasts }) => {
    const arranged = arrange();
    const { vault, mpc, evm, engine } = arranged;
    const sweep = await signedSweep(0);
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    mpc.signed.set(DEPOSIT_ID, sweep);
    evm.outcome = outcome;
    if (alreadyMined && sweep.hash !== null) evm.mined.add(sweep.hash);
    // The sender already holds its gas, so this isolates the node's answer.
    if (sweep.from !== null) evm.balances.set(sweep.from.toLowerCase(), 10n ** 18n);

    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Signed);
    await round(arranged);

    expect(stageOf(arranged, DEPOSIT_ID)).toBe(stage);
    expect(evm.broadcasts).toHaveLength(broadcasts);
    expect(engine.status(DEPOSIT_ID)?.consecutiveFailures).toBe(0);
  });

  it("asks for no gas when the deposit address already holds enough", async () => {
    const arranged = arrange();
    const { vault, mpc, evm, gas, engine } = arranged;
    const sweep = await signedSweep(0);
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    mpc.signed.set(DEPOSIT_ID, sweep);
    if (sweep.from !== null) evm.balances.set(sweep.from.toLowerCase(), 3_000_000_000_000_000n);

    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Broadcast);

    expect(gas.requests).toEqual([]);
  });

  it("keeps a sweep waiting, without failing it, while the gas limits refuse to fund it", async () => {
    const arranged = arrange();
    const { vault, mpc, evm, gas, engine, logger } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    mpc.signed.set(DEPOSIT_ID, await signedSweep(0));
    gas.refuse = true;

    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Signed);
    await round(arranged);
    await round(arranged);

    expect(stageOf(arranged, DEPOSIT_ID)).toBe(RequestStage.Signed);
    expect(evm.broadcasts).toEqual([]);
    expect(engine.status(DEPOSIT_ID)?.consecutiveFailures).toBe(0);
    expect(logger.warnings.some((line) => line.includes("gas top-up refused"))).toBe(true);
  });

  it("submits a broadcast transaction again once the interval passes without it mining, and not before", async () => {
    const arranged = arrange();
    const { vault, mpc, evm, engine, time } = arranged;
    const sweep = await signedSweep(0);
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    mpc.signed.set(DEPOSIT_ID, sweep);
    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Broadcast);
    expect(evm.broadcasts).toHaveLength(1);

    time.now += OPTIONS.rebroadcastIntervalMs - 1;
    await round(arranged);
    expect(evm.broadcasts).toHaveLength(1);

    time.now += 2;
    await round(arranged);
    expect(evm.broadcasts).toHaveLength(2);

    if (sweep.hash !== null) evm.mined.add(sweep.hash);
    time.now += OPTIONS.rebroadcastIntervalMs + 1;
    await round(arranged);
    expect(evm.broadcasts).toHaveLength(2);
  });
});

describe("the attestation", () => {
  it("tries the next verified attestation when the vault refuses one, and never offers the refused one again", async () => {
    const arranged = arrange();
    const { vault, mpc, engine } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    mpc.signed.set(DEPOSIT_ID, await signedSweep(0));
    mpc.attestationPosts.set(DEPOSIT_ID, [
      attestation(DEPOSIT_ID, 90n),
      attestation(DEPOSIT_ID, 101n),
    ]);
    vault.rejectedAttestations.add("90");

    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Attested);
    await round(arranged);

    expect(vault.writes.filter((write) => write.startsWith("queueAttestation"))).toEqual([
      "queueAttestation:90",
      "queueAttestation:101",
    ]);
  });
});

describe("writes to the vault", () => {
  it("folds every request's flush, attestations included, into one transaction", async () => {
    const arranged = arrange();
    const { vault, engine } = arranged;
    const second = idOf("c");
    const attested = idOf("d");
    vault.set(RequestKind.Deposit, DEPOSIT_ID, QUEUED);
    vault.set(RequestKind.Deposit, second, { ...QUEUED, inIndex: 8n });
    vault.set(RequestKind.Withdraw, attested, {
      vault: VaultPosition.Open,
      attestation: AttestationPosition.Queued,
    });
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    await engine.register(RequestKind.Deposit, second);
    await engine.register(RequestKind.Withdraw, attested);

    await round(arranged);

    expect(vault.writes).toEqual(["flush"]);
    const [flush] = vault.flushes;
    expect(flush?.inIndexes).toEqual([7n, 8n]);
    expect(flush?.requestIds.map((id) => bytesToHex(id))).toEqual([attested]);
  });

  it("runs Midnight writes one at a time and starts no second copy of a step still running", async () => {
    const arranged = arrange();
    const { vault, engine } = arranged;
    vault.delayMs = 30;
    const second = idOf("c");
    vault.set(RequestKind.Deposit, DEPOSIT_ID, FLUSHED);
    vault.set(RequestKind.Deposit, second, {
      ...FLUSHED,
      inIndex: 8n,
      outIndex: Uint8Array.of(8),
    });
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    await engine.register(RequestKind.Deposit, second);

    await engine.tick();
    await engine.tick();
    await engine.idle();

    expect(vault.maxActiveWrites).toBe(1);
    expect([...vault.writes].sort()).toEqual(["send:07", "send:08"]);
  });

  it("returns from a tick before its writes land", async () => {
    const arranged = arrange();
    const { vault, engine } = arranged;
    vault.delayMs = 50;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, QUEUED);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);

    await engine.tick();
    expect(vault.at(RequestKind.Deposit, DEPOSIT_ID)?.vault).toBe(VaultPosition.Queued);

    await engine.idle();
    expect(vault.at(RequestKind.Deposit, DEPOSIT_ID)?.vault).toBe(VaultPosition.Flushed);
  });

  it.each([
    { serve: true, sends: ["send:09"], flushes: 1 },
    { serve: false, sends: [], flushes: 0 },
  ])(
    "with serveUnregistered=$serve, the work nobody registered gets $sends and $flushes flush(es)",
    async ({ serve, sends, flushes }) => {
      const arranged = arrange({ serveUnregistered: serve });
      const { vault, engine } = arranged;
      vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
      await engine.register(RequestKind.Deposit, DEPOSIT_ID);
      vault.waiting = {
        open: [],
        queuedInIndexes: [3n],
        queuedAttestationIds: [],
        unsent: [{ kind: RequestKind.Withdraw, outIndex: Uint8Array.of(9) }],
      };

      await round(arranged);

      expect(vault.writes.filter((write) => write.startsWith("send"))).toEqual(sends);
      expect(vault.writes.filter((write) => write === "flush")).toHaveLength(flushes);
    },
  );
});

describe("failure", () => {
  it("fails a request after the configured run of consecutive failures, naming the last", async () => {
    const arranged = arrange();
    const { vault, engine } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, FLUSHED);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    vault.failures = [
      new Error("proof server down"),
      new Error("proof server down"),
      new Error("wallet out of DUST"),
    ];

    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Failed);

    expect(engine.status(DEPOSIT_ID)?.error).toBe(
      "3 failures in a row, the last: wallet out of DUST",
    );
  });

  it("resets the count when a step succeeds, so scattered failures never fail a request", async () => {
    const arranged = arrange();
    const { vault, engine } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, FLUSHED);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    vault.failures = [new Error("proof server down"), new Error("proof server down")];

    await round(arranged);
    await round(arranged);
    expect(engine.status(DEPOSIT_ID)?.consecutiveFailures).toBe(2);
    await round(arranged);

    expect(stageOf(arranged, DEPOSIT_ID)).toBe(RequestStage.Flushed);
    expect(engine.status(DEPOSIT_ID)?.consecutiveFailures).toBe(0);
    expect(vault.at(RequestKind.Deposit, DEPOSIT_ID)?.vault).toBe(VaultPosition.Open);
  });

  it("counts a failed MPC read like any other retryable failure", async () => {
    const arranged = arrange();
    const { vault, mpc, engine } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    mpc.failures = [new Error("indexer unreachable")];

    await round(arranged);

    expect(engine.status(DEPOSIT_ID)?.consecutiveFailures).toBe(1);
    expect(stageOf(arranged, DEPOSIT_ID)).toBe(RequestStage.Sent);
  });

  it.each([
    {
      stage: "sent",
      position: OPEN,
      waitMs: OPTIONS.stageTimeoutMs + 1,
      expected: RequestStage.Failed,
      error: /^timed out after \d+s in stage sent$/,
    },
    {
      stage: "queued",
      position: QUEUED,
      waitMs: OPTIONS.stageTimeoutMs + 1,
      expected: RequestStage.Failed,
      error: /^timed out after \d+s in stage queued$/,
    },
    {
      stage: "ready",
      position: { vault: VaultPosition.Open, attestation: AttestationPosition.Flushed },
      waitMs: 30 * OPTIONS.stageTimeoutMs,
      expected: RequestStage.Ready,
      error: /^$/,
    },
  ])(
    "after a long wait, a request in $stage ends up $expected",
    async ({ position, waitMs, expected, error }) => {
      const arranged = arrange();
      const { vault, engine, time } = arranged;
      vault.set(RequestKind.Deposit, DEPOSIT_ID, position);
      await engine.register(RequestKind.Deposit, DEPOSIT_ID);

      time.now += waitMs;
      await round(arranged);

      expect(stageOf(arranged, DEPOSIT_ID)).toBe(expected);
      expect(engine.status(DEPOSIT_ID)?.error ?? "").toMatch(error);
    },
  );

  it("does not hold a relayer that was down against the time it was down", async () => {
    const persistence = new MemoryPersistence();
    const before = arrange({}, persistence);
    before.vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await before.engine.register(RequestKind.Deposit, DEPOSIT_ID);

    const after = arrange({}, persistence, before.time.now + 10 * OPTIONS.stageTimeoutMs);
    after.vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await round(after);

    expect(stageOf(after, DEPOSIT_ID)).toBe(RequestStage.Sent);
  });

  it.each([
    {
      name: "before it was sent, fails",
      position: QUEUED,
      expected: RequestStage.Failed,
      error: /^the request left the vault before it was sent$/,
    },
    {
      name: "once it was sent, completes",
      position: OPEN,
      expected: RequestStage.Completed,
      error: /^$/,
    },
  ])("a request that leaves the vault $name", async ({ position, expected, error }) => {
    const arranged = arrange();
    const { vault, engine } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, position);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    await round(arranged);

    vault.remove(RequestKind.Deposit, DEPOSIT_ID);
    await roundsUntil(arranged, DEPOSIT_ID, expected);

    expect(engine.status(DEPOSIT_ID)?.error ?? "").toMatch(error);
  });
});

describe("restarting", () => {
  it("resumes from the persisted stage and signed transaction without asking the MPC again", async () => {
    const persistence = new MemoryPersistence();
    const first = arrange({}, persistence);
    const sweep = await signedSweep(0);
    first.vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await first.engine.register(RequestKind.Deposit, DEPOSIT_ID);
    first.mpc.signed.set(DEPOSIT_ID, sweep);
    await roundsUntil(first, DEPOSIT_ID, RequestStage.Signed);

    const second = arrange({}, persistence);
    second.vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    expect(second.engine.status(DEPOSIT_ID)).toMatchObject({
      stage: RequestStage.Signed,
      evmTxHash: sweep.hash,
    });
    await roundsUntil(second, DEPOSIT_ID, RequestStage.Broadcast);

    expect(second.mpc.signatureReads).toBe(0);
    expect(second.evm.broadcasts).toEqual([sweep.hash]);
  });

  it("re-derives the stage from the ledger when the relayer missed steps while it was down", async () => {
    const persistence = new MemoryPersistence();
    const first = arrange({}, persistence);
    first.vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await first.engine.register(RequestKind.Deposit, DEPOSIT_ID);

    const second = arrange({}, persistence);
    second.vault.set(RequestKind.Deposit, DEPOSIT_ID, {
      vault: VaultPosition.Open,
      attestation: AttestationPosition.Flushed,
    });
    await round(second);

    expect(stageOf(second, DEPOSIT_ID)).toBe(RequestStage.Ready);
  });
});

describe("requests nobody registered", () => {
  it("adopts a request found in the vault and carries it, and not when serving them is off", async () => {
    const served = arrange();
    served.vault.set(RequestKind.Withdraw, WITHDRAW_ID, OPEN);
    served.vault.waiting = {
      open: [{ kind: RequestKind.Withdraw, requestId: WITHDRAW_ID }],
      queuedInIndexes: [],
      queuedAttestationIds: [],
      unsent: [],
    };
    const ignored = arrange({ serveUnregistered: false });
    ignored.vault.set(RequestKind.Withdraw, WITHDRAW_ID, OPEN);
    ignored.vault.waiting = served.vault.waiting;

    await round(served);
    await round(ignored);

    expect(stageOf(served, WITHDRAW_ID)).toBe(RequestStage.Sent);
    expect(stageOf(ignored, WITHDRAW_ID)).toBeUndefined();
  });
});

describe("registering", () => {
  it("reports nothing for a request the vault does not hold", async () => {
    const { engine } = arrange();

    await expect(engine.register(RequestKind.Deposit, DEPOSIT_ID)).resolves.toBeUndefined();
    expect(engine.status(DEPOSIT_ID)).toBeUndefined();
  });

  it("starts at the stage the ledger proves, and a repeat changes nothing", async () => {
    const { engine, vault } = arrange();
    vault.set(RequestKind.Withdraw, WITHDRAW_ID, {
      vault: VaultPosition.Open,
      attestation: AttestationPosition.Queued,
    });

    const first = await engine.register(RequestKind.Withdraw, WITHDRAW_ID);
    const again = await engine.register(RequestKind.Withdraw, WITHDRAW_ID);

    expect(first?.stage).toBe(RequestStage.Attested);
    expect(again).toBe(first);
  });

  it("refuses an id the relayer tracks as the other kind", async () => {
    const { engine, vault } = arrange();
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);

    await expect(engine.register(RequestKind.Withdraw, DEPOSIT_ID)).rejects.toBeInstanceOf(
      RequestKindMismatchError,
    );
  });

  it("tracks a failed request afresh when the user registers it again", async () => {
    const arranged = arrange();
    const { vault, engine, time } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    time.now += OPTIONS.stageTimeoutMs + 1;
    await round(arranged);
    expect(stageOf(arranged, DEPOSIT_ID)).toBe(RequestStage.Failed);

    const again = await engine.register(RequestKind.Deposit, DEPOSIT_ID);

    expect(again?.stage).toBe(RequestStage.Sent);
    expect(again?.error).toBeUndefined();
  });

  it("forgets finished requests after the retention period", async () => {
    const arranged = arrange();
    const { vault, engine, time } = arranged;
    vault.set(RequestKind.Deposit, DEPOSIT_ID, OPEN);
    await engine.register(RequestKind.Deposit, DEPOSIT_ID);
    vault.remove(RequestKind.Deposit, DEPOSIT_ID);
    await roundsUntil(arranged, DEPOSIT_ID, RequestStage.Completed);

    time.now += OPTIONS.retentionMs + 1;
    await round(arranged);

    expect(engine.status(DEPOSIT_ID)).toBeUndefined();
  });
});

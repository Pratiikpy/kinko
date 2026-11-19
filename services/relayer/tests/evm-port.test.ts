// How the relayer reads a node's refusals, and the hard limits on the gas it sends.

import { describe, expect, it } from "vitest";

import { EthersEvmPort, type EvmNode, LimitedGasSponsor } from "../src/chain/evm-port.ts";
import { BroadcastOutcome, GasTopUpRefusedError } from "../src/ports.ts";
import { MemoryPersistence, StateStore } from "../src/store.ts";
import { signedSweep } from "./fakes.ts";

/** A node that refuses every broadcast with `failure`. */
const refusing = (failure: Error): EvmNode => ({
  getTransactionReceipt: () => Promise.resolve(null),
  getBalance: () => Promise.resolve(0n),
  broadcastTransaction: () => Promise.reject(failure),
});

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe("EthersEvmPort.broadcast", () => {
  it.each([
    {
      name: "geth's already known",
      error: new Error("already known"),
      outcome: BroadcastOutcome.AlreadyKnown,
    },
    {
      name: "an already imported transaction",
      error: new Error("Transaction already imported"),
      outcome: BroadcastOutcome.AlreadyKnown,
    },
    {
      name: "anvil's nonce too low",
      error: new Error("nonce too low: next nonce 5, tx nonce 4"),
      outcome: BroadcastOutcome.NonceConsumed,
    },
    {
      name: "ethers' NONCE_EXPIRED",
      error: coded("nonce has already been used", "NONCE_EXPIRED"),
      outcome: BroadcastOutcome.NonceConsumed,
    },
    {
      name: "ethers' INSUFFICIENT_FUNDS",
      error: coded("insufficient funds for intrinsic transaction cost", "INSUFFICIENT_FUNDS"),
      outcome: BroadcastOutcome.InsufficientFunds,
    },
    {
      name: "a node that says insufficient funds in words",
      error: new Error("Insufficient funds for gas * price + value"),
      outcome: BroadcastOutcome.InsufficientFunds,
    },
  ])("reads $name as $outcome", async ({ error, outcome }) => {
    const port = new EthersEvmPort(refusing(error));

    await expect(port.broadcast(await signedSweep(0))).resolves.toBe(outcome);
  });

  it("reports a transaction the node took as accepted", async () => {
    const port = new EthersEvmPort({
      ...refusing(new Error("unused")),
      broadcastTransaction: () => Promise.resolve(undefined as never),
    });

    await expect(port.broadcast(await signedSweep(0))).resolves.toBe(BroadcastOutcome.Accepted);
  });

  it("raises what it cannot classify, so the engine retries and counts it", async () => {
    const port = new EthersEvmPort(refusing(new Error("connect ECONNREFUSED 127.0.0.1:8545")));

    await expect(port.broadcast(await signedSweep(0))).rejects.toThrow("ECONNREFUSED");
  });
});

describe("LimitedGasSponsor", () => {
  const ADDRESS = `0x${"AB".repeat(20)}`;
  const OTHER = `0x${"CD".repeat(20)}`;
  const LIMITS = { maxPerAddressWei: 1_000n, maxPerDayWei: 1_500n };
  const DAY = 24 * 60 * 60 * 1000;

  function arrange() {
    const time = { now: 10 * DAY };
    const sent: { to: string; valueWei: bigint }[] = [];
    const store = new StateStore(new MemoryPersistence());
    const sponsor = new LimitedGasSponsor(
      LIMITS,
      (to, valueWei) => {
        sent.push({ to, valueWei });
        return Promise.resolve();
      },
      store,
      () => time.now,
    );
    return { time, sent, store, sponsor };
  }

  it("sends exactly the shortfall and records it against the address, whatever its case", async () => {
    const { sponsor, sent, store } = arrange();

    await expect(sponsor.topUp(ADDRESS, 400n)).resolves.toBe(400n);

    expect(sent).toEqual([{ to: ADDRESS, valueWei: 400n }]);
    expect(store.gasTopUps()).toEqual([
      { address: ADDRESS.toLowerCase(), amountWei: 400n, at: 10 * DAY },
    ]);
  });

  it("refuses an address past its own limit, counting what it already received", async () => {
    const { sponsor, sent } = arrange();
    await sponsor.topUp(ADDRESS, 600n);

    await expect(sponsor.topUp(ADDRESS.toLowerCase(), 401n)).rejects.toThrow(GasTopUpRefusedError);
    await expect(sponsor.topUp(ADDRESS, 401n)).rejects.toThrow(
      /would exceed its limit of 1000 wei/,
    );
    await expect(sponsor.topUp(ADDRESS, 400n)).resolves.toBe(400n);
    expect(sent.map((transfer) => transfer.valueWei)).toEqual([600n, 400n]);
  });

  it("refuses everyone past the daily limit, and forgets a day-old top-up", async () => {
    const { sponsor, time, sent } = arrange();
    await sponsor.topUp(ADDRESS, 900n);

    await expect(sponsor.topUp(OTHER, 700n)).rejects.toThrow(/daily limit of 1500 wei/);
    time.now += DAY;
    await expect(sponsor.topUp(OTHER, 700n)).resolves.toBe(700n);
    expect(sent).toHaveLength(2);
  });

  it("keeps its limits across a restart, since the ledger lives in the state file", async () => {
    const persistence = new MemoryPersistence();
    const first = new LimitedGasSponsor(
      LIMITS,
      () => Promise.resolve(),
      new StateStore(persistence),
      () => 10 * DAY,
    );
    await first.topUp(ADDRESS, 900n);

    const restarted = new LimitedGasSponsor(
      LIMITS,
      () => Promise.resolve(),
      new StateStore(persistence),
      () => 10 * DAY,
    );

    await expect(restarted.topUp(ADDRESS, 200n)).rejects.toThrow(GasTopUpRefusedError);
  });

  it("does not record a transfer that failed, so the failed amount stays available", async () => {
    const store = new StateStore(new MemoryPersistence());
    let failing = true;
    const sponsor = new LimitedGasSponsor(
      LIMITS,
      () => (failing ? Promise.reject(new Error("replacement underpriced")) : Promise.resolve()),
      store,
      () => 10 * DAY,
    );

    await expect(sponsor.topUp(ADDRESS, 800n)).rejects.toThrow("replacement underpriced");
    failing = false;

    await expect(sponsor.topUp(ADDRESS, 800n)).resolves.toBe(800n);
    expect(store.gasTopUps()).toHaveLength(1);
  });

  it("settles two top-ups asked at once one after the other, so together they cannot pass a limit", async () => {
    const { sponsor, sent } = arrange();

    const results = await Promise.allSettled([
      sponsor.topUp(ADDRESS, 700n),
      sponsor.topUp(ADDRESS, 700n),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(sent).toHaveLength(1);
  });
});

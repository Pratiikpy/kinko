// The sponsor must not become the leak.
//
// Its whole purpose is to let someone transact without exposing themselves, so what it writes
// down and what it tells a caller are a privacy boundary, not a logging preference. These cases
// hold that boundary: an upstream error from the proof server, the wallet or the node can quote
// the user's transaction back, and none of it may reach the caller or the default ledger.
import {
  SPONSOR_PROTOCOL_VERSION,
  type SponsorError,
  type TransactionDescription,
} from "@kinko/card";
import type { FinalizedTransaction } from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";

import {
  type SponsorLogEntry,
  type SponsorPolicy,
  SponsorService,
  type SponsorSigner,
} from "../src/index.ts";

const REGISTRY = "9be70aa1cafe0000000000000000000000000000000000000000000000033e8f7";

/** A realistic upstream error: it quotes a recipient address, a coin and raw transaction bytes. */
const LEAKY =
  "ProvingError: intent 1 output 0 to mn_addr_preview1t5vykkum7lma5mr2vug2wg90egqnw285h62znetds8flpu4434vq554wdz " +
  "coin 0x9f3ae1 value 230000 raw 0400deadbeefcafe0102030405060708";

const policy: SponsorPolicy = {
  contracts: [REGISTRY],
  circuits: ["settle_invoice"],
  maxFeeSpeck: 1_000n,
  budgetSpeck: 10_000n,
  rateLimit: { maxRequests: 100, windowMs: 60_000 },
  maxActionsPerTransaction: 1,
};

const description: TransactionDescription = {
  actions: [{ kind: "call", contractAddress: REGISTRY, entryPoint: "settle_invoice" }],
  circuits: ["settle_invoice"],
  contracts: [REGISTRY],
  hasAdministrativeAction: false,
};

const signerWith = (overrides: Partial<SponsorSigner>): SponsorSigner => ({
  address: "mn_addr_test1sponsor",
  dustSpeck: () => Promise.resolve(1_000_000n),
  estimateFee: () => Promise.resolve(100n),
  addDustFees: (tx) => Promise.resolve(tx),
  submit: () => Promise.resolve("tx-1"),
  ...overrides,
});

function build(overrides: Partial<SponsorSigner>, debug = false, overridePolicy = policy) {
  const logs: SponsorLogEntry[] = [];
  const service = new SponsorService({
    policy: overridePolicy,
    signer: signerWith(overrides),
    debug,
    describe: () => description,
    deserialize: () => ({}) as FinalizedTransaction,
    onLog: (entry) => logs.push(entry),
  });
  return { service, logs };
}

/** A request whose transaction differs each time it is read, as every real client's does. */
let made = 0;
const req = {
  protocol: SPONSOR_PROTOCOL_VERSION,
  get tx() {
    return `aabb${String((made += 1))}`;
  },
  caller: "web",
};
const caller = { id: "ip:203.0.113.9", label: "web" };

const refusal = (promise: Promise<unknown>): Promise<SponsorError> =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error as SponsorError,
  );

/** The whole log entry as text, so a test can assert that a secret appears nowhere in it. */
const everything = (entry: SponsorLogEntry | undefined): string => JSON.stringify(entry ?? {});

describe("upstream errors do not reach the caller", () => {
  it("a pricing failure is reported as a fixed sentence", async () => {
    const { service, logs } = build({
      estimateFee: () => Promise.reject(new Error(LEAKY)),
    });
    const error = await refusal(service.sponsor(req, caller));
    expect(error.code).toBe("UNREADABLE_TRANSACTION");
    expect(error.message).toBe("the transaction could not be priced.");
    expect(error.message).not.toContain("mn_addr_preview1");
    expect(everything(logs.at(-1))).not.toContain("mn_addr_preview1");
    expect(everything(logs.at(-1))).not.toContain("deadbeef");
  });

  it("a balancing failure is reported as a fixed sentence", async () => {
    const { service, logs } = build({
      addDustFees: () => Promise.reject(new Error(LEAKY)),
    });
    const error = await refusal(service.sponsor(req, caller));
    expect(error.message).toBe("the sponsored transaction could not be balanced for fees.");
    expect(everything(logs.at(-1))).not.toContain("mn_addr_preview1");
  });

  it("a submission failure is reported as a fixed sentence", async () => {
    const { service, logs } = build({
      submit: () => Promise.reject(new Error(LEAKY)),
    });
    const error = await refusal(service.sponsor(req, caller));
    expect(error.code).toBe("SUBMIT_FAILED");
    expect(error.message).not.toContain("mn_addr_preview1");
    expect(error.message).toContain("may still have reached the chain");
    expect(everything(logs.at(-1))).not.toContain("deadbeef");
  });

  it("an unreadable transaction is reported without echoing anything of it", async () => {
    const logs: SponsorLogEntry[] = [];
    const service = new SponsorService({
      policy,
      signer: signerWith({}),
      describe: () => description,
      deserialize: () => {
        throw new Error(LEAKY);
      },
      onLog: (entry) => logs.push(entry),
    });
    const error = await refusal(service.sponsor(req, caller));
    expect(error.message).not.toContain("mn_addr_preview1");
    expect(everything(logs.at(-1))).not.toContain("mn_addr_preview1");
  });
});

describe("the sponsor's own numbers are not published to callers", () => {
  it("does not tell a caller how much DUST it is holding", async () => {
    const quiet = build({
      dustSpeck: () => Promise.resolve(3n),
      estimateFee: () => Promise.resolve(500n),
    });
    const error = await refusal(quiet.service.sponsor(req, caller));
    expect(error.code).toBe("SPONSOR_OUT_OF_DUST");
    expect(error.message).toBe("this sponsor cannot cover the fee right now.");
    expect(quiet.logs.at(-1)?.detail).toBeUndefined();

    // The operator still sees it, in their own ledger, when they ask for it.
    const debugged = build(
      { dustSpeck: () => Promise.resolve(3n), estimateFee: () => Promise.resolve(500n) },
      true,
    );
    await refusal(debugged.service.sponsor(req, caller));
    expect(debugged.logs.at(-1)?.detail).toContain("holds 3 SPECK");
  });

  it("does not tell a caller how much budget is left", async () => {
    const tiny: SponsorPolicy = { ...policy, maxFeeSpeck: 100n, budgetSpeck: 100n };
    const { service } = build({ estimateFee: () => Promise.resolve(100n) }, false, tiny);
    await service.sponsor(req, caller);
    const error = await refusal(service.sponsor(req, caller));
    expect(error.message).toBe("this sponsor has no budget left to commit right now.");
    expect(error.message).not.toContain("100");
  });

  it("still names the fee and the cap, which are published policy", async () => {
    const { service } = build({ estimateFee: () => Promise.resolve(5_000n) });
    const error = await refusal(service.sponsor(req, caller));
    expect(error.code).toBe("FEE_TOO_LARGE");
    expect(error.message).toContain("5000");
    expect(error.message).toContain("1000");
  });
});

describe("the debug flag", () => {
  it("is off by default, so no upstream text reaches even the ledger", async () => {
    const { service, logs } = build({
      estimateFee: () => Promise.reject(new Error(LEAKY)),
    });
    await refusal(service.sponsor(req, caller));
    expect(logs.at(-1)?.detail).toBeUndefined();
  });

  it("when on, attaches bounded, single-line upstream text to the ledger only", async () => {
    const { service, logs } = build(
      {
        estimateFee: () => Promise.reject(new Error(`${"x".repeat(2_000)}\nsecond line`)),
      },
      true,
    );
    const error = await refusal(service.sponsor(req, caller));
    const detail = logs.at(-1)?.detail ?? "";
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThanOrEqual(500);
    expect(detail).not.toContain("\n");
    // And it is still not in what the caller was told.
    expect(error.message).toBe("the transaction could not be priced.");
  });
});

describe("what a successful entry carries", () => {
  it("logs the contract, the circuits, the fee and the tx id, and nothing from the transaction", async () => {
    const { service, logs } = build({});
    await service.sponsor(req, caller);
    const entry = logs.at(-1);
    expect(entry).toMatchObject({
      outcome: "paid",
      contractAddress: REGISTRY,
      circuits: ["settle_invoice"],
      feeSpeck: "100",
      txId: "tx-1",
      caller: "ip:203.0.113.9",
      label: "web",
    });
    // The transaction hex the caller sent is never written down.
    expect(everything(entry)).not.toContain("aabb");
    expect(entry?.detail).toBeUndefined();
  });
});

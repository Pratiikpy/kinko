// The persisted state: what survives a restart, what a damaged file does, and the file's
// atomic write.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilePersistence, MemoryPersistence, StateStore } from "../src/store.ts";
import { RequestKind, RequestStage, type TrackedRequest } from "../src/types.ts";
import { idOf } from "./fakes.ts";

const SIGNED: TrackedRequest = {
  kind: RequestKind.Deposit,
  requestId: idOf("a"),
  stage: RequestStage.Signed,
  createdAt: 1_000,
  updatedAt: 2_000,
  stageEnteredAt: 1_500,
  consecutiveFailures: 1,
  evmTxHash: `0x${"ab".repeat(32)}`,
  signedTransaction: "0x02f8",
  lastBroadcastAt: 1_800,
};

const FAILED: TrackedRequest = {
  kind: RequestKind.Withdraw,
  requestId: idOf("b"),
  stage: RequestStage.Failed,
  createdAt: 1_000,
  updatedAt: 3_000,
  stageEnteredAt: 3_000,
  consecutiveFailures: 0,
  error: "timed out after 1500s in stage sent",
};

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("restores every request and every gas top-up exactly after a restart", () => {
    const persistence = new MemoryPersistence();
    const store = new StateStore(persistence);
    store.put(SIGNED);
    store.put(FAILED);
    store.recordGasTopUp({
      address: `0x${"cd".repeat(20)}`,
      amountWei: 3n * 10n ** 18n,
      at: 5_000,
    });

    const restarted = new StateStore(persistence);

    expect(restarted.get(SIGNED.requestId)).toEqual(SIGNED);
    expect(restarted.get(FAILED.requestId)).toEqual(FAILED);
    expect(restarted.gasTopUps()).toEqual([
      { address: `0x${"cd".repeat(20)}`, amountWei: 3n * 10n ** 18n, at: 5_000 },
    ]);
  });

  it("lists only the requests that still need the relayer", () => {
    const store = new StateStore(new MemoryPersistence());
    store.put(SIGNED);
    store.put(FAILED);
    store.put({ ...SIGNED, requestId: idOf("c"), stage: RequestStage.Completed });

    expect(store.active().map((request) => request.requestId)).toEqual([SIGNED.requestId]);
  });

  it("drops finished requests older than the cutoff and keeps the rest", () => {
    const store = new StateStore(new MemoryPersistence());
    store.put(SIGNED);
    store.put(FAILED);

    expect(store.prune(2_500)).toBe(0);
    expect(store.prune(3_001)).toBe(1);
    expect(store.get(FAILED.requestId)).toBeUndefined();
    expect(store.get(SIGNED.requestId)).toEqual(SIGNED);
  });

  it("starts empty when no state was ever written", () => {
    expect(new StateStore(new MemoryPersistence()).active()).toEqual([]);
  });

  const VALID_REQUEST = { ...SIGNED };

  it.each([
    { name: "text that is not JSON", document: "{not json", error: /not JSON/ },
    {
      name: "another version's document",
      document: JSON.stringify({ version: 2, requests: [], gasTopUps: [] }),
      error: /version 1 state document/,
    },
    {
      name: "a document with no request list",
      document: JSON.stringify({ version: 1, gasTopUps: [] }),
      error: /"requests" and "gasTopUps" arrays/,
    },
    {
      name: "a request at a stage nobody defined",
      document: JSON.stringify({
        version: 1,
        requests: [{ ...VALID_REQUEST, stage: "teleported" }],
        gasTopUps: [],
      }),
      error: /unknown request stage "teleported"/,
    },
    {
      name: "a request of a kind nobody defined",
      document: JSON.stringify({
        version: 1,
        requests: [{ ...VALID_REQUEST, kind: "swap" }],
        gasTopUps: [],
      }),
      error: /unknown request kind "swap"/,
    },
    {
      name: "a request id that is not 64 lowercase hex characters",
      document: JSON.stringify({
        version: 1,
        requests: [{ ...VALID_REQUEST, requestId: "XYZ" }],
        gasTopUps: [],
      }),
      error: /malformed request id "XYZ"/,
    },
    {
      name: "a request whose timestamp is text",
      document: JSON.stringify({
        version: 1,
        requests: [{ ...VALID_REQUEST, createdAt: "yesterday" }],
        gasTopUps: [],
      }),
      error: /"createdAt" must be a number/,
    },
    {
      name: "a top-up whose amount is not a whole number",
      document: JSON.stringify({
        version: 1,
        requests: [],
        gasTopUps: [{ address: "0x", amountWei: "1.5", at: 1 }],
      }),
      error: /malformed gas amount "1.5"/,
    },
  ])("refuses $name rather than overwrite it", ({ document, error }) => {
    const persistence = new MemoryPersistence();
    persistence.write(document);

    expect(() => new StateStore(persistence)).toThrow(error);
    expect(persistence.read()).toBe(document);
  });
});

describe("FilePersistence", () => {
  const fileIn = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-state-"));
    DIRECTORIES.push(directory);
    return join(directory, "nested", "state.json");
  };

  it("reads nothing before the first write, and creates its directory on it", () => {
    const path = fileIn();
    const persistence = new FilePersistence(path);

    expect(persistence.read()).toBeUndefined();
    persistence.write('{"a":1}');

    expect(readFileSync(path, "utf8")).toBe('{"a":1}');
  });

  it("replaces the document without leaving a staging file behind", () => {
    const path = fileIn();
    const persistence = new FilePersistence(path);
    persistence.write("first");
    persistence.write("second");

    expect(persistence.read()).toBe("second");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("survives a store restart through a real file", () => {
    const path = fileIn();
    new StateStore(new FilePersistence(path)).put(SIGNED);

    expect(new StateStore(new FilePersistence(path)).get(SIGNED.requestId)).toEqual(SIGNED);
  });

  it("leaves a damaged file untouched when it refuses to load it", () => {
    const path = fileIn();
    new FilePersistence(path).write("placeholder");
    writeFileSync(path, "{broken");

    expect(() => new StateStore(new FilePersistence(path))).toThrow(/not JSON/);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });
});

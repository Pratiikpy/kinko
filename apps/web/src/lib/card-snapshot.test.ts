import { afterEach, describe, expect, it, vi } from "vitest";

import { latestBirth, snapshotFor } from "./card-snapshot.ts";

const BIRTH = "1996141-1a2b3c4d";

/**
 * A coin-free shielded snapshot, as the service publishes one.
 *
 * @param overrides - Fields to change.
 * @returns The snapshot, serialized.
 */
const snapshot = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: "v1",
    writtenBy: "v2",
    publicKeys: { coinPublicKey: "aa", encryptionPublicKey: "bb" },
    state: "00",
    protocolVersion: "2001100",
    offset: "1996141",
    networkId: "undeployed",
    coinHashes: {},
    ...overrides,
  });

const respond = (status: number, body: unknown) =>
  vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(body), { status })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("latestBirth", () => {
  it("is the birth the service names", async () => {
    const fetchMock = respond(200, { offset: "1996141", takenAt: 1, birth: BIRTH });
    vi.stubGlobal("fetch", fetchMock);
    expect(await latestBirth()).toBe(BIRTH);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v1\/card-snapshot\/latest$/);
  });

  it("is nothing when the service has none yet, is down, or sends something else", async () => {
    vi.stubGlobal("fetch", respond(404, { error: "none" }));
    expect(await latestBirth()).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("down"))),
    );
    expect(await latestBirth()).toBeUndefined();
    vi.stubGlobal("fetch", respond(200, { birth: "tomorrow" }));
    expect(await latestBirth()).toBeUndefined();
    vi.stubGlobal("fetch", respond(200, "text"));
    expect(await latestBirth()).toBeUndefined();
  });
});

describe("snapshotFor", () => {
  it("fetches the snapshot for a card's birth", async () => {
    const body = snapshot();
    const fetchMock = respond(200, { offset: "1996141", takenAt: 1, snapshot: body });
    vi.stubGlobal("fetch", fetchMock);
    expect(await snapshotFor(BIRTH)).toBe(body);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/v1/card-snapshot?birth=${BIRTH}`);
  });

  it("asks nothing for a card with no birth or a damaged one", async () => {
    const fetchMock = respond(200, { snapshot: snapshot() });
    vi.stubGlobal("fetch", fetchMock);
    expect(await snapshotFor(undefined)).toBeUndefined();
    expect(await snapshotFor("soon")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is nothing when the service has no snapshot for it, is down, or is slow", async () => {
    vi.stubGlobal("fetch", respond(404, { error: "another chain" }));
    expect(await snapshotFor(BIRTH)).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new DOMException("timed out", "TimeoutError"))),
    );
    expect(await snapshotFor(BIRTH)).toBeUndefined();
  });

  it("refuses a snapshot a card cannot start from, so the card replays the chain instead", async () => {
    const carries = snapshot({ coinHashes: { c: { nullifier: "n", commitment: "c" } } });
    vi.stubGlobal("fetch", respond(200, { snapshot: carries }));
    expect(await snapshotFor(BIRTH)).toBeUndefined();
    vi.stubGlobal("fetch", respond(200, { snapshot: snapshot({ networkId: "mainnet" }) }));
    expect(await snapshotFor(BIRTH)).toBeUndefined();
    vi.stubGlobal("fetch", respond(200, { snapshot: 7 }));
    expect(await snapshotFor(BIRTH)).toBeUndefined();
  });
});

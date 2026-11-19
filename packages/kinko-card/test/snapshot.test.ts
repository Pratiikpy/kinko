import { describe, expect, it } from "vitest";

import {
  cardSnapshot,
  publishedSnapshot,
  snapshotOffset,
  snapshotProblem,
} from "../src/snapshot.ts";

const ADDRESSES = {
  shielded: "mn_shield-addr_preprod1card",
  coinPublicKey: "11".repeat(32),
  encryptionPublicKey: "22".repeat(32),
};

/** A shielded snapshot as the wallet writes it, with a few fields set. */
const base = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: "v1",
    writtenBy: "v2",
    publicKeys: { coinPublicKey: "aa", encryptionPublicKey: "bb" },
    state: "6d69646e69676874",
    protocolVersion: "2001100",
    offset: "1987901",
    networkId: "preprod",
    coinHashes: {},
    ...overrides,
  });

describe("snapshotOffset", () => {
  it("reads the event the snapshot was taken at", () => {
    expect(snapshotOffset(base())).toBe(1_987_901n);
    expect(snapshotOffset(base({ offset: 42 }))).toBe(42n);
  });

  it("reads a wallet that applied no event as zero", () => {
    const { offset: _offset, ...without } = JSON.parse(base()) as Record<string, unknown>;
    expect(snapshotOffset(JSON.stringify(without))).toBe(0n);
  });

  it("refuses what is not a snapshot", () => {
    expect(() => snapshotOffset("nope")).toThrow(/not JSON/);
    expect(() => snapshotOffset("[]")).toThrow(/not a wallet snapshot/);
    expect(() => snapshotOffset(base({ offset: "abc" }))).toThrow(/not a number/);
    expect(() => snapshotOffset(base({ offset: { n: 1 } }))).toThrow(/not a number/);
  });
});

describe("snapshotProblem", () => {
  it("has none for a coin-free snapshot of this network", () => {
    expect(snapshotProblem(base(), "preprod")).toBeUndefined();
  });

  it("names a snapshot of another format, another network, or one that carries coins", () => {
    expect(snapshotProblem(base({ version: "v2" }), "preprod")).toMatch(/format/);
    expect(snapshotProblem(base(), "mainnet")).toMatch(/another network/);
    expect(
      snapshotProblem(base({ coinHashes: { c: { nullifier: "n", commitment: "c" } } }), "preprod"),
    ).toMatch(/carries coins/);
    expect(snapshotProblem(base({ coinHashes: undefined }), "preprod")).toMatch(/carries coins/);
    expect(snapshotProblem("nope", "preprod")).toMatch(/not JSON/);
  });

  it("refuses a snapshot that defers its coin check, which could carry coins the card would show", () => {
    expect(snapshotProblem(base({ coinHashesPending: true }), "preprod")).toMatch(/defers/);
    expect(snapshotProblem(base({ coinHashesPending: "yes" }), "preprod")).toMatch(/defers/);
    expect(snapshotProblem(base({ coinHashesPending: false }), "preprod")).toBeUndefined();
  });
});

describe("cardSnapshot", () => {
  it("gives the card's own keys to the tree and keeps everything else", () => {
    const converted = JSON.parse(cardSnapshot(base(), ADDRESSES, "preprod")) as Record<
      string,
      unknown
    >;
    expect(converted.publicKeys).toEqual({
      coinPublicKey: ADDRESSES.coinPublicKey,
      encryptionPublicKey: ADDRESSES.encryptionPublicKey,
    });
    expect(converted).toMatchObject({
      version: "v1",
      state: "6d69646e69676874",
      offset: "1987901",
      networkId: "preprod",
      coinHashes: {},
    });
  });

  it("keeps fields it does not know, so a newer wallet's snapshot still restores", () => {
    const converted = JSON.parse(
      cardSnapshot(base({ futureField: { a: 1 } }), ADDRESSES, "preprod"),
    ) as Record<string, unknown>;
    expect(converted.futureField).toEqual({ a: 1 });
  });

  it("does not change the snapshot it was given", () => {
    const original = base();
    cardSnapshot(original, ADDRESSES, "preprod");
    expect(original).toBe(base());
  });

  it("refuses a snapshot a card cannot start from", () => {
    expect(() => cardSnapshot(base(), ADDRESSES, "mainnet")).toThrow(/another network/);
    expect(() =>
      cardSnapshot(
        base({ coinHashes: { c: { nullifier: "n", commitment: "c" } } }),
        ADDRESSES,
        "preprod",
      ),
    ).toThrow(/carries coins/);
    expect(() => cardSnapshot("nope", ADDRESSES, "preprod")).toThrow(/not JSON/);
  });
});

describe("publishedSnapshot", () => {
  it("keeps the tree and drops the keys of the wallet that wrote it", () => {
    const published = JSON.parse(
      publishedSnapshot(base({ publicKeys: { coinPublicKey: "aa", encryptionPublicKey: "bb" } })),
    ) as { publicKeys: Record<string, string>; offset: unknown; version: unknown };
    expect(published.publicKeys).toEqual({
      coinPublicKey: "00".repeat(32),
      encryptionPublicKey: "00".repeat(32),
    });
    expect(published.version).toBe("v1");
    expect(JSON.stringify(published)).not.toContain('"aa"');
  });

  it("is still a snapshot a card can start from", () => {
    expect(snapshotProblem(publishedSnapshot(base()), "preprod")).toBeUndefined();
  });
});

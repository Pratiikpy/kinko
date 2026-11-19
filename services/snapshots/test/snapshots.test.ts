import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadBootstrap } from "../src/bootstrap.ts";
import { chainIdentity } from "../src/chain.ts";
import { readConfig } from "../src/config.ts";
import { Keeper } from "../src/keeper.ts";
import { createSnapshotServer } from "../src/server.ts";
import { type Retention, SnapshotStore } from "../src/store.ts";

const NETWORK = "preprod";
const HOUR = 60 * 60 * 1000;

/** A shielded snapshot as the wallet writes it, with the fields these tests care about. */
const snapshot = (offset: number, coins: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: "v1",
    writtenBy: "v2",
    publicKeys: { coinPublicKey: "aa", encryptionPublicKey: "bb" },
    state: "00",
    protocolVersion: "2001100",
    offset: String(offset),
    networkId: NETWORK,
    coinHashes: coins,
  });

const entry = (offset: number, takenAt: number) => ({
  offset: BigInt(offset),
  takenAt,
  snapshot: snapshot(offset),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kinko-snapshots-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SnapshotStore", () => {
  it("serves the newest snapshot at or before an event", () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    store.add(entry(100, 1));
    store.add(entry(200, 2));
    store.add(entry(300, 3));
    expect(store.pick(250n)?.offset).toBe(200n);
    expect(store.pick(200n)?.offset).toBe(200n);
    expect(store.pick(99n)).toBeUndefined();
    expect(store.pick(10_000n)?.offset).toBe(300n);
    expect(store.latest()?.offset).toBe(300n);
  });

  it("ignores a snapshot that has not moved past the newest", () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    expect(store.add(entry(100, 1))).toBe(true);
    expect(store.add(entry(100, 2))).toBe(false);
    expect(store.add(entry(90, 3))).toBe(false);
    expect(store.size).toBe(1);
  });

  it("keeps what it published across a restart", () => {
    const path = join(dir, "s.json");
    const first = SnapshotStore.open(path, "chain-a");
    first.add(entry(100, 1));
    first.add(entry(200, 2));
    const second = SnapshotStore.open(path, "chain-a");
    expect(second.size).toBe(2);
    expect(second.pick(150n)?.offset).toBe(100n);
    expect(second.latest()?.snapshot).toBe(snapshot(200));
  });

  it("discards a file written for another chain", () => {
    const path = join(dir, "s.json");
    SnapshotStore.open(path, "chain-a").add(entry(100, 1));
    const reset = SnapshotStore.open(path, "chain-b");
    expect(reset.size).toBe(0);
    expect(reset.pick(1_000_000n)).toBeUndefined();
  });

  it("starts empty from a file it cannot read", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, "{not json");
    expect(SnapshotStore.open(path, "chain-a").size).toBe(0);
  });

  it("writes the chain it was taken from into the file", () => {
    const path = join(dir, "s.json");
    SnapshotStore.open(path, "chain-a").add(entry(100, 1));
    expect((JSON.parse(readFileSync(path, "utf8")) as { chain: string }).chain).toBe("chain-a");
  });

  it("keeps recent snapshots densely and older ones one an hour, the latest of each", () => {
    const retention: Retention = { recent: 3, bucketMs: HOUR, maxAgeMs: 10 * HOUR };
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a", retention);
    // Four snapshots an hour, for five hours: twenty in all.
    for (let i = 0; i < 20; i++) store.add(entry(1_000 + i, i * (HOUR / 4)));
    // The last three are recent; before them, the latest snapshot of each hour: the first four
    // hours' last ones, and the fifth hour's only one so far.
    expect(store.size).toBe(3 + 5);
    expect(store.latest()?.offset).toBe(1_019n);
    const hourly = [1_003n, 1_007n, 1_011n, 1_015n];
    for (const offset of hourly) expect(store.pick(offset)?.offset).toBe(offset);
  });

  it("drops snapshots older than the maximum age but never the newest", () => {
    const retention: Retention = { recent: 1, bucketMs: HOUR, maxAgeMs: 2 * HOUR };
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a", retention);
    store.add(entry(100, 0));
    store.add(entry(200, 1 * HOUR));
    store.add(entry(300, 5 * HOUR));
    expect(store.pick(150n)).toBeUndefined();
    expect(store.pick(250n)).toBeUndefined();
    expect(store.latest()?.offset).toBe(300n);
  });
});

describe("Keeper", () => {
  it("publishes a snapshot, and only once the wallet has moved on", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    let offset = 100;
    const logs: string[] = [];
    const keeper = new Keeper({
      store,
      source: { snapshot: () => Promise.resolve(snapshot(offset)) },
      networkId: NETWORK,
      intervalMs: 1_000,
      now: () => 5,
      log: (l) => logs.push(l),
    });
    expect(await keeper.tick()).toBe(true);
    expect(await keeper.tick()).toBe(false);
    offset = 150;
    expect(await keeper.tick()).toBe(true);
    expect(store.latest()?.offset).toBe(150n);
    expect(logs.filter((l) => l.startsWith("published"))).toHaveLength(2);
  });

  it("tries again every few seconds until the first snapshot, then at its interval", async () => {
    vi.useFakeTimers();
    try {
      const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
      let offset = 0;
      let calls = 0;
      const keeper = new Keeper({
        store,
        source: {
          snapshot: () => {
            calls += 1;
            return Promise.resolve(snapshot(offset));
          },
        },
        networkId: NETWORK,
        intervalMs: 60_000,
      });
      keeper.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(2);
      offset = 10;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.latest()?.offset).toBe(10n);
      // Published: the next try waits the whole interval.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(4);
      keeper.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes nothing until the wallet has applied an event", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    const keeper = new Keeper({
      store,
      source: { snapshot: () => Promise.resolve(snapshot(0)) },
      networkId: NETWORK,
      intervalMs: 1_000,
    });
    expect(await keeper.tick()).toBe(false);
    expect(store.size).toBe(0);
  });

  it("refuses to publish a snapshot that carries a coin", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    const logs: string[] = [];
    const keeper = new Keeper({
      store,
      source: { snapshot: () => Promise.resolve(snapshot(100, { c: { nullifier: "n" } })) },
      networkId: NETWORK,
      intervalMs: 1_000,
      log: (l) => logs.push(l),
    });
    expect(await keeper.tick()).toBe(false);
    expect(store.size).toBe(0);
    expect(logs.join("\n")).toMatch(/REFUSED.*carries coins/);
  });

  it("refuses a snapshot of another network", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    const keeper = new Keeper({
      store,
      source: { snapshot: () => Promise.resolve(snapshot(100)) },
      networkId: "mainnet",
      intervalMs: 1_000,
    });
    expect(await keeper.tick()).toBe(false);
    expect(store.size).toBe(0);
  });

  it("survives a wallet that cannot snapshot yet and tries again", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    let fail = true;
    const logs: string[] = [];
    const keeper = new Keeper({
      store,
      source: {
        snapshot: () =>
          fail ? Promise.reject(new Error("not ready")) : Promise.resolve(snapshot(7)),
      },
      networkId: NETWORK,
      intervalMs: 1_000,
      log: (l) => logs.push(l),
    });
    expect(await keeper.tick()).toBe(false);
    expect(logs.join("\n")).toContain("snapshot failed: not ready");
    fail = false;
    expect(await keeper.tick()).toBe(true);
  });

  it("does not take two snapshots at once", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), "chain-a");
    let calls = 0;
    let release: () => void = () => undefined;
    const keeper = new Keeper({
      store,
      source: {
        snapshot: () => {
          calls += 1;
          return new Promise<string>((resolve) => {
            release = () => {
              resolve(snapshot(10));
            };
          });
        },
      },
      networkId: NETWORK,
      intervalMs: 1_000,
    });
    const first = keeper.tick();
    expect(await keeper.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
  });
});

const CHAIN = "abcdef0123456789";

describe("the server", () => {
  async function serve(
    store: SnapshotStore,
    extra: { rateMax?: number; trustProxyHops?: number } = {},
  ) {
    const server = createSnapshotServer({ store, networkId: NETWORK, ...extra });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return {
      base,
      close: () =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    };
  }

  it("answers a card being made with the newest event, and one being opened with its snapshot", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), CHAIN);
    store.add(entry(100, 1));
    store.add(entry(200, 2));
    const { base, close } = await serve(store);
    try {
      const latest = await fetch(`${base}/v1/card-snapshot/latest`);
      expect(latest.status).toBe(200);
      expect(await latest.json()).toEqual({ offset: "200", takenAt: 2, birth: "200-abcdef01" });

      const found = await fetch(`${base}/v1/card-snapshot?birth=150-abcdef01`);
      expect(found.status).toBe(200);
      const body = (await found.json()) as { offset: string; snapshot: string };
      expect(body.offset).toBe("100");
      // The tree is served; the keys of the wallet that wrote it are not.
      expect(JSON.parse(body.snapshot)).toEqual({
        ...(JSON.parse(snapshot(100)) as object),
        publicKeys: { coinPublicKey: "00".repeat(32), encryptionPublicKey: "00".repeat(32) },
      });
    } finally {
      await close();
    }
  });

  it("does not start a card from another chain's tree", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), CHAIN);
    store.add(entry(100, 1));
    const { base, close } = await serve(store);
    try {
      const other = await fetch(`${base}/v1/card-snapshot?birth=150-12345678`);
      expect(other.status).toBe(404);
      expect(((await other.json()) as { error: string }).error).toMatch(/another chain/);
    } finally {
      await close();
    }
  });

  it("says plainly when there is nothing yet", async () => {
    const { base, close } = await serve(SnapshotStore.open(join(dir, "s.json"), CHAIN));
    try {
      expect((await fetch(`${base}/v1/card-snapshot/latest`)).status).toBe(404);
      expect((await fetch(`${base}/v1/card-snapshot?birth=5-abcdef01`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("refuses a bad event id, a wrong method and an unknown path", async () => {
    const { base, close } = await serve(SnapshotStore.open(join(dir, "s.json"), CHAIN));
    try {
      const bad = [
        "",
        "?birth=",
        "?birth=12345",
        "?birth=-1-abcdef01",
        "?birth=1e3-abcdef01",
        "?birth=5-ABCDEF01",
        "?birth=5-abcdef0",
        "?birth=1234567890123456789012-abcdef01",
      ];
      const statuses = await Promise.all(
        bad.map(async (q) => (await fetch(`${base}/v1/card-snapshot${q}`)).status),
      );
      expect(statuses).toEqual(bad.map(() => 400));
      expect(
        (await fetch(`${base}/v1/card-snapshot?birth=1-abcdef01`, { method: "POST" })).status,
      ).toBe(405);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("reports how far the published tree has got", async () => {
    const store = SnapshotStore.open(join(dir, "s.json"), CHAIN);
    store.add(entry(100, Date.now() - 5_000));
    const { base, close } = await serve(store);
    try {
      const health = (await (await fetch(`${base}/healthz`)).json()) as {
        ok: boolean;
        network: string;
        chain: string;
        snapshots: number;
        latest: { offset: string; ageSeconds: number };
      };
      expect(health).toMatchObject({ ok: true, network: NETWORK, chain: CHAIN, snapshots: 1 });
      expect(health.latest.offset).toBe("100");
      expect(health.latest.ageSeconds).toBeGreaterThanOrEqual(4);
    } finally {
      await close();
    }
  });

  it("allows the app's origin and answers a preflight", async () => {
    const { base, close } = await serve(SnapshotStore.open(join(dir, "s.json"), CHAIN));
    try {
      const pre = await fetch(`${base}/v1/card-snapshot/latest`, {
        method: "OPTIONS",
        headers: { Origin: "https://kinko.example" },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await close();
    }
  });

  it("counts a proxied client by the address its own proxy saw, never by what the caller sent", async () => {
    const { base, close } = await serve(SnapshotStore.open(join(dir, "s.json"), CHAIN), {
      rateMax: 2,
      trustProxyHops: 1,
    });
    const ask = async (forwarded: string): Promise<number> =>
      (await fetch(`${base}/healthz`, { headers: { "X-Forwarded-For": forwarded } })).status;
    try {
      // One real client behind the proxy, varying what it claims on the left: one bucket.
      expect([await ask("a, 9.9.9.9"), await ask("b, 9.9.9.9"), await ask("c, 9.9.9.9")]).toEqual([
        200, 200, 429,
      ]);
      // Another real client is not held back by it.
      expect(await ask("8.8.8.8")).toBe(200);
    } finally {
      await close();
    }
  });

  it("limits a client that asks too often", async () => {
    const { base, close } = await serve(SnapshotStore.open(join(dir, "s.json"), CHAIN), {
      rateMax: 3,
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(`${base}/healthz`)).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await close();
    }
  });
});

describe("chainIdentity", () => {
  const answer =
    (body: unknown, status = 200): typeof fetch =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("reads the first block's hash", async () => {
    expect(await chainIdentity("http://x", answer({ data: { block: { hash: "abc123" } } }))).toBe(
      "abc123",
    );
  });

  it("fails when the indexer errors or has no first block", async () => {
    await expect(chainIdentity("http://x", answer({}, 402))).rejects.toThrow(/402/);
    await expect(chainIdentity("http://x", answer({ data: { block: null } }))).rejects.toThrow(
      /no first block/,
    );
    await expect(
      chainIdentity("http://x", answer({ errors: [{ message: "boom" }] })),
    ).rejects.toThrow(/boom/);
  });
});

describe("readConfig", () => {
  it("defaults to local, public, read-only settings", () => {
    const config = readConfig({}, "/repo", "preprod");
    expect(config).toMatchObject({
      port: 3400,
      host: "127.0.0.1",
      allowedOrigins: ["*"],
      intervalMs: 120_000,
      bootstrapPath: undefined,
    });
    expect(config.storePath).toBe(join("/repo", ".secrets", "preprod", "card-snapshots.json"));
  });

  it("reads overrides and refuses a bad interval", () => {
    expect(
      readConfig(
        { SNAPSHOTS_PORT: "4400", SNAPSHOTS_ALLOWED_ORIGINS: "https://a, https://b" },
        "/r",
        "n",
      ),
    ).toMatchObject({ port: 4400, allowedOrigins: ["https://a", "https://b"] });
    expect(() => readConfig({ SNAPSHOTS_INTERVAL_MS: "0" }, "/r", "n")).toThrow(/positive/);
    expect(() => readConfig({ SNAPSHOTS_INTERVAL_MS: "1.5" }, "/r", "n")).toThrow(/positive/);
    expect(readConfig({}, "/r", "n").trustProxyHops).toBe(0);
    expect(readConfig({ SNAPSHOTS_TRUST_PROXY_HOPS: "1" }, "/r", "n").trustProxyHops).toBe(1);
    expect(() => readConfig({ SNAPSHOTS_TRUST_PROXY_HOPS: "-1" }, "/r", "n")).toThrow(/whole/);
  });
});

describe("loadBootstrap", () => {
  it("reads the shielded snapshot out of a wallet cache", () => {
    const path = join(dir, "cache.json");
    writeFileSync(
      path,
      JSON.stringify({
        savedAt: "2026-11-18T06:08:55.177Z",
        snapshots: { shielded: snapshot(1_987_901) },
      }),
    );
    const loaded = loadBootstrap(path, NETWORK);
    expect(loaded).toMatchObject({
      offset: 1_987_901n,
      takenAt: Date.parse("2026-11-18T06:08:55.177Z"),
    });
    // What is kept is the tree, with the keys of the wallet it came from swapped out.
    expect(JSON.parse(loaded.snapshot)).toEqual({
      ...(JSON.parse(snapshot(1_987_901)) as object),
      publicKeys: { coinPublicKey: "00".repeat(32), encryptionPublicKey: "00".repeat(32) },
    });
  });

  it("reads a bare snapshot, dated by its file", () => {
    const path = join(dir, "snap.json");
    writeFileSync(path, snapshot(42));
    const loaded = loadBootstrap(path, NETWORK);
    expect(loaded.offset).toBe(42n);
    expect(loaded.takenAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses a snapshot that carries a coin, is for another network, or is not one", () => {
    const withCoin = join(dir, "coin.json");
    writeFileSync(withCoin, snapshot(5, { c: { nullifier: "n" } }));
    expect(() => loadBootstrap(withCoin, NETWORK)).toThrow(/carries coins/);
    const plain = join(dir, "plain.json");
    writeFileSync(plain, snapshot(5));
    expect(() => loadBootstrap(plain, "mainnet")).toThrow(/another network/);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, JSON.stringify({ hello: "world" }));
    expect(() => loadBootstrap(junk, NETWORK)).toThrow();
    expect(() => loadBootstrap(join(dir, "missing.json"), NETWORK)).toThrow(/Cannot read/);
  });
});

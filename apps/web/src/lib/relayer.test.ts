import { describe, expect, it } from "vitest";

import {
  awaitsUser,
  coverageBps,
  createRelayerClient,
  isTerminal,
  kusdInCirculation,
  parseBacking,
  parseHealth,
  parseRequestStatus,
  PROGRESS_STAGES,
  RelayerError,
  remainingSeconds,
  STAGE_COPY,
  STAGES,
} from "./relayer.ts";

const VAULT = "ab".repeat(32);
const EVM = "0x" + "12".repeat(20);
const USDC = "0x" + "34".repeat(20);
const ID = "cd".repeat(32);

const health = {
  ok: true,
  network: "undeployed",
  vaultContractAddress: VAULT,
  evmVaultAddress: EVM,
  usdcAddress: USDC,
  evmChainId: 11155111,
};
const backing = {
  usdcInVault: "150000000",
  kusdMinted: "160000000",
  kusdBurned: "20000000",
  vaultContractAddress: VAULT,
  evmVaultAddress: EVM,
  usdcAddress: USDC,
  ethereumBlock: 7_000_123,
  midnightBlock: 88_421,
  updatedAt: "2026-11-15T10:00:00Z",
};

type Handler = (
  url: string,
  init?: RequestInit,
) => { status: number; body?: unknown } | Promise<never>;

function fakeFetch(handler: Handler): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = await handler(url, init);
    return new Response(r.body === undefined ? "not json" : JSON.stringify(r.body), {
      status: r.status,
    });
  };
}

describe("response validation", () => {
  it("accepts a healthy relayer and normalises the vault address", () => {
    expect(
      parseHealth({ ...health, vaultContractAddress: `0x${VAULT.toUpperCase()}` })
        .vaultContractAddress,
    ).toBe(VAULT);
  });

  it("refuses an unhealthy or malformed health answer", () => {
    expect(() => parseHealth({ ...health, ok: false })).toThrow(RelayerError);
    expect(() => parseHealth({ ...health, evmVaultAddress: "0x12" })).toThrow(/evmVaultAddress/);
    expect(() => parseHealth({ ...health, evmChainId: -1 })).toThrow(/evmChainId/);
    expect(() => parseHealth(null)).toThrow(RelayerError);
  });

  it("reads every stage and refuses unknown ones", () => {
    for (const stage of STAGES) {
      expect(parseRequestStatus({ kind: "deposit", stage, updatedAt: "t" }).stage).toBe(stage);
    }
    expect(() =>
      parseRequestStatus({ kind: "deposit", stage: "teleported", updatedAt: "t" }),
    ).toThrow(/unknown stage/);
    expect(() => parseRequestStatus({ kind: "swap", stage: "queued", updatedAt: "t" })).toThrow(
      /kind/,
    );
  });

  it("keeps an Ethereum transaction hash and an error only when well formed", () => {
    const s = parseRequestStatus({
      kind: "withdraw",
      stage: "failed",
      evmTxHash: "0x" + "ef".repeat(32),
      error: "nonce taken",
      updatedAt: "t",
    });
    expect(s.evmTxHash).toBe("0x" + "ef".repeat(32));
    expect(s.error).toBe("nonce taken");
    expect(() =>
      parseRequestStatus({
        kind: "withdraw",
        stage: "broadcast",
        evmTxHash: "0x12",
        updatedAt: "t",
      }),
    ).toThrow(/evmTxHash/);
    expect(
      parseRequestStatus({
        kind: "withdraw",
        stage: "queued",
        evmTxHash: null,
        error: null,
        updatedAt: "t",
      }).evmTxHash,
    ).toBeUndefined();
  });

  it("reads backing figures as bigints and refuses non-integer amounts", () => {
    const b = parseBacking(backing);
    expect(b.usdcInVault).toBe(150_000_000n);
    expect(kusdInCirculation(b)).toBe(140_000_000n);
    expect(() => parseBacking({ ...backing, kusdMinted: "1.5" })).toThrow(/kusdMinted/);
    expect(() => parseBacking({ ...backing, usdcInVault: 150 })).toThrow(/usdcInVault/);
  });
});

describe("coverage", () => {
  it("is in basis points of circulation", () => {
    expect(coverageBps({ usdcInVault: 140n, kusdMinted: 160n, kusdBurned: 20n })).toBe(10_000n);
    expect(coverageBps({ usdcInVault: 70n, kusdMinted: 140n, kusdBurned: 0n })).toBe(5_000n);
  });

  it("is undefined when nothing circulates", () => {
    expect(coverageBps({ usdcInVault: 10n, kusdMinted: 5n, kusdBurned: 5n })).toBeNull();
  });
});

describe("client", () => {
  it("calls the documented endpoints", async () => {
    const seen: string[] = [];
    const c = createRelayerClient(
      "http://relayer/",
      fakeFetch((url, init) => {
        seen.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) return { status: 200, body: health };
        if (url.includes("/deposit-address")) return { status: 200, body: { evmAddress: EVM } };
        if (url.endsWith("/requests"))
          return {
            status: 202,
            body: {
              requestId: (
                JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
                  requestId?: string;
                }
              ).requestId,
            },
          };
        if (url.includes("/requests/"))
          return { status: 200, body: { kind: "deposit", stage: "signed", updatedAt: "t" } };
        return { status: 200, body: backing };
      }),
    );
    expect((await c.health()).network).toBe("undeployed");
    expect(await c.depositAddress(`0x${ID}`)).toBe(EVM);
    expect(await c.register("deposit", ID.toUpperCase())).toBe(ID);
    expect((await c.status(ID)).stage).toBe("signed");
    expect((await c.backing()).midnightBlock).toBe(88_421);
    expect(seen).toEqual([
      "GET http://relayer/health",
      `GET http://relayer/deposit-address?commitment=${ID}`,
      "POST http://relayer/requests",
      `GET http://relayer/requests/${ID}`,
      "GET http://relayer/backing",
    ]);
  });

  it("refuses malformed ids before any request leaves the page", async () => {
    let called = false;
    const c = createRelayerClient(
      "http://relayer",
      fakeFetch(() => ((called = true), { status: 200, body: {} })),
    );
    await expect(c.status("1234")).rejects.toThrow(/32 bytes/);
    await expect(c.depositAddress("zz".repeat(32))).rejects.toThrow(/32 bytes/);
    expect(called).toBe(false);
  });

  it("reports an unreachable relayer, a missing request and a refusal distinctly", async () => {
    const down = createRelayerClient("http://relayer", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    await expect(down.health()).rejects.toMatchObject({ kind: "unreachable" });

    const missing = createRelayerClient(
      "http://relayer",
      fakeFetch(() => ({ status: 404, body: { error: "unknown" } })),
    );
    await expect(missing.status(ID)).rejects.toMatchObject({ kind: "not-found", status: 404 });

    const refused = createRelayerClient(
      "http://relayer",
      fakeFetch(() => ({ status: 400, body: { error: "requestId is not on the vault" } })),
    );
    await expect(refused.register("withdraw", ID)).rejects.toThrow(/HTTP 400.*not on the vault/);

    const garbled = createRelayerClient(
      "http://relayer",
      fakeFetch(() => ({ status: 500 })),
    );
    await expect(garbled.backing()).rejects.toMatchObject({ kind: "http", status: 500 });
  });

  it("refuses a confirmation of a different request", async () => {
    const c = createRelayerClient(
      "http://relayer",
      fakeFetch(() => ({ status: 202, body: { requestId: "ee".repeat(32) } })),
    );
    await expect(c.register("deposit", ID)).rejects.toThrow(/different request/);
  });

  it("gives up on a relayer that never answers", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const c = createRelayerClient("http://relayer", hang, 50);
    await expect(c.health()).rejects.toMatchObject({ kind: "unreachable" });
  });
});

describe("stage copy", () => {
  it("names every stage for both kinds", () => {
    for (const kind of ["deposit", "withdraw"] as const) {
      for (const stage of STAGES) {
        expect(STAGE_COPY[kind][stage].title.length).toBeGreaterThan(0);
        expect(STAGE_COPY[kind][stage].detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("estimates less time left as a request advances, and none when it ends", () => {
    const left = PROGRESS_STAGES.map((s) => remainingSeconds("deposit", s));
    for (let i = 1; i < left.length; i++)
      expect(left[i]).toBeLessThanOrEqual(left[i - 1] ?? Infinity);
    expect(remainingSeconds("withdraw", "completed")).toBe(0);
    expect(remainingSeconds("withdraw", "failed")).toBe(0);
  });

  it("knows where the person must act and where polling ends", () => {
    expect(awaitsUser("ready")).toBe(true);
    expect(awaitsUser("signed")).toBe(false);
    expect(isTerminal("completed") && isTerminal("failed")).toBe(true);
    expect(isTerminal("ready")).toBe(false);
  });
});

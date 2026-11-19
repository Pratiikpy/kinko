import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";
import { describe, expect, it, vi } from "vitest";

import { sponsorFeePayer, walletFeePayer } from "../src/fees.ts";
import { SponsorError } from "../src/sponsor-protocol.ts";

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sponsorFeePayer", () => {
  it("posts the bound transaction and reports the fee", async () => {
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        answer(200, { protocol: 1, txId: "ab", feeSpeck: "42", circuits: ["settle_invoice"] }),
      ),
    );
    const payer = sponsorFeePayer({
      endpoint: "http://sponsor.test/",
      fetchImpl: fetchImpl as never,
    });
    await expect(payer.pay("00ff", "settle_invoice")).resolves.toEqual({
      paidBy: "sponsor",
      feeSpeck: "42",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://sponsor.test/v1/sponsor");
    expect(JSON.parse(init?.body as string)).toEqual({
      protocol: 1,
      tx: "00ff",
      circuit: "settle_invoice",
    });
  });

  it("keeps an endpoint that already names the path", async () => {
    const fetchImpl = vi.fn((_url: string) => Promise.resolve(answer(200, { txId: "ab" })));
    await sponsorFeePayer({ endpoint: "http://s/v1/sponsor", fetchImpl: fetchImpl as never }).pay(
      "00",
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://s/v1/sponsor");
  });

  it("surfaces a refusal with its code and retry time", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        answer(429, {
          protocol: 1,
          error: "slow down",
          code: "RATE_LIMITED",
          retryAfterSeconds: 9,
        }),
      );
    const err = await sponsorFeePayer({ endpoint: "http://s", fetchImpl: fetchImpl })
      .pay("00")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SponsorError);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 9, message: "slow down" });
  });

  it("reports an unreachable sponsor and a non-JSON answer as transport failures", async () => {
    const down = sponsorFeePayer({
      endpoint: "http://s",
      fetchImpl: () => Promise.reject(new Error("x")),
    });
    await expect(down.pay("00")).rejects.toMatchObject({ code: "TRANSPORT" });
    const html = sponsorFeePayer({
      endpoint: "http://s",
      fetchImpl: () => Promise.resolve(new Response("<html>", { status: 502 })),
    });
    await expect(html.pay("00")).rejects.toMatchObject({ code: "TRANSPORT", message: /502/ });
  });
});

describe("walletFeePayer", () => {
  it("has the wallet add its fee to the sealed transaction, then submits what came back", async () => {
    const balanceSealedTransaction = vi.fn(() => Promise.resolve({ tx: "beef" }));
    const submitTransaction = vi.fn(() => Promise.resolve());
    const api = { balanceSealedTransaction, submitTransaction } as unknown as ConnectedAPI;
    await expect(walletFeePayer(api).pay("00ff")).resolves.toEqual({ paidBy: "wallet" });
    expect(balanceSealedTransaction).toHaveBeenCalledWith("00ff", { payFees: true });
    expect(submitTransaction).toHaveBeenCalledWith("beef");
  });
});

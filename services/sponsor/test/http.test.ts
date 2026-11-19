// The server, over a real socket, with a fake wallet behind it.
//
// Everything else in this workspace tests the decision; this tests the wiring — the routes, the
// status codes a client branches on, the API-key check, and the fact that the rate-limit bucket
// comes from the connection rather than from the body.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  SPONSOR_PATH,
  SPONSOR_PROTOCOL_VERSION,
  SponsorError,
  sponsorFeePayer,
  type TransactionDescription,
} from "@kinko/card";
import type { FinalizedTransaction } from "@midnightntwrk/ledger-v9";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSponsorServer,
  type SponsorPolicy,
  SponsorService,
  type SponsorSigner,
} from "../src/index.ts";

const REGISTRY = "9be70aa1cafe0000000000000000000000000000000000000000000000033e8f7";

const policy: SponsorPolicy = {
  contracts: [REGISTRY],
  circuits: ["settle_invoice"],
  maxFeeSpeck: 1_000n,
  budgetSpeck: 10_000n,
  rateLimit: { maxRequests: 2, windowMs: 60_000 },
  maxActionsPerTransaction: 1,
};

const description: TransactionDescription = {
  actions: [{ kind: "call", contractAddress: REGISTRY, entryPoint: "settle_invoice" }],
  circuits: ["settle_invoice"],
  contracts: [REGISTRY],
  hasAdministrativeAction: false,
};

let submitted = 0;
const signer: SponsorSigner = {
  address: "mn_addr_test1sponsor",
  dustSpeck: () => Promise.resolve(1_000_000n),
  estimateFee: () => Promise.resolve(100n),
  addDustFees: (tx) => Promise.resolve(tx),
  submit: () => Promise.resolve(`tx-${String((submitted += 1))}`),
};

/** Posts to the sponsor as a client would, presenting an API key when given one. */
async function requestSponsorship(
  tx: string,
  options: { endpoint: string; circuit?: string; apiKey?: string },
): Promise<{ txId: string; circuits: string[] }> {
  const res = await fetch(`${options.endpoint}${SPONSOR_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({ protocol: SPONSOR_PROTOCOL_VERSION, tx, circuit: options.circuit }),
  });
  const body = (await res.json()) as {
    error?: string;
    code?: string;
    retryAfterSeconds?: number;
    txId: string;
    circuits: string[];
  };
  if (!res.ok) {
    throw Object.assign(
      new SponsorError(
        body.error ?? "",
        (body.code ?? "TRANSPORT") as never,
        body.retryAfterSeconds,
      ),
      { status: res.status },
    );
  }
  return body;
}

let server: Server;
let endpoint: string;

const start = (apiKeys?: Map<string, string>): Promise<void> =>
  new Promise((resolve) => {
    const service = new SponsorService({
      policy,
      signer,
      describe: () => description,
      deserialize: () => ({}) as FinalizedTransaction,
    });
    server = createSponsorServer({ service, apiKeys, allowedOrigins: ["*"] });
    server.listen(0, "127.0.0.1", () => {
      endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      resolve();
    });
  });

beforeEach(() => {
  submitted = 0;
});

afterEach(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    }),
);

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${endpoint}${SPONSOR_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("an open sponsor", () => {
  beforeEach(() => start());

  it("sponsors a transaction and answers 200", async () => {
    const response = await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      txId: "tx-1",
      feeSpeck: "100",
      circuits: ["settle_invoice"],
    });
  });

  it("works through the card wallet's own fee payer", async () => {
    const receipt = await sponsorFeePayer({ endpoint }).pay("aabb", "settle_invoice");
    expect(receipt).toEqual({ paidBy: "sponsor", feeSpeck: "100" });
  });

  it("serves its policy, so a UI can say what is sponsorable", async () => {
    const response = await fetch(`${endpoint}/v1/policy`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contracts: [REGISTRY],
      circuits: ["settle_invoice"],
    });
  });

  it("reports what it has spent on /healthz", async () => {
    await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" });
    const health = (await (await fetch(`${endpoint}/healthz`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      ok: true,
      sponsor: "mn_addr_test1sponsor",
      paid: 1,
      spentSpeck: "100",
      budgetSpeck: "10000",
      budgetLeftSpeck: "9900",
    });
  });

  it("rate limits by connection, which the body cannot change", async () => {
    // Three requests from the same socket, each claiming a different caller. The limit is two.
    await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb", caller: "one" });
    await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb", caller: "two" });
    const third = await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb", caller: "three" });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    expect(await third.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(submitted).toBe(2);
  });

  it("ignores a spoofed X-Forwarded-For, since no proxy is trusted", async () => {
    await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" }, { "X-Forwarded-For": "a" });
    await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" }, { "X-Forwarded-For": "b" });
    const third = await post(
      { protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" },
      { "X-Forwarded-For": "c" },
    );
    expect(third.status).toBe(429);
  });

  it("answers 404 for anything that is not its one route", async () => {
    expect((await fetch(`${endpoint}/`)).status).toBe(404);
    expect((await fetch(`${endpoint}${SPONSOR_PATH}`)).status).toBe(404);
  });

  it("answers a preflight", async () => {
    const response = await fetch(`${endpoint}${SPONSOR_PATH}`, {
      method: "OPTIONS",
      headers: { Origin: "https://example.test" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers 400 for a body that is not JSON", async () => {
    const response = await fetch(`${endpoint}${SPONSOR_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("a sponsor with API keys", () => {
  beforeEach(() => start(new Map([["s3cret", "web-demo"]])));

  it("refuses a request with no key", async () => {
    const response = await post({ protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(submitted).toBe(0);
  });

  it("refuses a wrong key", async () => {
    const response = await post(
      { protocol: SPONSOR_PROTOCOL_VERSION, tx: "aabb" },
      { Authorization: "Bearer nope" },
    );
    expect(response.status).toBe(401);
  });

  it("accepts the right key", async () => {
    const result = await requestSponsorship("aabb", { endpoint, apiKey: "s3cret" });
    expect(result.txId).toBe("tx-1");
  });

  it("surfaces a refusal to a client as a typed SponsorError", async () => {
    await requestSponsorship("aabb", { endpoint, apiKey: "s3cret" });
    await requestSponsorship("aabb", { endpoint, apiKey: "s3cret" });
    const error = await requestSponsorship("aabb", { endpoint, apiKey: "s3cret" }).then(
      () => undefined,
      (e: unknown) => e as SponsorError & { status?: number },
    );
    expect(error).toBeInstanceOf(SponsorError);
    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.status).toBe(429);
    expect(error?.retryAfterSeconds).toBe(60);
  });
});

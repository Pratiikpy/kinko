import { generateOracleKeypair, KinkoPay, verifyQuote } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { TokenName } from "../src/domain/enums.ts";
import { ApiError } from "../src/http/errors.ts";
import { Oracle, type SignedQuote } from "../src/oracle/oracle.ts";
import {
  createRateSource,
  HttpRateSource,
  parseScaledDecimal,
  RATE_SCALE,
  StaticRateSource,
} from "../src/oracle/rates.ts";
import { ChainSim, newTestInvoice, START } from "./support/chain-sim.ts";
import { containing } from "./support/fixtures.ts";

const fetchOf = (
  responses: (() => Response | Promise<Response>)[],
): { fetchImpl: typeof fetch; calls: () => number } => {
  let i = 0;
  return {
    fetchImpl: (): Promise<Response> =>
      Promise.resolve((responses[Math.min(i++, responses.length - 1)] as () => Response)()),
    calls: () => i,
  };
};
const json = (value: unknown) => () =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("rates", () => {
  it("parses decimals exactly, without floating point", () => {
    expect(parseScaledDecimal("1")).toBe(RATE_SCALE);
    expect(parseScaledDecimal("0.0913")).toBe(91_300_000n);
    expect(parseScaledDecimal("0.000000001")).toBe(1n);
    expect(parseScaledDecimal("12345.123456789")).toBe(12_345_123_456_789n);
    expect(parseScaledDecimal(" 2.5 ")).toBe(2_500_000_000n);
  });

  it.each(["", "0", "0.0", "-1", "1e-3", "1.0000000001", "abc", "1,5", "NaN"])(
    "refuses %j",
    (text) => {
      expect(() => parseScaledDecimal(text)).toThrow();
    },
  );

  it("serves a configured static rate", async () => {
    expect(await new StaticRateSource("0.0913").kusdPerNight()).toBe(91_300_000n);
  });

  it("builds the source the configuration asks for, or none", () => {
    expect(createRateSource({ kind: "none" })).toBeUndefined();
    expect(createRateSource({ kind: "static", kusdPerNight: "1" })).toBeInstanceOf(
      StaticRateSource,
    );
    expect(
      createRateSource({ kind: "http", url: "https://x.example/p", path: "a" }),
    ).toBeInstanceOf(HttpRateSource);
  });

  describe("HttpRateSource", () => {
    const make = (
      responses: (() => Response | Promise<Response>)[],
      over: { now?: () => number; ttlMs?: number; maxStaleMs?: number } = {},
    ) => {
      const f = fetchOf(responses);
      return {
        f,
        source: new HttpRateSource({
          url: "https://feed.example/price",
          path: "data.night.usd",
          fetchImpl: f.fetchImpl,
          ...over,
        }),
      };
    };

    it("reads a number or a numeric string at the configured path", async () => {
      expect(await make([json({ data: { night: { usd: 0.0913 } } })]).source.kusdPerNight()).toBe(
        91_300_000n,
      );
      expect(await make([json({ data: { night: { usd: "0.0913" } } })]).source.kusdPerNight()).toBe(
        91_300_000n,
      );
    });

    it("reads through arrays by index", async () => {
      const source = new HttpRateSource({
        url: "https://f.example",
        path: "rates.0.price",
        fetchImpl: fetchOf([json({ rates: [{ price: 2 }] })]).fetchImpl,
      });
      expect(await source.kusdPerNight()).toBe(2n * RATE_SCALE);
    });

    it("caches within the ttl and refetches after it", async () => {
      let t = 0;
      const { f, source } = make(
        [json({ data: { night: { usd: 1 } } }), json({ data: { night: { usd: 2 } } })],
        { now: () => t, ttlMs: 1_000 },
      );
      expect(await source.kusdPerNight()).toBe(RATE_SCALE);
      t = 999;
      expect(await source.kusdPerNight()).toBe(RATE_SCALE);
      expect(f.calls()).toBe(1);
      t = 1_000;
      expect(await source.kusdPerNight()).toBe(2n * RATE_SCALE);
    });

    it("serves the last rate when the feed fails briefly, and refuses once it is too old", async () => {
      let t = 0;
      const down = () => new Response("nope", { status: 503 });
      const { source } = make([json({ data: { night: { usd: 1 } } }), down], {
        now: () => t,
        ttlMs: 10,
        maxStaleMs: 1_000,
      });
      await source.kusdPerNight();
      t = 500;
      expect(await source.kusdPerNight()).toBe(RATE_SCALE);
      t = 1_001;
      await expect(source.kusdPerNight()).rejects.toMatchObject({
        status: 503,
        message: containing("feed answered 503"),
      });
    });

    it("refuses a feed that has no number at the path, or a nonsense one, rather than guess", async () => {
      await expect(make([json({ data: {} })]).source.kusdPerNight()).rejects.toThrow(ApiError);
      await expect(
        make([json({ data: { night: { usd: "cheap" } } })]).source.kusdPerNight(),
      ).rejects.toThrow(/unavailable/);
      await expect(
        make([json({ data: { night: { usd: 0 } } })]).source.kusdPerNight(),
      ).rejects.toThrow(/unavailable/);
      await expect(
        make([json({ data: { night: { usd: -3 } } })]).source.kusdPerNight(),
      ).rejects.toThrow(/unavailable/);
      await expect(
        make([() => new Response("<html>", { status: 200 })]).source.kusdPerNight(),
      ).rejects.toThrow(/unavailable/);
    });
  });
});

const asSignature = (q: SignedQuote) => ({
  announcement: { x: BigInt(q.signature.announcement.x), y: BigInt(q.signature.announcement.y) },
  response: BigInt(q.signature.response),
});

const termsOf = (q: SignedQuote) => ({
  baseAmount: BigInt(q.baseAmount),
  convertedAmount: BigInt(q.convertedAmount),
  fromToken: q.fromToken === TokenName.NATIVE ? KinkoPay.TokenKind.NATIVE : KinkoPay.TokenKind.KUSD,
  toToken: q.toToken === TokenName.NATIVE ? KinkoPay.TokenKind.NATIVE : KinkoPay.TokenKind.KUSD,
  expiresAt: BigInt(q.expiresAt),
});

describe("Oracle", () => {
  const keys = generateOracleKeypair();
  const make = (rate = "0.0913", over: { now?: () => number; ttl?: number } = {}) =>
    new Oracle({
      secretKey: keys.secretKey,
      rates: new StaticRateSource(rate),
      quoteTtlSeconds: over.ttl ?? 120,
      now: over.now ?? (() => Number(START) * 1000),
    });

  it("prices NATIVE to KUSD at the configured rate", async () => {
    const q = await make().quote(1_000_000n, TokenName.NATIVE, TokenName.KUSD);
    expect(q).toMatchObject({
      baseAmount: "1000000",
      // 0.0913 KUSD, asked as the next whole cent.
      convertedAmount: "100000",
      fromToken: "NATIVE",
      toToken: "KUSD",
    });
  });

  it("prices KUSD to NATIVE and round-trips", async () => {
    const q = await make().quote(91_300n, TokenName.KUSD, TokenName.NATIVE);
    expect(q.convertedAmount).toBe("1000000");
  });

  it("rounds a KUSD price up to a whole cent, so the merchant never receives less", async () => {
    const oracle = make("0.0913");
    // 0.0000000913 KUSD and 0.0000010043 KUSD are still worth asking a cent for.
    expect((await oracle.quote(1n, TokenName.NATIVE, TokenName.KUSD)).convertedAmount).toBe(
      "10000",
    );
    expect((await oracle.quote(11n, TokenName.NATIVE, TokenName.KUSD)).convertedAmount).toBe(
      "10000",
    );
    // 0.1826 KUSD becomes $0.19, never $0.18.
    expect((await oracle.quote(2_000_000n, TokenName.NATIVE, TokenName.KUSD)).convertedAmount).toBe(
      "190000",
    );
    // A price already in whole cents is left alone.
    expect(
      (await make("0.05").quote(40_000_000n, TokenName.NATIVE, TokenName.KUSD)).convertedAmount,
    ).toBe("2000000");
    // NIGHT is not rounded to cents: it is only ever rounded up to a base unit.
    expect((await make("3").quote(1n, TokenName.KUSD, TokenName.NATIVE)).convertedAmount).toBe("1");
  });

  it("sets the expiry in seconds, ttl after now", async () => {
    const q = await make("1", { ttl: 90 }).quote(5n, TokenName.NATIVE, TokenName.KUSD);
    expect(q.expiresAt).toBe(String(START + 90n));
  });

  it("signs a message the contract's own verifier accepts", async () => {
    const q = await make().quote(1_000_000n, TokenName.NATIVE, TokenName.KUSD);
    expect(verifyQuote(keys.publicKey, termsOf(q), asSignature(q))).toBe(true);
    expect(q.publicKey).toEqual({ x: keys.publicKey.x.toString(), y: keys.publicKey.y.toString() });
  });

  it("produces a signature that fails for any changed term or a different key", async () => {
    const q = await make().quote(1_000_000n, TokenName.NATIVE, TokenName.KUSD);
    const sig = asSignature(q);
    const t = termsOf(q);
    expect(
      verifyQuote(keys.publicKey, { ...t, convertedAmount: t.convertedAmount - 1n }, sig),
    ).toBe(false);
    expect(verifyQuote(keys.publicKey, { ...t, baseAmount: t.baseAmount + 1n }, sig)).toBe(false);
    expect(verifyQuote(keys.publicKey, { ...t, expiresAt: t.expiresAt + 1n }, sig)).toBe(false);
    expect(
      verifyQuote(
        keys.publicKey,
        { ...t, fromToken: KinkoPay.TokenKind.KUSD, toToken: KinkoPay.TokenKind.NATIVE },
        sig,
      ),
    ).toBe(false);
    expect(verifyQuote(generateOracleKeypair().publicKey, t, sig)).toBe(false);
  });

  it("counts quotes without keeping amounts", async () => {
    const oracle = make();
    await oracle.quote(100n, TokenName.NATIVE, TokenName.KUSD);
    await oracle.quote(200n, TokenName.NATIVE, TokenName.KUSD);
    expect(oracle.quotes).toBe(2);
    expect(JSON.stringify(oracle)).not.toContain("200");
  });

  it.each([
    [0n, "between 1 and 2^64"],
    [-5n, "between 1 and 2^64"],
    [2n ** 64n, "between 1 and 2^64"],
  ])("refuses a base amount of %s", async (amount, message) => {
    await expect(make().quote(amount, TokenName.NATIVE, TokenName.KUSD)).rejects.toMatchObject({
      status: 400,
      message: containing(message),
    });
  });

  it("refuses a conversion between an asset and itself", async () => {
    await expect(make().quote(5n, TokenName.KUSD, TokenName.KUSD)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses a result the contract cannot represent", async () => {
    await expect(
      make("1000000").quote(2n ** 64n - 1n, TokenName.NATIVE, TokenName.KUSD),
    ).rejects.toMatchObject({
      status: 400,
      message: containing("more than the contract"),
    });
  });

  it("refuses to quote without a rate source, with a 503 that says how to fix it", async () => {
    const oracle = new Oracle({
      secretKey: keys.secretKey,
      rates: undefined,
      quoteTtlSeconds: 120,
    });
    expect(oracle.canQuote).toBe(false);
    await expect(oracle.quote(5n, TokenName.NATIVE, TokenName.KUSD)).rejects.toMatchObject({
      status: 503,
      message: containing("KINKO_ORACLE_KUSD_PER_NIGHT"),
    });
  });

  it("refuses a secret key that would give the identity public key, which verifies every signature", () => {
    const order = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
    expect(() => new Oracle({ secretKey: order, rates: undefined, quoteTtlSeconds: 120 })).toThrow(
      /identity key/,
    );
    expect(
      () => new Oracle({ secretKey: order * 3n, rates: undefined, quoteTtlSeconds: 120 }),
    ).toThrow(/identity key/);
  });

  it("accepts a larger secret by the runtime's own reduction, and signs correctly with it", async () => {
    const big = new Oracle({
      secretKey: 2n ** 200n + 12345n,
      rates: new StaticRateSource("1"),
      quoteTtlSeconds: 60,
    });
    const q = await big.quote(10n, TokenName.NATIVE, TokenName.KUSD);
    expect(verifyQuote(big.publicKey, termsOf(q), asSignature(q))).toBe(true);
  });

  it("derives the same public key from the same secret every time", () => {
    expect(make().publicKey).toEqual({ x: keys.publicKey.x, y: keys.publicKey.y });
  });
});

describe("a quote on the real contract", () => {
  const keys = generateOracleKeypair();
  const oracle = new Oracle({
    secretKey: keys.secretKey,
    rates: new StaticRateSource("0.0913"),
    quoteTtlSeconds: 120,
    now: () => Number(START) * 1000,
  });

  const setup = async (oraclePk = keys.publicKey) => {
    const sim = await ChainSim.deploy(oraclePk);
    const invoice = newTestInvoice({ amount: 1_000_000n, token: KinkoPay.TokenKind.NATIVE });
    await sim.create(invoice);
    return { sim, invoice };
  };

  it("settles an invoice in the other asset when the contract verifies the oracle's signature in-circuit", async () => {
    const { sim, invoice } = await setup();
    const q = await oracle.quote(invoice.terms.amount, TokenName.NATIVE, TokenName.KUSD);
    await expect(
      sim.payConverted(
        invoice,
        { token: KinkoPay.TokenKind.KUSD, value: BigInt(q.convertedAmount) },
        { expiresAt: BigInt(q.expiresAt), signature: asSignature(q) },
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a quote signed by a different oracle", async () => {
    const { sim, invoice } = await setup(generateOracleKeypair().publicKey);
    const q = await oracle.quote(invoice.terms.amount, TokenName.NATIVE, TokenName.KUSD);
    await expect(
      sim.payConverted(
        invoice,
        { token: KinkoPay.TokenKind.KUSD, value: BigInt(q.convertedAmount) },
        { expiresAt: BigInt(q.expiresAt), signature: asSignature(q) },
      ),
    ).rejects.toThrow("oracle signature is invalid");
  });

  it("refuses a payer who hands over less than the quote said", async () => {
    const { sim, invoice } = await setup();
    const q = await oracle.quote(invoice.terms.amount, TokenName.NATIVE, TokenName.KUSD);
    await expect(
      sim.payConverted(
        invoice,
        { token: KinkoPay.TokenKind.KUSD, value: BigInt(q.convertedAmount) - 1n },
        { expiresAt: BigInt(q.expiresAt), signature: asSignature(q) },
      ),
    ).rejects.toThrow("oracle signature is invalid");
  });

  it("refuses a quote after it expires", async () => {
    const { sim, invoice } = await setup();
    const q = await oracle.quote(invoice.terms.amount, TokenName.NATIVE, TokenName.KUSD);
    sim.now = BigInt(q.expiresAt) + 1n;
    await expect(
      sim.payConverted(
        invoice,
        { token: KinkoPay.TokenKind.KUSD, value: BigInt(q.convertedAmount) },
        { expiresAt: BigInt(q.expiresAt), signature: asSignature(q) },
      ),
    ).rejects.toThrow();
  });

  it("works the other way: a KUSD invoice paid in NIGHT", async () => {
    const sim = await ChainSim.deploy(keys.publicKey);
    const invoice = newTestInvoice({ amount: 91_300n, token: KinkoPay.TokenKind.KUSD });
    await sim.create(invoice);
    const q = await oracle.quote(invoice.terms.amount, TokenName.KUSD, TokenName.NATIVE);
    await expect(
      sim.payConverted(
        invoice,
        { token: KinkoPay.TokenKind.NATIVE, value: BigInt(q.convertedAmount) },
        { expiresAt: BigInt(q.expiresAt), signature: asSignature(q) },
      ),
    ).resolves.toBeUndefined();
  });
});

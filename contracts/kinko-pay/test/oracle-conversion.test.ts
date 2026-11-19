// Oracle-verified conversion between NATIVE and KUSD.
//
// Signatures come from the real signer in src/oracle.ts and are checked by the
// standard library's jubjubSchnorrVerify inside the compiled circuit. Nothing
// is stubbed: if signer and verifier disagreed by one bit these tests would
// fail, which is the point. A contract that accepts a fake signature verifies
// nothing.

import {
  CompactTypeField,
  CompactTypeVector,
  ecMulGenerator,
  jubjubSchnorrSign,
} from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  type ConversionQuote,
  generateOracleKeypair,
  quoteMessage,
  signQuote,
  verifyQuote,
} from "../src/index.ts";
import { hex, paidTo, T0 } from "./harness.ts";
import {
  AMOUNT,
  base,
  coin,
  deployPay,
  InvoiceKind,
  KUSD,
  ledgerOf,
  NATIVE,
  PAYOUT,
  TokenKind,
} from "./pay-fixtures.ts";

const CONVERTED = 91_300n;
const HOUR = 3_600n;

const QUOTE: ConversionQuote = {
  baseAmount: AMOUNT,
  convertedAmount: CONVERTED,
  fromToken: TokenKind.NATIVE,
  toToken: TokenKind.KUSD,
  expiresAt: T0 + HOUR,
};

/** A NATIVE invoice on a contract that trusts `oracle`, and a payer holding KUSD. */
const setup = async (oracle = generateOracleKeypair(), convertedAmount = CONVERTED) => {
  const h = await deployPay(base({ convertedAmount }), oracle.publicKey);
  await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.NATIVE, 0n);
  return { h, oracle };
};

const payConverted = (
  h: Awaited<ReturnType<typeof setup>>["h"],
  signature: ReturnType<typeof signQuote>,
  over: {
    value?: bigint;
    color?: Uint8Array;
    paid?: (typeof TokenKind)[keyof typeof TokenKind];
    expiresAt?: bigint;
  } = {},
) =>
  h.call(
    "settle_invoice_converted",
    InvoiceKind.STANDARD,
    TokenKind.NATIVE,
    over.paid ?? TokenKind.KUSD,
    coin(over.value ?? CONVERTED, over.color ?? KUSD),
    over.expiresAt ?? QUOTE.expiresAt,
    signature,
  );

describe("oracle conversion", () => {
  it("accepts a correctly signed quote and forwards the converted coin to the merchant", async () => {
    const { h, oracle } = await setup();
    const sig = signQuote(oracle, QUOTE);
    expect(verifyQuote(oracle.publicKey, QUOTE, sig)).toBe(true);

    const receipt = await payConverted(h, sig);
    expect(receipt).toHaveLength(32);
    expect(paidTo(h.last("settle_invoice_converted").zswapOutputs)).toEqual([
      { to: hex(PAYOUT), value: CONVERTED, color: hex(KUSD) },
    ]);
  });

  it("converts in the other direction too: a KUSD invoice paid in NIGHT", async () => {
    const oracle = generateOracleKeypair();
    const h = await deployPay(base({ convertedAmount: CONVERTED }), oracle.publicKey);
    await h.call("create_invoice", InvoiceKind.STANDARD, TokenKind.KUSD, 0n);
    const quote = { ...QUOTE, fromToken: TokenKind.KUSD, toToken: TokenKind.NATIVE };
    await expect(
      h.call(
        "settle_invoice_converted",
        InvoiceKind.STANDARD,
        TokenKind.KUSD,
        TokenKind.NATIVE,
        coin(CONVERTED, NATIVE),
        quote.expiresAt,
        signQuote(oracle, quote),
      ),
    ).resolves.toHaveLength(32);
  });

  it("rejects a quote signed by a DIFFERENT oracle", async () => {
    const { h } = await setup();
    await expect(payConverted(h, signQuote(generateOracleKeypair(), QUOTE))).rejects.toThrow(
      "oracle signature is invalid",
    );
  });

  it("rejects a tampered converted amount", async () => {
    // The oracle signed for CONVERTED; the payer claims they owe less.
    const { h, oracle } = await setup(generateOracleKeypair(), CONVERTED - 1n);
    await expect(
      payConverted(h, signQuote(oracle, QUOTE), { value: CONVERTED - 1n }),
    ).rejects.toThrow("oracle signature is invalid");
  });

  it("rejects a quote priced for a different invoice amount", async () => {
    const { h, oracle } = await setup();
    await expect(
      payConverted(h, signQuote(oracle, { ...QUOTE, baseAmount: AMOUNT + 1n })),
    ).rejects.toThrow("oracle signature is invalid");
  });

  it("rejects a quote whose expiry was extended after signing", async () => {
    const { h, oracle } = await setup();
    await expect(
      payConverted(h, signQuote(oracle, QUOTE), { expiresAt: QUOTE.expiresAt + HOUR }),
    ).rejects.toThrow("oracle signature is invalid");
  });

  it("rejects a signature over any message other than a Kinko quote", async () => {
    // The domain element leads the digest, so a signature the oracle made
    // over the same numbers in any other layout does not verify.
    const { h, oracle } = await setup();
    const [, ...withoutDomain] = quoteMessage(QUOTE);
    const foreign = jubjubSchnorrSign(
      new CompactTypeVector(5, CompactTypeField),
      [0n, ...withoutDomain],
      oracle.secretKey,
    );
    await expect(payConverted(h, foreign)).rejects.toThrow("oracle signature is invalid");
  });

  it("rejects an expired quote", async () => {
    const { h, oracle } = await setup();
    h.at(QUOTE.expiresAt);
    await expect(payConverted(h, signQuote(oracle, QUOTE))).rejects.toThrow("quote has expired");
  });

  it("rejects a coin that is not the converted amount", async () => {
    const { h, oracle } = await setup();
    await expect(
      payConverted(h, signQuote(oracle, QUOTE), { value: CONVERTED - 1n }),
    ).rejects.toThrow("coin value does not match quote");
  });

  it("rejects a coin that is not the asset the quote priced", async () => {
    const { h, oracle } = await setup();
    await expect(payConverted(h, signQuote(oracle, QUOTE), { color: NATIVE })).rejects.toThrow(
      "coin is not the asset the quote priced",
    );
  });

  it("rejects a 'conversion' from an asset to itself", async () => {
    const { h, oracle } = await setup();
    const sameAsset = { ...QUOTE, toToken: TokenKind.NATIVE, convertedAmount: 1n };
    await expect(
      payConverted(h, signQuote(oracle, sameAsset), {
        paid: TokenKind.NATIVE,
        value: 1n,
        color: NATIVE,
      }),
    ).rejects.toThrow("conversion needs two different assets");
  });

  it("a converted settlement closes the invoice and cannot be repeated", async () => {
    const { h, oracle } = await setup();
    await payConverted(h, signQuote(oracle, QUOTE));
    await expect(payConverted(h, signQuote(oracle, QUOTE))).rejects.toThrow("invoice is not open");
  });
});

describe("the sealed oracle key", () => {
  it("is the key given at deployment", async () => {
    const oracle = generateOracleKeypair();
    const h = await deployPay(base(), oracle.publicKey);
    const sealed = ledgerOf(h).oracle_pk;
    expect([sealed.x, sealed.y]).toEqual([oracle.publicKey.x, oracle.publicKey.y]);
  });

  it("refuses the identity point, which would verify any signature", async () => {
    await expect(deployPay(base(), ecMulGenerator(0n))).rejects.toThrow(
      "oracle key is the identity point",
    );
  });
});

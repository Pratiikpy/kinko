import { generateOracleKeypair, KinkoPay, signQuote } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { quoteNightInKusd } from "./quote.ts";

const oracle = generateOracleKeypair();
const other = generateOracleKeypair();

/**
 * What the backend's oracle answers, signed with `keys`.
 *
 * @param keys - The signing oracle.
 * @param base - NIGHT priced.
 * @param converted - KUSD quoted.
 * @returns A fetch that answers with the signed quote.
 */
function answer(keys: typeof oracle, base: bigint, converted: bigint) {
  const terms = {
    baseAmount: base,
    convertedAmount: converted,
    fromToken: KinkoPay.TokenKind.NATIVE,
    toToken: KinkoPay.TokenKind.KUSD,
    expiresAt: 4_000_000_000n,
  };
  const sig = signQuote(keys, terms);
  const body = {
    quote: {
      baseAmount: base.toString(),
      convertedAmount: converted.toString(),
      fromToken: "NATIVE",
      toToken: "KUSD",
      expiresAt: terms.expiresAt.toString(),
      signature: {
        announcement: { x: sig.announcement.x.toString(), y: sig.announcement.y.toString() },
        response: sig.response.toString(),
      },
    },
  };
  return (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;
}

describe("quoteNightInKusd", () => {
  it("returns a quote the contract's oracle key verifies", async () => {
    const q = await quoteNightInKusd(
      40_000_000n,
      oracle.publicKey,
      answer(oracle, 40_000_000n, 2_000_000n),
    );
    expect(q.convertedAmount).toBe(2_000_000n);
    expect(q.fromToken).toBe(KinkoPay.TokenKind.NATIVE);
    expect(q.toToken).toBe(KinkoPay.TokenKind.KUSD);
  });

  it("refuses a quote signed by a key the contract does not trust", async () => {
    await expect(
      quoteNightInKusd(40_000_000n, oracle.publicKey, answer(other, 40_000_000n, 2_000_000n)),
    ).rejects.toThrow(/not signed by the key/);
  });

  it("refuses a quote for a different amount", async () => {
    await expect(
      quoteNightInKusd(40_000_000n, oracle.publicKey, answer(oracle, 1_000_000n, 50_000n)),
    ).rejects.toThrow(/different amount/);
  });

  it("passes on the oracle's own refusal", async () => {
    const refuse = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "The oracle has no rate source." } }), {
          status: 503,
        }),
      )) as typeof fetch;
    await expect(quoteNightInKusd(1n, oracle.publicKey, refuse)).rejects.toThrow(/no rate source/);
  });
});

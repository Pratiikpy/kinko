// Paying a NIGHT-priced invoice in private dollars.
//
// NIGHT exists only as an unshielded token on Midnight, so no shielded NIGHT
// coin can pay an invoice. An invoice priced in NIGHT is paid in KUSD instead,
// at a rate Kinko's oracle signs: the contract verifies the signature inside
// the proof, so the rate is proven while the amounts stay private. A quote
// lives for minutes, so one is fetched right before paying.

import { type ConversionQuote, KinkoPay, verifyQuote } from "@kinko/kinko-pay";

import { BACKEND_URL } from "./config.ts";

/** A quote the contract will accept, ready to pass to the circuit. */
export interface PaymentQuote extends ConversionQuote {
  readonly signature: {
    readonly announcement: { readonly x: bigint; readonly y: bigint };
    readonly response: bigint;
  };
}

interface WireQuote {
  readonly baseAmount: string;
  readonly convertedAmount: string;
  readonly expiresAt: string;
  readonly signature: {
    readonly announcement: { readonly x: string; readonly y: string };
    readonly response: string;
  };
}

const num = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v))
    throw new Error(`The oracle's ${what} is not a number.`);
  return BigInt(v);
};

/**
 * Ask Kinko's oracle what a NIGHT amount costs in KUSD, signed.
 *
 * @param night - The invoice amount, in NIGHT base units.
 * @param oraclePublicKey - The key sealed into the pay contract; the quote is checked against it.
 * @param oraclePublicKey.x - Its x coordinate.
 * @param oraclePublicKey.y - Its y coordinate.
 * @param fetchImpl - Injected for tests.
 * @returns The quote.
 * @throws {Error} When no backend is configured, the oracle refuses, or its signature would not
 *   verify on chain, so no proof is spent on a quote the contract would reject.
 */
export async function quoteNightInKusd(
  night: bigint,
  oraclePublicKey: { x: bigint; y: bigint },
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<PaymentQuote> {
  if (!BACKEND_URL) {
    throw new Error(
      "This invoice is priced in NIGHT, and this build has no Kinko backend to price it (VITE_BACKEND_URL).",
    );
  }
  const res = await fetchImpl(`${BACKEND_URL}/v1/oracle/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseAmount: night.toString(), fromToken: "NATIVE", toToken: "KUSD" }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    quote?: WireQuote;
    error?: { message?: string };
  };
  if (!res.ok || !body.quote) {
    throw new Error(body.error?.message ?? `The rate oracle answered ${String(res.status)}.`);
  }
  const q = body.quote;
  const quote: PaymentQuote = {
    baseAmount: num(q.baseAmount, "amount"),
    convertedAmount: num(q.convertedAmount, "price"),
    fromToken: KinkoPay.TokenKind.NATIVE,
    toToken: KinkoPay.TokenKind.KUSD,
    expiresAt: num(q.expiresAt, "expiry"),
    signature: {
      announcement: {
        x: num(q.signature.announcement.x, "signature"),
        y: num(q.signature.announcement.y, "signature"),
      },
      response: num(q.signature.response, "signature"),
    },
  };
  if (quote.baseAmount !== night) throw new Error("The oracle priced a different amount.");
  if (!verifyQuote(oraclePublicKey, quote, quote.signature)) {
    throw new Error("The oracle's quote is not signed by the key this contract trusts.");
  }
  return quote;
}

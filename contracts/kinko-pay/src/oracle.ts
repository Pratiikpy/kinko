// The conversion oracle's signing side.
//
// kinko_pay verifies quotes with the standard library's jubjubSchnorrVerify.
// The signer here is the runtime's jubjubSchnorrSign over the same message
// type, and the message itself comes from the compiled quote_digest circuit,
// so the bytes signed off-chain are the bytes verified in-circuit by
// construction. A signer that only approximated the verifier would simply
// produce rejected quotes, which is the correct failure.

import {
  CompactTypeField,
  CompactTypeVector,
  type JubjubPoint,
  jubjubSampleScalar,
  jubjubSchnorrSign,
  type JubjubSchnorrSignature,
  jubjubSchnorrVerify,
  jubjubSchnorrVerifyingKey,
} from "@midnight-ntwrk/compact-runtime";

import { pureCircuits, type TokenKind } from "./managed/kinko_pay/contract/index.js";

/** The type of the message the contract verifies: quote_digest's five fields. */
const QUOTE_MESSAGE = new CompactTypeVector(5, CompactTypeField);

/** An oracle signing key and the public key sealed into kinko_pay. */
export interface OracleKeypair {
  readonly secretKey: bigint;
  readonly publicKey: JubjubPoint;
}

/** The terms of a conversion quote. Amounts are base units of each asset. */
export interface ConversionQuote {
  /** The invoice amount, in the invoice's asset. */
  readonly baseAmount: bigint;
  /** What the payer hands over, in the paid asset. */
  readonly convertedAmount: bigint;
  /** The invoice's asset. */
  readonly fromToken: TokenKind;
  /** The asset the payer pays in. */
  readonly toToken: TokenKind;
  /** Block time in seconds after which the quote is refused. */
  readonly expiresAt: bigint;
}

/**
 * Draw a fresh oracle keypair.
 *
 * @returns A uniformly random signing key and its verifying key.
 */
export const generateOracleKeypair = (): OracleKeypair => {
  const secretKey = jubjubSampleScalar();
  return { secretKey, publicKey: jubjubSchnorrVerifyingKey(secretKey) };
};

/**
 * The message the contract verifies for `quote`, from the compiled circuit.
 *
 * @param quote - The quote terms.
 * @returns The five field elements the oracle signs.
 */
export const quoteMessage = (quote: ConversionQuote): bigint[] =>
  pureCircuits.quote_digest(
    quote.baseAmount,
    quote.convertedAmount,
    quote.fromToken,
    quote.toToken,
    quote.expiresAt,
  );

/**
 * Sign a conversion quote.
 *
 * @param keypair - The oracle's keys.
 * @param quote - The quote terms.
 * @returns A signature settle_invoice_converted accepts for exactly these terms.
 */
export const signQuote = (keypair: OracleKeypair, quote: ConversionQuote): JubjubSchnorrSignature =>
  jubjubSchnorrSign(QUOTE_MESSAGE, quoteMessage(quote), keypair.secretKey);

/**
 * Check a quote signature off-chain before spending a proof on it.
 *
 * @param publicKey - The oracle key sealed into the contract.
 * @param quote - The quote terms.
 * @param signature - The signature to check.
 * @returns Whether the contract would accept the signature for these terms.
 */
export const verifyQuote = (
  publicKey: JubjubPoint,
  quote: ConversionQuote,
  signature: JubjubSchnorrSignature,
): boolean => jubjubSchnorrVerify(QUOTE_MESSAGE, quoteMessage(quote), publicKey, signature);

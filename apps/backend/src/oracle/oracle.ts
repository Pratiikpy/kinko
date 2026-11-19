// The conversion oracle's signer.
//
// `kinko_pay` lets an invoice in one asset be paid in the other when the payer
// presents a quote signed by the oracle whose key was sealed into the contract
// at deployment. This class makes those quotes: it prices a conversion, builds
// the exact message the contract's `quote_digest` circuit defines, and signs it
// with the runtime's Jubjub Schnorr signer, the counterpart of the standard
// library verifier the contract runs. Every quote is verified before it leaves
// this process, so a signer that drifted from the verifier fails here loudly
// rather than producing quotes the chain rejects.
//
// Trust: the key cannot be replaced after deployment, each quote expires within
// minutes, and each binds both amounts and both assets, so a signature for one
// conversion cannot be replayed for another. The oracle never learns which
// invoice a quote is for or whether it is used.

import {
  type ConversionQuote,
  KinkoPay,
  type OracleKeypair,
  signQuote,
  verifyQuote,
} from "@kinko/kinko-pay";
import { jubjubSchnorrVerifyingKey } from "@midnight-ntwrk/compact-runtime";

import { TokenName } from "../domain/enums.ts";
import { badRequest, notConfigured } from "../http/errors.ts";
import { RATE_SCALE, type RateSource } from "./rates.ts";

const U64_MAX = 18_446_744_073_709_551_615n;
/** One cent of KUSD, in base units (six decimals). */
const KUSD_CENT = 10_000n;

const TOKEN_KIND: Readonly<Record<TokenName, KinkoPay.TokenKind>> = {
  [TokenName.NATIVE]: KinkoPay.TokenKind.NATIVE,
  [TokenName.KUSD]: KinkoPay.TokenKind.KUSD,
};

/** A signed quote, every number a decimal string so it survives JSON. */
export interface SignedQuote {
  readonly baseAmount: string;
  readonly convertedAmount: string;
  readonly fromToken: TokenName;
  readonly toToken: TokenName;
  /** Seconds since the epoch, compared with block time by the contract. */
  readonly expiresAt: string;
  readonly signature: {
    readonly announcement: { readonly x: string; readonly y: string };
    readonly response: string;
  };
  /** The key the contract must have been deployed with for this quote to verify. */
  readonly publicKey: { readonly x: string; readonly y: string };
}

/** Options for {@link Oracle}. */
export interface OracleOptions {
  /** The signing scalar. */
  readonly secretKey: bigint;
  readonly rates: RateSource | undefined;
  readonly quoteTtlSeconds: number;
  readonly now?: () => number;
}

/** Prices and signs conversion quotes. */
export class Oracle {
  readonly #keypair: OracleKeypair;
  readonly #rates: RateSource | undefined;
  readonly #ttl: number;
  readonly #now: () => number;
  /** Quotes signed since start. A count only; amounts are never kept. */
  quotes = 0;

  /**
   * Create a signer.
   *
   * @param options - The key, the rate source and the quote lifetime.
   * @throws {Error} When the secret key is not a valid Jubjub scalar or would give the identity key.
   */
  constructor(options: OracleOptions) {
    let publicKey;
    try {
      publicKey = jubjubSchnorrVerifyingKey(options.secretKey);
    } catch (cause) {
      throw new Error("KINKO_ORACLE_SECRET_KEY is not a valid Jubjub scalar", { cause });
    }
    // The runtime reduces the scalar modulo the group order, so a multiple of the
    // order gives the identity point, which verifies every signature. The
    // contract refuses it at construction; refuse it here before it is ever used.
    if (publicKey.x === 0n && publicKey.y === 1n) {
      throw new Error(
        "KINKO_ORACLE_SECRET_KEY is a multiple of the Jubjub group order and would give the identity key",
      );
    }
    this.#keypair = { secretKey: options.secretKey, publicKey };
    this.#rates = options.rates;
    this.#ttl = options.quoteTtlSeconds;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The verifying key to seal into `kinko_pay` at deployment.
   *
   * @returns The public key's coordinates.
   */
  get publicKey(): { readonly x: bigint; readonly y: bigint } {
    return { x: this.#keypair.publicKey.x, y: this.#keypair.publicKey.y };
  }

  /**
   * Whether a rate source is configured, so quotes can be made.
   *
   * @returns True when the oracle can price a conversion.
   */
  get canQuote(): boolean {
    return this.#rates !== undefined;
  }

  /**
   * Price a conversion and sign it.
   *
   * @param baseAmount - The invoice amount in its own asset's base units.
   * @param from - The invoice's asset.
   * @param to - The asset the payer will hand over.
   * @returns The signed quote.
   * @throws {ApiError} 400 for amounts that cannot be converted; 503 when no rate is available.
   */
  async quote(baseAmount: bigint, from: TokenName, to: TokenName): Promise<SignedQuote> {
    if (from === to) throw badRequest("fromToken and toToken must differ.");
    if (baseAmount <= 0n || baseAmount > U64_MAX)
      throw badRequest("baseAmount must be between 1 and 2^64 - 1.");
    if (!this.#rates) {
      throw notConfigured(
        "The oracle has no rate source. Set KINKO_ORACLE_KUSD_PER_NIGHT or KINKO_ORACLE_RATE_URL.",
      );
    }
    const rate = await this.#rates.kusdPerNight();
    // Rounded up, so the merchant never receives less than the invoice is worth. A price in
    // KUSD is rounded up to a whole cent: a payer is asked for $1.99, never $1.993438, and the
    // merchant gains at most a cent less than one.
    const exact =
      from === TokenName.NATIVE
        ? ceilDiv(baseAmount * rate, RATE_SCALE)
        : ceilDiv(baseAmount * RATE_SCALE, rate);
    const converted = to === TokenName.KUSD ? ceilDiv(exact, KUSD_CENT) * KUSD_CENT : exact;
    if (converted <= 0n) throw badRequest("That amount converts to nothing at the current rate.");
    if (converted > U64_MAX)
      throw badRequest("That amount converts to more than the contract can represent.");

    const terms: ConversionQuote = {
      baseAmount,
      convertedAmount: converted,
      fromToken: TOKEN_KIND[from],
      toToken: TOKEN_KIND[to],
      expiresAt: BigInt(Math.floor(this.#now() / 1000) + this.#ttl),
    };
    const signature = signQuote(this.#keypair, terms);
    if (!verifyQuote(this.#keypair.publicKey, terms, signature)) {
      throw new Error(
        "the signer and the contract's verifier disagree; refusing to issue the quote",
      );
    }
    this.quotes++;
    return {
      baseAmount: terms.baseAmount.toString(),
      convertedAmount: terms.convertedAmount.toString(),
      fromToken: from,
      toToken: to,
      expiresAt: terms.expiresAt.toString(),
      signature: {
        announcement: {
          x: signature.announcement.x.toString(),
          y: signature.announcement.y.toString(),
        },
        response: signature.response.toString(),
      },
      publicKey: {
        x: this.#keypair.publicKey.x.toString(),
        y: this.#keypair.publicKey.y.toString(),
      },
    };
  }
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

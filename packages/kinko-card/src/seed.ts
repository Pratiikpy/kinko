// How a card becomes a wallet.
//
// A card is 32 random bytes. A gift card's bytes are its entropy directly: the
// link is the money. A PIN card stretches its bytes and the PIN through scrypt,
// so the printed card alone opens nothing and the PIN alone opens nothing.
//
// The entropy is then read as a BIP-39 phrase and opened exactly as a Midnight
// wallet opens a phrase (BIP-39 seed, then the wallet SDK's HD roles). That is
// deliberate: the 24 words a card shows can be typed into any Midnight wallet,
// and the card's coins are there. Nothing about a card is Kinko-only.
//
// Every issuer, holder and test must agree on this derivation to the byte, or
// value is sent to keys nobody can rebuild. So there is one, here, with fixed
// vectors in its tests.

import { scryptAsync } from "@noble/hashes/scrypt";
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** Bytes in a card secret. */
export const CARD_SECRET_BYTES = 32;

/** Fewest digits a PIN may have. Six gives a million guesses, each a full scrypt. */
export const PIN_MIN_DIGITS = 6;
/** Most digits a PIN may have. */
export const PIN_MAX_DIGITS = 12;

/**
 * The PIN stretch. N = 2^17 with r = 8 makes every guess cost 128 MiB of
 * memory and roughly half a second, so a stolen card's million possible PINs
 * cost days of a large machine rather than seconds, while a holder opening the
 * card waits once. Changing any of these moves every PIN card's coins, so they
 * are part of the card format, not tuning.
 */
export const PIN_SCRYPT = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 } as const;

/** Domain separator for the PIN stretch, so these keys are never reused elsewhere. */
const PIN_DOMAIN = new TextEncoder().encode("kinko:card:pin:v2");

/** A card as its holder presents it. */
export type CardKey =
  | { readonly kind: "gift"; readonly secret: Uint8Array }
  | { readonly kind: "pin"; readonly secret: Uint8Array; readonly pin: string };

/** Why a PIN was refused. */
export type PinProblem = "length" | "digits" | "guessable";

/**
 * Check a PIN before it is ever used to derive keys.
 *
 * @param pin - The PIN as typed.
 * @returns The problem, or undefined when the PIN is acceptable.
 */
export function pinProblem(pin: string): PinProblem | undefined {
  if (!/^[0-9]*$/.test(pin)) return "digits";
  if (pin.length < PIN_MIN_DIGITS || pin.length > PIN_MAX_DIGITS) return "length";
  const digits = Array.from({ length: pin.length }, (_, i) => pin.charCodeAt(i) - 48);
  const same = digits.every((d) => d === digits[0]);
  const step = (dir: 1 | -1) =>
    digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + dir + 10) % 10);
  return same || step(1) || step(-1) ? "guessable" : undefined;
}

/**
 * Draw a new card secret from the platform's CSPRNG.
 *
 * @returns 32 random bytes.
 */
export function newCardSecret(): Uint8Array {
  const secret = new Uint8Array(CARD_SECRET_BYTES);
  globalThis.crypto.getRandomValues(secret);
  return secret;
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length !== CARD_SECRET_BYTES) {
    throw new Error(
      `A card secret is ${String(CARD_SECRET_BYTES)} bytes; this one is ${String(secret.length)}.`,
    );
  }
}

/**
 * The 32 bytes of entropy a card's wallet is opened from.
 *
 * @param card - The card, and its PIN for a PIN card.
 * @returns The entropy.
 * @throws {Error} When the secret is not 32 bytes or the PIN is refused, so no
 *   coin is ever sent to keys derived from junk.
 */
export async function cardEntropy(card: CardKey): Promise<Uint8Array> {
  assertSecret(card.secret);
  if (card.kind === "gift") return Uint8Array.from(card.secret);
  const problem = pinProblem(card.pin);
  if (problem) throw new Error(`The PIN is not usable (${problem}).`);
  const password = new Uint8Array(card.secret.length + card.pin.length);
  password.set(card.secret);
  password.set(new TextEncoder().encode(card.pin), card.secret.length);
  return scryptAsync(password, PIN_DOMAIN, PIN_SCRYPT);
}

/**
 * The card's recovery phrase: the same wallet, as 24 words any Midnight wallet accepts.
 *
 * @param entropy - The card's entropy, from {@link cardEntropy}.
 * @returns The phrase.
 */
export function recoveryPhrase(entropy: Uint8Array): string {
  assertSecret(entropy);
  return entropyToMnemonic(entropy, wordlist);
}

/**
 * The entropy a recovery phrase stands for.
 *
 * @param phrase - 24 words.
 * @returns The entropy, or undefined when the phrase is not a valid 24-word phrase.
 */
export function entropyOfPhrase(phrase: string): Uint8Array | undefined {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (words.split(" ").length !== 24 || !validateMnemonic(words, wordlist)) return undefined;
  return mnemonicToEntropy(words, wordlist);
}

/**
 * The HD wallet seed for a card, exactly as a wallet derives it from the phrase.
 *
 * @param entropy - The card's entropy.
 * @returns The 64-byte BIP-39 seed.
 */
export function walletSeed(entropy: Uint8Array): Uint8Array {
  return mnemonicToSeedSync(recoveryPhrase(entropy));
}

// Small cryptographic helpers: identifiers, hashing, constant-time comparison,
// and the vault that seals the one secret the backend must be able to read back.
//
// API keys are hashed at rest and never recoverable. Webhook signing secrets
// are different: the backend has to sign with them, so they are sealed with
// AES-256-GCM under a data key held only in the environment. A copy of the
// database alone yields neither.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** The data key must be exactly 32 bytes, given as 64 hex characters. */
export const DATA_KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * A random identifier with a readable prefix, such as `cs_3f9a…`.
 *
 * @param prefix - Short tag naming the kind of record.
 * @param bytes - Bytes of randomness; 16 gives 128 bits.
 * @returns The identifier.
 */
export const newId = (prefix: string, bytes = 16): string =>
  `${prefix}_${randomBytes(bytes).toString("hex")}`;

/**
 * SHA-256 of a UTF-8 string, as lowercase hex.
 *
 * @param value - The text to hash.
 * @returns The digest.
 */
export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Compare two strings in constant time. Unequal lengths return false without
 * comparing, which leaks only the length.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns Whether they are equal.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** A freshly drawn merchant API key. */
export interface GeneratedApiKey {
  /** The full key, shown to the merchant once. */
  readonly key: string;
  /** SHA-256 of the key; what the database stores. */
  readonly hash: string;
  /** The first characters after the `kk_` marker, safe to show in a list. */
  readonly prefix: string;
}

/** Marks a string as a Kinko API key, so a leaked one is recognisable to scanners. */
export const API_KEY_MARKER = "kk_";

/**
 * Draw an API key. 256 bits of randomness, so a plain SHA-256 is enough to
 * store: there is nothing to brute-force.
 *
 * @returns The key, its hash and its display prefix.
 */
export const generateApiKey = (): GeneratedApiKey => {
  const secret = randomBytes(32).toString("base64url");
  const key = `${API_KEY_MARKER}${secret}`;
  return { key, hash: sha256Hex(key), prefix: secret.slice(0, 8) };
};

/**
 * Draw a webhook signing secret.
 *
 * @returns A `whsec_`-prefixed secret with 256 bits of randomness.
 */
export const generateWebhookSecret = (): string => `whsec_${randomBytes(32).toString("base64url")}`;

/**
 * Draw a one-time attach token for a draft session.
 *
 * @returns A token the merchant's wallet presents when it attaches a commitment.
 */
export const generateAttachToken = (): string => `at_${randomBytes(24).toString("base64url")}`;

/** Crockford base32 without ambiguous letters, for codes people type. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Draw a short code a person can type into a chat, such as `K7QM-4XD2-9PTV`.
 *
 * @returns A twelve character code in three groups. 60 bits of entropy,
 *   short-lived and single use.
 */
export const generateLinkCode = (): string => {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += CODE_ALPHABET.charAt((bytes[i] ?? 0) % 32);
    if (i % 4 === 3 && i < 11) out += "-";
  }
  return out;
};

/**
 * Normalise a typed link code: case, spaces and look-alike letters.
 *
 * @param input - What the person typed.
 * @returns The canonical code, or `undefined` when it cannot be one.
 */
export const normaliseLinkCode = (input: string): string | undefined => {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(cleaned)) return undefined;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8, 12)}`;
};

/** Seals and opens short secrets under the deployment's data key. */
export class Vault {
  readonly #key: Buffer;

  /**
   * Create a vault.
   *
   * @param keyHex - The data key as 64 hex characters (32 bytes).
   * @throws {Error} When the key is not 64 hex characters.
   */
  constructor(keyHex: string) {
    if (!DATA_KEY_HEX.test(keyHex)) {
      throw new Error("the data key must be 64 hex characters (32 bytes)");
    }
    this.#key = Buffer.from(keyHex, "hex");
  }

  /**
   * Encrypt `plaintext` with a fresh nonce.
   *
   * @param plaintext - The secret to protect.
   * @returns `v1.<nonce>.<tag>.<ciphertext>`, each part base64url.
   */
  seal(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      "v1",
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      body.toString("base64url"),
    ].join(".");
  }

  /**
   * Decrypt a value produced by {@link Vault.seal}.
   *
   * @param sealed - The sealed text.
   * @returns The original secret.
   * @throws {Error} When the text is malformed, was tampered with, or was
   *   sealed under a different data key.
   */
  open(sealed: string): string {
    const [version, nonce, tag, body] = sealed.split(".");
    if (version !== "v1" || !nonce || !tag || !body) throw new Error("sealed value is malformed");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("sealed value could not be opened: wrong data key or tampered data");
    }
  }
}

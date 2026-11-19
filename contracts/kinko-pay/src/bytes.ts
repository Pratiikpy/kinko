// Byte plumbing shared by every Kinko Pay helper.
//
// Circuits take fixed-width byte strings; the app holds hex strings, links and
// random values. Everything here is conversion and randomness, the two things
// a circuit cannot do for itself.

/** Width of every key, salt, secret and digest the contracts handle. */
export const BYTES32 = 32;

/** Width of an Ethereum address, as the vault colour derivation takes it. */
export const EVM_ADDRESS_BYTES = 20;

/**
 * Fresh uniformly random bytes from the platform CSPRNG.
 *
 * Uses Web Crypto, which Node and browsers both provide, so the same helper
 * serves the app and the test suite.
 *
 * @param length - How many bytes to draw. Defaults to 32.
 * @returns The random bytes.
 */
export const randomBytes = (length: number = BYTES32): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * Lowercase hex of `bytes`, without a 0x prefix.
 *
 * @param bytes - The bytes to encode.
 * @returns The hex string.
 */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Decode a hex string of an exact byte width.
 *
 * @param hex - Hex, optionally 0x-prefixed, either case.
 * @param length - The width the value must have.
 * @returns The decoded bytes.
 * @throws {Error} When `hex` is not hex or decodes to a different width.
 */
export const fromHex = (hex: string, length: number = BYTES32): Uint8Array => {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("not a hex string");
  }
  if (clean.length !== length * 2) {
    throw new Error(`expected ${String(length)} bytes of hex, got ${String(clean.length / 2)}`);
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Right-pad ASCII text into 32 bytes, as Compact's `pad(32, ...)` does.
 *
 * @param text - ASCII text of at most 32 bytes.
 * @returns The padded bytes.
 * @throws {Error} When the text does not fit.
 */
export const pad32 = (text: string): Uint8Array => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > BYTES32) {
    throw new Error(`"${text}" does not fit in 32 bytes`);
  }
  const out = new Uint8Array(BYTES32);
  out.set(bytes);
  return out;
};

/**
 * Byte-wise equality.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns Whether both have the same length and contents.
 */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Encode a JSON-safe payload as unpadded base64url, the form links carry.
 *
 * @param payload - The object to encode.
 * @returns The base64url text.
 */
export const encodeLinkPayload = (payload: unknown): string => {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const b of json) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Decode a base64url payload produced by {@link encodeLinkPayload}. A full
 * link is accepted too: only the part after `#` is read, because the fragment
 * is the part a browser never sends to a server.
 *
 * @param encoded - The payload or a link carrying it in its fragment.
 * @returns The parsed value, or `undefined` when it is not valid.
 */
export const decodeLinkPayload = (encoded: string): unknown => {
  const fragment = encoded.includes("#") ? encoded.slice(encoded.indexOf("#") + 1) : encoded;
  if (fragment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(fragment)) return undefined;
  try {
    const b64 = fragment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

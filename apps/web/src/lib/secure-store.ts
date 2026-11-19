// Encryption at rest for the account's records.
//
// The records hold invoice owner secrets, payer keys and gift card secrets, so
// they are never written in the clear. The key comes from one of two places:
//
//   account  A NightKit account derives 32 bytes only it and this site can
//            produce (`appSecret`). The key is the same on every device the
//            person signs in on, so an exported backup opens anywhere.
//   device   Any other wallet: a random AES key generated in this browser and
//            kept in IndexedDB as a non-extractable CryptoKey. Page script can
//            use it but cannot read its bytes out.
//
// The ciphertext lives in localStorage under a key derived from the account,
// so two accounts in one browser never see each other's records.

import { storage } from "./storage.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const IV_BYTES = 12;
const DB_NAME = "kinko-keys";
const DB_STORE = "keys";

/** Where a slot's key comes from: the account itself, or this browser. */
export type KeySource = "account" | "device";

const toB64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * SHA-256 of text, as hex. Used to name storage slots without storing the account id.
 *
 * @param text - The text to hash.
 * @returns The digest as hex.
 */
export async function digestHex(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * An AES-GCM key derived with HKDF from 32 secret bytes.
 *
 * @param secret - The account-derived secret.
 * @returns A non-extractable AES-GCM key.
 */
export async function keyFromSecret(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("kinko:records:v1"),
      info: enc.encode("aes-gcm-256"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a JSON value.
 *
 * @param key - The AES-GCM key.
 * @param value - Any JSON-serialisable value.
 * @returns "v1.", the IV and the ciphertext, base64.
 */
export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value))),
  );
  return `v1.${toB64(iv)}.${toB64(ct)}`;
}

/**
 * Decrypt a value from {@link seal}.
 *
 * @param key - The AES-GCM key.
 * @param sealed - The sealed text.
 * @returns The value.
 * @throws {Error} When the key is wrong, the text was altered or its format is unknown.
 */
export async function open(key: CryptoKey, sealed: string): Promise<unknown> {
  const [version, iv, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("These records are in an unknown format.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv) as BufferSource },
    key,
    fromB64(ct) as BufferSource,
  );
  return JSON.parse(dec.decode(plain)) as unknown;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no IndexedDB, so records cannot be kept encrypted here."));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("IndexedDB could not be opened."));
    };
  });
}

/**
 * The device key for a slot, created on first use. Never extractable.
 *
 * @param slot - The slot name.
 * @returns The slot's key.
 * @throws {Error} When IndexedDB is unavailable or refuses the key.
 */
export async function deviceKey(slot: string): Promise<CryptoKey> {
  const db = await idb();
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(slot);
    req.onsuccess = () => {
      resolve(req.result as CryptoKey | undefined);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("The device key could not be read."));
    };
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(key, slot);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("The device key could not be saved."));
    };
  });
  return key;
}

/** One account's encrypted records, and where their key came from. */
export interface SecureSlot {
  readonly source: KeySource;
  /** Read and decrypt the records; null when none were saved. */
  readonly load: () => Promise<unknown>;
  /** Encrypt and save the records. */
  readonly save: (value: unknown) => Promise<void>;
}

/**
 * Open the encrypted slot for one account.
 *
 * @param accountId - A stable id for the account (its coin public key).
 * @param appSecret - The account-derived secret when the wallet offers one.
 * @returns The slot.
 */
export async function openSlot(accountId: string, appSecret?: Uint8Array): Promise<SecureSlot> {
  const slot = (await digestHex(`kinko:${accountId}`)).slice(0, 32);
  const source: KeySource = appSecret ? "account" : "device";
  const key = appSecret ? await keyFromSecret(appSecret) : await deviceKey(slot);
  const storageKey = `records:${source}:${slot}`;
  return {
    source,
    load: async () => {
      const sealed = storage.get(storageKey);
      return sealed === null ? null : open(key, sealed);
    },
    save: async (value) => {
      if (!storage.set(storageKey, await seal(key, value))) {
        throw new Error("This browser refused to save your records (storage is full or disabled).");
      }
    },
  };
}

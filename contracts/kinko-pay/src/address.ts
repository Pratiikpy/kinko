// Reading a Midnight shielded address into the two keys Kinko needs from it.
//
// An invoice's payout is a coin public key, and the payer's wallet encrypts
// the forwarded coin to that key's encryption public key. A shielded address
// carries both, so it is the one thing a merchant has to give.

import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";

/**
 * Write a coin public key and its encryption public key as a shielded address.
 *
 * @param coinPublicKey - The zswap coin public key, 32 bytes.
 * @param encryptionPublicKey - The matching encryption public key, 32 bytes.
 * @param networkId - The network the address is for.
 * @returns The bech32m address.
 */
export const shieldedAddressFor = (
  coinPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
  networkId: string,
): string =>
  MidnightBech32m.encode(
    networkId,
    new ShieldedAddress(
      new ShieldedCoinPublicKey(Buffer.from(coinPublicKey)),
      new ShieldedEncryptionPublicKey(Buffer.from(encryptionPublicKey)),
    ),
  ).asString();

/** The receiving keys a shielded address carries. */
export interface ShieldedKeys {
  /** The zswap coin public key, 32 bytes. */
  readonly coinPublicKey: Uint8Array;
  /** The matching encryption public key, 32 bytes. */
  readonly encryptionPublicKey: Uint8Array;
  /** The network the address belongs to. */
  readonly networkId: string;
}

/**
 * Read a bech32m shielded address (`mn_shield-addr_<network>1…`).
 *
 * @param address - The address.
 * @param networkId - When given, the network the address must belong to.
 * @returns Its coin and encryption public keys and its network.
 * @throws {TypeError} When it is not a shielded address, or is on another network.
 */
export const shieldedKeysOf = (address: string, networkId?: string): ShieldedKeys => {
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(address.trim());
  } catch (cause) {
    throw new TypeError("not a Midnight shielded address (mn_shield-addr_…)", { cause });
  }
  const network = String(parsed.network);
  if (networkId !== undefined && network !== networkId) {
    throw new TypeError(`the address is on ${network}, not ${networkId}`);
  }
  let decoded: ShieldedAddress;
  try {
    decoded = parsed.decode(ShieldedAddress, parsed.network);
  } catch (cause) {
    throw new TypeError("not a Midnight shielded address (mn_shield-addr_…)", { cause });
  }
  return {
    coinPublicKey: new Uint8Array(Buffer.from(decoded.coinPublicKeyString(), "hex")),
    encryptionPublicKey: new Uint8Array(Buffer.from(decoded.encryptionPublicKeyString(), "hex")),
    networkId: network,
  };
};

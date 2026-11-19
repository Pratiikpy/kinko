// A card's keys and addresses, derived the way every Midnight wallet derives
// them from a seed: account 0, index 0 of the Zswap, Dust and NightExternal
// roles. Pure: no network.

import * as ledger from "@midnightntwrk/ledger-v9";
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk-hd";
import {
  createKeystore,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

/** Everything a card wallet signs and spends with. */
export interface CardKeys {
  /** The per-wallet seeds the card's wallets start from, as sensitive as the keys below. */
  readonly seeds: WalletSeeds;
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly unshieldedKeystore: UnshieldedKeystore;
}

/** Where a card receives. */
export interface CardAddresses {
  /** Bech32m shielded address: what an issuer or a top-up pays. */
  readonly shielded: string;
  /** Hex, 32 bytes. */
  readonly coinPublicKey: string;
  /** Hex, 32 bytes. */
  readonly encryptionPublicKey: string;
}

/**
 * Derive a card's keys from its HD seed.
 *
 * @param seed - The 64-byte seed from `walletSeed`.
 * @param networkId - The network the unshielded keystore is bound to.
 * @returns The keys.
 * @throws {Error} When the seed is rejected, which a BIP-39 seed never is.
 */
export function deriveCardKeys(seed: Uint8Array, networkId: string): CardKeys {
  const seeds = WalletSeeds.fromMasterSeed(seed);
  return {
    seeds,
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(seeds.shielded),
    dustSecretKey: ledger.DustSecretKey.fromSeed(seeds.dust),
    unshieldedKeystore: createKeystore({ kind: "schnorr", secret: seeds.unshielded }, networkId),
  };
}

/**
 * A card's receiving addresses.
 *
 * @param keys - The card's keys.
 * @param networkId - The network the address is encoded for.
 * @returns The addresses.
 */
export function cardAddresses(keys: CardKeys, networkId: string): CardAddresses {
  const coinPublicKey = keys.shieldedSecretKeys.coinPublicKey;
  const encryptionPublicKey = keys.shieldedSecretKeys.encryptionPublicKey;
  const address = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(encryptionPublicKey),
  );
  return {
    shielded: MidnightBech32m.encode(networkId, address).asString(),
    coinPublicKey,
    encryptionPublicKey,
  };
}

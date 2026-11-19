// The KUSD colour sealed into kinko_pay at deployment.
//
// KUSD is the vault's shielded token for USDC. Its colour is
// tokenType(vaultTokenDomainSeparator(usdcAddress), vaultContractAddress),
// which the compiled kusd_color_for circuit computes. Deriving it here costs
// no transaction, and a deploy script that seals the wrong colour would make
// every KUSD invoice unpayable, so the derivation is the circuit itself.

import { bytesEqual, EVM_ADDRESS_BYTES, fromHex } from "./bytes.ts";
import { pureCircuits } from "./managed/kinko_pay/contract/index.js";

/** The native token's colour: the all-zero token type. */
export const NATIVE_COLOR = new Uint8Array(32);

/**
 * The KUSD colour for a deployed vault.
 *
 * @param usdcAddress - The USDC ERC20 address on Ethereum, 20 bytes of hex.
 * @param vaultContractAddress - The vault's Midnight contract address, 32 bytes of hex.
 * @returns The colour every KUSD coin carries.
 * @throws {Error} When either address has the wrong width or is not hex.
 */
export const kusdColor = (usdcAddress: string, vaultContractAddress: string): Uint8Array =>
  pureCircuits.kusd_color_for(fromHex(usdcAddress, EVM_ADDRESS_BYTES), {
    bytes: fromHex(vaultContractAddress),
  });

/**
 * Whether a coin colour is KUSD for the given sealed colour, for wallets
 * filtering their coins before a payment.
 *
 * @param coinColor - The colour a coin carries.
 * @param sealedKusdColor - The colour read from kinko_pay's ledger.
 * @returns Whether the coin is KUSD.
 */
export const isKusd = (coinColor: Uint8Array, sealedKusdColor: Uint8Array): boolean =>
  bytesEqual(coinColor, sealedKusdColor);

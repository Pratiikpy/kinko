// A payout address for tests: a shielded address whose coin key is 0x12…12.

import { fromHex, shieldedAddressFor } from "@kinko/kinko-pay";

/** The payout coin public key, hex. */
export const PAYOUT_COIN = "12".repeat(32);
/** Its encryption public key, hex. */
export const PAYOUT_ENC = "13".repeat(32);
/** The shielded address carrying both. */
export const PAYOUT_ADDRESS = shieldedAddressFor(
  fromHex(PAYOUT_COIN),
  fromHex(PAYOUT_ENC),
  "undeployed",
);

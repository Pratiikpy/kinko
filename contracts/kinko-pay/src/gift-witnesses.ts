// Private-state witnesses for kinko_gift.

import type { Witnesses } from "./managed/kinko_gift/contract/index.js";

/** What an issuer keeps locally while issuing or voiding a card. */
export interface GiftPrivateState {
  /** The card. Whoever holds it holds the money. */
  readonly cardSecret: Uint8Array;
  /** The issuer's secret. Its hash is the issuer's public id. */
  readonly issuerSecret: Uint8Array;
}

/** Witness implementations for kinko_gift, typed against the generated shape. */
export const giftWitnesses: Witnesses<GiftPrivateState> = {
  card_secret: ({ privateState }) => [privateState, privateState.cardSecret],
  issuer_secret: ({ privateState }) => [privateState, privateState.issuerSecret],
};

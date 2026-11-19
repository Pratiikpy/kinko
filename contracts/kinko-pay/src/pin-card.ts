// A PIN card as it is handed over or printed.
//
// The card's 32 bytes go on the card; the PIN never does. Neither opens the
// card's wallet alone: @kinko/card stretches the two together. The encoded
// form belongs in a URL fragment or a QR code, which browsers never send to a
// server.

import { isBirth } from "./birth.ts";
import { decodeLinkPayload, encodeLinkPayload } from "./bytes.ts";

/** A PIN card as decoded from its link: everything except the PIN. */
export interface PinCardLink {
  /** The card's 32 bytes, hex. */
  readonly secret: string;
  /** Where on the chain the card was made, when its owner stamped it. */
  readonly birth?: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * Encode a PIN card for printing or handing over.
 *
 * @param secret - The card's 32 bytes, hex.
 * @param birth - Where on the chain the card was made, from the snapshot service.
 * @returns The payload for a link's fragment.
 * @throws {Error} When the secret is not 32 bytes of hex, or the birth is malformed.
 */
export const encodePinCard = (secret: string, birth?: string): string => {
  if (!HEX32.test(secret)) throw new Error("A card secret is 32 bytes of hex.");
  if (birth !== undefined && !isBirth(birth)) throw new Error("A card's birth is malformed.");
  return encodeLinkPayload({ v: 2, k: "pin", s: secret, b: birth });
};

/**
 * Decode a PIN card produced by {@link encodePinCard}.
 *
 * @param encoded - The payload, or a full link carrying it in its fragment.
 * @returns The card, or undefined when this is not a PIN card.
 */
export const decodePinCard = (encoded: string): PinCardLink | undefined => {
  const raw = decodeLinkPayload(encoded) as
    { v?: unknown; k?: unknown; s?: unknown; b?: unknown } | undefined;
  if (raw?.v !== 2 || raw.k !== "pin" || typeof raw.s !== "string" || !HEX32.test(raw.s)) {
    return undefined;
  }
  // A birth that is not well-formed is dropped, not refused: the card still opens, from the start.
  return { secret: raw.s, ...(isBirth(raw.b) ? { birth: raw.b } : {}) };
};

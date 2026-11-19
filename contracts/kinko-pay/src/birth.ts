// A card's birth: where on the chain it was made, so it can start its wallet from there.
//
// `<event id>-<chain>`, as the snapshot service stamps it (see @kinko/snapshots). It rides in the
// card's link beside the secret. It is not secret and carries nothing but a position on a chain.

/** A birth: the last shielded event the published tree had applied, and the chain it was on. */
const BIRTH = /^[0-9]{1,18}-[0-9a-f]{8}$/;

/**
 * @param value - Anything.
 * @returns True when it is a well-formed birth.
 */
export const isBirth = (value: unknown): value is string =>
  typeof value === "string" && BIRTH.test(value);

// Private-state witnesses for kinko_tags.

import type { Witnesses } from "./managed/kinko_tags/contract/index.js";

/** What a tag owner keeps locally. */
export interface TagsPrivateState {
  /** The owner secret. Only its tag-bound hash is ever stored. */
  readonly tagSecret: Uint8Array;
}

/** Witness implementations for kinko_tags, typed against the generated shape. */
export const tagsWitnesses: Witnesses<TagsPrivateState> = {
  tag_secret: ({ privateState }) => [privateState, privateState.tagSecret],
};

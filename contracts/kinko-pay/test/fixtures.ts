// Deployments of kinko_gift and kinko_tags for their suites.

import { createConstructorContext } from "@midnight-ntwrk/compact-runtime";

import {
  type GiftPrivateState,
  giftWitnesses,
  KinkoGift,
  KinkoTags,
  type TagsPrivateState,
  tagsWitnesses,
} from "../src/index.ts";
import { CPK, Harness } from "./harness.ts";

export type GiftHarness = Harness<GiftPrivateState, KinkoGift.Circuits<GiftPrivateState>>;
export type TagsHarness = Harness<TagsPrivateState, KinkoTags.Circuits<TagsPrivateState>>;

export const deployGift = async (initial: GiftPrivateState): Promise<GiftHarness> => {
  const contract = new KinkoGift.Contract<GiftPrivateState>(giftWitnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext(initial, CPK),
  );
  return new Harness(contract.circuits, currentContractState, initial);
};

export const deployTags = async (initial: TagsPrivateState): Promise<TagsHarness> => {
  const contract = new KinkoTags.Contract<TagsPrivateState>(tagsWitnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext(initial, CPK),
  );
  return new Harness(contract.circuits, currentContractState, initial);
};

export const giftLedger = (h: GiftHarness): KinkoGift.Ledger => KinkoGift.ledger(h.charged());
export const tagsLedger = (h: TagsHarness): KinkoTags.Ledger => KinkoTags.ledger(h.charged());

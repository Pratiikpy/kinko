// Kinko's compiled contracts, each bound to its compiler output so it can be
// deployed and proven against. The managed directories are produced by each
// contract package's `yarn compile:zk`.

import { fileURLToPath } from "node:url";

import {
  Contract as DisclosureContract,
  type DisclosurePrivateState,
  witnesses as disclosureWitnesses,
} from "@kinko/kinko-disclosure";
import {
  type GiftPrivateState,
  giftWitnesses,
  KinkoGift,
  KinkoPay,
  KinkoTags,
  type PayPrivateState,
  payWitnesses,
  type TagsPrivateState,
  tagsWitnesses,
} from "@kinko/kinko-pay";
import { makeCompiledContract } from "@sig-net/midnight-contract-deploy";

const managed = (pkg: string, name: string): string =>
  fileURLToPath(new URL(`../../../contracts/${pkg}/src/managed/${name}`, import.meta.url));

/** Compiler output directory of each Kinko contract. */
export const MANAGED_PATHS = {
  pay: managed("kinko-pay", "kinko_pay"),
  tags: managed("kinko-pay", "kinko_tags"),
  gift: managed("kinko-pay", "kinko_gift"),
  disclosure: managed("kinko-disclosure", "kinko_disclosure"),
} as const;

/** The payments contract: invoices, settlement, receipts, refunds, attestations. */
export const payCompiled = makeCompiledContract<
  KinkoPay.Contract<PayPrivateState>,
  PayPrivateState
>("kinko_pay", KinkoPay.Contract, payWitnesses, MANAGED_PATHS.pay);

/** The tag registry. */
export const tagsCompiled = makeCompiledContract<
  KinkoTags.Contract<TagsPrivateState>,
  TagsPrivateState
>("kinko_tags", KinkoTags.Contract, tagsWitnesses, MANAGED_PATHS.tags);

/** Gift cards. */
export const giftCompiled = makeCompiledContract<
  KinkoGift.Contract<GiftPrivateState>,
  GiftPrivateState
>("kinko_gift", KinkoGift.Contract, giftWitnesses, MANAGED_PATHS.gift);

/** Examiner disclosure. */
export const disclosureCompiled = makeCompiledContract<
  DisclosureContract<DisclosurePrivateState>,
  DisclosurePrivateState
>("kinko_disclosure", DisclosureContract, disclosureWitnesses, MANAGED_PATHS.disclosure);

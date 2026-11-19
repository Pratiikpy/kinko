// Kinko Pay's export surface: the three compiled contracts, their witnesses and
// the off-chain helpers the app needs.
//
// Each compiled contract is exported as a namespace because they share names
// (Contract, ledger, pureCircuits, TokenKind). Nothing here touches a Node-only
// API, so the same surface runs in the browser app and in a backend.

export * from "./address.ts";
export * from "./birth.ts";
export * from "./bytes.ts";
export * from "./gift-card.ts";
export * from "./gift-witnesses.ts";
export * from "./kusd.ts";
export * as KinkoGift from "./managed/kinko_gift/contract/index.js";
export * as KinkoPay from "./managed/kinko_pay/contract/index.js";
export * as KinkoTags from "./managed/kinko_tags/contract/index.js";
export * from "./oracle.ts";
export * from "./pay.ts";
export * from "./pay-witnesses.ts";
export * from "./pin-card.ts";
export * from "./tags.ts";
export * from "./tags-witnesses.ts";

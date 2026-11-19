// Gift cards: private bearer notes.
//
// Two things need proving. First, that the card secret really controls the
// money: the same secret always derives the same spending keys, and a
// different secret never does. Second, that the registry proves who issued a
// card, in which asset, without leaking anything, and that knowing an
// issuer's public id is not enough to issue in their name.

import { cardAddresses, deriveCardKeys, walletSeed } from "@kinko/card";
import { describe, expect, it } from "vitest";

import {
  coinPublicKeyForCard,
  createGiftCard,
  decodeGiftCard,
  encodeGiftCard,
  encryptionPublicKeyForCard,
  giftCommitmentOf,
  issuerIdOf,
  keysForCard,
  KinkoGift,
} from "../src/index.ts";
import { deployGift, type GiftHarness, giftLedger } from "./fixtures.ts";
import { bytes32, hex } from "./harness.ts";

const { TokenKind } = KinkoGift;
const SECRET = bytes32(0xc1);
const ISSUER = bytes32(0x11);

const issuerState = { cardSecret: SECRET, issuerSecret: ISSUER };
const fresh = () => deployGift(issuerState);

describe("the card controls the money", () => {
  it("derives spending keys from the card secret", () => {
    const card = createGiftCard(ISSUER);
    expect(card.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(card.coinPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(card.encryptionPublicKey.length).toBeGreaterThan(0);
    expect(card.token).toBe(TokenKind.KUSD);
  });

  it("the same secret always derives the same keys", () => {
    const card = createGiftCard(ISSUER);
    expect(coinPublicKeyForCard(card.secret)).toBe(card.coinPublicKey);
    expect(encryptionPublicKeyForCard(card.secret)).toBe(card.encryptionPublicKey);
    expect(keysForCard(card.secret).coinSecretKey).toBeDefined();
  });

  it("a different secret never derives the same key", () => {
    const keys = new Set(Array.from({ length: 25 }, () => createGiftCard(ISSUER).coinPublicKey));
    expect(keys.size).toBe(25);
  });

  it("is the wallet the card's recovery phrase opens in any Midnight wallet", () => {
    const card = createGiftCard(ISSUER);
    const wallet = cardAddresses(
      deriveCardKeys(walletSeed(Buffer.from(card.secret, "hex")), "undeployed"),
      "undeployed",
    );
    expect(card.coinPublicKey).toBe(wallet.coinPublicKey);
    expect(card.encryptionPublicKey).toBe(wallet.encryptionPublicKey);
  });

  it("rejects a malformed secret rather than deriving a key nobody owns", () => {
    for (const bad of ["", "abc", "zz".repeat(32), "ab".repeat(31)]) {
      expect(() => keysForCard(bad)).toThrow();
    }
  });
});

describe("handing a card over", () => {
  it("round-trips through an encoded card, including from a full link", () => {
    const card = createGiftCard(ISSUER, TokenKind.NATIVE);
    const encoded = encodeGiftCard(card, "cd".repeat(32));
    const decoded = decodeGiftCard(`https://kinko.example/gift#${encoded}`);
    expect(decoded).toEqual({
      secret: card.secret,
      token: TokenKind.NATIVE,
      issuerId: card.issuerId,
      contractAddress: "cd".repeat(32),
    });
  });

  it("carries the birth its issuer stamped, and opens from the start when it is damaged", () => {
    const card = createGiftCard(ISSUER, TokenKind.KUSD);
    const birth = "1996141-1a2b3c4d";
    expect(decodeGiftCard(encodeGiftCard(card, "cd".repeat(32), birth))?.birth).toBe(birth);
    expect(decodeGiftCard(encodeGiftCard(card, "cd".repeat(32)))).not.toHaveProperty("birth");
    expect(() => encodeGiftCard(card, undefined, "yesterday")).toThrow(/birth/);
    const damaged = Buffer.from(
      JSON.stringify({ v: 2, s: card.secret, t: TokenKind.KUSD, i: card.issuerId, b: "x" }),
    ).toString("base64url");
    expect(decodeGiftCard(damaged)?.secret).toBe(card.secret);
    expect(decodeGiftCard(damaged)).not.toHaveProperty("birth");
  });

  it("refuses a version-1 card, whose keys were not a wallet's", () => {
    const card = createGiftCard(ISSUER);
    const v1 = Buffer.from(
      JSON.stringify({ v: 1, s: card.secret, t: card.token, i: card.issuerId }),
    ).toString("base64url");
    expect(decodeGiftCard(v1)).toBeUndefined();
  });

  it("returns undefined for junk rather than throwing", () => {
    for (const bad of ["", "not-base64!!", "aGVsbG8", "#", "eyJ2IjoxLCJzIjoic2hvcnQifQ"]) {
      expect(decodeGiftCard(bad)).toBeUndefined();
    }
  });
});

describe("the registry", () => {
  it("registers a card the recipient can verify from the card alone", async () => {
    const h = await fresh();
    const c = await h.call("issue", TokenKind.KUSD);
    expect(hex(c)).toBe(hex(giftCommitmentOf(issuerIdOf(ISSUER), TokenKind.KUSD, hex(SECRET))));
    expect(await h.call("card_issued", c)).toBe(true);
    expect(giftLedger(h).issued).toBe(1n);
  });

  it("a card prepared off-chain registers under the commitment it predicted", async () => {
    const card = createGiftCard(ISSUER);
    const h = await deployGift({
      cardSecret: Buffer.from(card.secret, "hex"),
      issuerSecret: ISSUER,
    });
    expect(hex(await h.call("issue", TokenKind.KUSD))).toBe(card.commitment);
  });

  it("REFUSES issuing the same card twice", async () => {
    const h = await fresh();
    await h.call("issue", TokenKind.KUSD);
    await expect(h.call("issue", TokenKind.KUSD)).rejects.toThrow("card already issued");
  });

  it("binds the asset: a KUSD card does not verify as a NIGHT card", async () => {
    const h = await fresh();
    await h.call("issue", TokenKind.KUSD);
    const asNative = giftCommitmentOf(issuerIdOf(ISSUER), TokenKind.NATIVE, hex(SECRET));
    expect(await h.call("card_issued", asNative)).toBe(false);
  });

  it("a recipient who knows the issuer id cannot issue in the issuer's name", async () => {
    // The recipient holds the issuer's public id, not the issuer secret, and
    // issuing derives the id from the secret. Whatever they register lands
    // under some other id.
    const h = await fresh();
    h.as({ cardSecret: bytes32(0xc9), issuerSecret: issuerIdOf(ISSUER) });
    const c = await h.call("issue", TokenKind.KUSD);
    expect(hex(c)).not.toBe(
      hex(giftCommitmentOf(issuerIdOf(ISSUER), TokenKind.KUSD, hex(bytes32(0xc9)))),
    );
  });

  it("lets the issuer void a card", async () => {
    const h = await fresh();
    const c = await h.call("issue", TokenKind.KUSD);
    await h.call("void_card", TokenKind.KUSD);
    expect(await h.call("card_voided", c)).toBe(true);
  });

  it("REFUSES voiding by anyone but the issuer, including the card holder", async () => {
    const h = await fresh();
    await h.call("issue", TokenKind.KUSD);
    h.as({ issuerSecret: bytes32(0x99) });
    await expect(h.call("void_card", TokenKind.KUSD)).rejects.toThrow("unknown card");
  });

  it("REFUSES voiding twice, and voiding a card never issued", async () => {
    const h = await fresh();
    await expect(h.call("void_card", TokenKind.KUSD)).rejects.toThrow("unknown card");
    await h.call("issue", TokenKind.KUSD);
    await h.call("void_card", TokenKind.KUSD);
    await expect(h.call("void_card", TokenKind.KUSD)).rejects.toThrow("card already void");
  });

  it("an unregistered card does not verify", async () => {
    const h = await fresh();
    expect(await h.call("card_issued", bytes32(0xee))).toBe(false);
    expect(await h.call("card_voided", bytes32(0xee))).toBe(false);
  });
});

describe("privacy", () => {
  it("publishes no card secret, no issuer secret and no issuer id", async () => {
    const h: GiftHarness = await fresh();
    const c = await h.call("issue", TokenKind.KUSD);
    await h.call("void_card", TokenKind.KUSD);
    const view = h.observerView();
    expect(view).toContain(hex(c)); // sighted
    expect(view).not.toContain(hex(SECRET));
    expect(view).not.toContain(hex(ISSUER));
    expect(view).not.toContain(hex(issuerIdOf(ISSUER)));
  });

  it("publishes NO value at all: there is no vault to watch", async () => {
    const h = await fresh();
    await h.call("issue", TokenKind.KUSD);
    h.as({ cardSecret: bytes32(0xc2) });
    await h.call("issue", TokenKind.KUSD);
    expect(Object.keys(giftLedger(h)).sort()).toEqual(["cards", "issued", "voided"]);
    expect(h.calls.every((c) => c.zswapOutputs.length === 0)).toBe(true);
  });

  it("two cards from one issuer are unlinkable in the registry", async () => {
    const h = await fresh();
    const a = await h.call("issue", TokenKind.KUSD);
    h.as({ cardSecret: bytes32(0xc2) });
    const b = await h.call("issue", TokenKind.KUSD);
    expect(hex(a)).not.toBe(hex(b));
    expect(giftLedger(h).cards.size()).toBe(2n);
  });
});

import { mnemonicToSeedSync } from "@scure/bip39";
import { deriveAccountKeys, deriveAddresses } from "@sig-net/midnight-contract-deploy";
import { describe, expect, it } from "vitest";

import { cardAddresses, deriveCardKeys } from "../src/keys.ts";
import {
  cardEntropy,
  entropyOfPhrase,
  newCardSecret,
  pinProblem,
  recoveryPhrase,
  walletSeed,
} from "../src/seed.ts";

const secret = (byte: number) => new Uint8Array(32).fill(byte);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("pinProblem", () => {
  it("accepts six to twelve digits that are not a pattern", () => {
    expect(pinProblem("204817")).toBeUndefined();
    expect(pinProblem("830215947361")).toBeUndefined();
  });

  it("names what is wrong with a refused PIN", () => {
    expect(pinProblem("20481")).toBe("length");
    expect(pinProblem("8302159473612")).toBe("length");
    expect(pinProblem("2048a7")).toBe("digits");
    expect(pinProblem("000000")).toBe("guessable");
    expect(pinProblem("123456")).toBe("guessable");
    expect(pinProblem("890123")).toBe("guessable");
    expect(pinProblem("654321")).toBe("guessable");
  });
});

describe("cardEntropy", () => {
  it("is a gift card's own secret", async () => {
    expect(hex(await cardEntropy({ kind: "gift", secret: secret(7) }))).toBe("07".repeat(32));
  });

  it("stretches a PIN card's secret and PIN to fixed bytes", async () => {
    const a = await cardEntropy({ kind: "pin", secret: secret(7), pin: "204817" });
    expect(hex(a)).toBe(hex(await cardEntropy({ kind: "pin", secret: secret(7), pin: "204817" })));
    expect(hex(a)).toMatchInlineSnapshot(
      `"389ec3966664dde39ab6733f93d4ce9773944501d804cb34366ee273b0b4ca34"`,
    );
  });

  it("gives another wallet for another PIN or another card", async () => {
    const base = hex(await cardEntropy({ kind: "pin", secret: secret(7), pin: "204817" }));
    expect(hex(await cardEntropy({ kind: "pin", secret: secret(7), pin: "204818" }))).not.toBe(
      base,
    );
    expect(hex(await cardEntropy({ kind: "pin", secret: secret(8), pin: "204817" }))).not.toBe(
      base,
    );
    expect(base).not.toBe("07".repeat(32));
  });

  it("refuses a secret of the wrong size and a refused PIN", async () => {
    await expect(cardEntropy({ kind: "gift", secret: new Uint8Array(31) })).rejects.toThrow(
      /32 bytes/,
    );
    await expect(cardEntropy({ kind: "pin", secret: secret(7), pin: "111111" })).rejects.toThrow(
      /guessable/,
    );
  });
});

describe("recovery phrase", () => {
  it("is 24 words that round-trip to the same entropy", () => {
    const entropy = newCardSecret();
    const phrase = recoveryPhrase(entropy);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(hex(entropyOfPhrase(`  ${phrase.toUpperCase()}  `) ?? new Uint8Array())).toBe(
      hex(entropy),
    );
  });

  it("refuses a phrase that is not 24 valid words", () => {
    const phrase = recoveryPhrase(secret(1));
    expect(entropyOfPhrase(phrase.split(" ").slice(0, 12).join(" "))).toBeUndefined();
    expect(entropyOfPhrase(phrase.replace(/\S+$/, "zoo"))).toBeUndefined();
    expect(entropyOfPhrase("")).toBeUndefined();
  });

  it("opens the same seed a wallet derives from the phrase", () => {
    const phrase = recoveryPhrase(secret(3));
    expect(hex(walletSeed(secret(3)))).toBe(hex(mnemonicToSeedSync(phrase)));
  });
});

describe("card keys", () => {
  it("derive one fixed shielded address per card", () => {
    const keys = deriveCardKeys(walletSeed(secret(7)), "undeployed");
    const again = deriveCardKeys(walletSeed(secret(7)), "undeployed");
    const a = cardAddresses(keys, "undeployed");
    expect(a).toEqual(cardAddresses(again, "undeployed"));
    expect(a.shielded).toMatch(/^mn_shield-addr_undeployed1/);
    expect(a.coinPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.shielded).toMatchInlineSnapshot(
      `"mn_shield-addr_undeployed1gtnajzyhxv2yts4j9kh5teac9khazqg0lu2j9eq4fnwtd63rzdjssdm9e6chk4laefg99z4x6j88fcugzgfftsssq2jrp99zzpeu5sckugucx"`,
    );
  });

  it("are the keys any Midnight wallet opens from the card's recovery phrase", () => {
    const phrase = recoveryPhrase(secret(7));
    const wallet = deriveAddresses(deriveAccountKeys(phrase, "undeployed"), "undeployed");
    const card = cardAddresses(deriveCardKeys(walletSeed(secret(7)), "undeployed"), "undeployed");
    expect(card.shielded).toBe(wallet.shielded);
  });

  it("differ between cards", () => {
    const a = cardAddresses(deriveCardKeys(walletSeed(secret(7)), "undeployed"), "undeployed");
    const b = cardAddresses(deriveCardKeys(walletSeed(secret(8)), "undeployed"), "undeployed");
    expect(a.coinPublicKey).not.toBe(b.coinPublicKey);
  });
});

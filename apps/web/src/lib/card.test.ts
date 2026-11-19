import { recoveryPhrase } from "@kinko/card/seed";
import { encodeGiftCard, encodePinCard, KinkoGift } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { entropyOf, parseCardInput } from "./card.ts";

const SECRET = "c1".repeat(32);
const ISSUER = "11".repeat(32);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("parseCardInput", () => {
  it("reads a gift card link", () => {
    const link = `https://kinko.example/gift#${encodeGiftCard({ secret: SECRET, token: KinkoGift.TokenKind.KUSD, issuerId: ISSUER })}`;
    expect(parseCardInput(link)).toMatchObject({ kind: "gift", secret: SECRET, issuerId: ISSUER });
  });

  it("reads a PIN card link", () => {
    expect(parseCardInput(`https://kinko.example/card#${encodePinCard(SECRET)}`)).toEqual({
      kind: "pin",
      secret: SECRET,
    });
  });

  it("reads the birth a card's link carries, and nothing when it carries none", () => {
    const birth = "1996141-1a2b3c4d";
    expect(parseCardInput(`https://kinko.example/card#${encodePinCard(SECRET, birth)}`)).toEqual({
      kind: "pin",
      secret: SECRET,
      birth,
    });
    const gift = encodeGiftCard(
      { secret: SECRET, token: KinkoGift.TokenKind.KUSD, issuerId: ISSUER },
      undefined,
      birth,
    );
    expect(parseCardInput(`https://kinko.example/gift#${gift}`)).toMatchObject({
      kind: "gift",
      birth,
    });
    expect(
      parseCardInput(`https://kinko.example/card#${encodePinCard(SECRET)}`),
    ).not.toHaveProperty("birth");
  });

  it("reads the birth that follows a recovery phrase, and keeps the same card", () => {
    const phrase = recoveryPhrase(new Uint8Array(32).fill(5));
    const birth = "1996141-1a2b3c4d";
    const parsed = parseCardInput(`${phrase} ${birth}`);
    expect(parsed?.kind === "phrase" ? hex(parsed.entropy) : "").toBe("05".repeat(32));
    expect(parsed).toHaveProperty("birth", birth);
    expect(parseCardInput(phrase)).not.toHaveProperty("birth");
  });

  it("refuses a phrase whose last word is not a birth and not a word", () => {
    const phrase = recoveryPhrase(new Uint8Array(32).fill(5));
    expect(parseCardInput(`${phrase} 1996141`)).toBeUndefined();
  });

  it("reads a recovery phrase, whatever its spacing or case", () => {
    const phrase = recoveryPhrase(new Uint8Array(32).fill(5));
    const parsed = parseCardInput(`  ${phrase.toUpperCase().replace(/ /g, "   ")} `);
    expect(parsed?.kind).toBe("phrase");
    expect(parsed?.kind === "phrase" ? hex(parsed.entropy) : "").toBe("05".repeat(32));
  });

  it("reads nothing from junk", () => {
    for (const bad of ["", "   ", "hello", "https://kinko.example/pay#abc", SECRET]) {
      expect(parseCardInput(bad)).toBeUndefined();
    }
  });
});

describe("entropyOf", () => {
  it("is a gift card's own secret", async () => {
    const input = parseCardInput(
      encodeGiftCard({ secret: SECRET, token: KinkoGift.TokenKind.KUSD, issuerId: ISSUER }),
    );
    if (!input) throw new Error("the gift card did not parse");
    expect(hex(await entropyOf(input))).toBe(SECRET);
  });

  it("asks a PIN card for its PIN, and stretches it", async () => {
    const input = { kind: "pin" as const, secret: SECRET };
    await expect(entropyOf(input)).rejects.toThrow(/PIN/);
    const a = hex(await entropyOf(input, "204817"));
    expect(a).not.toBe(SECRET);
    expect(hex(await entropyOf(input, "204817"))).toBe(a);
  });
});

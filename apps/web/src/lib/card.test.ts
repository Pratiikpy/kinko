import { recoveryPhrase } from "@kinko/card/seed";
import { encodeGiftCard, encodePinCard, KinkoGift } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { entropyOf, parseCardInput, withoutBirth } from "./card.ts";

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

  it("reads a birth as a holder may have typed it, and drops one it cannot read", () => {
    const phrase = recoveryPhrase(new Uint8Array(32).fill(5));
    for (const typed of [
      "1996141-1A2B3C4D",
      "birth:1996141-1a2b3c4d",
      "Birth: 1996141-1a2b3c4d".replace(": ", ":"),
      "1996141-1a2b3c4d.",
    ]) {
      expect(parseCardInput(`${phrase} ${typed}`)).toHaveProperty("birth", "1996141-1a2b3c4d");
    }
    // A damaged birth does not make a right phrase wrong: the card opens, the slow way.
    for (const typed of ["1996141", "1996141-1a2b3c4", "soon"]) {
      const parsed = parseCardInput(`${phrase} ${typed}`);
      expect(parsed?.kind).toBe("phrase");
      expect(parsed).not.toHaveProperty("birth");
    }
  });

  it("is not a card when the words are wrong, with or without a birth", () => {
    const words = recoveryPhrase(new Uint8Array(32).fill(5)).split(" ");
    expect(parseCardInput(`${words.slice(0, 23).join(" ")} 1996141-1a2b3c4d`)).toBeUndefined();
    expect(parseCardInput(`${words.slice(0, 22).join(" ")} notaword`)).toBeUndefined();
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

describe("withoutBirth", () => {
  const birth = "1996141-1a2b3c4d";
  it("opens any kind of card the slow way, keeping everything else", () => {
    expect(withoutBirth({ kind: "pin", secret: SECRET, birth })).toEqual({
      kind: "pin",
      secret: SECRET,
    });
    const entropy = new Uint8Array(32).fill(5);
    expect(withoutBirth({ kind: "phrase", entropy, birth })).toEqual({ kind: "phrase", entropy });
    const gift = parseCardInput(
      `https://kinko.example/gift#${encodeGiftCard({ secret: SECRET, token: KinkoGift.TokenKind.KUSD, issuerId: ISSUER }, undefined, birth)}`,
    );
    expect(gift).toHaveProperty("birth", birth);
    if (gift === undefined) throw new Error("the gift link was not read");
    const slow = withoutBirth(gift);
    expect(slow).toMatchObject({ kind: "gift", secret: SECRET, issuerId: ISSUER });
    expect(slow).not.toHaveProperty("birth");
  });
});

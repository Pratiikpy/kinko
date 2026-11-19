import { describe, expect, it } from "vitest";

import { decodeGiftCard, decodePinCard, encodePinCard } from "../src/index.ts";

const SECRET = "ab".repeat(32);

describe("PIN card links", () => {
  it("round-trip the card, from the payload or a full link", () => {
    const payload = encodePinCard(SECRET);
    expect(decodePinCard(payload)).toEqual({ secret: SECRET });
    expect(decodePinCard(`https://kinko.example/card#${payload}`)).toEqual({ secret: SECRET });
  });

  it("carry the birth stamped on the card, and leave it out when there is none", () => {
    const birth = "1996141-1a2b3c4d";
    expect(decodePinCard(encodePinCard(SECRET, birth))).toEqual({ secret: SECRET, birth });
    expect(decodePinCard(encodePinCard(SECRET))).not.toHaveProperty("birth");
    expect(() => encodePinCard(SECRET, "soon")).toThrow(/birth/);
  });

  it("open from the start when a link's birth is damaged", () => {
    const damaged = Buffer.from(
      JSON.stringify({ v: 2, k: "pin", s: SECRET, b: "not-a-birth" }),
    ).toString("base64url");
    expect(decodePinCard(damaged)).toEqual({ secret: SECRET });
  });

  it("never carry a PIN", () => {
    const json = Buffer.from(encodePinCard(SECRET), "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual(["k", "s", "v"]);
    const stamped = Buffer.from(encodePinCard(SECRET, "7-1a2b3c4d"), "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(stamped) as object).sort()).toEqual(["b", "k", "s", "v"]);
  });

  it("are not mistaken for gift cards, and gift cards are not mistaken for them", () => {
    expect(decodeGiftCard(encodePinCard(SECRET))).toBeUndefined();
    const gift = Buffer.from(JSON.stringify({ v: 2, s: SECRET, t: 1, i: SECRET })).toString(
      "base64url",
    );
    expect(decodePinCard(gift)).toBeUndefined();
  });

  it("refuse a malformed secret, and junk", () => {
    expect(() => encodePinCard("abc")).toThrow(/32 bytes/);
    for (const bad of ["", "#", "not-base64!!", encodePinCard(SECRET).slice(0, 10)]) {
      expect(decodePinCard(bad)).toBeUndefined();
    }
  });
});

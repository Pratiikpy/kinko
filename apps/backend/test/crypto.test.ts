import { describe, expect, it } from "vitest";

import {
  generateApiKey,
  generateAttachToken,
  generateLinkCode,
  generateWebhookSecret,
  newId,
  normaliseLinkCode,
  safeEqual,
  sha256Hex,
  Vault,
} from "../src/domain/crypto.ts";
import { computeSignature, signHeader } from "../src/domain/signing.ts";

const KEY = "ab".repeat(32);

describe("Vault", () => {
  it("opens what it sealed", () => {
    const vault = new Vault(KEY);
    expect(vault.open(vault.seal("whsec_example"))).toBe("whsec_example");
  });

  it("seals the same text differently each time, so equal secrets are not linkable", () => {
    const vault = new Vault(KEY);
    expect(vault.seal("same")).not.toBe(vault.seal("same"));
  });

  it("refuses a value sealed under a different key", () => {
    const sealed = new Vault(KEY).seal("secret");
    expect(() => new Vault("cd".repeat(32)).open(sealed)).toThrow(/wrong data key or tampered/);
  });

  it("refuses a value that was altered", () => {
    const vault = new Vault(KEY);
    const [v, nonce, tag, body] = vault.seal("secret").split(".");
    const flipped = `${body?.slice(0, -2) ?? ""}AA`;
    expect(() => vault.open([v, nonce, tag, flipped].join("."))).toThrow(/tampered/);
  });

  it("refuses malformed input and malformed keys", () => {
    expect(() => new Vault(KEY).open("not-sealed")).toThrow(/malformed/);
    expect(() => new Vault("short")).toThrow(/64 hex/);
    expect(() => new Vault("zz".repeat(32))).toThrow(/64 hex/);
  });

  it("does not put the plaintext in what it stores", () => {
    expect(new Vault(KEY).seal("whsec_visible")).not.toContain("whsec_visible");
  });
});

describe("credentials", () => {
  it("draws API keys that are unique, marked, and stored only as a hash", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^kk_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).toBe(sha256Hex(a.key));
    expect(a.hash).not.toContain(a.key.slice(3, 12));
    expect(a.prefix).toBe(a.key.slice(3, 11));
  });

  it("draws webhook secrets and attach tokens with their markers", () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateAttachToken()).toMatch(/^at_[A-Za-z0-9_-]{32}$/);
  });

  it("makes identifiers with a readable prefix", () => {
    expect(newId("cs")).toMatch(/^cs_[0-9a-f]{32}$/);
    expect(newId("key", 8)).toMatch(/^key_[0-9a-f]{16}$/);
  });

  it("compares in constant time and rejects different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("link codes", () => {
  it("draws codes in three groups of four from an unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++)
      expect(generateLinkCode()).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      );
  });

  it("forgives case, spaces and look-alike letters when a person types one", () => {
    expect(normaliseLinkCode("k7qm 4xd2 9ptv")).toBe("K7QM-4XD2-9PTV");
    expect(normaliseLinkCode("K7QM4XD29PTV")).toBe("K7QM-4XD2-9PTV");
    expect(normaliseLinkCode("O1IL-0000-0000")).toBe("0111-0000-0000");
  });

  it("refuses what cannot be a code", () => {
    expect(normaliseLinkCode("")).toBeUndefined();
    expect(normaliseLinkCode("K7QM-4XD2")).toBeUndefined();
    expect(normaliseLinkCode("K7QM-4XD2-9PTV-AAAA")).toBeUndefined();
    expect(normaliseLinkCode("K7QM-4XD2-9PT!")).toBeUndefined();
  });

  it("round-trips: whatever is drawn normalises to itself", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateLinkCode();
      expect(normaliseLinkCode(code)).toBe(code);
    }
  });
});

describe("webhook signatures", () => {
  it("signs the timestamp together with the body", () => {
    const header = signHeader("whsec_x", '{"a":1}', 1_700_000_000_999);
    expect(header).toBe(`t=1700000000,v1=${computeSignature("whsec_x", 1_700_000_000, '{"a":1}')}`);
  });

  it("changes when the body, the secret or the timestamp changes", () => {
    const base = computeSignature("s", 1, "body");
    expect(computeSignature("s", 1, "bodY")).not.toBe(base);
    expect(computeSignature("t", 1, "body")).not.toBe(base);
    expect(computeSignature("s", 2, "body")).not.toBe(base);
  });

  it("matches an independent HMAC-SHA256 computation", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", "k").update("1700000000.{}").digest("hex");
    expect(computeSignature("k", 1_700_000_000, "{}")).toBe(expected);
  });
});

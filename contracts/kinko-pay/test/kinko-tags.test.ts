// Tags: pay @alice instead of sharing an address.
//
// The cases that lose money are the ones tested hardest: squatting a name
// someone already holds, registering a lookalike, a stranger repointing a tag
// at their own keys, and a transfer that leaves payments flowing to the
// previous owner.

import { describe, expect, it } from "vitest";

import { normaliseTag, ownsTag, resolveTag, tagBytes, tagName, tagOwnerOf } from "../src/index.ts";
import { deployTags, type TagsHarness, tagsLedger } from "./fixtures.ts";
import { bytes32, fail, hex } from "./harness.ts";

const ALICE_SECRET = bytes32(0xa1);
const BOB_SECRET = bytes32(0xb1);
const ALICE_COIN = { bytes: bytes32(0x0a) };
const ALICE_ENC = bytes32(0x1a);
const BOB_COIN = { bytes: bytes32(0x0b) };
const BOB_ENC = bytes32(0x1b);
const EMPTY = { bytes: new Uint8Array(32) };

const raw = (text: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(text));
  return out;
};

const withAlice = async (): Promise<{ h: TagsHarness; tag: Uint8Array }> => {
  const h = await deployTags({ tagSecret: ALICE_SECRET });
  const tag = tagBytes("@alice");
  await h.call("register_tag", tag, ALICE_COIN, ALICE_ENC);
  return { h, tag };
};

describe("normalisation off-chain, checked by the compiled circuit", () => {
  it("drops one '@', trims and lowercases", () => {
    const t = normaliseTag("  @Alice_01 ");
    expect(t.ok && t.name).toBe("alice_01");
    expect(t.ok && hex(t.bytes)).toBe(hex(raw("alice_01")));
    expect(tagName(raw("alice_01"))).toBe("alice_01");
  });

  it("refuses what it cannot represent rather than rewriting it", () => {
    expect(normaliseTag("")).toEqual({ ok: false, error: "empty" });
    expect(normaliseTag("@")).toEqual({ ok: false, error: "empty" });
    for (const bad of [
      "al",
      "a".repeat(21),
      "al ice",
      "al-ice",
      "ålice",
      "@@alice",
      "alice!",
      "x".repeat(40),
    ]) {
      expect({ bad, tag: normaliseTag(bad) }).toEqual({
        bad,
        tag: { ok: false, error: "invalid" },
      });
    }
    for (const good of ["abc", "a".repeat(20), "user_2026", "___"]) {
      expect({ good, ok: normaliseTag(good).ok }).toEqual({ good, ok: true });
    }
    expect(() => tagBytes("no")).toThrow(/not a valid tag/);
  });
});

describe("register_tag", () => {
  it("registers a tag that resolves to its receiving keys", async () => {
    const { h, tag } = await withAlice();
    const resolved = resolveTag(tagsLedger(h), "@ALICE");
    expect(resolved && hex(resolved.coinPublicKey)).toBe(hex(ALICE_COIN.bytes));
    expect(resolved && hex(resolved.encryptionPublicKey)).toBe(hex(ALICE_ENC));
    expect(hex(tagsLedger(h).tags.lookup(tag).owner)).toBe(hex(tagOwnerOf(tag, ALICE_SECRET)));
    expect(ownsTag(tagsLedger(h), tag, ALICE_SECRET)).toBe(true);
    expect(ownsTag(tagsLedger(h), tag, BOB_SECRET)).toBe(false);
  });

  it("does not resolve an unregistered or invalid name", async () => {
    const { h } = await withAlice();
    expect(resolveTag(tagsLedger(h), "@bob")).toBeUndefined();
    expect(resolveTag(tagsLedger(h), "@a")).toBeUndefined();
  });

  it("REFUSES a tag that is already registered", async () => {
    const { h, tag } = await withAlice();
    h.as({ tagSecret: BOB_SECRET });
    await expect(h.call("register_tag", tag, BOB_COIN, BOB_ENC)).rejects.toThrow(
      "tag is already registered",
    );
  });

  it("REFUSES the empty tag", async () => {
    const h = await deployTags({ tagSecret: ALICE_SECRET });
    await expect(h.call("register_tag", new Uint8Array(32), ALICE_COIN, ALICE_ENC)).rejects.toThrow(
      "tag is empty",
    );
  });

  it("REFUSES every non-canonical form on chain, so no lookalike can sit beside a real tag", async () => {
    const h = await deployTags({ tagSecret: ALICE_SECRET });
    const ninePlusZeroGap = raw("al");
    ninePlusZeroGap[3] = 0x69; // "al\0i": a character after padding
    const overlong = raw("a".repeat(21));
    for (const bad of [
      raw("Alice"),
      raw("al"),
      raw("al-ice"),
      raw("al ice"),
      ninePlusZeroGap,
      overlong,
      bytes32(0x61),
    ]) {
      await expect(h.call("register_tag", bad, ALICE_COIN, ALICE_ENC)).rejects.toThrow(
        "tag is not in canonical form",
      );
    }
    expect(tagsLedger(h).tags.size()).toBe(0n);
  });

  it("REFUSES empty receiving keys", async () => {
    const h = await deployTags({ tagSecret: ALICE_SECRET });
    await expect(h.call("register_tag", tagBytes("alice"), EMPTY, ALICE_ENC)).rejects.toThrow(
      "receiving keys are empty",
    );
    await expect(
      h.call("register_tag", tagBytes("alice"), ALICE_COIN, new Uint8Array(32)),
    ).rejects.toThrow("receiving keys are empty");
  });
});

describe("update_tag_keys", () => {
  it("lets the owner point the tag at new keys", async () => {
    const { h, tag } = await withAlice();
    await h.call("update_tag_keys", tag, BOB_COIN, BOB_ENC);
    expect(
      hex((resolveTag(tagsLedger(h), "alice") ?? fail("alice does not resolve")).coinPublicKey),
    ).toBe(hex(BOB_COIN.bytes));
    expect(hex(tagsLedger(h).tags.lookup(tag).owner)).toBe(hex(tagOwnerOf(tag, ALICE_SECRET)));
  });

  it("REFUSES a stranger repointing someone else's tag at their keys", async () => {
    const { h, tag } = await withAlice();
    h.as({ tagSecret: BOB_SECRET });
    await expect(h.call("update_tag_keys", tag, BOB_COIN, BOB_ENC)).rejects.toThrow(
      "not the tag owner",
    );
    expect(
      hex((resolveTag(tagsLedger(h), "alice") ?? fail("alice does not resolve")).coinPublicKey),
    ).toBe(hex(ALICE_COIN.bytes));
  });

  it("REFUSES an unknown tag and empty keys", async () => {
    const { h, tag } = await withAlice();
    await expect(h.call("update_tag_keys", tagBytes("carol"), BOB_COIN, BOB_ENC)).rejects.toThrow(
      "unknown tag",
    );
    await expect(h.call("update_tag_keys", tag, EMPTY, BOB_ENC)).rejects.toThrow(
      "receiving keys are empty",
    );
  });
});

describe("transfer_tag", () => {
  it("hands the tag and its receiving keys to the new owner in one step", async () => {
    const { h, tag } = await withAlice();
    await h.call("transfer_tag", tag, tagOwnerOf(tag, BOB_SECRET), BOB_COIN, BOB_ENC);
    expect(
      hex((resolveTag(tagsLedger(h), "alice") ?? fail("alice does not resolve")).coinPublicKey),
    ).toBe(hex(BOB_COIN.bytes));
    expect(ownsTag(tagsLedger(h), tag, BOB_SECRET)).toBe(true);

    // The previous owner has lost control; the new one has it.
    await expect(h.call("update_tag_keys", tag, ALICE_COIN, ALICE_ENC)).rejects.toThrow(
      "not the tag owner",
    );
    h.as({ tagSecret: BOB_SECRET });
    await expect(h.call("update_tag_keys", tag, BOB_COIN, ALICE_ENC)).resolves.toEqual([]);
  });

  it("REFUSES a transfer by anyone but the owner", async () => {
    const { h, tag } = await withAlice();
    h.as({ tagSecret: BOB_SECRET });
    await expect(
      h.call("transfer_tag", tag, tagOwnerOf(tag, BOB_SECRET), BOB_COIN, BOB_ENC),
    ).rejects.toThrow("not the tag owner");
  });

  it("REFUSES an empty new owner or empty keys, and an unknown tag", async () => {
    const { h, tag } = await withAlice();
    await expect(
      h.call("transfer_tag", tag, new Uint8Array(32), BOB_COIN, BOB_ENC),
    ).rejects.toThrow("new owner is empty");
    await expect(
      h.call("transfer_tag", tag, tagOwnerOf(tag, BOB_SECRET), EMPTY, BOB_ENC),
    ).rejects.toThrow("receiving keys are empty");
    await expect(
      h.call("transfer_tag", tagBytes("carol"), tagOwnerOf(tag, BOB_SECRET), BOB_COIN, BOB_ENC),
    ).rejects.toThrow("unknown tag");
  });
});

describe("release_tag", () => {
  it("frees the tag for the next registrant", async () => {
    const { h, tag } = await withAlice();
    await h.call("release_tag", tag);
    expect(resolveTag(tagsLedger(h), "alice")).toBeUndefined();
    h.as({ tagSecret: BOB_SECRET });
    await h.call("register_tag", tag, BOB_COIN, BOB_ENC);
    expect(ownsTag(tagsLedger(h), tag, BOB_SECRET)).toBe(true);
  });

  it("REFUSES a release by anyone but the owner, and of an unknown tag", async () => {
    const { h, tag } = await withAlice();
    h.as({ tagSecret: BOB_SECRET });
    await expect(h.call("release_tag", tag)).rejects.toThrow("not the tag owner");
    await expect(h.call("release_tag", tagBytes("carol"))).rejects.toThrow("unknown tag");
  });
});

describe("what a tag reveals", () => {
  it("the keys behind a tag are public; the owner secret is not", async () => {
    const { h, tag } = await withAlice();
    await h.call("update_tag_keys", tag, BOB_COIN, BOB_ENC);
    const view = h.observerView();
    expect(view).toContain(hex(BOB_COIN.bytes)); // public by design: sighted
    expect(view).toContain(hex(BOB_ENC));
    expect(view).not.toContain(hex(ALICE_SECRET));
  });

  it("one secret's owner records for two tags are unrelated", async () => {
    const { h } = await withAlice();
    await h.call("register_tag", tagBytes("alice_shop"), ALICE_COIN, ALICE_ENC);
    const l = tagsLedger(h);
    expect(hex(l.tags.lookup(tagBytes("alice")).owner)).not.toBe(
      hex(l.tags.lookup(tagBytes("alice_shop")).owner),
    );
  });
});

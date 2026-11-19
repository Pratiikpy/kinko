import { describe, expect, it } from "vitest";

import { digestHex, keyFromSecret, open, seal } from "./secure-store.ts";

const secret = (fill: number) => new Uint8Array(32).fill(fill);

describe("records encryption", () => {
  it("round-trips a document under the same account secret", async () => {
    const doc = { version: 1, invoices: [{ ownerSecret: "ab".repeat(32) }] };
    const sealed = await seal(await keyFromSecret(secret(7)), doc);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("ownerSecret");
    expect(await open(await keyFromSecret(secret(7)), sealed)).toEqual(doc);
  });

  it("never produces the same ciphertext twice", async () => {
    const key = await keyFromSecret(secret(1));
    expect(await seal(key, { a: 1 })).not.toBe(await seal(key, { a: 1 }));
  });

  it("refuses a different key", async () => {
    const sealed = await seal(await keyFromSecret(secret(1)), { a: 1 });
    await expect(open(await keyFromSecret(secret(2)), sealed)).rejects.toThrow();
  });

  it("refuses a tampered ciphertext and an unknown format", async () => {
    const key = await keyFromSecret(secret(3));
    const sealed = await seal(key, { amount: "100" });
    const [v, iv, ct = ""] = sealed.split(".");
    const flipped = `${v ?? ""}.${iv ?? ""}.${(ct.startsWith("A") ? "B" : "A") + ct.slice(1)}`;
    await expect(open(key, flipped)).rejects.toThrow();
    await expect(open(key, "v2.x.y")).rejects.toThrow(/unknown format/);
  });

  it("names slots by digest, not by account id", async () => {
    const d = await digestHex("kinko:abc");
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(await digestHex("kinko:abc"));
    expect(d).not.toBe(await digestHex("kinko:abd"));
  });
});

import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { describe, expect, it } from "vitest";

import { shieldedKeysOf } from "../src/index.ts";

const COIN = "a1".repeat(32);
const ENC = "b2".repeat(32);
const address = (network: string) =>
  MidnightBech32m.encode(
    network,
    new ShieldedAddress(
      new ShieldedCoinPublicKey(Buffer.from(COIN, "hex")),
      new ShieldedEncryptionPublicKey(Buffer.from(ENC, "hex")),
    ),
  ).asString();

describe("shieldedKeysOf", () => {
  it("reads both keys and the network from a shielded address", () => {
    const keys = shieldedKeysOf(`  ${address("preview")} `);
    expect(Buffer.from(keys.coinPublicKey).toString("hex")).toBe(COIN);
    expect(Buffer.from(keys.encryptionPublicKey).toString("hex")).toBe(ENC);
    expect(keys.networkId).toBe("preview");
  });

  it("refuses an address on another network when one is required", () => {
    expect(() => shieldedKeysOf(address("preview"), "undeployed")).toThrow(
      /on preview, not undeployed/,
    );
  });

  it("refuses text that is not a shielded address", () => {
    for (const junk of ["", "0xabc", "mn_addr_undeployed1qqqq", COIN]) {
      expect(() => shieldedKeysOf(junk)).toThrow(/not a Midnight shielded address/);
    }
  });
});

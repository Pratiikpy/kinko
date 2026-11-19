import { describe, expect, it, vi } from "vitest";

import type * as config from "./config.ts";

// The MPC's published key and the preprod vault are public. The address below is what the live
// relayer returned for this commitment, derived independently in the browser build's own library.
vi.mock("./config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof config>()),
  MPC_PUBLIC_KEY:
    "0x047dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d8432847f591ab25ca454effb522ec2eaf04b7e1c83ba65ae731ea98dd52eb7d458dd4",
  PINNED_VAULT: {
    vaultContractAddress: "9b0c8e579e0118e6a0ea8e67ff9029221a267888aa131c3ddd468c978e9523b8",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    evmVaultAddress: "0xE08c063236e38c0D1B17515826F82D1d3308ce05",
  },
}));

const { assertDepositAddress } = await import("./vault.ts");

const COMMITMENT = "11".repeat(32);
const DERIVED = "0x32Ca21cE8A014243589fFF86d2BE7F39C555B954";

describe("assertDepositAddress", () => {
  it("accepts the address the build derives, whatever its case", async () => {
    await expect(assertDepositAddress(DERIVED, COMMITMENT)).resolves.toBeUndefined();
    await expect(assertDepositAddress(DERIVED.toLowerCase(), COMMITMENT)).resolves.toBeUndefined();
  });

  it("refuses an address a relayer made up, so no USDC is sent to it", async () => {
    await expect(
      assertDepositAddress("0x000000000000000000000000000000000000dEaD", COMMITMENT),
    ).rejects.toThrow(/cannot reproduce/);
  });

  it("refuses the right address for another user's commitment", async () => {
    await expect(assertDepositAddress(DERIVED, "22".repeat(32))).rejects.toThrow(
      /cannot reproduce/,
    );
  });
});

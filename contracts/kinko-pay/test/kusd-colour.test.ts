// The KUSD colour: derived exactly as the vault mints it, and sealed.
//
// kinko_pay is told KUSD's colour at deployment. If the deploy script derived
// it wrong by one byte, every KUSD invoice would be unpayable, and the failure
// would only appear on chain in the middle of a payment. So the derivation is
// checked against the vault's own compiled code (compiled from engine/vault,
// untouched, by `yarn compile`) and against the ledger runtime's tokenType.
//
// The seal is checked from both sides: the constructor refuses a colour that
// would make KUSD payable in NIGHT, and no circuit ever changes the value.

import { readFileSync } from "node:fs";

import { rawTokenType, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  fromHex,
  generateOracleKeypair,
  KinkoPay,
  kusdColor,
  NATIVE_COLOR,
  signQuote,
} from "../src/index.ts";
import { pureCircuits as vault } from "../src/managed/erc20-vault/contract/index.js";
import { bytes32, hex, T0 } from "./harness.ts";
import { base, coin, deployPay, InvoiceKind, KUSD, ledgerOf, TokenKind } from "./pay-fixtures.ts";

// Circle's USDC on Ethereum mainnet and on Sepolia, plus edge-case addresses.
const USDC_ADDRESSES = [
  "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  "00".repeat(20),
  "ff".repeat(20),
] as const;

describe("the colour derivation matches the vault", () => {
  it("vault_token_domain reproduces the vault's vaultTokenDomainSeparator", () => {
    for (const usdc of USDC_ADDRESSES) {
      const address = fromHex(usdc, 20);
      expect(hex(KinkoPay.pureCircuits.vault_token_domain(address))).toBe(
        hex(vault.vaultTokenDomainSeparator(address)),
      );
    }
  });

  it("kusd_color_for equals the ledger's own tokenType over the vault's domain separator", () => {
    for (const usdc of USDC_ADDRESSES) {
      const vaultAddress = sampleContractAddress();
      const domain = vault.vaultTokenDomainSeparator(fromHex(usdc, 20));
      const fromLedger: unknown = rawTokenType(domain, vaultAddress);
      expect(hex(kusdColor(usdc, vaultAddress))).toBe(
        fromLedger instanceof Uint8Array ? hex(fromLedger) : String(fromLedger).toLowerCase(),
      );
    }
  });

  it("accepts 0x-prefixed addresses and gives the same colour", () => {
    const vaultAddress = sampleContractAddress();
    expect(hex(kusdColor(`0x${USDC_ADDRESSES[0]}`, `0x${vaultAddress}`))).toBe(
      hex(kusdColor(USDC_ADDRESSES[0], vaultAddress)),
    );
  });

  it("is deterministic, and differs per token and per vault deployment", () => {
    const vaultA = sampleContractAddress();
    const vaultB = sampleContractAddress();
    const usdc = USDC_ADDRESSES[0];
    expect(hex(kusdColor(usdc, vaultA))).toBe(hex(kusdColor(usdc, vaultA)));
    expect(hex(kusdColor(usdc, vaultA))).not.toBe(hex(kusdColor(usdc, vaultB)));
    expect(hex(kusdColor(usdc, vaultA))).not.toBe(hex(kusdColor(USDC_ADDRESSES[1], vaultA)));
  });

  it("is never the native colour", () => {
    for (const usdc of USDC_ADDRESSES) {
      expect(hex(kusdColor(usdc, sampleContractAddress()))).not.toBe(hex(NATIVE_COLOR));
    }
  });

  it("refuses addresses of the wrong width", () => {
    expect(() => kusdColor("abcd", sampleContractAddress())).toThrow(/expected 20 bytes/);
    expect(() => kusdColor(USDC_ADDRESSES[0], "abcd")).toThrow(/expected 32 bytes/);
    expect(() => kusdColor("zz".repeat(20), sampleContractAddress())).toThrow(/not a hex string/);
  });
});

describe("the seal", () => {
  it("stores the colour given at deployment", async () => {
    const colour = kusdColor(USDC_ADDRESSES[1], sampleContractAddress());
    const h = await deployPay(base(), undefined, colour);
    expect(hex(ledgerOf(h).kusd_color)).toBe(hex(colour));
  });

  it("refuses the native colour, which would make every KUSD invoice payable in NIGHT", async () => {
    await expect(deployPay(base(), undefined, NATIVE_COLOR)).rejects.toThrow(
      "KUSD colour cannot be the native token",
    );
  });

  it("is declared sealed, so the compiler rejects any circuit that writes it", () => {
    const source = readFileSync(new URL("../src/kinko_pay.compact", import.meta.url), "utf8");
    expect(source).toMatch(/^export sealed ledger kusd_color: Bytes<32>;$/m);
    expect(source).toMatch(/^export sealed ledger oracle_pk: JubjubPoint;$/m);
  });

  it("survives every kind of call unchanged", async () => {
    const oracle = generateOracleKeypair();
    const h = await deployPay(base({ convertedAmount: 7n }), oracle.publicKey);
    await h.call("create_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD, 0n);
    await h.call("settle_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD, coin(42_500n, KUSD));
    const quote = {
      baseAmount: 42_500n,
      convertedAmount: 7n,
      fromToken: TokenKind.KUSD,
      toToken: TokenKind.NATIVE,
      expiresAt: T0 + 60n,
    };
    h.as({ payerKey: bytes32(0x51) });
    await h.call(
      "settle_invoice_converted",
      InvoiceKind.MULTIPAY,
      TokenKind.KUSD,
      TokenKind.NATIVE,
      coin(7n, NATIVE_COLOR),
      quote.expiresAt,
      signQuote(oracle, quote),
    );
    await h.call("refund_payment", InvoiceKind.MULTIPAY, TokenKind.KUSD, coin(42_500n, KUSD));
    await h.call("close_invoice", InvoiceKind.MULTIPAY, TokenKind.KUSD);
    expect(hex(ledgerOf(h).kusd_color)).toBe(hex(KUSD));
    expect(ledgerOf(h).oracle_pk.x).toBe(oracle.publicKey.x);
  });
});

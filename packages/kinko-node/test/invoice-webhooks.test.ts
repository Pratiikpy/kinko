import { decodePaymentLink, fromHex, invoiceCommitmentOf, KinkoPay, toHex } from "@kinko/kinko-pay";
import { describe, expect, it } from "vitest";

import { formatAmount, parseAmount } from "../src/amount.ts";
import { buildInvoice, decodeInvoiceLink } from "../src/invoice.ts";
import { Asset, InvoiceKind, type WebhookEvent } from "../src/types.ts";
import {
  constructWebhookEvent,
  SignatureFailure,
  signWebhookBody,
  verifyWebhookSignature,
  WebhookSignatureError,
} from "../src/webhooks.ts";
import { PAYOUT_ADDRESS, PAYOUT_COIN, PAYOUT_ENC } from "./payout.ts";

/** Narrow a possibly missing value, failing the test with a clear message when it is absent. */
const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
};

const KEYS = { merchantKey: "11".repeat(32), payoutAddress: PAYOUT_ADDRESS };
const CONTEXT = { contractAddress: "ab".repeat(32), appUrl: "https://app.kinko.example" };

describe("amounts", () => {
  it.each([
    ["25", 25_000_000n],
    ["25.5", 25_500_000n],
    ["25.50", 25_500_000n],
    ["0.000001", 1n],
    ["0.1", 100_000n],
    ["18446744073709.551615", 18_446_744_073_709_551_615n],
    [" 7 ", 7_000_000n],
  ])("parses %s", (text, units) => {
    expect(parseAmount(text)).toBe(units);
  });

  it.each([
    "",
    "abc",
    "-5",
    "1e3",
    "1,5",
    "0",
    "0.0",
    "1.0000001",
    ".5",
    "5.",
    "18446744073709.551616",
    "NaN",
  ])("refuses %j", (text) => {
    expect(() => parseAmount(text)).toThrow(RangeError);
  });

  it("formats base units with at least two places", () => {
    expect(formatAmount(25_500_000n)).toBe("25.50");
    expect(formatAmount(25_000_000n)).toBe("25.00");
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(123_456_789n)).toBe("123.456789");
    expect(formatAmount(0n)).toBe("0.00");
  });

  it("round-trips through parse and format", () => {
    for (const text of ["1.00", "0.50", "99.999999", "1234567.01"])
      expect(formatAmount(parseAmount(text))).toBe(text);
  });

  it("supports other decimals", () => {
    expect(parseAmount("1.5", 2)).toBe(150n);
    expect(() => parseAmount("1.555", 2)).toThrow(/more than 2 decimal places/);
  });
});

describe("buildInvoice", () => {
  it("builds a commitment the contract's own circuit reproduces from the link", () => {
    const invoice = buildInvoice(
      KEYS,
      { amount: 42_500n, asset: Asset.KUSD },
      CONTEXT,
      1_800_000_000,
    );
    const decoded = decodePaymentLink(invoice.paymentLink);
    expect(decoded?.contractAddress).toBe(CONTEXT.contractAddress);
    expect(decoded?.terms.amount).toBe(42_500n);
    expect(decoded?.terms.token).toBe(KinkoPay.TokenKind.KUSD);
    expect(toHex(invoiceCommitmentOf(required(decoded, "a decoded link").terms))).toBe(
      invoice.commitment,
    );
  });

  it("puts the terms in the fragment of a link on the web app's pay page, and nothing in the query", () => {
    const invoice = buildInvoice(KEYS, { amount: 1n }, CONTEXT);
    const url = new URL(invoice.paymentLink);
    expect(url.origin + url.pathname).toBe("https://app.kinko.example/pay");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${invoice.linkPayload}`);
  });

  it("never puts the owner secret in the link, and keeps it out of everything else public", () => {
    const invoice = buildInvoice(KEYS, { amount: 5n }, CONTEXT);
    expect(invoice.paymentLink).not.toContain(invoice.ownerSecret);
    const payload = JSON.stringify(decodePaymentLink(invoice.paymentLink), (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v,
    );
    expect(payload).not.toContain(invoice.ownerSecret);
    expect(invoice.ownerSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(invoice.ownerSecret).not.toBe(invoice.salt);
  });

  it("uses fresh randomness every time, so equal invoices cannot be linked", () => {
    const a = buildInvoice(KEYS, { amount: 5n }, CONTEXT);
    const b = buildInvoice(KEYS, { amount: 5n }, CONTEXT);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ownerSecret).not.toBe(b.ownerSecret);
    expect(a.commitment).not.toBe(b.commitment);
  });

  it("changes the commitment with each term", () => {
    const base = buildInvoice(KEYS, { amount: 5n }, CONTEXT);
    const salt = fromHex(base.salt);
    const commit = (over: Partial<Parameters<typeof invoiceCommitmentOf>[0]>) =>
      toHex(
        invoiceCommitmentOf({
          merchantKey: fromHex(KEYS.merchantKey),
          payout: fromHex(PAYOUT_COIN),
          amount: 5n,
          kind: KinkoPay.InvoiceKind.STANDARD,
          token: KinkoPay.TokenKind.KUSD,
          salt,
          expiresAt: 0n,
          ...over,
        }),
      );
    expect(commit({})).toBe(base.commitment);
    expect(commit({ amount: 6n })).not.toBe(base.commitment);
    expect(commit({ token: KinkoPay.TokenKind.NATIVE })).not.toBe(base.commitment);
    expect(commit({ kind: KinkoPay.InvoiceKind.MULTIPAY })).not.toBe(base.commitment);
    expect(commit({ merchantKey: fromHex("22".repeat(32)) })).not.toBe(base.commitment);
  });

  it("defaults to a standard KUSD invoice that never expires", () => {
    const invoice = buildInvoice(KEYS, { amount: 1n }, CONTEXT);
    expect(invoice).toMatchObject({ kind: "standard", asset: "KUSD", expiresAt: 0, amount: "1" });
  });

  it("sets an expiry in block-time seconds from now", () => {
    const invoice = buildInvoice(
      KEYS,
      { amount: 1n, expiresInSeconds: 3_600 },
      CONTEXT,
      1_800_000_000,
    );
    expect(invoice.expiresAt).toBe(1_800_003_600);
    expect(decodePaymentLink(invoice.paymentLink)?.terms.expiresAt).toBe(1_800_003_600n);
  });

  it("supports every kind and asset, and a string amount", () => {
    for (const kind of Object.values(InvoiceKind)) {
      for (const asset of Object.values(Asset))
        expect(buildInvoice(KEYS, { amount: "7", kind, asset }, CONTEXT)).toMatchObject({
          kind,
          asset,
          amount: "7",
        });
    }
  });

  it("normalises the keys it was given", () => {
    const invoice = buildInvoice(
      {
        merchantKey: `0x${"AB".repeat(32)}`,
        payoutAddress: ` ${PAYOUT_ADDRESS}
`,
      },
      { amount: 1n },
      CONTEXT,
    );
    expect(invoice).toMatchObject({
      merchantKey: "ab".repeat(32),
      payoutKey: PAYOUT_COIN,
      payoutAddress: PAYOUT_ADDRESS,
    });
  });

  it("puts the payout address's encryption key in the link, for the payer's wallet", () => {
    const invoice = buildInvoice(KEYS, { amount: 1n }, CONTEXT);
    const decoded = decodePaymentLink(invoice.paymentLink);
    expect(decoded?.payoutEncryptionKey && toHex(decoded.payoutEncryptionKey)).toBe(PAYOUT_ENC);
    expect(decoded && toHex(decoded.terms.payout)).toBe(PAYOUT_COIN);
  });

  it("refuses a payout address on another network than the context names", () => {
    expect(() => buildInvoice(KEYS, { amount: 1n }, { ...CONTEXT, networkId: "preprod" })).toThrow(
      /on undeployed, not preprod/,
    );
  });

  it.each([
    [{ amount: 0n }, RangeError],
    [{ amount: -5n }, RangeError],
    [{ amount: "12.5" }, RangeError],
    [{ amount: "abc" }, RangeError],
    [{ amount: 2n ** 64n }, Error],
    [{ amount: 5n, expiresInSeconds: 30 }, RangeError],
    [{ amount: 5n, expiresInSeconds: 90.5 }, RangeError],
  ])("refuses invalid case #%#", (params, errorType) => {
    expect(() => buildInvoice(KEYS, params, CONTEXT)).toThrow(errorType);
  });

  it("refuses malformed keys with a message that names them", () => {
    expect(() => buildInvoice({ ...KEYS, merchantKey: "short" }, { amount: 1n }, CONTEXT)).toThrow(
      /merchantKey must be 64 hex/,
    );
    expect(() =>
      buildInvoice({ ...KEYS, payoutAddress: "12".repeat(32) }, { amount: 1n }, CONTEXT),
    ).toThrow(/payoutAddress must be your wallet's shielded address/);
  });
});

describe("decodeInvoiceLink", () => {
  it("reads back what the payer is given, and the commitment the chain will hold", () => {
    const invoice = buildInvoice(
      KEYS,
      {
        amount: 25_500_000n,
        kind: InvoiceKind.MULTIPAY,
        asset: Asset.NATIVE,
        expiresInSeconds: 3_600,
      },
      CONTEXT,
      1_800_000_000,
    );
    expect(decodeInvoiceLink(invoice.paymentLink)).toEqual({
      contractAddress: CONTEXT.contractAddress,
      commitment: invoice.commitment,
      kind: "multipay",
      asset: "NATIVE",
      amount: "25500000",
      expiresAt: 1_800_003_600,
    });
    expect(decodeInvoiceLink(invoice.linkPayload)?.commitment).toBe(invoice.commitment);
  });

  it("returns nothing for what is not a link, and exposes no secret", () => {
    expect(decodeInvoiceLink("https://app.kinko.example/pay#garbage")).toBeUndefined();
    expect(decodeInvoiceLink("")).toBeUndefined();
    const invoice = buildInvoice(KEYS, { amount: 5n }, CONTEXT);
    const text = JSON.stringify(decodeInvoiceLink(invoice.paymentLink));
    for (const secret of [invoice.ownerSecret, invoice.salt, KEYS.merchantKey, PAYOUT_COIN])
      expect(text).not.toContain(secret);
  });
});

describe("webhook signatures", () => {
  const SECRET = "whsec_test";
  const BODY = JSON.stringify({
    id: "evt_1",
    type: "invoice.settled",
    createdAt: "2027-01-15T12:00:00.000Z",
    data: { sessionId: "cs_1" },
  });
  const NOW = 1_800_000_000_000;
  const header = (over = 0) => signWebhookBody(BODY, SECRET, NOW + over);

  it("accepts a delivery signed with the secret, inside the window", () => {
    expect(verifyWebhookSignature(BODY, header(), SECRET, { now: () => NOW })).toEqual({
      valid: true,
    });
    expect(verifyWebhookSignature(BODY, header(), SECRET, { now: () => NOW + 299_000 })).toEqual({
      valid: true,
    });
  });

  it("accepts the body as bytes", () => {
    expect(
      verifyWebhookSignature(new TextEncoder().encode(BODY), header(), SECRET, { now: () => NOW })
        .valid,
    ).toBe(true);
  });

  it("refuses a different secret, an altered body, and a re-serialised one", () => {
    const opts = { now: () => NOW };
    expect(verifyWebhookSignature(BODY, header(), "whsec_other", opts)).toEqual({
      valid: false,
      reason: SignatureFailure.MISMATCH,
    });
    expect(verifyWebhookSignature(BODY.replace("cs_1", "cs_2"), header(), SECRET, opts).valid).toBe(
      false,
    );
    expect(
      verifyWebhookSignature(JSON.stringify(JSON.parse(BODY), null, 2), header(), SECRET, opts)
        .valid,
    ).toBe(false);
  });

  it("refuses a replay outside the tolerance, in either direction", () => {
    expect(verifyWebhookSignature(BODY, header(), SECRET, { now: () => NOW + 301_000 })).toEqual({
      valid: false,
      reason: SignatureFailure.TIMESTAMP_OUTSIDE_TOLERANCE,
    });
    expect(verifyWebhookSignature(BODY, header(), SECRET, { now: () => NOW - 301_000 })).toEqual({
      valid: false,
      reason: SignatureFailure.TIMESTAMP_OUTSIDE_TOLERANCE,
    });
    expect(
      verifyWebhookSignature(BODY, header(), SECRET, {
        now: () => NOW + 3_000_000,
        toleranceSeconds: 4_000,
      }).valid,
    ).toBe(true);
  });

  it("will not accept an old timestamp with a signature made for a newer one", () => {
    const [, v1] = header(0).split(",");
    const forged = `t=${String(NOW / 1000 - 10)},${v1 ?? ""}`;
    expect(verifyWebhookSignature(BODY, forged, SECRET, { now: () => NOW }).valid).toBe(false);
  });

  it.each([
    undefined,
    null,
    "",
    "garbage",
    "t=,v1=",
    "t=123",
    "v1=abcd",
    "t=abc,v1=00",
    "t=1800000000,v1=short",
    `t=1800000000,v1=${"zz".repeat(32)}`,
  ])("calls %j malformed or mismatched, never valid", (value) => {
    expect(verifyWebhookSignature(BODY, value, SECRET, { now: () => NOW }).valid).toBe(false);
  });

  it("reports a missing header as malformed", () => {
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toEqual({
      valid: false,
      reason: SignatureFailure.MALFORMED_HEADER,
    });
  });

  it("accepts any one of several v1 signatures, so a rotation can overlap", () => {
    const good = header();
    const rotated = `${good},v1=${"0".repeat(64)}`;
    expect(
      verifyWebhookSignature(
        BODY,
        `t=${good.split(",")[0]?.slice(2) ?? ""},v1=${"0".repeat(64)},${good.split(",")[1] ?? ""}`,
        SECRET,
        { now: () => NOW },
      ).valid,
    ).toBe(true);
    expect(verifyWebhookSignature(BODY, rotated, SECRET, { now: () => NOW }).valid).toBe(true);
  });

  it("parses only after verifying", () => {
    const event: WebhookEvent = constructWebhookEvent(BODY, header(), SECRET, { now: () => NOW });
    expect(event).toMatchObject({
      id: "evt_1",
      type: "invoice.settled",
      data: { sessionId: "cs_1" },
    });
    expect(() =>
      constructWebhookEvent("not json", signWebhookBody("not json", "other", NOW), SECRET, {
        now: () => NOW,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it("throws an error that says why", () => {
    const error = (() => {
      try {
        constructWebhookEvent(BODY, header(), "wrong", { now: () => NOW });
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({
      reason: SignatureFailure.MISMATCH,
      message: expect.stringMatching(/Wrong webhook secret/) as string,
    });
  });
});

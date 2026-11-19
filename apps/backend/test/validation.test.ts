import { describe, expect, it } from "vitest";

import {
  attachCommitmentBody,
  botLinkBody,
  createMerchantBody,
  createSessionBody,
  hex32,
  listSessionsQuery,
  oracleQuoteBody,
  parseInput,
  parseUrl,
  updateMerchantBody,
} from "../src/domain/schemas.ts";
import { ApiError } from "../src/http/errors.ts";
import { checkWebhookUrl, isPublicAddress } from "../src/webhooks/url-policy.ts";
import { containing, matching } from "./support/fixtures.ts";

const C = "ab".repeat(32);

describe("hex32", () => {
  it("accepts 64 hex characters and normalises case and the 0x prefix", () => {
    expect(hex32.parse(C.toUpperCase())).toBe(C);
    expect(hex32.parse(`0x${C}`)).toBe(C);
  });
  it.each(["", "ab", `${C}0`, "zz".repeat(32), ` ${C}`])("rejects %j", (v) => {
    expect(hex32.safeParse(v).success).toBe(false);
  });
});

describe("parseUrl", () => {
  it("accepts http and https", () => {
    expect("url" in parseUrl("https://shop.example/thanks?o=1")).toBe(true);
    expect("url" in parseUrl("http://localhost:3000/ok")).toBe(true);
  });
  it("refuses a fragment, because the terms of a payment link live there", () => {
    const result = parseUrl("https://pay.kinko.example/pay#eyJhIjoxfQ");
    expect(result).toMatchObject({
      reason: containing("must not contain a fragment"),
    });
    expect(parseUrl("https://x.example/#")).toMatchObject({
      reason: containing("fragment"),
    });
  });
  it.each([
    "javascript:alert(1)",
    "ftp://x.example",
    "file:///etc/passwd",
    "//x.example",
    "x.example",
    "https://user:pw@x.example",
  ])("refuses %s", (v) => {
    expect("reason" in parseUrl(v)).toBe(true);
  });
});

describe("createSessionBody", () => {
  it("accepts a full session and normalises the commitment", () => {
    const parsed = createSessionBody.parse({
      commitment: `0x${C.toUpperCase()}`,
      kind: "multipay",
      token: "NATIVE",
      title: "  Invoice 12 ",
      memo: "Line one\nline two",
      amount: "42500",
      clientReference: "order-9",
      successUrl: "https://shop.example/ok",
      cancelUrl: "https://shop.example/no",
      ttlSeconds: 600,
    });
    expect(parsed.commitment).toBe(C);
    expect(parsed.title).toBe("Invoice 12");
  });

  it("is strict: an unknown field is an error, not silently dropped", () => {
    expect(createSessionBody.safeParse({ ammount: "5" }).success).toBe(false);
    expect(createSessionBody.safeParse({ merchantKey: C }).success).toBe(false);
    expect(createSessionBody.safeParse({ salt: C }).success).toBe(false);
  });

  it.each([
    [{ amount: "0" }, "between 1 and 2^64"],
    [{ amount: "18446744073709551616" }, "between 1 and 2^64"],
    [{ amount: "12.5" }, "whole number"],
    [{ amount: "-3" }, "whole number"],
    [{ kind: "recurring" }, "Invalid enum"],
    [{ token: "BTC" }, "Invalid enum"],
    [{ ttlSeconds: 5 }, "greater than or equal to 60"],
    [{ ttlSeconds: 99_999_999 }, "less than or equal to"],
    [{ ttlSeconds: 90.5 }, "integer"],
    [{ title: "" }, "must not be empty"],
    [{ title: "x".repeat(121) }, "at most 120"],
    [{ title: "bad\u0000title" }, "control characters"],
    [{ memo: "bad\u0007memo" }, "control characters"],
    [{ successUrl: "javascript:alert(1)" }, "http or https"],
    [{ cancelUrl: "https://x.example/#amount=5" }, "fragment"],
  ])("rejects %j", (input, message) => {
    const result = createSessionBody.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(message);
  });

  it("allows a newline in a memo but not in a title", () => {
    expect(createSessionBody.safeParse({ memo: "a\nb" }).success).toBe(true);
    expect(createSessionBody.safeParse({ title: "a\nb" }).success).toBe(false);
  });
});

describe("other bodies", () => {
  it("requires a name to register and a sane webhook URL", () => {
    expect(createMerchantBody.safeParse({}).success).toBe(false);
    expect(createMerchantBody.safeParse({ name: "Acme", webhookUrl: null }).success).toBe(true);
    expect(
      createMerchantBody.safeParse({ name: "Acme", webhookUrl: "https://x.example/#f" }).success,
    ).toBe(false);
  });
  it("requires an update to change something", () => {
    expect(updateMerchantBody.safeParse({}).success).toBe(false);
    expect(updateMerchantBody.safeParse({ webhookUrl: null }).success).toBe(true);
  });
  it("requires a commitment to attach", () => {
    expect(attachCommitmentBody.safeParse({ commitment: "nope" }).success).toBe(false);
    expect(attachCommitmentBody.parse({ commitment: C })).toEqual({ commitment: C });
  });
  it("validates quote requests", () => {
    expect(
      oracleQuoteBody.parse({ baseAmount: "100", fromToken: "NATIVE", toToken: "KUSD" }),
    ).toMatchObject({ baseAmount: "100" });
    expect(
      oracleQuoteBody.safeParse({ baseAmount: "100", fromToken: "KUSD", toToken: "KUSD" }).success,
    ).toBe(false);
    expect(
      oracleQuoteBody.safeParse({ baseAmount: "1e6", fromToken: "NATIVE", toToken: "KUSD" })
        .success,
    ).toBe(false);
    expect(
      oracleQuoteBody.safeParse({ baseAmount: 100, fromToken: "NATIVE", toToken: "KUSD" }).success,
    ).toBe(false);
  });
  it("validates chat ids, negative for groups, never zero or fractional", () => {
    expect(botLinkBody.parse({ code: "ABCD", chatId: -100123 }).chatId).toBe(-100123);
    expect(botLinkBody.safeParse({ code: "ABCD", chatId: 0 }).success).toBe(false);
    expect(botLinkBody.safeParse({ code: "ABCD", chatId: 1.5 }).success).toBe(false);
    expect(botLinkBody.safeParse({ code: "ABCD", chatId: "abc" }).success).toBe(false);
  });
  it("coerces and bounds list queries", () => {
    expect(listSessionsQuery.parse({})).toEqual({ limit: 25 });
    expect(listSessionsQuery.parse({ limit: "10", status: "settled", before: "7" })).toEqual({
      limit: 10,
      status: "settled",
      before: 7,
    });
    expect(listSessionsQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(listSessionsQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(listSessionsQuery.safeParse({ status: "weird" }).success).toBe(false);
  });
});

describe("parseInput", () => {
  it("turns a failure into a 400 that names the field", () => {
    const error = (() => {
      try {
        parseInput(createSessionBody, { amount: "0" }, "checkout session");
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      message: matching(/^Invalid checkout session\. amount:/),
      details: [{ path: "amount", message: expect.any(String) as string }],
    });
  });
});

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "treats %s as public",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "192.0.2.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "::ffff:a9fe:a9fe",
    "not-an-ip",
    "",
  ])("treats %s as not public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it("does not treat the neighbours of a private range as private", () => {
    expect(isPublicAddress("172.15.255.255")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("11.0.0.1")).toBe(true);
  });
});

describe("checkWebhookUrl", () => {
  const strict = { allowPrivateTargets: false };
  it("accepts a public https URL", () => {
    expect(checkWebhookUrl("https://hooks.example.com/kinko", strict)).toBeUndefined();
    expect(checkWebhookUrl("https://8.8.8.8/hook", strict)).toBeUndefined();
  });
  it.each([
    ["http://hooks.example.com/x", "must use https"],
    ["https://localhost/x", "public host name"],
    ["https://app.localhost/x", "public host name"],
    ["https://printer.local/x", "public host name"],
    ["https://db.internal/x", "public host name"],
    ["https://intranet/x", "public host name"],
    ["https://127.0.0.1/x", "private or reserved"],
    ["https://169.254.169.254/latest/meta-data", "private or reserved"],
    ["https://[::1]/x", "private or reserved"],
    ["https://[::ffff:7f00:1]/x", "private or reserved"],
    ["https://x.example/hook#frag", "fragment"],
    ["https://u:p@x.example/hook", "credentials"],
  ])("refuses %s", (url, reason) => {
    expect(checkWebhookUrl(url, strict)).toContain(reason);
  });
  it("allows http and private targets only when development mode says so, and still refuses a fragment", () => {
    const dev = { allowPrivateTargets: true };
    expect(checkWebhookUrl("http://127.0.0.1:9000/hook", dev)).toBeUndefined();
    expect(checkWebhookUrl("http://localhost:9000/hook#x", dev)).toContain("fragment");
  });
});

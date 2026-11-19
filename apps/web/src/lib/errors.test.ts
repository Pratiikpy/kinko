import { describe, expect, it } from "vitest";

import { explain } from "./errors.ts";

describe("explain", () => {
  it("names an expired NIGHT price when a converted payment fails on chain", () => {
    const e = new Error(
      'CallTxFailedError: { "circuitId": "settle_invoice_converted", "status": "FailFallible" }',
    );
    const x = explain(e);
    expect(x.message).toMatch(/NIGHT price expired/);
    expect(x.declined).toBe(false);
  });

  it("leaves other on-chain failures to the general explanations", () => {
    const x = explain(
      new Error('CallTxFailedError: { "circuitId": "settle_invoice", "status": "FailFallible" }'),
    );
    expect(x.message).not.toMatch(/NIGHT price/);
  });

  it("reads a contract assert as the product's own refusal", () => {
    const x = explain(new Error("failed assert: invoice is not open"));
    expect(x).toMatchObject({ message: "Invoice is not open.", refusedByContract: true });
  });

  it("treats a wallet refusal as the person's choice", () => {
    expect(explain({ code: "Rejected", message: "no" }).declined).toBe(true);
  });
});

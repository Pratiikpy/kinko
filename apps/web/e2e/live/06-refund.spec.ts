// A customer pays an invoice and asks for a refund; the merchant refunds it
// from the invoice page with the customer's refund code. The truth is both
// wallets' balances, which must return to where they started, and the
// contract's refund record, which must refuse a second refund.

import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  consoleSettled,
  DEPLOYMENT,
  expectNoProblems,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

const AMOUNT = 4_000_000n;

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a merchant refunds a payment with the customer's refund code, once", async ({ browser }) => {
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const customer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const customerBefore = await customer.wallet.balance(kusd);
  test.skip(customerBefore < AMOUNT, `the customer holds ${String(customerBefore)} KUSD`);
  const merchantBefore = await merchant.wallet.balance(kusd);

  await merchant.page.goto("/app/request");
  await connect(merchant);
  await merchant.page.getByLabel("What is it for?").fill("Glaze workshop seat");
  await merchant.page.getByLabel("Amount").fill("4");
  await merchant.page.getByRole("button", { name: "Create the request" }).click();
  await expect(merchant.page.getByText("Your request is live")).toBeVisible({
    timeout: 15 * 60_000,
  });
  const linkLabel = await merchant.page
    .getByRole("button", { name: /^Copy Payment link:/ })
    .getAttribute("aria-label");
  const link = linkLabel?.replace(/^Copy Payment link:\s*/, "") ?? "";

  await customer.page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await connect(customer);
  await customer.page.getByRole("button", { name: "Pay $4.00 privately" }).click();
  await expect(customer.page.getByText("Paid privately")).toBeVisible({ timeout: 15 * 60_000 });
  const codeLabel = await customer.page
    .getByRole("button", { name: /^Copy Refund code:/ })
    .getAttribute("aria-label");
  const refundCode = codeLabel?.replace(/^Copy Refund code:\s*/, "") ?? "";
  expect(refundCode.length).toBeGreaterThan(20);
  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(merchantBefore + AMOUNT);

  // The merchant opens the invoice and refunds the payment the code names.
  await merchant.page.getByRole("link", { name: "Track it" }).click();
  await merchant.page.getByLabel("Refund code").fill(refundCode);
  await merchant.page.getByRole("button", { name: "Refund $4.00" }).click();
  await expect(merchant.page.getByText("Refunded to the payer's key.")).toBeVisible({
    timeout: 15 * 60_000,
  });
  await shot(merchant, "refund-done");

  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(merchantBefore);
  await expect
    .poll(() => customer.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(customerBefore);

  // A second refund of the same payment is refused before anything is signed.
  await merchant.page.getByRole("button", { name: "Refund $4.00" }).click();
  await expect(merchant.page.getByText("That payment has already been refunded.")).toBeVisible({
    timeout: 2 * 60_000,
  });

  // The refused second refund is logged on purpose; nothing else may be.
  const expected = (p: string) => p.includes("That payment has already been refunded.");
  await consoleSettled();
  expect(merchant.problems.filter(expected)).toHaveLength(1);
  merchant.problems.splice(
    0,
    merchant.problems.length,
    ...merchant.problems.filter((p) => !expected(p)),
  );
  await expectNoProblems(merchant, customer);
});

// A merchant requests a payment and a customer pays it, both through the app
// in their own browsers, with real proofs on the local chain. The source of
// truth is checked after every step: the merchant's and payer's wallets and
// the contract's ledger, not the screen.

import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  DEPLOYMENT,
  dumpIfStalled,
  expectNoProblems,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a merchant requests $12.50 and a customer pays it from their private balance", async ({
  browser,
}) => {
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const payer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const amount = 12_500_000n;

  const payerBefore = await payer.wallet.balance(kusd);
  const merchantBefore = await merchant.wallet.balance(kusd);
  test.skip(payerBefore < amount, `the payer holds ${String(payerBefore)} KUSD; deposit first`);

  await merchant.page.goto("/app/request");
  await connect(merchant);
  await merchant.page.getByLabel("What is it for?").fill("Logo design, November");
  await merchant.page.getByLabel("Amount").fill("12.50");
  await merchant.page.getByRole("button", { name: "Create the request" }).click();
  await expect(merchant.page.getByText("Your request is live")).toBeVisible({
    timeout: 15 * 60_000,
  });
  await shot(merchant, "invoice-created");
  const link = await merchant.page
    .getByRole("button", { name: /Copy Payment link/ })
    .getAttribute("aria-label");
  const url = link?.replace(/^Copy Payment link:\s*/, "");
  expect(url, "the request shows its payment link").toMatch(/^https?:\/\//);

  await payer.page.goto(url ?? "");
  await connect(payer);
  await expect(payer.page.getByText("Logo design, November")).toBeVisible();
  await expect(payer.page.getByText("$12.50").first()).toBeVisible();
  await shot(payer, "invoice-to-pay");
  await payer.page.getByRole("button", { name: "Pay $12.50 privately" }).click();
  if (process.env.KINKO_DEBUG_STALL) await dumpIfStalled(payer.page, "Paid privately", 120_000);
  await expect(payer.page.getByText("Paid privately")).toBeVisible({ timeout: 15 * 60_000 });
  await shot(payer, "invoice-paid");

  await expect
    .poll(() => payer.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(payerBefore - amount);
  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(merchantBefore + amount);

  await merchant.page.goto("/app/invoices");
  await expect(merchant.page.getByText("Logo design, November")).toBeVisible();
  await expect(merchant.page.getByText(/Settled|Paid/).first()).toBeVisible({
    timeout: 5 * 60_000,
  });
  await shot(merchant, "invoice-settled");

  await expectNoProblems(merchant, payer);
});

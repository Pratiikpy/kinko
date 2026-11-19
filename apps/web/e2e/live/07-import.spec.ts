// An invoice built on a merchant's machine by the SDK (the same code the CLI
// and the MCP server use) is saved to a file, published from the web app's
// Invoices page with the merchant's wallet, and paid by a customer from its
// link. The truth is the merchant's balance and the invoice's status on chain.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { buildInvoice, saveInvoiceSecrets } from "@kinko/node";
import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  DEPLOYMENT,
  expectNoProblems,
  NETWORK,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

const AMOUNT = 2_500_000n;

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("an invoice built by the SDK is published from the app and paid", async ({ browser }) => {
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const customer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const customerBefore = await customer.wallet.balance(kusd);
  test.skip(customerBefore < AMOUNT, `the customer holds ${String(customerBefore)} KUSD`);
  const merchantBefore = await merchant.wallet.balance(kusd);

  // On the merchant's machine: build the invoice and save its secrets.
  const invoice = buildInvoice(
    {
      merchantKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      payoutAddress: await merchant.wallet.shieldedAddress(),
    },
    { amount: AMOUNT },
    {
      contractAddress: DEPLOYMENT.pay.contractAddress,
      appUrl: "http://127.0.0.1:5191",
      networkId: NETWORK,
    },
  );
  const home = mkdtempSync(`${tmpdir()}/kinko-import-`);
  const file = await saveInvoiceSecrets({ KINKO_HOME: home }, invoice);

  // In the app: publish it with the merchant's wallet.
  await merchant.page.goto("/app/invoices");
  await connect(merchant);
  await merchant.page.getByLabel("Or paste its contents").fill(readFileSync(file, "utf8"));
  await expect(merchant.page.locator("p").filter({ hasText: invoice.commitment })).toBeVisible();
  await expect(merchant.page.getByText("Payments go to another wallet")).toHaveCount(0);
  await merchant.page.getByRole("button", { name: "Publish on Midnight" }).click();
  await expect(
    merchant.page.getByText("The invoice is on chain and its payment link works."),
  ).toBeVisible({
    timeout: 15 * 60_000,
  });
  await shot(merchant, "import-published");

  // The customer pays from the link the SDK made.
  await customer.page.goto(invoice.paymentLink.replace(/^https?:\/\/[^/]+/, ""));
  await connect(customer);
  await customer.page.getByRole("button", { name: "Pay $2.50 privately" }).click();
  await expect(customer.page.getByText("Paid privately")).toBeVisible({ timeout: 15 * 60_000 });
  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(merchantBefore + AMOUNT);

  // The merchant's list shows it paid.
  await merchant.page.goto("/app/invoices");
  await expect(merchant.page.getByText("Paid").first()).toBeVisible({ timeout: 2 * 60_000 });
  await shot(merchant, "import-paid");

  await expectNoProblems(merchant, customer);
});

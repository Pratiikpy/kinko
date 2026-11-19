// A payer pays a short payroll file in one go. The file first has a bad line,
// which the page names and refuses to pay; once fixed, every line is paid in
// one private transfer. The truth is the recipient's shielded balance.

import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  DEPLOYMENT,
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

test("a payer pays a batch file, after the page names its bad line", async ({ browser }) => {
  const recipient = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const payer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const total = 3_250_000n;
  const payerBefore = await payer.wallet.balance(kusd);
  test.skip(payerBefore < total, `the payer holds ${String(payerBefore)} KUSD`);
  const recipientBefore = await recipient.wallet.balance(kusd);
  const address = await recipient.wallet.shieldedAddress();

  await payer.page.goto("/app/batch");
  await connect(payer);
  const field = payer.page.getByLabel("Or paste it: recipient, amount, note");
  await field.fill(`${address}, 1.50, March retainer\nnot-an-address, 2, broken line\n`);
  await expect(payer.page.getByText("1 line to fix")).toBeVisible();
  await expect(payer.page.getByText(/^Line 2:/)).toBeVisible();
  await expect(payer.page.getByRole("button", { name: /^Pay 1 person/ })).toBeDisabled();

  await field.fill(`${address}, 1.50, March retainer\n${address}, 1.75, Kiln repair\n`);
  await expect(payer.page.getByText("2 payments · $3.25")).toBeVisible();
  await expect(payer.page.getByText("Ready")).toHaveCount(2);
  await shot(payer, "batch-ready");
  await payer.page.getByRole("button", { name: /^Pay 2 people/ }).click();
  await expect(payer.page.getByText("Every payment in the file was sent privately.")).toBeVisible({
    timeout: 15 * 60_000,
  });
  await expect(payer.page.getByText("2 of 2 sent")).toBeVisible();
  await shot(payer, "batch-paid");

  await expect
    .poll(() => recipient.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(recipientBefore + total);
  await expect
    .poll(() => payer.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBeLessThanOrEqual(payerBefore - total);

  await expectNoProblems(recipient, payer);
});

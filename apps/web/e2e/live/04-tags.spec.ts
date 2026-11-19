// A merchant claims an @tag and a customer pays it by name, both through the
// app. The truth is the two wallets' shielded balances and the tag registry's
// public ledger, which must not name either party.

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

const AMOUNT = 3_000_000n;

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a merchant claims an @tag and a customer pays $3 to it by name", async ({ browser }) => {
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const payer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const payerBefore = await payer.wallet.balance(kusd);
  test.skip(payerBefore < AMOUNT, `the payer holds ${String(payerBefore)} KUSD; deposit first`);
  const merchantBefore = await merchant.wallet.balance(kusd);
  const tag = `kt_${Date.now().toString(36)}`;

  await merchant.page.goto("/app/tags");
  await connect(merchant);
  await merchant.page.getByLabel("Your tag").fill(tag);
  await expect(merchant.page.getByText(`@${tag} is available.`)).toBeVisible();
  await merchant.page.getByRole("button", { name: `Claim @${tag}` }).click();
  await expect(merchant.page.getByText("The tag is yours.")).toBeVisible({ timeout: 15 * 60_000 });
  await shot(merchant, "tag-claimed");

  await payer.page.goto("/app/pay");
  await connect(payer);
  await payer.page.getByLabel("Who are you paying?").fill(`@${tag}`);
  await expect(payer.page.getByText(/found$/).first()).toBeVisible({ timeout: 60_000 });
  await payer.page.getByLabel("Amount").fill("3");
  await payer.page.getByRole("button", { name: /^Pay \$3\.00 to/ }).click();
  await expect(payer.page.getByText(/^Sent privately\./)).toBeVisible({ timeout: 15 * 60_000 });
  await shot(payer, "tag-paid");

  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(merchantBefore + AMOUNT);
  await expect
    .poll(() => payer.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBeLessThanOrEqual(payerBefore - AMOUNT);

  await expectNoProblems(merchant, payer);
});

// An invoice priced in NIGHT, paid in private dollars: the merchant's SDK
// prices it at 40 NIGHT, the app publishes it, and the customer pays the KUSD
// the oracle quotes, the rate proven inside the payment. NIGHT exists only
// unshielded on Midnight, so this is the only way such an invoice can be paid.
// The truth is the merchant's KUSD balance, which rises by the quoted price.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { Asset, buildInvoice, saveInvoiceSecrets } from "@kinko/node";
import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  DEPLOYMENT,
  expectNoProblems,
  finished,
  NETWORK,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

const NIGHT = 40_000_000n;

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a 40 NIGHT invoice is paid in KUSD at the oracle's signed rate", async ({ browser }) => {
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const customer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const merchantBefore = await merchant.wallet.balance(kusd);

  const invoice = buildInvoice(
    {
      merchantKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      payoutAddress: await merchant.wallet.shieldedAddress(),
    },
    { amount: NIGHT, asset: Asset.NATIVE },
    {
      contractAddress: DEPLOYMENT.pay.contractAddress,
      appUrl: "http://127.0.0.1:5191",
      networkId: NETWORK,
    },
  );
  const file = await saveInvoiceSecrets(
    { KINKO_HOME: mkdtempSync(`${tmpdir()}/kinko-night-`) },
    invoice,
  );

  await merchant.page.goto("/app/invoices");
  await connect(merchant);
  await merchant.page.getByLabel("Or paste its contents").fill(readFileSync(file, "utf8"));
  await merchant.page.getByRole("button", { name: "Publish on Midnight" }).click();
  await finished(merchant, "The invoice is on chain and its payment link works.");

  await customer.page.goto(invoice.paymentLink.replace(/^https?:\/\/[^/]+/, ""));
  await connect(customer);
  await expect(customer.page.getByText(/^40(\.00)? NIGHT$/).first()).toBeVisible();
  const priced = customer.page.getByText(/^Paid in private dollars: \$[0-9.]+/);
  await expect(priced).toBeVisible({ timeout: 60_000 });
  const dollars = /\$([0-9]+\.[0-9]{2})/.exec((await priced.textContent()) ?? "")?.[1];
  expect(dollars, "the page names the KUSD price").toBeDefined();
  const price = BigInt(Math.round(Number(dollars) * 1_000_000));
  const customerBefore = await customer.wallet.balance(kusd);
  test.skip(
    customerBefore < (price * 102n) / 100n,
    `the customer holds ${String(customerBefore)} KUSD`,
  );
  await shot(customer, "night-priced");

  await customer.page.getByRole("button", { name: `Pay $${dollars ?? ""} privately` }).click();
  await finished(customer, "Paid privately");
  await shot(customer, "night-paid");

  // The rate is live and the quote is fetched again at payment, so the exact KUSD can differ a
  // little from the cents shown. What must hold: the merchant gains exactly what the customer
  // loses, and it is the shown price to within the feed's movement over a minute.
  await expect
    .poll(async () => (await merchant.wallet.balance(kusd)) - merchantBefore, {
      timeout: 5 * 60_000,
    })
    .toBeGreaterThan(0n);
  const gained = (await merchant.wallet.balance(kusd)) - merchantBefore;
  await expect
    .poll(() => customer.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(customerBefore - gained);
  const drift = Number(gained - price) / Number(price);
  expect(Math.abs(drift), `paid ${String(gained)} against a shown ${String(price)}`).toBeLessThan(
    0.02,
  );

  await expectNoProblems(merchant, customer);
});

// A merchant's checkout system sells something through Kinko's hosted
// checkout. Its server registers with the backend and starts a draft session
// through the SDK; the merchant's wallet creates the invoice from the draft
// link in the app, which hands the commitment back to the session; a customer
// pays on the hosted checkout page; the merchant's server sees the session
// settle. The truth is the backend's session status, which its watcher reads
// from the chain, and the merchant's wallet balance.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Kinko, SessionStatus } from "@kinko/node";
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

// The backend this run's app talks to: the local stack's, or the deployed network's own.
const BACKEND = NETWORK === "undeployed" ? "http://localhost:3100" : "http://localhost:4100";
const AMOUNT = 7_250_000n;

function registrationToken(): string | undefined {
  const file = fileURLToPath(
    new URL(
      `../../../backend/.env${NETWORK === "undeployed" ? "" : `.${NETWORK}`}`,
      import.meta.url,
    ),
  );
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("KINKO_REGISTRATION_TOKEN="));
  return line?.slice("KINKO_REGISTRATION_TOKEN=".length).trim();
}

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a merchant's server sells through the hosted checkout and sees it settle", async ({
  browser,
}) => {
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const customer = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const customerBefore = await customer.wallet.balance(kusd);
  test.skip(customerBefore < AMOUNT, `the customer holds ${String(customerBefore)} KUSD`);
  const merchantBefore = await merchant.wallet.balance(kusd);

  // The merchant's server: register, then start a draft for this order.
  const token = registrationToken();
  const registration = await Kinko.register({
    baseUrl: BACKEND,
    name: "Aiko's Ceramics",
    ...(token ? { registrationToken: token } : {}),
  });
  const server = new Kinko({ apiKey: registration.apiKey.key, baseUrl: BACKEND });
  const draft = await server.checkout.drafts.create({
    title: "Order 1042, two tea bowls",
    clientReference: "order-1042",
    ttlSeconds: 3600,
  });
  expect(draft.session.status).toBe(SessionStatus.DRAFT);

  // The merchant opens the draft link and creates the invoice with their wallet.
  await merchant.page.goto(draft.formUrl.replace(/^https?:\/\/[^/]+/, ""));
  await connect(merchant);
  await expect(merchant.page.getByLabel("What is it for?")).toHaveValue(
    "Order 1042, two tea bowls",
  );
  await merchant.page.getByLabel("Amount").fill("7.25");
  await merchant.page.getByRole("button", { name: "Create the request" }).click();
  await expect(merchant.page.getByText("Your request is live")).toBeVisible({
    timeout: 15 * 60_000,
  });
  await expect(
    merchant.page.getByText(`Linked to checkout session ${draft.session.id}`),
  ).toBeVisible();
  await shot(merchant, "checkout-draft-created");
  await expect
    .poll(async () => (await server.checkout.sessions.retrieve(draft.session.id)).status, {
      timeout: 60_000,
    })
    .toBe(SessionStatus.PENDING);
  const label = await merchant.page
    .getByRole("button", { name: /^Copy Checkout page:/ })
    .getAttribute("aria-label");
  const checkoutUrl = label?.replace(/^Copy Checkout page:\s*/, "") ?? "";
  expect(checkoutUrl).toContain(`/checkout?session=${draft.session.id}#`);

  // The customer pays on the hosted checkout page.
  await customer.page.goto(checkoutUrl.replace(/^https?:\/\/[^/]+/, ""));
  await expect(customer.page.getByText("Aiko's Ceramics").first()).toBeVisible();
  await expect(customer.page.getByText("$7.25").first()).toBeVisible();
  await connect(customer);
  await shot(customer, "checkout-to-pay");
  await customer.page.getByRole("button", { name: "Pay $7.25 privately" }).click();
  await expect(customer.page.getByText("Paid privately")).toBeVisible({ timeout: 15 * 60_000 });
  await shot(customer, "checkout-paid");

  // The merchant's server sees the order settle, from the chain.
  const settled = await server.checkout.sessions.waitForSettlement(draft.session.id, {
    timeoutMs: 5 * 60_000,
    intervalMs: 3_000,
  });
  expect(settled.status).toBe(SessionStatus.SETTLED);
  expect(settled.clientReference).toBe("order-1042");
  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(merchantBefore + AMOUNT);
  await expect(customer.page.getByRole("status").filter({ hasText: /^Paid\./ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(customer.page.getByRole("link", { name: /Return to/ })).toHaveCount(0);
  await shot(customer, "checkout-settled");

  await expectNoProblems(merchant, customer);
});

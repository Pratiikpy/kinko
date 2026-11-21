// A PIN card, end to end through the app: its owner makes and loads it; a
// merchant requests a payment; someone holding the card and its PIN pays at
// the invoice page with no wallet at all, Kinko's sponsor paying the fee; then
// the owner refuses a wrong PIN and freezes the card, moving what is left back.
// Balances are checked on chain after each step.

import { cardEntropy, recoveryPhrase } from "@kinko/card/seed";
import { decodePinCard } from "@kinko/kinko-pay";
import { expect, firefox, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  BIRTH,
  cardBalanceOnChain,
  closeParties,
  connect,
  consoleSettled,
  copied,
  DEPLOYMENT,
  expectNoProblems,
  finished,
  OPEN_MS,
  party,
  recording,
  registry,
  RESULTS,
  seed,
  settleAndClose,
  shot,
  snapshotResponse,
  SYNC_MS,
  watchConsole,
} from "./live.ts";

const PIN = "204817";

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a card and its PIN pay an invoice with no wallet, then the owner freezes it", async ({
  browser,
}) => {
  const owner = await party(browser, reg, "Payer", seed("USER_SEED"));
  const merchant = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const load = 3_000_000n;
  const price = 1_250_000n;
  const ownerBefore = await owner.wallet.balance(kusd);
  test.skip(ownerBefore < load, `the owner holds ${String(ownerBefore)} KUSD`);

  // The owner makes a card loaded with $3.
  await owner.page.goto("/app/card");
  await connect(owner);
  await owner.page.getByLabel("Name, for you").fill("Weekend card");
  await owner.page.getByLabel("Load it with").fill("3.00");
  await owner.page.getByLabel("PIN", { exact: true }).fill(PIN);
  await owner.page.getByLabel("PIN again").fill(PIN);
  await owner.page.getByRole("button", { name: "Make the card" }).click();
  await finished(owner, "The card is ready.");
  const link = await copied(owner.page, "Card link");
  expect(link).toMatch(/\/card#/);
  await shot(owner, "card-made");
  const decoded = decodePinCard(link);
  if (!decoded) throw new Error("the card link is not a PIN card");
  expect(decoded.birth, "the owner's card is stamped with where the chain's tree stood").toMatch(
    BIRTH,
  );
  const entropy = await cardEntropy({
    kind: "pin",
    secret: Uint8Array.from(Buffer.from(decoded.secret, "hex")),
    pin: PIN,
  });
  await expect
    .poll(() => cardBalanceOnChain(entropy, kusd, decoded.birth), {
      timeout: SYNC_MS,
      intervals: [5_000],
    })
    .toBe(load);

  // The merchant requests $1.25.
  await merchant.page.goto("/app/request");
  await connect(merchant);
  await merchant.page.getByLabel("What is it for?").fill("Two coffees");
  await merchant.page.getByLabel("Amount").fill("1.25");
  await merchant.page.getByRole("button", { name: "Create the request" }).click();
  await finished(merchant, "Your request is live");
  const payLink = await copied(merchant.page, "Payment link");
  const merchantBefore = await merchant.wallet.balance(kusd);

  // Someone with the card and its PIN pays, in a browser with no wallet connected: a second
  // engine, Firefox, so the card path is proven outside Chromium too. The card proves from the
  // page, uploading the circuit's ~90 MB proving key to the proof server, a request that crashes
  // Playwright's own Chromium connection, so the holder is Firefox on every network.
  const holderBrowser = await firefox.launch();
  await test.info().attach("holder browser", { body: holderBrowser.version() });
  const holder = await holderBrowser.newContext({
    viewport: { width: 1440, height: 900 },
    ...recording("Holder"),
  });
  const page = await holder.newPage();
  const problems: string[] = [];
  watchConsole(page, "Holder", problems, false);
  page.on("pageerror", (e) => problems.push(`[Holder] pageerror: ${e.message}`));

  // The same card from its recovery phrase with its birth after it, the way a holder who kept only
  // the words reopens it: it starts from the service's tree too, and needs no PIN.
  const phrasePage = await holder.newPage();
  watchConsole(phrasePage, "Holder", problems, false);
  phrasePage.on("pageerror", (e) => problems.push(`[Holder] pageerror: ${e.message}`));
  await phrasePage.goto(payLink);
  await phrasePage.getByRole("button", { name: "Pay with a Kinko card instead" }).click();
  await phrasePage
    .getByLabel("Card link or 24-word recovery phrase")
    .fill(`${recoveryPhrase(entropy)} ${decoded.birth ?? ""}`);
  const phraseStarted = snapshotResponse(phrasePage);
  await phrasePage.getByRole("button", { name: "Open the card" }).click();
  await expect(phrasePage.getByTestId("card-balance")).toHaveText("$3.00", { timeout: OPEN_MS });
  expect((await phraseStarted).status()).toBe(200);
  // The wallet says where it started: a 200 alone would also pass if the snapshot were dropped
  // and the card had quietly replayed the chain.
  await expect(phrasePage.getByTestId("card-balance")).toHaveAttribute(
    "data-started-from",
    "snapshot",
  );
  await phrasePage.close();

  await page.goto(payLink);
  await expect(page.getByText("Two coffees")).toBeVisible();
  await page.getByRole("button", { name: "Pay with a Kinko card instead" }).click();
  await page.getByLabel("Card link or 24-word recovery phrase").fill(link);
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  const started = snapshotResponse(page);
  await page.getByRole("button", { name: "Open the card" }).click();
  await expect(page.getByTestId("card-balance")).toHaveText("$3.00", { timeout: OPEN_MS });
  // The card started from the service's tree at its birth, rather than replaying the chain.
  expect((await started).status()).toBe(200);
  await expect(page.getByTestId("card-balance")).toHaveAttribute("data-started-from", "snapshot");
  await expect(page.getByText("Kinko pays the network fee. You need no wallet.")).toBeVisible();
  await page.screenshot({ path: `${RESULTS}/shots/card-pay.png`, fullPage: true });
  await page.getByRole("button", { name: "Pay $1.25 from the card" }).click();
  // Name the stage every half minute, so a slow step shows where it is.
  const progress = setInterval(() => {
    void page
      .locator('section[aria-labelledby="pay-with-card-title"] [role="status"]')
      .allInnerTexts()
      .then((t) => {
        console.log(`[Holder] stage: ${t.join(" | ").replace(/\s+/g, " ")}`);
      })
      .catch(() => undefined);
  }, 30_000);
  try {
    await expect(page.getByText("Paid from the card")).toBeVisible({ timeout: 15 * 60_000 });
  } finally {
    clearInterval(progress);
  }
  // The invoice turns paid; the card's receipt and refund code stay on screen.
  await expect(page.getByText("Paid", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Paid from the card")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Copy Receipt:/ })).toBeVisible();
  const cardCodeLabel = await page
    .getByRole("button", { name: /^Copy Refund code:/ })
    .getAttribute("aria-label");
  const cardRefundCode = cardCodeLabel?.replace(/^Copy Refund code:\s*/, "") ?? "";
  expect(cardRefundCode.length).toBeGreaterThan(20);
  await expect(page.getByRole("button", { name: "Connect to pay" })).toHaveCount(0);
  await page.screenshot({ path: `${RESULTS}/shots/card-paid.png`, fullPage: true });
  await consoleSettled();
  expect(problems).toEqual([]);
  await settleAndClose(holder);
  await holderBrowser.close();

  await expect
    .poll(() => merchant.wallet.balance(kusd), { timeout: SYNC_MS })
    .toBe(merchantBefore + price);
  await expect
    .poll(() => cardBalanceOnChain(entropy, kusd, decoded.birth), {
      timeout: SYNC_MS,
      intervals: [5_000],
    })
    .toBe(load - price);

  // The merchant refunds the payment with the card's refund code. The refund goes to the card's
  // own key, encrypted to the card's own encryption key, so the card finds it with no wallet.
  await merchant.page.getByRole("link", { name: "Track it" }).click();
  await merchant.page.getByLabel("Refund code").fill(cardRefundCode);
  await merchant.page.getByRole("button", { name: "Refund $1.25" }).click();
  await expect(merchant.page.getByText("Refunded to the payer's key.")).toBeVisible({
    timeout: 15 * 60_000,
  });
  await shot(merchant, "card-refunded");
  await expect.poll(() => merchant.wallet.balance(kusd), { timeout: SYNC_MS }).toBe(merchantBefore);
  await expect
    .poll(() => cardBalanceOnChain(entropy, kusd, decoded.birth), {
      timeout: SYNC_MS,
      intervals: [5_000],
    })
    .toBe(load);

  // The owner refuses a wrong PIN, then freezes the card.
  await owner.page.goto("/app/card");
  await owner.page.getByRole("button", { name: "Manage" }).first().click();
  const ownerStarted = snapshotResponse(owner.page);
  await owner.page.getByLabel("PIN, to open the card").fill("830215");
  await owner.page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(owner.page.getByText("That PIN does not open this card.")).toBeVisible({
    timeout: 60_000,
  });
  await owner.page.getByLabel("PIN, to open the card").fill(PIN);
  await owner.page.getByRole("button", { name: "Open", exact: true }).click();
  const ownerMid = await owner.wallet.balance(kusd);
  await owner.page.getByRole("button", { name: "Freeze: move $3.00 back" }).click({
    timeout: OPEN_MS,
  });
  expect((await ownerStarted).status()).toBe(200);
  await finished(owner, "Frozen. The balance is back in your account.");
  await shot(owner, "card-frozen");
  await expect.poll(() => owner.wallet.balance(kusd), { timeout: SYNC_MS }).toBe(ownerMid + load);
  await expect
    .poll(() => cardBalanceOnChain(entropy, kusd, decoded.birth), {
      timeout: SYNC_MS,
      intervals: [5_000],
    })
    .toBe(0n);

  await expectNoProblems(owner, merchant);
});

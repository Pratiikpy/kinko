// Gift cards, issued and received through the app: an issuer funds a card and
// sends its link; the recipient opens the link with no wallet, sees it is
// genuine and what it holds, then connects and moves the balance into their own
// account, their wallet paying the fee. The card's balance is read from the
// chain by opening the card from Node, never trusted from the page.

import { decodeGiftCard } from "@kinko/kinko-pay";
import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  BIRTH,
  cardBalanceOnChain,
  closeParties,
  connect,
  copied,
  DEPLOYMENT,
  expectNoProblems,
  finished,
  OPEN_MS,
  party,
  registry,
  seed,
  shot,
  snapshotResponse,
  SYNC_MS,
} from "./live.ts";

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("a recipient opens a $2.50 gift card without a wallet, then keeps it", async ({ browser }) => {
  const issuer = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const recipient = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const amount = 2_500_000n;
  const issuerBefore = await issuer.wallet.balance(kusd);
  test.skip(issuerBefore < amount, `the issuer holds ${String(issuerBefore)} KUSD`);

  await issuer.page.goto("/app/gifts");
  await connect(issuer);
  await issuer.page.getByLabel("Amount").fill("2.50");
  await issuer.page.getByLabel("Label, for you").fill("Birthday, Aiko");
  await issuer.page.getByRole("button", { name: "Issue and fund the card" }).click();
  await finished(issuer, "Registered and funded.");
  const link = await copied(issuer.page, "Card link");
  expect(link).toMatch(/\/gift#/);
  await shot(issuer, "gift-issued");

  const card = decodeGiftCard(link);
  if (!card) throw new Error("the issued link is not a gift card");
  expect(card.birth, "the issuer stamps the card with where the chain's tree stood").toMatch(BIRTH);
  const entropy = Uint8Array.from(Buffer.from(card.secret, "hex"));
  await expect
    .poll(() => cardBalanceOnChain(entropy, kusd, card.birth), {
      timeout: SYNC_MS,
      intervals: [5_000],
    })
    .toBe(amount);

  // The recipient opens the link with no wallet connected.
  const started = snapshotResponse(recipient.page);
  await recipient.page.goto(link);
  await expect(recipient.page.getByText("Genuine")).toBeVisible({ timeout: 60_000 });
  await expect(recipient.page.getByTestId("card-balance")).toHaveText("$2.50", {
    timeout: OPEN_MS,
  });
  // The card started from the service's tree at its birth, rather than replaying the chain.
  expect((await started).status()).toBe(200);
  await expect(recipient.page.getByTestId("card-balance")).toHaveAttribute(
    "data-started-from",
    "snapshot",
  );
  await shot(recipient, "gift-opened");

  const recipientBefore = await recipient.wallet.balance(kusd);
  await connect(recipient);
  await recipient.page.getByRole("button", { name: "Move $2.50 to my account" }).click();
  await finished(recipient, "$2.50 moved to your account");
  await shot(recipient, "gift-kept");

  await expect
    .poll(() => recipient.wallet.balance(kusd), { timeout: SYNC_MS })
    .toBe(recipientBefore + amount);
  await expect
    .poll(() => cardBalanceOnChain(entropy, kusd, card.birth), {
      timeout: SYNC_MS,
      intervals: [5_000],
    })
    .toBe(0n);

  await expectNoProblems(issuer, recipient);
});

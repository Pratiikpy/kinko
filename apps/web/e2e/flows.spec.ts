// What a person does on each surface, and what they must see back. Run once
// per project; the assertions are about behaviour, not looks.

import {
  BACKING,
  connect,
  DEPOSIT_ADDRESS,
  expect,
  goInApp,
  injectWallet,
  mockRelayer,
  shot,
  test,
} from "./fixtures.ts";

test("the theme toggle switches and is remembered across a reload", async ({
  page,
  problems,
}, info) => {
  void problems;
  await page.goto("/");
  const before = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
  const after = await page.locator("html").getAttribute("data-theme");
  expect(after).not.toBe(before);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", after ?? "");
  void info;
});

test("the landing page shows the relayer's live backing figures", async ({ page, problems }) => {
  void problems;
  await page.goto("/");
  await expect(page.getByText("$1,250.40").first()).toBeVisible();
  await expect(page.getByText("$1,250.00").first()).toBeVisible();
  await expect(page.getByText(/Covered/)).toContainText("100.03%");
  await expect(page.getByText(BACKING.ethereumBlock.toLocaleString()).first()).toBeVisible();
});

test("the backing page says which figures it could not read itself", async ({ page, problems }) => {
  void problems;
  await page.goto("/backing");
  await expect(page.getByText("No Ethereum RPC in this build")).toBeVisible();
  await expect(page.getByText("No public indexer in this build")).toBeVisible();
  await expect(page.getByText(/Fully backed, by the relayer's report/)).toBeVisible();
});

test("a relayer outage is stated, not hidden", async ({ page }, info) => {
  await page.unrouteAll();
  await mockRelayer(page, { down: true });
  await page.goto("/backing");
  await expect(page.getByText(/Cannot be verified right now/)).toBeVisible();
  await expect(page.getByText(/HTTP 503/).first()).toBeVisible();
  await shot(page, info, "backing-relayer-down");
});

test("connecting shows the private balance and the shielded address", async ({
  page,
  problems,
}) => {
  void problems;
  await injectWallet(page);
  await page.goto("/app");
  await expect(page.getByText(/Connect to see your private balance/)).toBeVisible();
  await connect(page);
  await expect(
    page.getByRole("button", { name: /Copy Address: mn_shield-addr_undeployed1/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show code" }).click();
  await expect(page.getByRole("img", { name: /QR code of your shielded address/ })).toBeVisible();
});

test("starting a deposit fetches the deposit address and keeps it across a reload", async ({
  page,
  problems,
}, info) => {
  void problems;
  await injectWallet(page);
  await page.goto("/app");
  await connect(page);
  await goInApp(page, "/app/add");
  await page.getByLabel("Amount in USDC").fill("12x");
  await page.getByRole("button", { name: "Get my deposit address" }).click();
  await expect(page.getByText(/Use digits and at most one decimal point/)).toBeVisible();
  await page.getByLabel("Amount in USDC").fill("100");
  await page.getByRole("button", { name: "Get my deposit address" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`Copy Address: ${DEPOSIT_ADDRESS}`) }),
  ).toBeVisible();
  await expect(page.getByText(/Balances could not be read/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the deposit" })).toBeDisabled();
  await expect(page.getByText("Send USDC to your deposit address")).toBeVisible();
  await shot(page, info, "app-add-funding");

  // A closed tab resumes: the wallet used last reconnects by itself, and the
  // request is in the encrypted records.
  await page.goto("/app");
  await expect(page.getByTestId("balance")).toContainText("$1,250.00", { timeout: 20_000 });
  await expect(page.getByText(/Deposit of \$100.00 in progress/)).toBeVisible();
});

test("batch pay checks every line on the device and names the bad ones", async ({
  page,
  problems,
}, info) => {
  void problems;
  await injectWallet(page);
  await page.goto("/app");
  await connect(page);
  await goInApp(page, "/app/batch");
  await page
    .getByLabel(/Or paste it/)
    .fill(
      `recipient,amount,memo\n@alice,1250,Retainer\n@bob_designs,480\n0x${"ab".repeat(20)},5\n@carol,abc`,
    );
  await expect(page.getByText("2 lines to fix")).toBeVisible();
  await expect(page.getByText(/Line 4:/)).toBeVisible();
  await expect(page.getByText(/Line 5:/)).toBeVisible();
  await expect(page.getByText("2 payments · $1,730.00")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay 2 people/ })).toBeDisabled();
  await shot(page, info, "app-batch-checked");
});

test("pay refuses text that is not a tag, address or link", async ({ page, problems }) => {
  void problems;
  await page.goto("/app/pay");
  await page.getByLabel("Who are you paying?").fill("0xnot-a-thing");
  await expect(page.getByText(/is not a @tag, a shielded address on this network/)).toBeVisible();
});

test("verify refuses a forged proof, and checkout explains an incomplete link", async ({
  page,
  problems,
}) => {
  void problems;
  await page.goto("/verify#bm90LWEtcHJvb2Y");
  await expect(page.getByText("That is not a Kinko receipt proof.")).toBeVisible();
  await page.goto("/checkout#garbage");
  await expect(page.getByText("This checkout link is incomplete")).toBeVisible();
});

test("the tour remembers ticked stops", async ({ page, problems }) => {
  void problems;
  await page.goto("/walkthrough");
  await page.getByRole("button", { name: "Mark stop 1 as done" }).click();
  await expect(page.getByText("1 of 7 done.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Mark stop 1 as not done" })).toBeVisible();
});

test("every page is reachable from the menu on a phone", async ({ page, problems }, info) => {
  void problems;
  test.skip(!info.project.name.startsWith("phone"), "the menu button exists at phone width only");
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  await shot(page, info, "menu-open");
  await dialog.getByRole("link", { name: "Gift cards" }).click();
  await expect(page).toHaveURL(/\/app\/gifts$/);
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
});

test("the menu closes with Escape and the page is keyboard reachable", async ({
  page,
  problems,
}, info) => {
  void problems;
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  if (info.project.name.startsWith("phone")) {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
  }
});

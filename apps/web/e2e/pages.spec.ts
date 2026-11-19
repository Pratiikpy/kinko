// Every page, at desktop and phone width, light and dark: it renders its
// heading, has no sideways scroll, keeps controls at least 44px tall, logs no
// errors, and is captured for visual review.

import {
  connect,
  expect,
  expectNoHorizontalScroll,
  expectTapTargets,
  goInApp,
  injectWallet,
  shot,
  test,
} from "./fixtures.ts";

const PUBLIC: { path: string; name: string; heading: RegExp }[] = [
  { path: "/", name: "landing", heading: /A private dollar account/ },
  { path: "/backing", name: "backing", heading: /Is every private dollar here/ },
  { path: "/examine", name: "examine", heading: /Exactly the records a case names/ },
  { path: "/checkout", name: "checkout-empty", heading: /checkout link is incomplete/ },
  { path: "/gift", name: "gift-empty", heading: /card link is incomplete/ },
  {
    // A PIN card's link opens on its PIN prompt; nothing is read until the PIN is given.
    path: `/card#${Buffer.from(JSON.stringify({ v: 2, k: "pin", s: "ab".repeat(32) })).toString("base64url")}`,
    name: "card-pin",
    heading: /PIN card/,
  },
  { path: "/verify", name: "verify", heading: /Check a payment receipt/ },
  { path: "/docs", name: "docs", heading: /How to use Kinko/ },
  { path: "/developer", name: "developer", heading: /Build on Kinko/ },
  { path: "/vision", name: "vision", heading: /Private payments, public reserves/ },
  { path: "/privacy", name: "privacy", heading: /What is public, what is private/ },
  { path: "/walkthrough", name: "walkthrough", heading: /See the whole product/ },
  { path: "/app", name: "app-disconnected", heading: /Private dollars/ },
  { path: "/no-such-page", name: "not-found", heading: /nothing at this address/ },
];

for (const p of PUBLIC) {
  test(`${p.name} renders cleanly`, async ({ page, problems }, info) => {
    void problems;
    await page.goto(p.path);
    await expect(
      page.getByRole("heading", { level: 1 }).or(page.getByText(p.heading)).first(),
    ).toContainText(p.heading);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page);
    await expectTapTargets(page);
    await shot(page, info, p.name);
  });
}

// The menu a narrow screen opens must fill the screen and reach every section. It once opened as a
// strip as tall as the header, with the links beneath the page, and no page test opened it.
for (const width of [390, 900]) {
  test(`the menu opens full height and returns focus, at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open menu" });
    await opener.click();
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box?.height ?? 0, "the menu fills the viewport").toBeGreaterThanOrEqual(699);
    for (const link of ["Backing", "Examine", "Docs", "Tour"]) {
      const target = menu.getByRole("link", { name: link, exact: true });
      await expect(target).toBeInViewport();
    }
    await expect(menu.getByRole("link", { name: "Settings" })).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

const CONNECTED: { path: string; name: string; heading: RegExp }[] = [
  { path: "/app", name: "app-home", heading: /Private dollars/ },
  { path: "/app/add", name: "app-add", heading: /Turn USDC into private dollars/ },
  { path: "/app/withdraw", name: "app-withdraw", heading: /Take your dollars back out/ },
  { path: "/app/pay", name: "app-pay", heading: /Pay anyone, privately/ },
  { path: "/app/request", name: "app-request", heading: /Ask to be paid/ },
  { path: "/app/invoices", name: "app-invoices", heading: /What you have asked for/ },
  { path: "/app/batch", name: "app-batch", heading: /Pay a whole list at once/ },
  { path: "/app/gifts", name: "app-gifts", heading: /handed over as a link/ },
  { path: "/app/card", name: "app-card", heading: /A card and a PIN, no wallet at the till/ },
  { path: "/app/receipts", name: "app-receipts", heading: /Proof of what you paid/ },
  { path: "/app/merchant", name: "app-merchant", heading: /Your business, seen only by you/ },
  { path: "/app/tags", name: "app-tags", heading: /Be paid by name/ },
  { path: "/app/settings", name: "app-settings", heading: /Settings/ },
];

test("connected account screens render cleanly", async ({ page, problems }, info) => {
  void problems;
  test.setTimeout(180_000);
  await injectWallet(page);
  await page.goto("/app");
  await connect(page);
  for (const p of CONNECTED) {
    await goInApp(page, p.path);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(p.heading);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    await expectTapTargets(page);
    await shot(page, info, p.name);
  }
});

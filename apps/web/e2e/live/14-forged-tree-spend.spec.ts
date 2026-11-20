// What a card started from a tree with a changed hash does when it spends.
//
// 13-forged-tree shows a card opens from such a tree and shows the right balance, because the
// wallet follows the chain's events from the snapshot and finds its coin by decrypting them. The
// tree's hashes matter only when the card proves a spend. This makes a card, opens it from a
// snapshot with one hex digit of its tree changed, and freezes it, which spends the whole card
// back to its owner, then records whether the spend went through and what the page said.

import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  copied,
  DEPLOYMENT,
  finished,
  OPEN_MS,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

const PIN = "204817";
const POSITION = Number(process.env.KINKO_FORGE_POSITION ?? "1500");

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

/** The same snapshot with one hex digit of its state changed. */
const forge = (body: string, position: number): string => {
  const parsed = JSON.parse(body) as { snapshot: string };
  const snapshot = JSON.parse(parsed.snapshot) as { state: string };
  const at = snapshot.state[position] ?? "0";
  const changed = at === "0" ? "1" : "0";
  snapshot.state = `${snapshot.state.slice(0, position)}${changed}${snapshot.state.slice(position + 1)}`;
  return JSON.stringify({ ...parsed, snapshot: JSON.stringify(snapshot) });
};

test("a card opened from a tree with a changed hash is frozen, or says why not", async ({
  browser,
}) => {
  const owner = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const load = 1_000_000n;
  const ownerBefore = await owner.wallet.balance(kusd);
  test.skip(ownerBefore < load, `the owner holds ${String(ownerBefore)} KUSD`);

  await owner.page.goto("/app/card");
  await connect(owner);
  await owner.page.getByLabel("Name, for you").fill("Forged spend card");
  await owner.page.getByLabel("Load it with").fill("1.00");
  await owner.page.getByLabel("PIN", { exact: true }).fill(PIN);
  await owner.page.getByLabel("PIN again").fill(PIN);
  await owner.page.getByRole("button", { name: "Make the card" }).click();
  await finished(owner, "The card is ready.");
  await copied(owner.page, "Card link");

  await owner.page.route("**/v1/card-snapshot?birth=*", async (route) => {
    const real = await route.fetch();
    await route.fulfill({ response: real, body: forge(await real.text(), POSITION) });
  });
  await owner.page.goto("/app/card");
  await owner.page.getByRole("button", { name: "Manage" }).first().click();
  await owner.page.getByLabel("PIN, to open the card").fill(PIN);
  await owner.page.getByRole("button", { name: "Open", exact: true }).click();
  const balance = owner.page.getByTestId("card-balance");
  await expect(balance).toBeVisible({ timeout: OPEN_MS });
  const started = await balance.getAttribute("data-started-from");
  console.log(`FORGED-SPEND digit ${String(POSITION)}: opened from ${started ?? "?"}`);

  const before = await owner.wallet.balance(kusd);
  await owner.page.getByRole("button", { name: /^Freeze: move \$1\.00 back/ }).click({
    timeout: OPEN_MS,
  });
  const outcome = await Promise.race([
    owner.page
      .getByText("Frozen. The balance is back in your account.")
      .waitFor({ timeout: 20 * 60_000 })
      .then(() => "frozen"),
    owner.page
      .locator('[role="alert"]')
      .first()
      .waitFor({ timeout: 20 * 60_000 })
      .then(
        async () =>
          `alert: ${(await owner.page.locator('[role="alert"]').first().innerText()).replace(/\s+/g, " ")}`,
      ),
  ]);
  await shot(owner, "forged-spend");
  const after = await owner.wallet.balance(kusd);
  console.log(
    `FORGED-SPEND digit ${String(POSITION)}: ${outcome}; owner KUSD ${String(before)} -> ${String(after)}`,
  );
  expect(["frozen", "alert"].some((p) => outcome.startsWith(p))).toBe(true);
});

// A card started from a snapshot whose commitment tree has the right size and wrong hashes.
//
// The snapshot service is believed about the chain only as far as the card can check it, and a
// tree with the right size and wrong hashes is not something the card can check before it spends.
// This opens one real card several times, each time with one byte of the tree changed on the way
// from the service, and records what the card does: where it started from, what it shows, and
// whether it ends up showing the right balance.

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
  SYNC_MS,
} from "./live.ts";

const PIN = "204817";
/** Where in the snapshot's hex-encoded state one digit is changed: past the header, into the tree. */
const POSITIONS = [400, 900, 1500, 2300, 3000];

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

test("a card opened from a tree with a changed hash shows what it started from and its balance", async ({
  browser,
}) => {
  const owner = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const load = 1_000_000n;
  const ownerBefore = await owner.wallet.balance(kusd);
  test.skip(ownerBefore < load, `the owner holds ${String(ownerBefore)} KUSD`);

  await owner.page.goto("/app/card");
  await connect(owner);
  await owner.page.getByLabel("Name, for you").fill("Forged tree card");
  await owner.page.getByLabel("Load it with").fill("1.00");
  await owner.page.getByLabel("PIN", { exact: true }).fill(PIN);
  await owner.page.getByLabel("PIN again").fill(PIN);
  await owner.page.getByRole("button", { name: "Make the card" }).click();
  await finished(owner, "The card is ready.");
  await copied(owner.page, "Card link");

  const seen: string[] = [];
  for (const position of POSITIONS) {
    await owner.page.route("**/v1/card-snapshot?birth=*", async (route) => {
      const real = await route.fetch();
      await route.fulfill({ response: real, body: forge(await real.text(), position) });
    });
    await owner.page.goto("/app/card");
    await owner.page.getByRole("button", { name: "Manage" }).first().click();
    await owner.page.getByLabel("PIN, to open the card").fill(PIN);
    await owner.page.getByRole("button", { name: "Open", exact: true }).click();
    const balance = owner.page.getByTestId("card-balance");
    let outcome = "no balance within the wait";
    try {
      await expect(balance).toBeVisible({ timeout: OPEN_MS });
      const first = await balance.getAttribute("data-started-from");
      const text = await balance.textContent();
      outcome = `shows ${text ?? ""} started from ${first ?? "?"}`;
      // If it fell back to the chain it replays from the first event; give that the sync budget.
      if (first !== "snapshot") {
        await expect(balance).toHaveText("$1.00", { timeout: SYNC_MS });
        outcome += ", then $1.00";
      }
    } catch (error) {
      outcome += ` (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : "error"})`;
    }
    await owner.page.unroute("**/v1/card-snapshot?birth=*");
    seen.push(`digit ${String(position)}: ${outcome}`);
    console.log(`FORGED-TREE digit ${String(position)}: ${outcome}`);
  }
  test.info().annotations.push({ type: "forged-tree", description: seen.join(" | ") });
});

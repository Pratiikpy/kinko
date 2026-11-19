// Examiner disclosure, every role through the app: an account holder files a
// sealed statement; the operator registers an examiner; the examiner opens a
// case naming that record; one keyholder approves and the record stays
// sealed; a second approves and the examiner reads exactly that record,
// checked against its anchor. The keys come from the deployment ceremony.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";

import {
  closeParties,
  connect,
  expectNoProblems,
  finished,
  NETWORK,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

interface Ceremony {
  operatorSecret: string;
  keyholders: { index: number; scalar: string; bindingScalar: string }[];
}

const ceremony = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(`../../../../.secrets/${NETWORK}/disclosure-ceremony.json`, import.meta.url),
    ),
    "utf8",
  ),
) as Ceremony;

const role = (page: Page, name: string) => page.getByRole("radio", { name }).click();
const copied = async (page: Page, label: string) =>
  (
    (await page
      .getByRole("button", { name: new RegExp(`^Copy ${label}:`) })
      .getAttribute("aria-label")) ?? ""
  ).replace(new RegExp(`^Copy ${label}:\\s*`), "");

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test("an examiner reads exactly the record a case names, after two keyholders approve", async ({
  browser,
}) => {
  const holder = await party(browser, reg, "Payer", seed("USER_SEED"));
  const staff = await party(browser, reg, "Merchant", seed("BEARER_SEED"));
  const memo = `Kiln invoice ${Date.now().toString(36)}`;

  // The account holder files a sealed statement.
  await holder.page.goto("/examine");
  await connect(holder);
  await role(holder.page, "An account holder");
  await holder.page.getByLabel("Amount").fill("312.40");
  await holder.page.getByLabel("Counterparty").fill("Mashiko Clay Co.");
  await holder.page.getByLabel("Reference").fill("INV-2026-118");
  await holder.page.getByLabel("Memo").fill(memo);
  await holder.page.getByRole("button", { name: /^File/ }).click();
  await finished(holder, "Sealed and filed.");
  const recordId = await copied(holder.page, "Record id");
  expect(recordId).toMatch(/^[0-9a-f]{64}$/);

  // The examiner makes a key; the operator registers it.
  const page = staff.page;
  await page.goto("/examine");
  await connect(staff);
  await role(page, "An examiner");
  await page.getByRole("button", { name: "Make a new examiner key" }).click();
  const scalar = await copied(page, "Scalar \\(secret\\)");
  const publicKey = await copied(page, "Public key, for the operator");
  await role(page, "The operator");
  await page.getByLabel("Operator secret").fill(ceremony.operatorSecret);
  await expect(page.getByText("Matches the commitment sealed at deployment.")).toBeVisible();
  await page.getByLabel("Examiner public key, as the examiner page gives it").fill(publicKey);
  await page.getByRole("button", { name: "Register the examiner" }).click();
  await finished(staff, "Done and logged.");

  // The examiner opens a case naming the record.
  await role(page, "An examiner");
  await page.getByLabel("Examiner scalar").fill(scalar);
  await expect(page.getByText("Registered", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Record ids, separated by spaces or commas").fill(recordId);
  await page.getByRole("button", { name: /^Open/ }).click();
  await finished(staff, "Case opened. Keyholders can now see its scope and decide.");

  // Keyholder 0 approves: one share opens nothing.
  const approve = async (slot: number) => {
    const k = ceremony.keyholders[slot];
    if (!k) throw new Error(`no keyholder ${String(slot)} in the ceremony file`);
    await role(page, "A keyholder");
    await page.getByRole("radio", { name: `Slot ${String(slot)}` }).click();
    await page.getByLabel("Your share scalar").fill(`0x${k.scalar}`);
    await page.getByLabel("Binding scalar").fill(`0x${k.bindingScalar}`);
    await page.getByRole("button", { name: "Approve" }).first().click();
    await finished(staff, "Approved and logged.");
  };
  await approve(0);
  await role(page, "An examiner");
  await page.getByLabel("Examiner scalar").fill(scalar);
  await expect(page.getByText("Still sealed: two keyholders must approve.")).toBeVisible({
    timeout: 60_000,
  });

  // Keyholder 2 approves: now the examiner reads the record, checked against its anchor.
  await approve(2);
  await role(page, "An examiner");
  await page.getByLabel("Examiner scalar").fill(scalar);
  await expect(page.getByText(/Approved by keyholders 0 and 2/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\$312\.40\s+received from Mashiko Clay Co\./)).toBeVisible();
  await expect(page.getByText(memo, { exact: false })).toBeVisible();
  await expect(page.getByText(/Matches its anchor on chain\./)).toBeVisible();
  await shot(staff, "examine-disclosed");

  // Anyone sees the case and the log, not the contents.
  await role(page, "Anyone");
  await expect(page.getByText(memo)).toHaveCount(0);
  await shot(staff, "examine-public");

  await expectNoProblems(holder, staff);
});

// A user takes private dollars ($10, or what KINKO_LIVE_WITHDRAW_USDC names) back out as USDC to an Ethereum address
// they choose, through the app. The truth is read from both chains: the USDC
// that arrives at the address, the user's shielded balance, and the vault's
// public supply counters on the backing page.

import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";
import { ethers } from "ethers";

import {
  closeParties,
  connect,
  DEPLOYMENT,
  ENV,
  expectNoProblems,
  party,
  registry,
  seed,
  shot,
} from "./live.ts";

// Whole dollars to withdraw; a test wallet short of $11 can name a smaller amount.
const DOLLARS = process.env.KINKO_LIVE_WITHDRAW_USDC ?? "10";
if (!/^[1-9]\d*$/.test(DOLLARS)) throw new Error("KINKO_LIVE_WITHDRAW_USDC must be whole dollars.");
const AMOUNT = BigInt(DOLLARS) * 1_000_000n;
const ERC20 = ["function balanceOf(address who) view returns (uint256)"];

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test(`a user withdraws $${DOLLARS} of KUSD and receives $${DOLLARS} of USDC on Ethereum`, async ({
  browser,
}) => {
  const user = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const before = await user.wallet.balance(kusd);
  // The withdrawal and the vault's fee (well under a dollar), with a dollar to spare.
  test.skip(
    before < AMOUNT + 1_000_000n,
    `the user holds ${String(before)} KUSD; run the deposit first`,
  );

  const provider = new ethers.JsonRpcProvider(ENV.EVM_RPC_URL ?? "http://localhost:8545");
  const usdc = new ethers.Contract(ENV.ERC20_ADDRESS ?? "", ERC20, provider);
  const destination = ethers.Wallet.createRandom().address;

  await user.page.goto("/app/withdraw");
  await connect(user);
  await user.page.getByLabel("Amount in USDC").fill(DOLLARS);
  await user.page.getByLabel("Ethereum address that receives the USDC").fill(destination);
  const feeText = await user.page
    .getByText("Vault fee, set on chain")
    .locator("..")
    .getByText(/^\$/)
    .textContent();
  const fee = BigInt(Math.round(Number((feeText ?? "$0").replace(/[$,]/g, "")) * 1_000_000));
  await shot(user, "withdraw-form");
  await user.page.getByRole("button", { name: "Start the withdrawal" }).click();

  const close = user.page.getByRole("button", { name: "Close the withdrawal" });
  // The relayer takes minutes; stop at once if the app reports a failed action instead.
  await expect
    .poll(
      async () =>
        (await close.isVisible()) ||
        user.problems.some((p) => p.includes("[kinko] the action failed")),
      { timeout: 25 * 60_000, intervals: [5_000] },
    )
    .toBe(true);
  await expect(close, user.problems.join("\n")).toBeVisible();
  await shot(user, "withdraw-ready");
  await close.click();
  await expect(user.page.getByText(`USDC was sent to ${destination}`)).toBeVisible({
    timeout: 15 * 60_000,
  });
  await shot(user, "withdraw-done");

  await expect
    .poll(async () => (await usdc.getFunction("balanceOf")(destination)) as bigint, {
      timeout: 5 * 60_000,
    })
    .toBe(AMOUNT);
  await expect
    .poll(() => user.wallet.balance(kusd), { timeout: 5 * 60_000 })
    .toBe(before - AMOUNT - fee);

  await user.page.goto("/backing");
  await expect(user.page.getByText(/Fully backed/).first()).toBeVisible();
  await shot(user, "backing-after-withdraw");

  await expectNoProblems(user);
});

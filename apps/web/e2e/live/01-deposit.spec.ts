// A user turns USDC into private dollars through the app. The USDC arrives at
// the deposit address by an ordinary ERC20 transfer from another Ethereum
// account, exactly as it would from an exchange; everything after that runs
// through the app, the relayer, the signer network and the vault. On the local
// stack the paying account is dealt $50 on the Sepolia fork; on a deployed
// network it is the real Sepolia account EVM_FUNDER_PRIVATE_KEY names, paying
// KINKO_LIVE_DEPOSIT_USDC (default 20) of its own USDC.
// The truth is read from both chains: the user's shielded balance, the
// vault's USDC balance, and the vault's public supply counters.

import { expect, test } from "@playwright/test";
import type { WalletRegistry } from "@sig-net/midnight-contract-deploy";
import { dealFork } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/fork-funding.ts";
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

const LOCAL = (ENV.NETWORK_ID ?? "undeployed") === "undeployed";
const USDC = LOCAL ? 50n : BigInt(ENV.KINKO_LIVE_DEPOSIT_USDC ?? "20");
const AMOUNT = USDC * 1_000_000n;
const DOLLARS = `$${USDC.toString()}.00`;
const ERC20 = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
];

let reg: WalletRegistry;
test.beforeAll(() => {
  reg = registry();
});
test.afterAll(async () => {
  await closeParties();
  await reg.close();
});

test(`a user deposits ${DOLLARS} of USDC and receives ${DOLLARS} of private KUSD`, async ({
  browser,
}) => {
  const user = await party(browser, reg, "Payer", seed("USER_SEED"));
  const kusd = DEPLOYMENT.kusdColor;
  const before = await user.wallet.balance(kusd);
  const provider = new ethers.JsonRpcProvider(ENV.EVM_RPC_URL ?? "http://localhost:8545");
  const usdc = new ethers.Contract(ENV.ERC20_ADDRESS ?? "", ERC20, provider);
  const vaultUsdcBefore = (await usdc.getFunction("balanceOf")(ENV.EVM_VAULT_ADDRESS)) as bigint;

  await user.page.goto("/app/add");
  await connect(user);
  await user.page.getByLabel("Amount in USDC").fill(USDC.toString());
  await user.page.getByRole("button", { name: "Get my deposit address" }).click();
  const label = await user.page
    .getByRole("button", { name: /^Copy Address: 0x/ })
    .getAttribute("aria-label");
  const depositAddress = label?.replace(/^Copy Address:\s*/, "") ?? "";
  expect(depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const gasText = await user.page.getByText(/^Up to [0-9.]+ ETH for the sweep's gas/).textContent();
  const gasEth = /Up to ([0-9.]+)/.exec(gasText ?? "")?.[1];
  expect(gasEth, "the page states the gas the sweep needs").toBeDefined();
  await shot(user, "deposit-address");

  // Another account pays the address, as an exchange withdrawal would.
  const funder = LOCAL
    ? ethers.Wallet.createRandom().connect(provider)
    : new ethers.Wallet(seed("EVM_FUNDER_PRIVATE_KEY"), provider);
  if (LOCAL) await dealFork(provider, funder.address, AMOUNT);
  // A run that stopped after paying the address resumes with what it already holds, so the
  // address never ends up with more than the deposit this test checks.
  const held = (await usdc.getFunction("balanceOf")(depositAddress)) as bigint;
  if (held < AMOUNT) {
    const transfer = (await usdc.connect(funder).getFunction("transfer")(
      depositAddress,
      AMOUNT - held,
    )) as ethers.ContractTransactionResponse;
    await transfer.wait();
  }
  await (
    await funder.sendTransaction({ to: depositAddress, value: ethers.parseEther(gasEth ?? "0") })
  ).wait();

  const start = user.page.getByRole("button", { name: "Start the deposit" });
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const ready = user.page.getByText("Your dollars are ready to mint");
  const refused = user.page.getByText("The deposit did not start");
  // A live MPC attests after Ethereum finality, about 13 minutes on Sepolia.
  await expect(ready.or(refused)).toBeVisible({ timeout: (LOCAL ? 25 : 50) * 60_000 });
  await expect(refused, user.problems.join("\n")).toBeHidden();
  await shot(user, "deposit-ready");
  await user.page.getByRole("button", { name: `Receive ${DOLLARS}` }).click();
  await expect(user.page.getByText(`${DOLLARS} KUSD is in your private balance.`)).toBeVisible({
    timeout: 15 * 60_000,
  });
  await shot(user, "deposit-done");

  await expect.poll(() => user.wallet.balance(kusd), { timeout: 5 * 60_000 }).toBe(before + AMOUNT);
  const vaultUsdcAfter = (await usdc.getFunction("balanceOf")(ENV.EVM_VAULT_ADDRESS)) as bigint;
  expect(vaultUsdcAfter - vaultUsdcBefore).toBe(AMOUNT);

  // The public backing page agrees with both chains.
  await user.page.goto("/backing");
  await expect(user.page.getByText(/Fully backed/).first()).toBeVisible();
  await shot(user, "backing-after-deposit");

  await expectNoProblems(user);
});

// Shared browser-suite machinery.
//
// Every test runs with listeners for console errors, page errors and failed
// requests attached before the first navigation, and fails if any fired. The
// relayer is answered by the suite with fixed figures, and a Midnight wallet
// that speaks the DApp Connector API is injected for the connected screens.
// Nothing here is product code: it stands in for services the suite does not
// start, so every screen can be checked in a known state.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { rawTokenType } from "@midnight-ntwrk/compact-runtime";
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from "@midnightntwrk/wallet-sdk-address-format";
import { expect, type Page, test as base, type TestInfo } from "@playwright/test";
import { evmAddressBytes, pureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";

export const RELAYER = "http://127.0.0.1:3299";
export const VAULT_CONTRACT = "4b".repeat(32);
export const EVM_VAULT = "0x8f0A22Fb5D3aA9C4E1b2d3C4b5a6978877665544";
export const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const DEPOSIT_ADDRESS = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";

/** KUSD's token type for the mocked deployment, computed the way the app computes it. */
export const KUSD_TYPE = rawTokenType(
  pureCircuits.vaultTokenDomainSeparator(evmAddressBytes(USDC)),
  VAULT_CONTRACT,
);

const COIN_PK = "a1".repeat(32);
const ENC_PK = "b2".repeat(32);
export const SHIELDED = MidnightBech32m.encode(
  "undeployed",
  new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(COIN_PK, "hex")),
    new ShieldedEncryptionPublicKey(Buffer.from(ENC_PK, "hex")),
  ),
).asString();
const UNSHIELDED = MidnightBech32m.encode(
  "undeployed",
  new UnshieldedAddress(Buffer.from("c3".repeat(32), "hex")),
).asString();

export const BACKING = {
  usdcInVault: "1250400000",
  kusdMinted: "1310000000",
  kusdBurned: "60000000",
  vaultContractAddress: VAULT_CONTRACT,
  evmVaultAddress: EVM_VAULT,
  usdcAddress: USDC,
  ethereumBlock: 7_412_886,
  midnightBlock: 191_204,
  updatedAt: new Date().toISOString(),
};

/** Answer the relayer's five endpoints with fixed, well-formed figures. */
export async function mockRelayer(page: Page, opts: { down?: boolean } = {}) {
  await page.route(`${RELAYER}/**`, async (route) => {
    if (opts.down) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "maintenance" }),
      });
      return;
    }
    const url = new URL(route.request().url());
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/health")
      return json(200, {
        ok: true,
        network: "undeployed",
        vaultContractAddress: VAULT_CONTRACT,
        evmVaultAddress: EVM_VAULT,
        usdcAddress: USDC,
        evmChainId: 11155111,
      });
    if (url.pathname === "/backing") return json(200, BACKING);
    if (url.pathname === "/deposit-address") return json(200, { evmAddress: DEPOSIT_ADDRESS });
    if (url.pathname === "/requests" && route.request().method() === "POST")
      return json(202, JSON.parse(route.request().postData() ?? "{}"));
    if (url.pathname.startsWith("/requests/"))
      return json(200, { kind: "deposit", stage: "signed", updatedAt: new Date().toISOString() });
    if (url.pathname === "/graphql") return json(200, { data: { contractAction: null } });
    return json(404, { error: "not found" });
  });
}

/** Inject a Midnight wallet into window.midnight, as an extension would. */
export async function injectWallet(page: Page, kusdBalance = 1_250_000_000n) {
  await page.addInitScript(
    ({ shielded, unshielded, coin, enc, kusd, balance, indexer }) => {
      const api = {
        getConfiguration: () =>
          Promise.resolve({
            indexerUri: indexer,
            indexerWsUri: indexer.replace("http", "ws"),
            substrateNodeUri: "ws://127.0.0.1:9944",
            networkId: "undeployed",
          }),
        getConnectionStatus: () =>
          Promise.resolve({ status: "connected", networkId: "undeployed" }),
        getShieldedAddresses: () =>
          Promise.resolve({
            shieldedAddress: shielded,
            shieldedCoinPublicKey: coin,
            shieldedEncryptionPublicKey: enc,
          }),
        getUnshieldedAddress: () => Promise.resolve({ unshieldedAddress: unshielded }),
        getShieldedBalances: () => Promise.resolve({ [kusd]: BigInt(balance) }),
        getUnshieldedBalances: () => Promise.resolve({}),
        getDustBalance: () => Promise.resolve({ balance: 0n, cap: 0n }),
        hintUsage: () => Promise.resolve(),
      };
      const wallet = {
        name: "Test wallet",
        icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%231f6f5c%22/%3E%3C/svg%3E",
        rdns: "test.kinko.wallet",
        apiVersion: "4.1.0",
        connect: () => Promise.resolve(api),
      };
      (window as unknown as { midnight: Record<string, unknown> }).midnight = { kinkotest: wallet };
    },
    {
      shielded: SHIELDED,
      unshielded: UNSHIELDED,
      coin: COIN_PK,
      enc: ENC_PK,
      kusd: KUSD_TYPE,
      balance: kusdBalance.toString(),
      indexer: `${RELAYER}/graphql`,
    },
  );
}

/** Connect the injected wallet through NightKit's own button and wallet list. */
export async function connect(page: Page) {
  await page
    .getByRole("button", { name: /^Connect/ })
    .locator("visible=true")
    .first()
    .click();
  await page.getByRole("button", { name: /Test wallet/ }).click();
  await expect(page.getByTestId("balance")).toContainText("$1,250.00", { timeout: 20_000 });
}

/** Navigate inside the app without a reload, so the wallet session stays. */
export async function goInApp(page: Page, to: string) {
  await page.evaluate((p) => {
    window.history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, to);
  await page.waitForLoadState("networkidle");
}

/** Every visible button and form control must be at least 44px tall. */
export async function expectTapTargets(page: Page) {
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "main button, main input:not([type=file]):not(.sr-only), main select, main textarea, header button",
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== "hidden" &&
          !el.classList.contains("sr-only") &&
          !el.closest(".sr-only")
        );
      })
      .filter((el) => el.getBoundingClientRect().height < 43.5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent).trim().slice(0, 40)}" ${String(Math.round(el.getBoundingClientRect().height))}px`,
      ),
  );
  expect(small, "controls under 44px").toEqual([]);
}

export async function expectNoHorizontalScroll(page: Page) {
  const { scroll, client, wide } = await page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    // Name the outermost elements that stick out, so a failure says where.
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(
        (el) =>
          el.getBoundingClientRect().right > client + 1 && !el.closest("[class*=overflow-x-auto]"),
      )
      .filter(
        (el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= client + 1,
      )
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${el.className.slice(0, 60)} right=${String(Math.round(el.getBoundingClientRect().right))}`,
      );
    return { scroll: document.documentElement.scrollWidth, client, wide };
  });
  expect(scroll, `page scrolls sideways: ${wide.join(" | ")}`).toBeLessThanOrEqual(client);
}

export async function shot(page: Page, info: TestInfo, name: string) {
  const dir = path.join(import.meta.dirname, "screenshots", info.project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

interface Fixtures {
  problems: string[];
}

/**
 * The suite's test: theme set from the project's colour scheme, the relayer
 * answered, and every console error, page error and failed request recorded
 * and checked at the end.
 */
export const test = base.extend<Fixtures>({
  problems: async ({ page }, use, info) => {
    const problems: string[] = [];
    const dark = info.project.use.colorScheme === "dark";
    await page.addInitScript(
      (t) => {
        try {
          // Only the first load takes the project's theme; a choice made in the page then sticks.
          if (localStorage.getItem("kinko:theme") === null) localStorage.setItem("kinko:theme", t);
        } catch {
          // Storage may be blocked; the default theme then applies.
        }
      },
      dark ? "dark" : "light",
    );
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      // A navigation away from a page aborts its pending requests; that is not a failure.
      if (!err.includes("ERR_ABORTED")) problems.push(`requestfailed: ${r.url()} ${err}`);
    });
    await mockRelayer(page);
    await use(problems);
    expect(problems, "console errors, page errors or failed requests").toEqual([]);
  },
});

export { expect };

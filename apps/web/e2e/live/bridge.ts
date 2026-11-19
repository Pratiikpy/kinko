// Puts a DevWallet behind window.midnight in a page, so the app connects to
// it through the same DApp Connector discovery an extension uses. Values
// cross the binding as JSON, with bigints tagged so balances survive intact.

import type { Page } from "@playwright/test";

import type { DevWallet } from "./dev-wallet.ts";

const BIGINT_TAG = "$bigint";

// Real wallets announce an icon; so does this one, so the wallet chip renders as it would.
const DEV_WALLET_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f6f5c"/><path d="M9 11h14v10H9z" fill="none" stroke="#fff" stroke-width="2"/><circle cx="19" cy="16" r="1.6" fill="#fff"/></svg>',
  );

/**
 * Tag every bigint in a value so it survives JSON.
 *
 * @param value - Any value.
 * @returns The value with bigints replaced by tagged strings.
 */
export function encodeBigints(value: unknown): unknown {
  if (typeof value === "bigint") return { [BIGINT_TAG]: value.toString() };
  if (Array.isArray(value)) return value.map(encodeBigints);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBigints(v)]));
  }
  return value;
}

/**
 * Restore the bigints {@link encodeBigints} tagged.
 *
 * @param value - A decoded JSON value.
 * @returns The value with bigints restored.
 */
export function decodeBigints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBigints);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const tagged = record[BIGINT_TAG];
    if (typeof tagged === "string" && Object.keys(record).length === 1) return BigInt(tagged);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decodeBigints(v)]));
  }
  return value;
}

/**
 * Inject a DevWallet into a page before any of its scripts run.
 *
 * @param page - The page.
 * @param wallet - The wallet that answers.
 * @param name - The name the wallet picker shows.
 */
export async function injectDevWallet(
  page: Page,
  wallet: DevWallet,
  name = "Dev wallet",
): Promise<void> {
  await page.exposeBinding(
    "__kinkoDevWallet",
    async (_source, method: string, argsJson: string) => {
      const args = decodeBigints(JSON.parse(argsJson)) as unknown[];
      const result = await wallet.call(method, args);
      return JSON.stringify(encodeBigints(result ?? null));
    },
  );
  await page.addInitScript(
    ({ walletName, walletIcon, tag, networkId }) => {
      const call = (
        window as unknown as {
          __kinkoDevWallet: (method: string, args: string) => Promise<string>;
        }
      ).__kinkoDevWallet;
      const encode = (v: unknown): unknown => {
        if (typeof v === "bigint") return { [tag]: v.toString() };
        if (Array.isArray(v)) return v.map(encode);
        if (v && typeof v === "object") {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
        }
        return v;
      };
      const decode = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(decode);
        if (v && typeof v === "object") {
          const r = v as Record<string, unknown>;
          if (typeof r[tag] === "string" && Object.keys(r).length === 1) return BigInt(r[tag]);
          return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, decode(x)]));
        }
        return v;
      };
      const methods = [
        "getConfiguration",
        "getConnectionStatus",
        "getShieldedAddresses",
        "getUnshieldedAddress",
        "getShieldedBalances",
        "getUnshieldedBalances",
        "getDustBalance",
        "hintUsage",
        "balanceUnsealedTransaction",
        "balanceSealedTransaction",
        "submitTransaction",
        "makeTransfer",
      ];
      const hexOf = (b: Uint8Array) =>
        Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      const bytesOf = (h: string) =>
        new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
      const api = Object.fromEntries(
        methods.map((m) => [
          m,
          async (...args: unknown[]) => {
            const out = await call(m, JSON.stringify(encode(args)));
            const value = decode(JSON.parse(out));
            return value === null ? undefined : value;
          },
        ]),
      );
      // Proving goes to the wallet, as with a real wallet: only the preimage crosses.
      (api as Record<string, unknown>).getProvingProvider = () =>
        Promise.resolve({
          check: async (preimage: Uint8Array, keyLocation: string) => {
            const out = decode(
              JSON.parse(
                await call("provingCheck", JSON.stringify(encode([hexOf(preimage), keyLocation]))),
              ),
            ) as (bigint | null)[];
            // JSON has no undefined; the ledger expects it for an unset input.
            return out.map((v) => v ?? undefined);
          },
          prove: async (preimage: Uint8Array, keyLocation: string, overwrite?: bigint) => {
            const out = decode(
              JSON.parse(
                await call(
                  "provingProve",
                  JSON.stringify(encode([hexOf(preimage), keyLocation, overwrite ?? null])),
                ),
              ),
            );
            return bytesOf(String(out));
          },
        });
      const midnight = ((window as unknown as { midnight?: Record<string, unknown> }).midnight ??=
        {});
      midnight.kinkodev = {
        name: walletName,
        icon: walletIcon,
        rdns: "dev.kinko.wallet",
        apiVersion: "4.1.0",
        connect: (requested: string) =>
          requested === networkId
            ? Promise.resolve(api)
            : Promise.reject(new Error(`this wallet is on ${networkId}, not ${requested}`)),
      };
    },
    {
      walletName: name,
      walletIcon: DEV_WALLET_ICON,
      tag: BIGINT_TAG,
      networkId: wallet.config.networkId,
    },
  );
}

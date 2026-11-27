// Deployment configuration, read once from the build environment.
//
// Every value is optional at build time so a fresh checkout renders, but each
// screen that needs a missing value says which one, in plain words, instead of
// failing somewhere deep inside a transaction.

const env = import.meta.env as Record<string, string | undefined>;

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
};

const hex32 = (value: string | undefined): string | undefined => {
  const v = clean(value)?.replace(/^0x/i, "").toLowerCase();
  return v && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
};

/** "off" switches a service off explicitly, overriding the local-network default. */
const OFF = "off";

const url = (value: string | undefined): string | undefined => clean(value)?.replace(/\/+$/, "");

// A URL setting with a default that applies only when the variable is absent.
const urlOr = (value: string | undefined, fallback: string | undefined): string | undefined =>
  clean(value) === OFF ? undefined : (url(value) ?? fallback);

/** The Midnight network this build talks to. The wallet must be on the same one. */
export const NETWORK_ID = clean(env.VITE_NETWORK_ID) ?? "undeployed";

/**
 * The networks NightKit's vault (nightkit-vault 0.1.3) opens accounts on. On any other network it
 * refuses to connect, so this build offers only wallets that speak Midnight themselves there.
 */
const VAULT_NETWORKS: ReadonlySet<string> = new Set(["undeployed", "stagenet"]);

/** Whether an account can be opened from an Ethereum or Solana wallet on this network. */
export const VAULT_SIGN_IN = VAULT_NETWORKS.has(NETWORK_ID);

/**
 * Where the NightKit vault is served. It must be a different origin from the app. Unset on a
 * network the vault does not serve, so NightKit never offers a sign-in that would fail.
 */
export const NIGHTKIT_VAULT_URL = VAULT_SIGN_IN
  ? (url(env.VITE_NIGHTKIT_VAULT_URL) ?? "http://localhost:5184")
  : undefined;

/** The relayer that carries vault requests through their permissionless steps. */
export const RELAYER_URL = urlOr(
  env.VITE_RELAYER_URL,
  import.meta.env.DEV ? "http://localhost:3200" : undefined,
);

/** The merchant backend: checkout sessions, webhooks and the conversion oracle. */
export const BACKEND_URL = urlOr(
  env.VITE_BACKEND_URL,
  import.meta.env.DEV ? "http://localhost:3100" : undefined,
);

/**
 * A public, read-only Midnight indexer for pages that need no wallet: backing,
 * tag lookup, invoice status, the examiner view. A connected wallet's own
 * indexer is used for everything it signs.
 */
export const PUBLIC_INDEXER = (() => {
  const http = urlOr(
    env.VITE_INDEXER_URL,
    NETWORK_ID === "undeployed" ? "http://localhost:8088/api/v4/graphql" : undefined,
  );
  const ws = http
    ? (url(env.VITE_INDEXER_WS_URL) ?? http.replace(/^http/, "ws").concat("/ws"))
    : undefined;
  return http && ws ? { http, ws } : undefined;
})();

/** An Ethereum JSON-RPC endpoint the browser reads balances and nonces from. */
export const EVM_RPC_URL = urlOr(
  env.VITE_EVM_RPC_URL,
  NETWORK_ID === "undeployed" ? "http://localhost:8545" : undefined,
);

/** The Ethereum chain the vault holds USDC on. Sepolia unless stated otherwise. */
export const EVM_CHAIN_ID = Number(clean(env.VITE_EVM_CHAIN_ID) ?? "11155111");

/** An optional Midnight explorer. Without one, addresses are shown in full to copy. */
export const MIDNIGHT_EXPLORER_URL = url(env.VITE_MIDNIGHT_EXPLORER_URL);

/** The Ethereum explorer: Etherscan for Sepolia unless the build names another. */
export const EVM_EXPLORER_URL =
  url(env.VITE_EVM_EXPLORER_URL) ??
  (EVM_CHAIN_ID === 11155111 ? "https://sepolia.etherscan.io" : undefined);

/** Kinko's own contracts on Midnight. */
export const CONTRACTS = {
  pay: hex32(env.VITE_KINKO_PAY_ADDRESS),
  tags: hex32(env.VITE_KINKO_TAGS_ADDRESS),
  gift: hex32(env.VITE_KINKO_GIFT_ADDRESS),
  disclosure: hex32(env.VITE_KINKO_DISCLOSURE_ADDRESS),
} as const;

/**
 * The MPC's published root public key (SEC1 hex or NEAR form), which every deposit address derives
 * from. With it a build checks the address a relayer hands out instead of believing it.
 */
export const MPC_PUBLIC_KEY = clean(env.VITE_MPC_PUBLIC_KEY);

/** The name of one of Kinko's own contracts. */
export type KinkoContract = keyof typeof CONTRACTS;

/**
 * The vault deployment, when the build pins it. The relayer's /health names
 * the same values; pinning them here lets the public pages read both chains
 * directly even while the relayer is down.
 */
export const PINNED_VAULT = (() => {
  const vaultContractAddress = hex32(env.VITE_VAULT_CONTRACT_ADDRESS);
  const usdcAddress = clean(env.VITE_USDC_ADDRESS);
  const evmVaultAddress = clean(env.VITE_EVM_VAULT_ADDRESS);
  const evm = /^0x[0-9a-fA-F]{40}$/;
  return vaultContractAddress &&
    usdcAddress &&
    evm.test(usdcAddress) &&
    evmVaultAddress &&
    evm.test(evmVaultAddress)
    ? { vaultContractAddress, usdcAddress, evmVaultAddress }
    : undefined;
})();

/**
 * Whether this build pins its vault. A build with some of the pin variables but not all of them
 * has quietly pinned nothing, which Settings says instead of leaving it to be discovered.
 */
export const PIN_STATUS: "pinned" | "partial" | "none" = PINNED_VAULT
  ? "pinned"
  : [env.VITE_VAULT_CONTRACT_ADDRESS, env.VITE_USDC_ADDRESS, env.VITE_EVM_VAULT_ADDRESS].some(
        (v) => clean(v) !== undefined,
      )
    ? "partial"
    : "none";

/** The environment variable that configures each contract, for messages. */
export const CONTRACT_ENV: Record<KinkoContract, string> = {
  pay: "VITE_KINKO_PAY_ADDRESS",
  tags: "VITE_KINKO_TAGS_ADDRESS",
  gift: "VITE_KINKO_GIFT_ADDRESS",
  disclosure: "VITE_KINKO_DISCLOSURE_ADDRESS",
};

/**
 * Where each contract's proving keys and ZK IR are served from. The fetch
 * provider reads `<base>/<contract>/keys/<circuit>.prover` and friends.
 */
export const ZK_BASE_URL = url(env.VITE_ZK_BASE_URL) ?? "/zk";

/**
 * Kinko's fee sponsor: pays the network fee when a card pays an invoice, so a
 * card holder needs no wallet at checkout. Without one, a card can still pay
 * when a connected wallet covers the fee.
 */
export const SPONSOR_URL = urlOr(
  env.VITE_SPONSOR_URL,
  import.meta.env.DEV ? "http://localhost:3300" : undefined,
);

/**
 * Kinko's snapshot service: publishes the chain's shielded commitment tree at recent events, so
 * a brand-new card starts its wallet from where it was made instead of replaying every event the
 * chain has recorded. Without one, a card still opens, just slowly the first time.
 */
export const SNAPSHOTS_URL = urlOr(
  env.VITE_SNAPSHOTS_URL,
  import.meta.env.DEV ? "http://localhost:3400" : undefined,
);

/** The Midnight node, reported to dApps by a card. A card never submits to it directly. */
export const NODE_URL =
  url(env.VITE_NODE_URL) ?? (NETWORK_ID === "undeployed" ? "http://localhost:9944" : undefined);

/** Local proof server, used only when the wallet does not prove itself. */
export const PROOF_SERVER_URL = url(env.VITE_PROOF_SERVER_URL) ?? "http://localhost:6300";

/** USDC has six decimals on every chain Kinko supports; KUSD mirrors it. */
export const USDC_DECIMALS = 6;

/** Kinko's public source code, Apache-2.0. */
export const SOURCE_URL = "https://github.com/Pratiikpy/kinko";

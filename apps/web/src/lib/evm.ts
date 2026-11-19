// The Ethereum side: the one chain the vault holds USDC on.
//
// Reads (balances, the deposit address's nonce) go through the configured
// RPC, so the backing page works with no wallet at all. Writes (sending USDC
// to a deposit address) go through the person's own Ethereum wallet.

import { createPublicClient, defineChain, erc20Abi, http, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

import { EVM_CHAIN_ID, EVM_EXPLORER_URL, EVM_RPC_URL } from "./config.ts";

const sepoliaChain = EVM_RPC_URL
  ? { ...sepolia, rpcUrls: { default: { http: [EVM_RPC_URL] } } }
  : sepolia;

/** The Ethereum chain this build's vault lives on, reading through the configured RPC. */
export const evmChain =
  EVM_CHAIN_ID === sepolia.id
    ? sepoliaChain
    : defineChain({
        id: EVM_CHAIN_ID,
        name: `Ethereum (chain ${String(EVM_CHAIN_ID)})`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: EVM_RPC_URL ? [EVM_RPC_URL] : [] } },
      });

let client: PublicClient | null = null;

const NO_RPC = "This build has no Ethereum RPC configured (VITE_EVM_RPC_URL).";

/**
 * A read-only client on the configured RPC.
 *
 * @returns The client, or null when this build names no RPC.
 */
export function evmReader(): PublicClient | null {
  if (!EVM_RPC_URL) return null;
  client ??= createPublicClient({
    chain: evmChain,
    transport: http(EVM_RPC_URL, { retryCount: 1, timeout: 10_000 }),
  }) as PublicClient;
  return client;
}

function reader(): PublicClient {
  const c = evmReader();
  if (!c) throw new Error(NO_RPC);
  return c;
}

/** A 0x-prefixed hex string, as viem types addresses and hashes. */
export type Hex = `0x${string}`;

/**
 * The USDC balance of an address.
 *
 * @param usdc - The USDC token address.
 * @param holder - The address whose balance to read.
 * @returns Base units of USDC.
 * @throws {Error} When this build names no Ethereum RPC.
 */
export async function usdcBalance(usdc: string, holder: string): Promise<bigint> {
  return reader().readContract({
    address: usdc as Hex,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder as Hex],
  });
}

/**
 * The ETH balance of an address.
 *
 * @param holder - The address whose balance to read.
 * @returns Wei.
 * @throws {Error} When this build names no Ethereum RPC.
 */
export async function ethBalance(holder: string): Promise<bigint> {
  return reader().getBalance({ address: holder as Hex });
}

/**
 * The next nonce of an account, counting transactions still pending.
 *
 * @param holder - The account.
 * @returns The nonce its next transaction will use.
 * @throws {Error} When this build names no Ethereum RPC.
 */
export async function nextNonce(holder: string): Promise<bigint> {
  return BigInt(
    await reader().getTransactionCount({ address: holder as Hex, blockTag: "pending" }),
  );
}

/**
 * The latest Ethereum block number.
 *
 * @returns The block number.
 * @throws {Error} When this build names no Ethereum RPC.
 */
export async function latestBlock(): Promise<bigint> {
  return reader().getBlockNumber();
}

/**
 * An explorer link for an address.
 *
 * @param address - The address.
 * @returns The link, or null when no explorer is configured.
 */
export const evmAddressUrl = (address: string): string | null =>
  EVM_EXPLORER_URL ? `${EVM_EXPLORER_URL}/address/${address}` : null;

/**
 * An explorer link for a transaction.
 *
 * @param hash - The transaction hash.
 * @returns The link, or null when no explorer is configured.
 */
export const evmTxUrl = (hash: string): string | null =>
  EVM_EXPLORER_URL ? `${EVM_EXPLORER_URL}/tx/${hash}` : null;

/**
 * An explorer link for one holder's balance of a token.
 *
 * @param token - The token address.
 * @param holder - The holder's address.
 * @returns The link, or null when no explorer is configured.
 */
export const evmTokenHolderUrl = (token: string, holder: string): string | null =>
  EVM_EXPLORER_URL ? `${EVM_EXPLORER_URL}/token/${token}?a=${holder}` : null;

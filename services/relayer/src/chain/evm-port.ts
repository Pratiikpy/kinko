// The relayer's Ethereum side over an ethers JSON-RPC provider, and the gas sponsor that
// funds a deposit sweep from the operator's own account within hard limits.

import { type JsonRpcProvider, type Transaction, Wallet } from "ethers";

import type { GasTopUpConfig } from "../config.ts";
import { BroadcastOutcome, type EvmPort, type GasSponsor, GasTopUpRefusedError } from "../ports.ts";
import type { StateStore } from "../store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calls the relayer makes of an Ethereum node. */
export type EvmNode = Pick<
  JsonRpcProvider,
  "getTransactionReceipt" | "getBalance" | "broadcastTransaction"
>;

/** Sends ETH from the funding account and resolves once it has mined. */
export type EtherTransfer = (to: string, valueWei: bigint) => Promise<void>;

function codeOf(error: Error): string | undefined {
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** The relayer's reads and submissions on the Ethereum chain the vault is pinned to. */
export class EthersEvmPort implements EvmPort {
  private readonly provider: EvmNode;

  /**
   * Bind to a provider.
   *
   * @param provider - A provider on the vault's chain.
   */
  constructor(provider: EvmNode) {
    this.provider = provider;
  }

  /** @inheritdoc */
  async isMined(hash: string): Promise<boolean> {
    return (await this.provider.getTransactionReceipt(hash)) !== null;
  }

  /** @inheritdoc */
  balance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  /** @inheritdoc */
  async broadcast(transaction: Transaction): Promise<BroadcastOutcome> {
    try {
      await this.provider.broadcastTransaction(transaction.serialized);
      return BroadcastOutcome.Accepted;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const message = error.message.toLowerCase();
      const code = codeOf(error);
      if (
        message.includes("already known") ||
        message.includes("already imported") ||
        message.includes("alreadyknown")
      ) {
        return BroadcastOutcome.AlreadyKnown;
      }
      if (code === "NONCE_EXPIRED" || message.includes("nonce too low")) {
        return BroadcastOutcome.NonceConsumed;
      }
      if (code === "INSUFFICIENT_FUNDS" || message.includes("insufficient funds")) {
        return BroadcastOutcome.InsufficientFunds;
      }
      throw error;
    }
  }
}

/**
 * Sends a deposit address the ETH its sweep needs, from an account the operator funded.
 *
 * The trust it adds: the relayer's key can spend that account's ETH, and anyone who can
 * queue a deposit can make the relayer send gas to the deposit address that deposit
 * derives. The per-address and per-day limits are the bound on that: the most the account
 * can lose to the sweeps of strangers in a day is the per-day limit. Keep the account's
 * balance to little more than that. The key never touches Midnight, USDC or any user's key.
 */
export class LimitedGasSponsor implements GasSponsor {
  private readonly limits: Pick<GasTopUpConfig, "maxPerAddressWei" | "maxPerDayWei">;
  private readonly transfer: EtherTransfer;
  private readonly store: StateStore;
  private readonly clock: () => number;
  // Top-ups run one at a time: two sweeps funded together must each see the other's total.
  private serial: Promise<unknown> = Promise.resolve();

  /**
   * Bind to the funding account's limits.
   *
   * @param limits - The per-address and per-day limits, in wei.
   * @param transfer - Sends ETH from the funding account and resolves once it is mined.
   * @param store - Where top-ups are recorded, so the limits survive a restart.
   * @param clock - The current time in epoch milliseconds.
   */
  constructor(
    limits: Pick<GasTopUpConfig, "maxPerAddressWei" | "maxPerDayWei">,
    transfer: EtherTransfer,
    store: StateStore,
    clock: () => number,
  ) {
    this.limits = limits;
    this.transfer = transfer;
    this.store = store;
    this.clock = clock;
  }

  /** @inheritdoc */
  topUp(address: string, shortfallWei: bigint): Promise<bigint> {
    const run = this.serial.then(() => this.send(address, shortfallWei));
    this.serial = run.catch(() => undefined);
    return run;
  }

  private async send(address: string, shortfallWei: bigint): Promise<bigint> {
    const now = this.clock();
    const target = address.toLowerCase();
    let toAddress = 0n;
    let lastDay = 0n;
    for (const record of this.store.gasTopUps()) {
      if (record.address === target) toAddress += record.amountWei;
      if (now - record.at < DAY_MS) lastDay += record.amountWei;
    }
    if (toAddress + shortfallWei > this.limits.maxPerAddressWei) {
      throw new GasTopUpRefusedError(
        `${address} would exceed its limit of ${String(this.limits.maxPerAddressWei)} wei ` +
          `(${String(toAddress)} already sent, ${String(shortfallWei)} needed)`,
      );
    }
    if (lastDay + shortfallWei > this.limits.maxPerDayWei) {
      throw new GasTopUpRefusedError(
        `the daily limit of ${String(this.limits.maxPerDayWei)} wei would be exceeded ` +
          `(${String(lastDay)} sent in the last 24 hours, ${String(shortfallWei)} needed)`,
      );
    }
    await this.transfer(address, shortfallWei);
    this.store.recordGasTopUp({ address: target, amountWei: shortfallWei, at: now });
    return shortfallWei;
  }
}

/**
 * Sends ETH from an account the operator funded.
 *
 * @param provider - A provider on the vault's chain.
 * @param privateKey - The funding account's key, 0x-prefixed.
 * @returns A transfer that resolves once the ETH has mined.
 */
export function ethersTransfer(provider: JsonRpcProvider, privateKey: string): EtherTransfer {
  const wallet = new Wallet(privateKey, provider);
  return async (to, valueWei) => {
    const sent = await wallet.sendTransaction({ to, value: valueWei });
    await sent.wait();
  };
}

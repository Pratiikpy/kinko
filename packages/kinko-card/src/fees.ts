// Who pays a card's network fee.
//
// A card holds KUSD and nothing else: no NIGHT, so no DUST, so it cannot pay a
// fee. Every card transaction is therefore built, proven and bound with only
// its own value balanced, and handed to a fee payer that adds DUST and submits.
// The payer receives a bound transaction: it can add a fee and nothing else,
// and it never sees the card's keys or the circuit's private inputs.
//
//   sponsorFeePayer   Kinko's sponsor service pays. For a holder with no wallet
//                     at all, paying a checkout with a card.
//   walletFeePayer    the holder's own connected wallet pays. For moving a
//                     card's balance into the holder's own account.

import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";

import {
  SPONSOR_PATH,
  SPONSOR_PROTOCOL_VERSION,
  SponsorError,
  type SponsorErrorBody,
  type SponsorRequest,
  type SponsorResponse,
} from "./sponsor-protocol.ts";

/** What a payer reports after submitting. */
export interface FeeReceipt {
  readonly paidBy: "sponsor" | "wallet";
  /** DUST paid, in SPECK, when the payer said. */
  readonly feeSpeck?: string;
}

/** Adds DUST to a bound, fee-less transaction and submits it. */
export interface FeePayer {
  readonly kind: FeeReceipt["paidBy"];
  /**
   * @param txHex - The card's bound transaction.
   * @param circuit - What it calls, for the sponsor to cross-check.
   * @returns What was paid.
   */
  pay(txHex: string, circuit?: string): Promise<FeeReceipt>;
}

/** Options for {@link sponsorFeePayer}. */
export interface SponsorOptions {
  /** The sponsor's base URL, with or without the path. */
  readonly endpoint: string;
  /** Proving already happened, so this bounds the sponsor's balancing and submission only. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const sponsorUrl = (endpoint: string): string => {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith(SPONSOR_PATH) ? trimmed : `${trimmed}${SPONSOR_PATH}`;
};

/**
 * Kinko's fee sponsor pays.
 *
 * @param options - Where the sponsor is.
 * @returns The payer.
 */
export function sponsorFeePayer(options: SponsorOptions): FeePayer {
  return {
    kind: "sponsor",
    async pay(txHex, circuit) {
      const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
      const body: SponsorRequest = { protocol: SPONSOR_PROTOCOL_VERSION, tx: txHex, circuit };
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, options.timeoutMs ?? 180_000);
      let res: Response;
      try {
        res = await doFetch(sponsorUrl(options.endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new SponsorError("Kinko's fee sponsor could not be reached.", "TRANSPORT");
      } finally {
        clearTimeout(timer);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new SponsorError(
          `Kinko's fee sponsor answered ${String(res.status)} without a reason.`,
          "TRANSPORT",
        );
      }
      if (!res.ok) {
        const err = parsed as Partial<SponsorErrorBody>;
        throw new SponsorError(
          typeof err.error === "string"
            ? err.error
            : `Kinko's fee sponsor answered ${String(res.status)}.`,
          err.code ?? "TRANSPORT",
          err.retryAfterSeconds,
        );
      }
      const ok = parsed as Partial<SponsorResponse>;
      return {
        paidBy: "sponsor",
        feeSpeck: typeof ok.feeSpeck === "string" ? ok.feeSpeck : undefined,
      };
    },
  };
}

/**
 * The holder's own wallet pays, through the DApp Connector.
 *
 * @param api - The connected wallet.
 * @returns The payer.
 */
export function walletFeePayer(api: ConnectedAPI): FeePayer {
  return {
    kind: "wallet",
    async pay(txHex) {
      const { tx } = await api.balanceSealedTransaction(txHex, { payFees: true });
      await api.submitTransaction(tx);
      return { paidBy: "wallet" };
    },
  };
}

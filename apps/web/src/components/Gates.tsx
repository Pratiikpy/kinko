import { ConnectButton } from "nightkit-react";
import type { ReactNode } from "react";

import { CONTRACT_ENV, CONTRACTS, type KinkoContract } from "../lib/config.ts";
import { useAccount } from "../state/account.tsx";
import { useDeployment } from "../state/deployment.tsx";
import { Card, Notice } from "./ui.tsx";

/**
 * Renders its children only for a connected account whose records are open.
 * Otherwise it says what connecting does and offers the button.
 */
export function ConnectGate({ children, what }: { children: ReactNode; what: string }) {
  const { account, records, recordsError, sync } = useAccount();
  if (!account) {
    return (
      <Card className="text-center">
        <p className="font-display text-xl text-ink">Connect to {what}</p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-2">
          Use a Midnight wallet, or open a private account from MetaMask, Phantom or Coinbase Wallet
          with one signature. Your keys stay in a vault this page cannot read.
        </p>
        <div className="mt-5 flex justify-center">
          <ConnectButton label="Connect wallet" />
        </div>
      </Card>
    );
  }
  if (recordsError) {
    return (
      <Notice tone="bad" title="Your private records could not be opened">
        {recordsError}
      </Notice>
    );
  }
  if (!records) {
    return (
      <Notice title="Opening your private records">
        Decrypting what this device keeps for your account…
      </Notice>
    );
  }
  return (
    <>
      {sync && !sync.synced ? (
        <div className="mb-5">
          <Notice tone="warn" title="Your account is still syncing">
            Addresses work now. Balances and sending wait until the sync finishes
            {sync.progress !== null ? ` (${String(Math.floor(sync.progress * 100))}%)` : ""}. A
            first sync on a public network can take around twenty minutes; later visits restore in
            seconds.
          </Notice>
        </div>
      ) : null}
      {children}
    </>
  );
}

/**
 * Says plainly when a contract this screen needs is not configured in this build.
 */
export function ContractNotice({ contracts }: { contracts: readonly KinkoContract[] }) {
  const missing = contracts.filter((c) => !CONTRACTS[c]);
  if (missing.length === 0) return null;
  return (
    <div className="mb-5">
      <Notice tone="warn" title="Not deployed in this build">
        This screen needs {missing.length === 1 ? "a contract" : "contracts"} this deployment does
        not name yet:{" "}
        {missing.map((m, i) => (
          <span key={m}>
            <code className="font-mono text-xs">{CONTRACT_ENV[m]}</code>
            {i < missing.length - 1 ? ", " : ""}
          </span>
        ))}
        . You can look around; submitting stays disabled until it is set.
      </Notice>
    </div>
  );
}

/** The same, for the vault and relayer. */
export function VaultNotice() {
  const { state, relayerUp, refresh } = useDeployment();
  if (state.status === "loading") return null;
  if (state.status === "unavailable") {
    return (
      <div className="mb-5">
        <Notice
          tone="bad"
          title="The vault cannot be reached"
          action={
            <button
              type="button"
              onClick={refresh}
              className="min-h-11 rounded-lg px-3 text-sm font-semibold text-shu-ink hover:underline"
            >
              Retry
            </button>
          }
        >
          {state.reason} Deposits and withdrawals are unavailable until it answers. Your balance and
          payments are unaffected.
        </Notice>
      </div>
    );
  }
  if (!relayerUp) {
    return (
      <div className="mb-5">
        <Notice tone="warn" title="The relayer is not answering">
          New deposits and withdrawals wait until it is back. Requests already started are safe:
          they resume where they stopped.
        </Notice>
      </div>
    );
  }
  return null;
}

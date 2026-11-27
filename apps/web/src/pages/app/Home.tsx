import {
  ArrowDownToLine,
  ArrowUpFromLine,
  EyeOff,
  HandCoins,
  QrCode,
  RefreshCw,
  Send,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ConnectGate } from "../../components/Gates.tsx";
import { QR } from "../../components/QR.tsx";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Copyable,
  EmptyState,
  Notice,
  SectionTitle,
  Skeleton,
} from "../../components/ui.tsx";
import { formatAmount, relativeTime } from "../../lib/format.ts";
import { activity, openRequests } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";
import { useDeployment } from "../../state/deployment.tsx";

function Balance() {
  const { balance, refreshBalance, account } = useAccount();
  const { state } = useDeployment();
  const [showQr, setShowQr] = useState(false);
  return (
    <Card className="relative overflow-hidden border-t-4 border-t-shu">
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <EyeOff aria-hidden className="h-4 w-4 shrink-0 text-shu" />
            <span className="text-balance">Private balance · only you can see it</span>
          </p>
          <button
            type="button"
            onClick={refreshBalance}
            aria-label="Refresh balance"
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <RefreshCw aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <p
          className="tabular mt-2 font-display text-5xl text-ink sm:text-6xl"
          data-testid="balance"
        >
          {balance.status === "ready" ? (
            <>
              ${formatAmount(balance.kusd)}
              <span className="ml-2 align-middle font-sans text-base font-medium text-ink-3">
                KUSD
              </span>
            </>
          ) : balance.status === "error" ? (
            <span className="text-2xl text-bad">Balance unavailable</span>
          ) : (
            <Skeleton className="h-14 w-56" />
          )}
        </p>
        {balance.status === "error" ? (
          <p className="mt-2 text-sm text-ink-2">{balance.message}</p>
        ) : null}
        {balance.status === "ready" && state.status !== "ready" ? (
          <p className="mt-2 text-sm text-warn">
            KUSD cannot be told apart from other tokens until the vault is reachable.
          </p>
        ) : null}
        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ButtonLink to="/app/add">
            <ArrowDownToLine aria-hidden className="h-4 w-4" /> Add
          </ButtonLink>
          <ButtonLink to="/app/pay" variant="secondary">
            <Send aria-hidden className="h-4 w-4" /> Pay
          </ButtonLink>
          <ButtonLink to="/app/request" variant="secondary">
            <HandCoins aria-hidden className="h-4 w-4" /> Request
          </ButtonLink>
          <ButtonLink to="/app/withdraw" variant="secondary">
            <ArrowUpFromLine aria-hidden className="h-4 w-4" /> Withdraw
          </ButtonLink>
        </div>
        {account ? (
          <div className="mt-6 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink-2">Your shielded address</span>
              <Copyable value={account.shieldedAddress} label="Address" />
              <Button
                variant="ghost"
                onClick={() => {
                  setShowQr((s) => !s);
                }}
                aria-expanded={showQr}
              >
                <QrCode aria-hidden className="h-4 w-4" /> {showQr ? "Hide code" : "Show code"}
              </Button>
            </div>
            {showQr ? (
              <div className="mt-4">
                <QR
                  value={account.shieldedAddress}
                  label="QR code of your shielded address"
                  size={180}
                />
                <p className="mt-2 max-w-sm text-sm text-ink-3">
                  Anyone can send KUSD to this address. A @tag or a one-off request link keeps
                  payers from seeing it at all.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function InFlight() {
  const { records } = useAccount();
  if (!records) return null;
  const open = openRequests(records);
  if (open.length === 0) return null;
  return (
    <div className="space-y-3">
      {open.map((r) => (
        <Notice
          key={r.localId}
          tone={r.phase === "failed" || r.error ? "warn" : "shu"}
          title={`${r.kind === "deposit" ? "Deposit" : "Withdrawal"} of $${formatAmount(BigInt(r.amount))} ${r.phase === "failed" || r.error ? "needs your attention" : "in progress"}`}
          action={
            <ButtonLink
              to={`/app/${r.kind === "deposit" ? "add" : "withdraw"}?request=${r.localId}`}
              variant="secondary"
            >
              Continue
            </ButtonLink>
          }
        >
          Started {relativeTime(r.createdAt)}. It carries on from where it stopped, even after
          closing the tab.
        </Notice>
      ))}
    </div>
  );
}

function Activity() {
  const { records } = useAccount();
  if (!records) return null;
  const items = activity(records);
  return (
    <Card>
      <SectionTitle
        aside={
          <Link to="/app/receipts" className="text-sm font-medium text-shu-ink hover:underline">
            Receipts
          </Link>
        }
      >
        Recent activity
      </SectionTitle>
      {items.length === 0 ? (
        <EmptyState title="Nothing here yet">
          Add dollars from Ethereum, or request a payment. What you do appears here, on this device
          only.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.id}>
              <Link
                to={i.href}
                className="flex min-h-14 items-center justify-between gap-4 py-3 hover:bg-surface-2/60"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{i.title}</p>
                  <p className="text-xs text-ink-3">
                    {i.detail} · {relativeTime(i.at)}
                  </p>
                </div>
                <span
                  className={`tabular shrink-0 text-sm font-semibold ${i.direction === "in" ? "text-ok" : "text-ink"}`}
                >
                  {i.direction === "in" ? "+" : "−"}${formatAmount(BigInt(i.amount))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-ink-3">
        This list is kept encrypted on this device. The chain holds no history of your payments to
        read back.
      </p>
    </Card>
  );
}

export default function Home() {
  const { walletName, openedWith, fees } = useAccount();
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-shu-ink">
            Your account
          </p>
          <h1 className="mt-2 font-display text-3xl text-ink sm:text-4xl">Private dollars</h1>
        </div>
        {walletName ? (
          <div className="flex flex-wrap gap-2">
            <Badge>{walletName}</Badge>
            {openedWith ? (
              <Badge tone="neutral">Opened with {openedWith.split(" · ")[0]}</Badge>
            ) : null}
            <Badge tone={fees === "sponsor" ? "ok" : "neutral"}>
              {fees === "sponsor" ? "Network fees paid for you" : "Fees from your wallet"}
            </Badge>
          </div>
        ) : null}
      </div>
      <ConnectGate what="see your private balance">
        <div className="space-y-6">
          <InFlight />
          <Balance />
          <Activity />
        </div>
      </ConnectGate>
    </div>
  );
}

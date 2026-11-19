import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
import {
  ButtonLink,
  Card,
  Copyable,
  EmptyState,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  Stat,
} from "../../components/ui.tsx";
import { useInvoiceStatuses } from "../../hooks/useInvoiceStatuses.ts";
import { formatAmount } from "../../lib/format.ts";
import { type DayBucket, merchantStats, receivedBy, timeline } from "../../lib/merchant.ts";
import { useAccount } from "../../state/account.tsx";
import { StatusBadge } from "./Invoices.tsx";

function Chart({ data }: { data: DayBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = data.reduce(
    (m, d) => (d.issued > m ? d.issued : d.received > m ? d.received : m),
    0n,
  );
  const h = 160;
  const w = 600;
  const bw = w / data.length;
  const y = (v: bigint) => (max === 0n ? 0 : Number((v * BigInt(h - 8)) / max));
  const focus = hover !== null ? data[hover] : undefined;
  const summary = data.filter((d) => d.received > 0n || d.issued > 0n);
  return (
    <figure>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-line-strong" /> Requested
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-shu" /> Received
        </span>
        <span className="ml-auto tabular text-ink-3" aria-live="polite">
          {focus
            ? `${focus.day}: requested $${formatAmount(focus.issued)}, received $${formatAmount(focus.received)}`
            : "Last 30 days"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${String(w)} ${String(h)}`}
        className="h-40 w-full"
        role="img"
        aria-label="Daily value requested and received over the last 30 days"
        onMouseLeave={() => {
          setHover(null);
        }}
      >
        <line
          x1="0"
          x2={w}
          y1={h - 0.5}
          y2={h - 0.5}
          className="stroke-line-strong"
          strokeWidth="1"
        />
        {data.map((d, i) => (
          <g
            key={d.day}
            onMouseEnter={() => {
              setHover(i);
            }}
          >
            <rect x={i * bw} y="0" width={bw} height={h} fill="transparent" />
            <rect
              x={i * bw + bw * 0.15}
              y={h - y(d.issued)}
              width={bw * 0.32}
              height={y(d.issued)}
              rx="2"
              className="fill-line-strong"
            />
            <rect
              x={i * bw + bw * 0.52}
              y={h - y(d.received)}
              width={bw * 0.32}
              height={y(d.received)}
              rx="2"
              className="fill-shu"
            />
          </g>
        ))}
      </svg>
      <figcaption className="sr-only">
        {summary.length === 0
          ? "No activity in the last 30 days."
          : summary
              .map(
                (d) =>
                  `${d.day}: requested ${formatAmount(d.issued)}, received ${formatAmount(d.received)}.`,
              )
              .join(" ")}
      </figcaption>
    </figure>
  );
}

export default function Merchant() {
  const { records } = useAccount();
  const read = useInvoiceStatuses();
  const invoices = useMemo(() => records?.invoices ?? [], [records]);
  const stats = merchantStats(invoices);
  const data = useMemo(() => timeline(invoices), [invoices]);
  const top = [...invoices].sort((a, b) => Number(receivedBy(b) - receivedBy(a))).slice(0, 5);
  const checkout = invoices.filter((i) => i.status === "open").slice(0, 4);

  return (
    <div>
      <PageHeader
        eyebrow="Merchant"
        title="Your business, seen only by you"
        actions={<ButtonLink to="/app/request">New request</ButtonLink>}
      >
        Totals here are added up on this device from your own invoice records. The chain never held
        them, so nobody else can compute them.
      </PageHeader>
      <ContractNotice contracts={["pay"]} />
      <ConnectGate what="see your merchant dashboard">
        {read.status === "error" && invoices.length > 0 ? (
          <div className="mb-4">
            <Notice tone="warn">
              Live status could not be read: {read.message} Showing the last known figures.
            </Notice>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card>
            <Stat
              label="Received"
              value={`$${formatAmount(stats.received)}`}
              hint={`${String(stats.payments)} payment${stats.payments === 1 ? "" : "s"}`}
            />
          </Card>
          <Card>
            <Stat
              label="Waiting"
              value={`$${formatAmount(stats.outstanding)}`}
              hint={`${String(stats.openCount)} open request${stats.openCount === 1 ? "" : "s"}`}
            />
          </Card>
          <Card>
            <Stat
              label="Paid in full"
              value={stats.paidCount}
              hint={`of ${String(stats.invoiceCount)} issued`}
            />
          </Card>
          <Card>
            <Stat
              label="Paid rate"
              value={
                stats.invoiceCount
                  ? `${String(Math.round((stats.paidCount / stats.invoiceCount) * 100))}%`
                  : "—"
              }
              hint="Invoices settled or closed"
            />
          </Card>
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <SectionTitle>Timeline</SectionTitle>
            {invoices.length === 0 ? (
              <EmptyState title="No invoices yet">Create a request to start.</EmptyState>
            ) : (
              <Chart data={data} />
            )}
            <p className="mt-2 text-xs text-ink-3">
              Received is dated when this device first saw the payment on chain, since payments
              carry no public timestamp linking them to you.
            </p>
          </Card>
          <Card>
            <SectionTitle
              aside={
                <Link
                  to="/app/invoices"
                  className="text-sm font-medium text-shu-ink hover:underline"
                >
                  Search all
                </Link>
              }
            >
              Top invoices
            </SectionTitle>
            {top.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {top.map((i) => (
                  <li key={i.commitment}>
                    <Link
                      to={`/app/invoices/${i.commitment}`}
                      className="flex min-h-12 items-center justify-between gap-3 py-2"
                    >
                      <span className="truncate text-sm text-ink">{i.title || "Untitled"}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular text-sm font-semibold text-ink">
                          ${formatAmount(receivedBy(i))}
                        </span>
                        <StatusBadge status={i.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <SectionTitle>Hosted checkout</SectionTitle>
            <p className="mb-4 text-sm text-ink-2">
              Every request also has a checkout page: send customers there from your site, and it
              shows payment status live until they pay.
            </p>
            {checkout.length === 0 ? (
              <p className="text-sm text-ink-3">
                Open requests appear here with their checkout links.
              </p>
            ) : (
              <ul className="space-y-2">
                {checkout.map((i) => (
                  <li key={i.commitment} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {i.title || "Untitled"} · ${formatAmount(BigInt(i.amount))}
                    </span>
                    <Copyable value={i.link.replace("/pay#", "/checkout#")} label="Checkout" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <SectionTitle>Hand your accountant the right records</SectionTitle>
            <div className="space-y-3">
              <PrivacyLine>
                Receipts prove single payments to anyone you choose, without showing the rest.
              </PrivacyLine>
              <PrivacyLine>
                For an audit or a regulator, records are sealed to a named examiner and opened only
                with two of three keyholders' approval.{" "}
                <Link to="/examine" className="font-medium text-shu-ink hover:underline">
                  How examination works
                </Link>
                .
              </PrivacyLine>
            </div>
          </Card>
        </div>
      </ConnectGate>
    </div>
  );
}

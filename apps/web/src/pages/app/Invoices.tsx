import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
import { ImportInvoice } from "../../components/ImportInvoice.tsx";
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  Input,
  Notice,
  PageHeader,
  Segmented,
} from "../../components/ui.tsx";
import { useInvoiceStatuses } from "../../hooks/useInvoiceStatuses.ts";
import { formatAmount, relativeTime } from "../../lib/format.ts";
import type { InvoiceRecord } from "../../lib/records.ts";
import { parseDraftFragment } from "../../lib/session.ts";
import { useAccount } from "../../state/account.tsx";

type Filter = "all" | "open" | "settled" | "cancelled";

export function StatusBadge({ status }: { status: InvoiceRecord["status"] }) {
  if (status === "settled") return <Badge tone="ok">Paid</Badge>;
  if (status === "cancelled") return <Badge>Cancelled</Badge>;
  if (status === "open") return <Badge tone="shu">Open</Badge>;
  return <Badge tone="warn">Not found yet</Badge>;
}

export default function Invoices() {
  const { records } = useAccount();
  const { hash } = useLocation();
  const navigate = useNavigate();
  // A checkout system's draft link lands here; invoices are created on the Request page.
  useEffect(() => {
    if (parseDraftFragment(hash.slice(1))) void navigate(`/app/request${hash}`, { replace: true });
  }, [hash, navigate]);
  const read = useInvoiceStatuses();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (records?.invoices ?? []).filter(
      (i) =>
        (filter === "all" || i.status === filter) &&
        (!q ||
          i.title.toLowerCase().includes(q) ||
          i.memo.toLowerCase().includes(q) ||
          i.commitment.includes(q) ||
          formatAmount(BigInt(i.amount)).includes(q)),
    );
  }, [records, query, filter]);

  return (
    <div>
      <PageHeader
        eyebrow="Invoices"
        title="What you have asked for"
        actions={<ButtonLink to="/app/request">New request</ButtonLink>}
      >
        Every invoice you issued from this device. Titles, amounts and payout keys live here,
        encrypted; the chain holds only commitments and status.
      </PageHeader>
      <ContractNotice contracts={["pay"]} />
      <ConnectGate what="see your invoices">
        <Card>
          <div className="mb-5 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="relative block">
              <span className="sr-only">Search invoices</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
              />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                placeholder="Search by title, note, amount or id"
                className="pl-10"
              />
            </label>
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "open", label: "Open" },
                { value: "settled", label: "Paid" },
                { value: "cancelled", label: "Cancelled" },
              ]}
            />
          </div>
          {read.status === "error" && (records?.invoices.length ?? 0) > 0 ? (
            <div className="mb-4">
              <Notice tone="warn">
                Live status could not be read: {read.message} Showing the last known status.
              </Notice>
            </div>
          ) : null}
          {list.length === 0 ? (
            <EmptyState
              title={records?.invoices.length ? "No invoice matches" : "No invoices yet"}
              action={
                records?.invoices.length ? undefined : (
                  <ButtonLink to="/app/request">Create your first request</ButtonLink>
                )
              }
            >
              {records?.invoices.length
                ? "Try another search or filter."
                : "Requests you create appear here with their live status."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {list.map((i) => (
                <li key={i.commitment}>
                  <Link
                    to={`/app/invoices/${i.commitment}`}
                    className="flex min-h-16 flex-wrap items-center justify-between gap-3 py-3 hover:bg-surface-2/60"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">
                        {i.title || "Untitled request"}
                      </p>
                      <p className="text-xs text-ink-3">
                        {i.kind === "standard"
                          ? "One payment"
                          : i.kind === "multipay"
                            ? `Many payers · ${String(i.contributions ?? 0)} paid`
                            : `Donation · ${String(i.contributions ?? 0)} gifts`}{" "}
                        · {relativeTime(i.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular font-semibold text-ink">
                        {i.token === "NATIVE"
                          ? `${formatAmount(BigInt(i.amount))} NIGHT`
                          : `$${formatAmount(BigInt(i.amount))}`}
                      </span>
                      <StatusBadge status={i.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="mt-6">
          <ImportInvoice />
        </div>
      </ConnectGate>
    </div>
  );
}

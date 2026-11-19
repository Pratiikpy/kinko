import { FileCheck2, Send } from "lucide-react";
import { useState } from "react";

import { ConnectGate } from "../../components/Gates.tsx";
import {
  Badge,
  Button,
  Card,
  Copyable,
  EmptyState,
  PageHeader,
  PrivacyLine,
  SectionTitle,
} from "../../components/ui.tsx";
import { formatAmount, relativeTime } from "../../lib/format.ts";
import { parsePaymentLink } from "../../lib/pay.ts";
import { encodeReceiptProof } from "../../lib/receipts.ts";
import type { PaymentRecord } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";

function proofLink(p: PaymentRecord): string | null {
  if (!p.invoiceLink || !p.payerKey || !p.refundTo || p.index === undefined) return null;
  const link = parsePaymentLink(p.invoiceLink);
  if (!link) return null;
  return `${window.location.origin}/verify#${encodeReceiptProof({ contract: link.contractAddress, terms: link.terms, payerKey: p.payerKey, refundTo: p.refundTo, index: BigInt(p.index), title: link.meta.title })}`;
}

function Row({ p }: { p: PaymentRecord }) {
  const [open, setOpen] = useState(false);
  const proof = proofLink(p);
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {p.receipt ? (
            <FileCheck2 aria-hidden className="h-5 w-5 shrink-0 text-shu" />
          ) : (
            <Send aria-hidden className="h-5 w-5 shrink-0 text-ink-3" />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">To {p.toLabel}</p>
            <p className="text-xs text-ink-3">
              {relativeTime(p.createdAt)}
              {p.memo ? ` · ${p.memo}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="tabular font-semibold text-ink">${formatAmount(BigInt(p.amount))}</span>
          {p.receipt ? (
            <Badge tone="shu">Receipt</Badge>
          ) : (
            <Badge>{p.kind === "batch" ? "Batch" : "Transfer"}</Badge>
          )}
          {p.receipt ? (
            <Button
              variant="ghost"
              onClick={() => {
                setOpen((o) => !o);
              }}
              aria-expanded={open}
            >
              {open ? "Hide" : "Prove"}
            </Button>
          ) : null}
        </div>
      </div>
      {open && p.receipt ? (
        <div className="mt-3 space-y-3 rounded-xl bg-surface-2 p-4">
          <p className="text-sm text-ink-2">
            Send this link to whoever needs proof. It shows this one payment, its amount and the
            invoice it paid. It reveals no other payment of yours, and no balance.
          </p>
          {proof ? (
            <Copyable value={proof} label="Proof link" />
          ) : (
            <p className="text-sm text-warn">
              The invoice terms for this payment were not kept, so a proof link cannot be built.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Copyable value={p.receipt} label="Receipt" />
            {p.txId ? <Copyable value={p.txId} label="Transaction" /> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function Receipts() {
  const { records } = useAccount();
  const payments = records?.payments ?? [];
  const receipts = payments.filter((p) => p.receipt).length;
  return (
    <div>
      <PageHeader eyebrow="Receipts" title="Proof of what you paid, for whoever you choose">
        Every invoice you pay leaves a receipt only you can open. Prove one payment to one person,
        and nothing else about you.
      </PageHeader>
      <ConnectGate what="see your receipts">
        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <SectionTitle
              aside={
                <span className="text-sm text-ink-3">
                  {receipts} with receipts · {payments.length} payments
                </span>
              }
            >
              Your payments
            </SectionTitle>
            {payments.length === 0 ? (
              <EmptyState title="No payments yet">
                Payments you make from this device appear here.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {payments.map((p) => (
                  <Row key={p.id} p={p} />
                ))}
              </ul>
            )}
          </Card>
          <aside className="space-y-4">
            <Card>
              <SectionTitle>How a receipt works</SectionTitle>
              <div className="space-y-3">
                <PrivacyLine>
                  Paying an invoice publishes a receipt digest. Alone it means nothing to anyone.
                </PrivacyLine>
                <PrivacyLine>
                  Your proof link carries the invoice terms and your secrets for that one payment.
                  The verifier recomputes the digest and finds it on chain.
                </PrivacyLine>
                <PrivacyLine>
                  Each payment uses fresh secrets, so one proof cannot be linked to any other
                  payment.
                </PrivacyLine>
              </div>
            </Card>
            <Card>
              <p className="text-sm leading-relaxed text-ink-2">
                Payments to a @tag, an address or a batch are plain private transfers. They leave no
                receipt on chain; the entry here is your own record of them.
              </p>
            </Card>
          </aside>
        </div>
      </ConnectGate>
    </div>
  );
}

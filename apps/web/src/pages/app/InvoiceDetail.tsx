import { decodeRefundCode, refundTagOf } from "@kinko/kinko-pay";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ConnectGate } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { QR } from "../../components/QR.tsx";
import {
  Button,
  Card,
  Copyable,
  EmptyState,
  Notice,
  PrivacyLine,
  SectionTitle,
  TextField,
} from "../../components/ui.tsx";
import { useCall } from "../../hooks/useCall.ts";
import { useInvoiceStatuses } from "../../hooks/useInvoiceStatuses.ts";
import { CONTRACTS } from "../../lib/config.ts";
import { formatAmount, fromHex, relativeTime, toHex } from "../../lib/format.ts";
import { readerFor } from "../../lib/midnight/providers.ts";
import {
  cancelInvoice,
  closeInvoice,
  kusdColorOf,
  readPayLedger,
  receiptExists,
  receiptFrom,
  receiptRefunded,
  refundConvertedPayment,
  refundPayment,
  termsOfRecord,
} from "../../lib/pay.ts";
import { patch } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";
import { StatusBadge } from "./Invoices.tsx";

function Refund({ commitment }: { commitment: string }) {
  const { account, records } = useAccount();
  const invoice = records?.invoices.find((i) => i.commitment === commitment);
  const call = useCall();
  const [code, setCode] = useState("");
  const [check, setCheck] = useState<string | null>(null);
  const payment = code.trim() ? decodeRefundCode(code.trim()) : undefined;
  if (!invoice || !CONTRACTS.pay) return null;

  // A NIGHT invoice is paid in KUSD at a quoted rate, so what is refunded is what the code says
  // was paid, not the invoice's amount.
  const refundedDollars = invoice.token === "NATIVE" ? payment?.paidAmount : BigInt(invoice.amount);
  const refundLabel =
    refundedDollars === undefined ? "Refund" : `Refund $${formatAmount(refundedDollars)}`;

  const refund = () =>
    call.run(async (onStage) => {
      if (!account || !payment || !CONTRACTS.pay) throw new Error("Paste a valid refund code.");
      const ledger = await readPayLedger(await readerFor(account), CONTRACTS.pay);
      const receipt = receiptFrom(
        commitment,
        invoice.kind,
        toHex(payment.payerKey),
        toHex(payment.refundTo),
        toHex(payment.refundEnc),
        payment.index,
      );
      if (!receiptExists(ledger, receipt))
        throw new Error("No payment of this invoice matches that refund code.");
      if (receiptRefunded(ledger, toHex(refundTagOf(fromHex(receipt)))))
        throw new Error("That payment has already been refunded.");
      setCheck(receipt);
      const request = {
        account,
        payAddress: CONTRACTS.pay,
        terms: termsOfRecord(invoice),
        ownerSecret: fromHex(invoice.ownerSecret),
        payment,
        kusdColor: kusdColorOf(ledger),
        onStage,
      };
      // A NIGHT invoice is paid in KUSD at a quoted rate, so what comes back is what was paid.
      if (invoice.token === "NATIVE") {
        await refundConvertedPayment({ ...request, paidAmount: payment.paidAmount });
        return;
      }
      await refundPayment(request);
    });

  return (
    <Card>
      <SectionTitle>Refund a payment</SectionTitle>
      <p className="mb-4 text-sm text-ink-2">
        A payer who wants a refund sends you their refund code. It names their one payment; the
        refund goes back to the key bound into their receipt, so it cannot be redirected.
        {invoice.token === "NATIVE"
          ? " This invoice is priced in NIGHT and was paid in KUSD at the oracle's rate, so what comes back is the KUSD the payer paid, as their code states."
          : ""}
      </p>
      <div className="grid gap-3 sm:max-w-lg">
        <TextField
          label="Refund code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
          spellCheck={false}
          autoComplete="off"
          error={
            code.trim() && !payment
              ? "That is not a refund code this version of Kinko can read. Codes from payments made on an earlier version of the contract name receipts it no longer holds."
              : null
          }
        />
        <Button
          variant="secondary"
          onClick={() => void refund()}
          busy={call.busy}
          disabled={!payment}
        >
          {refundLabel}
        </Button>
        {check ? (
          <p className="text-xs text-ink-3">
            Refunding the payment with receipt {check.slice(0, 16)}…
          </p>
        ) : null}
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="Refunded to the payer's key."
        />
      </div>
    </Card>
  );
}

export default function InvoiceDetail() {
  const { commitment = "" } = useParams();
  const { account, records, update } = useAccount();
  const read = useInvoiceStatuses(8_000);
  const invoice = records?.invoices.find((i) => i.commitment === commitment);
  const call = useCall();

  const act = (what: "cancel" | "close") =>
    call.run(async (onStage) => {
      if (!account || !invoice || !CONTRACTS.pay) throw new Error("Connect your wallet first.");
      const p = {
        account,
        payAddress: CONTRACTS.pay,
        terms: termsOfRecord(invoice),
        ownerSecret: fromHex(invoice.ownerSecret),
        onStage,
      };
      if (what === "cancel") await cancelInvoice(p);
      else await closeInvoice(p);
      await update((doc) =>
        patch(doc, "invoices", invoice.commitment, {
          status: what === "cancel" ? "cancelled" : "settled",
        }),
      );
      read.refresh();
    });

  return (
    <div>
      <Link
        to="/app/invoices"
        className="mb-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> All invoices
      </Link>
      <ConnectGate what="see this invoice">
        {!invoice ? (
          <EmptyState title="This invoice is not on this device">
            Invoices are kept on the device that created them. Open it from that device, or restore
            a backup in Settings.
          </EmptyState>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <div className="space-y-6">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-sm text-ink-2">{invoice.title || "Untitled request"}</p>
                    <p className="tabular mt-1 font-display text-5xl text-ink">
                      ${formatAmount(BigInt(invoice.amount))}
                    </p>
                    {invoice.memo ? (
                      <p className="mt-2 text-sm text-ink-2">{invoice.memo}</p>
                    ) : null}
                  </div>
                  <StatusBadge status={invoice.status} />
                </div>
                <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-ink-3">Kind</dt>
                    <dd className="text-ink">
                      {invoice.kind === "standard"
                        ? "One payment"
                        : invoice.kind === "multipay"
                          ? "Many payers"
                          : "Donation"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Payments so far</dt>
                    <dd className="text-ink">{invoice.contributions ?? 0}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Created</dt>
                    <dd className="text-ink">{relativeTime(invoice.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Expires</dt>
                    <dd className="text-ink">
                      {invoice.expiresAt === "0"
                        ? "Never"
                        : new Date(Number(invoice.expiresAt) * 1000).toLocaleString()}
                    </dd>
                  </div>
                </dl>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Copyable value={invoice.commitment} label="Commitment" />
                  {invoice.createTxId ? (
                    <Copyable value={invoice.createTxId} label="Created in" />
                  ) : null}
                </div>
                {read.status === "error" ? (
                  <div className="mt-4">
                    <Notice tone="warn">Live status could not be read: {read.message}</Notice>
                  </div>
                ) : null}
                {invoice.status === "open" ? (
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-5">
                    {invoice.kind !== "standard" ? (
                      <Button
                        variant="secondary"
                        onClick={() => void act("close")}
                        busy={call.busy}
                      >
                        Close to new payments
                      </Button>
                    ) : null}
                    {(invoice.contributions ?? 0) === 0 ? (
                      <Button variant="danger" onClick={() => void act("cancel")} busy={call.busy}>
                        Cancel the invoice
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-3">
                  <ProofProgress stage={call.stage} startedAt={call.startedAt} error={call.error} />
                </div>
              </Card>
              {(invoice.contributions ?? 0) > 0 ? <Refund commitment={invoice.commitment} /> : null}
            </div>
            <aside className="space-y-4">
              <Card>
                <SectionTitle>Share</SectionTitle>
                <QR value={invoice.link} label="QR code of the payment link" size={176} />
                <div className="mt-4 grid gap-2">
                  <Copyable value={invoice.link} label="Payment link" />
                  <Copyable
                    value={invoice.link.replace("/pay#", "/checkout#")}
                    label="Checkout page"
                  />
                </div>
              </Card>
              <Card>
                <div className="space-y-3">
                  <PrivacyLine>
                    Status and the number of payments are public. Who paid and how much are not.
                  </PrivacyLine>
                  <PrivacyLine>
                    Only you hold this invoice's owner secret, so only you can close, cancel or
                    refund it.
                  </PrivacyLine>
                </div>
              </Card>
            </aside>
          </div>
        )}
      </ConnectGate>
    </div>
  );
}

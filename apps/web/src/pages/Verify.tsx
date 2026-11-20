import { CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  Card,
  Copyable,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  Skeleton,
  TextField,
} from "../components/ui.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { formatAmount } from "../lib/format.ts";
import { readerFor } from "../lib/midnight/providers.ts";
import { invoiceView, readPayLedger, receiptExists } from "../lib/pay.ts";
import { claimedBy, decodeReceiptProof } from "../lib/receipts.ts";
import { useAccount } from "../state/account.tsx";

export default function Verify() {
  const { hash } = useLocation();
  const { account } = useAccount();
  const [text, setText] = useState(hash.length > 1 ? hash.slice(1) : "");
  useEffect(() => {
    if (hash.length > 1) setText(hash.slice(1));
  }, [hash]);
  const proof = text.trim() ? decodeReceiptProof(text) : null;

  const result = useAsync(
    async () => {
      if (!proof) throw new Error("No proof to check.");
      const claim = claimedBy(proof);
      const ledger = await readPayLedger(await readerFor(account), proof.contract);
      return {
        ...claim,
        onChain: receiptExists(ledger, claim.receipt),
        invoice: invoiceView(ledger, claim.commitment),
      };
    },
    [text, account],
    { enabled: Boolean(proof) },
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow="Public · no wallet needed" title="Check a payment receipt">
        Someone sent you a proof that they paid an invoice. This page recomputes the receipt from
        what the proof contains and looks for it on Midnight.
      </PageHeader>
      <Card>
        <TextField
          label="Proof link"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          spellCheck={false}
          autoComplete="off"
          error={
            text.trim() && !proof
              ? "That is not a receipt proof this version of Kinko can read. Proofs made on an earlier version name receipts it no longer holds."
              : null
          }
        />
        {proof ? (
          <div className="mt-6 space-y-4">
            <div>
              <p className="text-sm text-ink-2">{proof.title ?? "Invoice"}</p>
              <p className="tabular font-display text-4xl text-ink">
                ${formatAmount(proof.terms.amount)}
              </p>
            </div>
            {result.status === "loading" ? (
              <Skeleton className="h-16 w-full" />
            ) : result.status === "error" ? (
              <Notice tone="warn" title="The chain could not be read">
                {result.message}
              </Notice>
            ) : result.value.onChain ? (
              <div className="flex gap-3 rounded-xl border border-ok/30 bg-ok-soft p-4">
                <CheckCircle2 aria-hidden className="h-6 w-6 shrink-0 text-ok" />
                <div>
                  <p className="font-semibold text-ok">This payment is on chain</p>
                  <p className="mt-1 text-sm text-ink-2">
                    An invoice for ${formatAmount(proof.terms.amount)}, payable to the key below,
                    was paid with the per-payment secrets in this proof, which only the payer had.
                    The invoice is now {result.value.invoice?.status ?? "unknown"}.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex gap-3 rounded-xl border border-bad/30 bg-bad-soft p-4">
                <CircleAlert aria-hidden className="h-6 w-6 shrink-0 text-bad" />
                <div>
                  <p className="font-semibold text-bad">No such payment</p>
                  <p className="mt-1 text-sm text-ink-2">
                    The receipt this proof describes is not on the ledger. The proof was altered,
                    belongs to another network, or the payment never happened.
                  </p>
                </div>
              </div>
            )}
            {result.status === "ready" ? (
              <div className="flex flex-wrap gap-2">
                <Copyable value={result.value.receipt} label="Receipt" />
                <Copyable value={result.value.commitment} label="Invoice" />
                <Copyable
                  value={Array.from(proof.terms.payout, (b) =>
                    b.toString(16).padStart(2, "0"),
                  ).join("")}
                  label="Payee key"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>
      <Card className="mt-6">
        <SectionTitle>What this proves, and what it does not</SectionTitle>
        <div className="space-y-3">
          <PrivacyLine>
            It proves one payment: this amount, to this invoice's payout key, made with secrets the
            payer drew for it.
          </PrivacyLine>
          <PrivacyLine>
            It reveals nothing about the payer's balance or any other payment they made.
          </PrivacyLine>
          <PrivacyLine>
            It does not name the payer. A proof can be forwarded, so treat it like a paper receipt:
            it shows the payment happened, and whoever gave it to you had it.
          </PrivacyLine>
        </div>
      </Card>
    </div>
  );
}

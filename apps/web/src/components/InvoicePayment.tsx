import { encodeRefundCode, KinkoPay } from "@kinko/kinko-pay";
import { CheckCircle2, Clock } from "lucide-react";
import { ConnectButton } from "nightkit-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useAsync } from "../hooks/useAsync.ts";
import { useCall } from "../hooks/useCall.ts";
import { formatAmount, fromHex, toHex } from "../lib/format.ts";
import { readerFor } from "../lib/midnight/providers.ts";
import {
  invoiceView,
  KIND_NAME,
  kusdColorOf,
  type ParsedLink,
  payInvoice,
  paymentUrl,
  readPayLedger,
} from "../lib/pay.ts";
import { quoteNightInKusd } from "../lib/quote.ts";
import { localId, upsert } from "../lib/records.ts";
import { useAccount } from "../state/account.tsx";
import { PayWithCard } from "./PayWithCard.tsx";
import { ProofProgress } from "./ProofProgress.tsx";
import { Badge, Button, Copyable, Notice, PrivacyLine, Skeleton } from "./ui.tsx";

const KIND_TEXT = {
  standard: "One payment",
  multipay: "Many payers",
  donation: "Donation",
} as const;

/**
 * Pay one invoice from its link, and keep a private receipt of it.
 */
export function InvoicePayment({
  link,
  live = false,
  onPaid,
}: {
  link: ParsedLink;
  live?: boolean;
  /** Told once the chain shows the invoice paid, by anyone. */
  onPaid?: () => void;
}) {
  const { account, balance, update } = useAccount();
  const call = useCall();
  const [paid, setPaid] = useState<{ receipt: string; refundCode: string } | null>(null);
  const { terms, contractAddress, meta } = link;
  const kind = KIND_NAME(terms.kind);

  const commitment = useAsync(async () => {
    const { invoiceCommitmentOf } = await import("@kinko/kinko-pay");
    return toHex(invoiceCommitmentOf(terms));
  }, [contractAddress, terms.salt]);

  const status = useAsync(
    async () => {
      if (commitment.status !== "ready") throw new Error("Working out the invoice id…");
      const ledger = await readPayLedger(await readerFor(account), contractAddress);
      return {
        view: invoiceView(ledger, commitment.value),
        kusdColor: kusdColorOf(ledger),
        oraclePk: ledger.oracle_pk,
      };
    },
    [account, contractAddress, commitment.status],
    { intervalMs: live ? 5_000 : 20_000, enabled: commitment.status === "ready" },
  );

  const view = status.status === "ready" ? status.value.view : undefined;
  const settled = view?.status === "settled";
  useEffect(() => {
    if (settled) onPaid?.();
  }, [settled, onPaid]);
  const expired = terms.expiresAt > 0n && BigInt(Math.floor(Date.now() / 1000)) > terms.expiresAt;
  // Priced in NIGHT, paid in KUSD at the oracle's signed rate (see lib/quote.ts).
  const night = terms.token === KinkoPay.TokenKind.NATIVE;
  const oraclePk = status.status === "ready" ? status.value.oraclePk : null;
  const price = useAsync(
    async () => {
      if (!oraclePk) throw new Error("Reading the invoice…");
      return quoteNightInKusd(terms.amount, oraclePk);
    },
    [terms.amount, oraclePk?.x],
    { enabled: night && oraclePk !== null && !settled, intervalMs: 60_000 },
  );
  const due = night
    ? price.status === "ready"
      ? price.value.convertedAmount
      : null
    : terms.amount;
  const freshQuote = night && oraclePk ? () => quoteNightInKusd(terms.amount, oraclePk) : undefined;
  const payable = view?.status === "open" && !expired;
  const short = balance.status === "ready" && due !== null && balance.kusd < due;
  // Links made before they carried the payout's encryption key cannot be paid:
  // the payer's wallet would have no key to encrypt the merchant's coin to.
  const payoutEncryptionKey = link.payoutEncryptionKey;

  const pay = () =>
    call.run(async (onStage) => {
      if (!account || status.status !== "ready") throw new Error("Connect your wallet first.");
      if (!payoutEncryptionKey) throw new Error("This link is too old to pay. Ask for a new one.");
      // Every payment draws a fresh payer key, so its nullifier is unique at
      // index 0; the index exists for one payer contributing deliberately twice.
      const out = await payInvoice({
        account,
        payAddress: contractAddress,
        terms,
        payoutEncryptionKey,
        kusdColor: status.value.kusdColor,
        quote: freshQuote ? await freshQuote() : undefined,
        onStage,
      });
      const refundCode = encodeRefundCode(
        {
          payerKey: fromHex(out.payerKey),
          refundTo: fromHex(out.refundTo),
          index: out.index,
        },
        fromHex(account.encryptionPublicKey),
        out.paid ?? terms.amount,
      );
      await update((doc) =>
        upsert(doc, "payments", {
          id: localId(),
          to: commitment.status === "ready" ? commitment.value : "",
          toLabel: meta.title ?? "an invoice",
          amount: (out.paid ?? terms.amount).toString(),
          createdAt: Date.now(),
          kind: "invoice",
          txId: out.txId,
          invoiceCommitment: commitment.status === "ready" ? commitment.value : undefined,
          invoiceKind: kind,
          invoiceLink: paymentUrl("/pay", terms, contractAddress, meta, payoutEncryptionKey),
          receipt: out.receipt,
          payerKey: out.payerKey,
          refundTo: out.refundTo,
          index: out.index.toString(),
          memo: meta.memo,
        }),
      );
      setPaid({ receipt: out.receipt, refundCode });
      status.refresh();
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-2">{meta.title ?? "Invoice"}</p>
          <p className="tabular mt-1 font-display text-5xl text-ink">
            {night ? `${formatAmount(terms.amount)} NIGHT` : `$${formatAmount(terms.amount)}`}
          </p>
          {night ? (
            <p className="mt-2 text-sm text-ink-2" aria-live="polite">
              {price.status === "ready"
                ? `Paid in private dollars: $${formatAmount(price.value.convertedAmount)} at the oracle's rate now. The rate is proven inside the payment.`
                : price.status === "error"
                  ? `The NIGHT price could not be read: ${price.message}`
                  : "Reading the NIGHT price…"}
            </p>
          ) : null}
          {meta.memo ? <p className="mt-2 max-w-md text-sm text-ink-2">{meta.memo}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>{KIND_TEXT[kind]}</Badge>
          {view === undefined ? (
            status.status === "error" ? (
              <Badge tone="warn">Status unavailable</Badge>
            ) : (
              <Skeleton className="h-6 w-20" />
            )
          ) : view === null ? (
            <Badge tone="bad">Not found</Badge>
          ) : expired ? (
            <Badge tone="warn">Expired</Badge>
          ) : (
            <Badge
              tone={view.status === "open" ? "shu" : view.status === "settled" ? "ok" : "neutral"}
            >
              {view.status === "open"
                ? "Open"
                : view.status === "settled"
                  ? "Paid"
                  : view.status === "cancelled"
                    ? "Cancelled"
                    : "Unknown"}
            </Badge>
          )}
        </div>
      </div>

      {status.status === "error" ? (
        <Notice tone="warn" title="The invoice's status could not be read">
          {status.message}
        </Notice>
      ) : null}
      {view === null ? (
        <Notice tone="bad" title="No invoice matches this link">
          The link may have been altered, or the invoice was created on a different network.
        </Notice>
      ) : null}
      {view && view.contributions > 0 && kind !== "standard" ? (
        <p className="text-sm text-ink-2">
          {view.contributions} payment{view.contributions === 1 ? "" : "s"} so far. Amounts are not
          public.
        </p>
      ) : null}
      {terms.expiresAt > 0n ? (
        <p className="flex items-center gap-2 text-sm text-ink-3">
          <Clock aria-hidden className="h-4 w-4" /> {expired ? "Expired" : "Expires"}{" "}
          {new Date(Number(terms.expiresAt) * 1000).toLocaleString()}
        </p>
      ) : null}

      {paid ? (
        <div className="rounded-2xl border border-ok/30 bg-ok-soft p-5">
          <p className="flex items-center gap-2 font-semibold text-ok">
            <CheckCircle2 aria-hidden className="h-5 w-5" /> Paid privately
          </p>
          <p className="mt-2 text-sm text-ink-2">
            Your receipt proves this one payment to this one merchant, and nothing else. It is saved
            on this device.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Copyable value={paid.receipt} label="Receipt" />
            <Copyable value={paid.refundCode} label="Refund code" />
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Give the refund code to the merchant only if you ask for a refund. It names this payment
            and nothing else.
          </p>
          <Link
            to="/app/receipts"
            className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-shu-ink hover:underline"
          >
            See your receipts
          </Link>
        </div>
      ) : !account ? (
        payable ? (
          <div>
            <ConnectButton label="Connect to pay" />
            <p className="mt-2 text-sm text-ink-3">
              Paying needs a private account with KUSD. Opening one takes a single signature.
            </p>
          </div>
        ) : null
      ) : (
        <div className="space-y-3">
          {!payoutEncryptionKey ? (
            <Notice tone="warn" title="This link is from an older version of Kinko">
              It does not carry the key the payment is encrypted to, so it cannot be paid. Ask the
              merchant for a new link.
            </Notice>
          ) : null}
          {short ? (
            <Notice tone="warn" title="Not enough private dollars">
              Your balance is ${formatAmount(balance.kusd)}. <Link to="/app/add">Add dollars</Link>{" "}
              first.
            </Notice>
          ) : null}
          <Button
            onClick={() => void pay()}
            busy={call.busy}
            disabled={
              !payable || short || due === null || !payoutEncryptionKey || call.stage === "done"
            }
            className="w-full sm:w-auto"
          >
            Pay ${due === null ? "…" : formatAmount(due)} privately
          </Button>
          <ProofProgress
            stage={call.stage}
            startedAt={call.startedAt}
            error={call.error}
            doneText="Paid. The merchant receives the coin directly."
          />
        </div>
      )}

      {!paid && payoutEncryptionKey && view ? (
        <PayWithCard
          link={link}
          kusdColor={status.status === "ready" ? status.value.kusdColor : null}
          due={due}
          freshQuote={freshQuote}
          payable={payable}
          onPaid={status.refresh}
        />
      ) : null}

      <div className="space-y-2 border-t border-line pt-4">
        <PrivacyLine>
          The chain records that this invoice was paid. It does not record the amount, you, or the
          merchant.
        </PrivacyLine>
        <PrivacyLine>
          The coin goes straight to the payout key sealed into the invoice, so nobody can redirect
          it.
        </PrivacyLine>
      </div>
    </div>
  );
}

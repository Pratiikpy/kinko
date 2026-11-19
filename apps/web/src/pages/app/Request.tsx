import { Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { QR } from "../../components/QR.tsx";
import {
  Button,
  Card,
  Copyable,
  Field,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  Segmented,
  Select,
  TextArea,
  TextField,
} from "../../components/ui.tsx";
import { useCall } from "../../hooks/useCall.ts";
import { CONTRACTS } from "../../lib/config.ts";
import { AMOUNT_ERROR_TEXT, formatAmount, fromHex, parseAmount, toHex } from "../../lib/format.ts";
import { createInvoice, paymentUrl } from "../../lib/pay.ts";
import { type InvoiceKindName, type InvoiceRecord, upsert } from "../../lib/records.ts";
import { attachCommitment, type DraftRequest, parseDraftFragment } from "../../lib/session.ts";
import { useAccount } from "../../state/account.tsx";

const EXPIRY = [
  { value: "0", label: "Never" },
  { value: "86400", label: "In 1 day" },
  { value: "604800", label: "In 7 days" },
  { value: "2592000", label: "In 30 days" },
];

const KINDS = [
  {
    value: "standard" as const,
    label: "One payment",
    hint: "Closes as soon as it is paid. For a bill or a sale.",
  },
  {
    value: "multipay" as const,
    label: "Many payers",
    hint: "Each payer pays the amount; you close it when done. For tickets or a group bill.",
  },
  {
    value: "donation" as const,
    label: "Donation",
    hint: "Open-ended. Each gift is the amount shown.",
  },
];

/** What happened when the invoice was handed back to a merchant's checkout session. */
type AttachState =
  | { readonly kind: "none" }
  | { readonly kind: "attached"; readonly sessionId: string }
  | { readonly kind: "failed"; readonly sessionId: string; readonly reason: string };

function AttachNotice({ state }: { state: AttachState }) {
  if (state.kind === "none") return null;
  return state.kind === "attached" ? (
    <PrivacyLine>
      Linked to checkout session {state.sessionId}. Send the customer the checkout page above; the
      merchant backend now watches the invoice and notifies your server when it is paid.
    </PrivacyLine>
  ) : (
    <p className="text-sm text-bad" role="alert">
      The invoice is on chain, but checkout session {state.sessionId} was not updated:{" "}
      {state.reason}
    </p>
  );
}

function Created({ invoice, attach }: { invoice: InvoiceRecord; attach: AttachState }) {
  // A checkout started by the merchant's server names its session, so the
  // hosted page can show the merchant, the live status and the way back.
  const checkout = invoice.link.replace(
    "/pay#",
    attach.kind === "attached"
      ? `/checkout?session=${encodeURIComponent(attach.sessionId)}#`
      : "/checkout#",
  );
  const share = async () => {
    try {
      await navigator.share({
        title: invoice.title || "Payment request",
        text: `Pay $${formatAmount(BigInt(invoice.amount))} privately with Kinko`,
        url: invoice.link,
      });
    } catch {
      // The person closed the share sheet; nothing to report.
    }
  };
  return (
    <Card>
      <SectionTitle>Your request is live</SectionTitle>
      <div className="grid gap-6 sm:grid-cols-[auto_1fr] xl:grid-cols-1">
        <QR
          value={invoice.link}
          label={`QR code of the payment link for $${formatAmount(BigInt(invoice.amount))}`}
          size={176}
        />
        <div className="min-w-0 space-y-3">
          <p className="tabular font-display text-3xl text-ink">
            ${formatAmount(BigInt(invoice.amount))}
          </p>
          <p className="text-sm text-ink-2">{invoice.title || "Payment request"}</p>
          <Copyable value={invoice.link} label="Payment link" className="w-full" />
          <Copyable value={checkout} label="Checkout page" className="w-full" />
          <div className="flex flex-wrap gap-2 pt-1">
            {"share" in navigator ? (
              <Button variant="secondary" onClick={() => void share()}>
                <Share2 aria-hidden className="h-4 w-4" /> Share
              </Button>
            ) : null}
            <Link
              to={`/app/invoices/${invoice.commitment}`}
              className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-shu-ink hover:underline"
            >
              Track it
            </Link>
          </div>
        </div>
      </div>
      <div className="mt-5 space-y-2 border-t border-line pt-4">
        <AttachNotice state={attach} />
        <PrivacyLine>
          The link carries the terms in its fragment, which browsers never send to a server. Anyone
          with the link can pay it.
        </PrivacyLine>
        <PrivacyLine>
          Only the invoice's commitment is on chain. The amount, your payout key and the salt are
          not.
        </PrivacyLine>
      </div>
    </Card>
  );
}

export default function Request() {
  const { account, update, secret } = useAccount();
  const call = useCall();
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [amountText, setAmountText] = useState("");
  const [kind, setKind] = useState<InvoiceKindName>("standard");
  const [expiry, setExpiry] = useState("0");
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<InvoiceRecord | null>(null);
  const [attach, setAttach] = useState<AttachState>({ kind: "none" });
  const { hash } = useLocation();
  const [draft, setDraft] = useState<DraftRequest | null>(null);
  const parsed = parseAmount(amountText);

  // A merchant's server can create a draft checkout session and send the
  // merchant here with its id, a one-time attach token and the labels it chose.
  useEffect(() => {
    const d = parseDraftFragment(hash.slice(1));
    if (!d) return;
    setDraft(d);
    setTitle(d.title);
    setMemo(d.memo);
    setKind(d.kind);
  }, [hash]);

  const submit = () =>
    call.run(async (onStage) => {
      setTouched(true);
      if (!account || !parsed.ok || !CONTRACTS.pay) throw new Error("Check the amount.");
      const merchantKey = await secret("merchant");
      const expiresAt =
        expiry === "0" ? 0n : BigInt(Math.floor(Date.now() / 1000) + Number(expiry));
      const inv = await createInvoice({
        account,
        payAddress: CONTRACTS.pay,
        merchantKey,
        amount: parsed.value,
        kind,
        expiresAt,
        onStage,
      });
      const link = paymentUrl(
        "/pay",
        inv.terms,
        CONTRACTS.pay,
        { title, memo },
        fromHex(account.encryptionPublicKey),
      );
      const record: InvoiceRecord = {
        commitment: inv.commitment,
        title: title.trim(),
        memo: memo.trim(),
        amount: parsed.value.toString(),
        kind,
        merchantKey: toHex(inv.terms.merchantKey),
        payout: toHex(inv.terms.payout),
        salt: toHex(inv.terms.salt),
        ownerSecret: toHex(inv.ownerSecret),
        expiresAt: expiresAt.toString(),
        createdAt: Date.now(),
        link,
        createTxId: inv.txId,
        status: "open",
        contributions: 0,
      };
      await update((doc) => upsert(doc, "invoices", record));
      setCreated(record);
      if (draft) {
        try {
          await attachCommitment(draft, inv.commitment);
          setAttach({ kind: "attached", sessionId: draft.sessionId });
        } catch (e) {
          setAttach({
            kind: "failed",
            sessionId: draft.sessionId,
            reason: e instanceof Error ? e.message : "unknown error",
          });
        }
      }
    });

  return (
    <div>
      <PageHeader eyebrow="Request" title="Ask to be paid, privately">
        Create an invoice and share it as a link or a code. Payers see the amount and your title;
        the chain sees neither.
      </PageHeader>
      <ContractNotice contracts={["pay"]} />
      {draft ? (
        <Card className="mb-6">
          <p className="text-sm text-ink-2">
            Your checkout system asked for this invoice (session {draft.sessionId}). Set the amount
            and create it; Kinko hands its commitment back to the session. The amount never reaches
            your server.
          </p>
        </Card>
      ) : null}
      <ConnectGate what="request a payment">
        <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
          <Card>
            <form
              className="grid gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <TextField
                label="What is it for?"
                placeholder="Website redesign, November"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                }}
                maxLength={80}
                hint="Shown to the payer. Travels in the link, never on chain."
              />
              <TextField
                label="Amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="1,250.00"
                value={amountText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                }}
                onBlur={() => {
                  setTouched(true);
                }}
                error={touched && !parsed.ok ? AMOUNT_ERROR_TEXT[parsed.error] : null}
              />
              <Segmented label="Who pays" value={kind} onChange={setKind} options={KINDS} />
              <Field label="Expires" htmlFor="expiry">
                <Select
                  id="expiry"
                  value={expiry}
                  onChange={(e) => {
                    setExpiry(e.target.value);
                  }}
                >
                  {EXPIRY.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note to the payer (optional)" htmlFor="memo">
                <TextArea
                  id="memo"
                  value={memo}
                  onChange={(e) => {
                    setMemo(e.target.value);
                  }}
                  maxLength={200}
                />
              </Field>
              <Button type="submit" busy={call.busy} disabled={!CONTRACTS.pay || !parsed.ok}>
                Create the request
              </Button>
              <ProofProgress
                stage={call.stage}
                startedAt={call.startedAt}
                error={call.error}
                doneText="Your invoice is on chain as a commitment."
              />
            </form>
          </Card>
          <div>
            {created ? (
              <Created invoice={created} attach={attach} />
            ) : (
              <Card>
                <SectionTitle>What the payer gets</SectionTitle>
                <p className="text-sm leading-relaxed text-ink-2">
                  A link that opens a page showing your title, the amount and the invoice's live
                  status. They pay from their own private balance and keep a receipt that proves
                  this one payment, to you, and nothing else.
                </p>
              </Card>
            )}
          </div>
        </div>
      </ConnectGate>
    </div>
  );
}

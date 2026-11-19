import { KinkoPay } from "@kinko/kinko-pay";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useCall } from "../hooks/useCall.ts";
import { CONTRACTS } from "../lib/config.ts";
import { formatAmount, toHex } from "../lib/format.ts";
import { type ImportedInvoice, InvoiceFileError, parseInvoiceFile } from "../lib/import-invoice.ts";
import { readerFor } from "../lib/midnight/providers.ts";
import { invoiceOwnership, publishInvoice, readPayLedger } from "../lib/pay.ts";
import { type InvoiceRecord, upsert } from "../lib/records.ts";
import { useAccount } from "../state/account.tsx";
import { ProofProgress } from "./ProofProgress.tsx";
import { Button, Card, Field, Notice, SectionTitle, TextArea } from "./ui.tsx";

const KIND_TEXT = { standard: "One payment", multipay: "Many payers", donation: "Donation" };

function recordOf(inv: ImportedInvoice, createTxId?: string): InvoiceRecord {
  return {
    commitment: inv.commitment,
    title: inv.title,
    memo: inv.memo,
    amount: inv.terms.amount.toString(),
    kind: inv.kind,
    token: inv.terms.token === KinkoPay.TokenKind.NATIVE ? "NATIVE" : "KUSD",
    merchantKey: toHex(inv.terms.merchantKey),
    payout: toHex(inv.terms.payout),
    salt: toHex(inv.terms.salt),
    ownerSecret: toHex(inv.ownerSecret),
    expiresAt: inv.terms.expiresAt.toString(),
    createdAt: Date.now(),
    link: inv.link,
    ...(createTxId ? { createTxId } : {}),
    status: "open",
    contributions: 0,
  };
}

/**
 * Publish an invoice the SDK, the CLI or the MCP server built on the
 * merchant's machine. Until a wallet publishes it, its payment link matches
 * nothing on chain.
 */
export function ImportInvoice() {
  const { account, records, update } = useAccount();
  const call = useCall();
  const [text, setText] = useState("");
  const [done, setDone] = useState<{ commitment: string; published: boolean } | null>(null);

  let parsed: ImportedInvoice | null = null;
  let problem: string | null = null;
  if (text.trim()) {
    try {
      parsed = parseInvoiceFile(text);
    } catch (e) {
      problem = e instanceof InvoiceFileError ? e.message : "That is not an invoice file.";
    }
  }
  const known = parsed ? records?.invoices.some((i) => i.commitment === parsed.commitment) : false;
  const paysElsewhere =
    parsed && account ? toHex(parsed.terms.payout) !== account.coinPublicKey.toLowerCase() : false;

  const publish = () =>
    call.run(async (onStage) => {
      const inv = parsed;
      if (!account || !inv || !CONTRACTS.pay) throw new Error("Paste an invoice file first.");
      const ledger = await readPayLedger(await readerFor(account), CONTRACTS.pay);
      // Already published (from another device, or a retry after a lost
      // confirmation): keep it, without asking the chain for a duplicate.
      const ownership = invoiceOwnership(
        ledger,
        inv.commitment,
        inv.ownerSecret,
        inv.terms.expiresAt,
      );
      if (ownership === "taken") {
        throw new Error(
          "An invoice with this commitment is already on chain, but with a different expiry from the one this file records. Check which file is the right one before relying on either.",
        );
      }
      if (ownership === "own") {
        await update((doc) => upsert(doc, "invoices", recordOf(inv)));
        setDone({ commitment: inv.commitment, published: false });
        return;
      }
      const { txId } = await publishInvoice({
        account,
        payAddress: CONTRACTS.pay,
        terms: inv.terms,
        ownerSecret: inv.ownerSecret,
        onStage,
      });
      await update((doc) => upsert(doc, "invoices", recordOf(inv, txId)));
      setDone({ commitment: inv.commitment, published: true });
      setText("");
    });

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setDone(null);
    call.reset();
    setText(await file.text());
  };

  return (
    <Card>
      <SectionTitle>Publish an invoice made elsewhere</SectionTitle>
      <p className="mb-4 text-sm leading-relaxed text-ink-2">
        The SDK, the <code className="font-mono text-xs">kinko</code> command and the assistant
        build invoices on your own machine and save each one to a file in{" "}
        <code className="font-mono text-xs">~/.config/kinko/invoices</code>. Its link works once
        your wallet publishes it here. The file holds the invoice&apos;s secrets; it stays in this
        browser and is never sent anywhere.
      </p>
      <div className="grid gap-4 lg:max-w-2xl">
        <label className="inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition hover:border-line-strong">
          <FileUp aria-hidden className="h-4 w-4" />
          Choose the invoice file
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => void readFile(e.target.files?.[0])}
          />
        </label>
        <Field label="Or paste its contents" htmlFor="invoice-file">
          <TextArea
            id="invoice-file"
            rows={5}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            value={text}
            onChange={(e) => {
              setDone(null);
              call.reset();
              setText(e.target.value);
            }}
          />
        </Field>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        {parsed ? (
          <div className="rounded-xl bg-surface-2 p-4 text-sm">
            <p className="font-semibold text-ink">{parsed.title || "Untitled invoice"}</p>
            <p className="tabular mt-1 text-ink-2">
              {parsed.terms.token === KinkoPay.TokenKind.NATIVE
                ? `${formatAmount(parsed.terms.amount)} NIGHT`
                : `$${formatAmount(parsed.terms.amount)}`}{" "}
              · {KIND_TEXT[parsed.kind]}
              {parsed.terms.expiresAt > 0n
                ? ` · expires ${new Date(Number(parsed.terms.expiresAt) * 1000).toLocaleString()}`
                : ""}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-ink-3">{parsed.commitment}</p>
          </div>
        ) : null}
        {paysElsewhere ? (
          <Notice tone="warn" title="Payments go to another wallet">
            This invoice pays out to a different wallet from the one connected. That is allowed:
            publishing only puts it on chain. Payments reach the wallet the invoice names.
          </Notice>
        ) : null}
        {known && !done ? (
          <Notice tone="neutral">This invoice is already in your list.</Notice>
        ) : null}
        <Button
          onClick={() => void publish()}
          busy={call.busy}
          disabled={!parsed || !CONTRACTS.pay || Boolean(known)}
          className="w-fit"
        >
          Publish on Midnight
        </Button>
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="Published. The invoice's link can be paid now."
        />
        {done ? (
          <Notice tone="ok" title={done.published ? "Published" : "Added to your invoices"}>
            {done.published
              ? "The invoice is on chain and its payment link works."
              : "It was already on chain, so nothing was signed."}{" "}
            <Link to={`/app/invoices/${done.commitment}`}>Open it</Link>
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}

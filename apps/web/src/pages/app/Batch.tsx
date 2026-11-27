import { resolveTag } from "@kinko/kinko-pay";
import { Download, FileUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  TextArea,
} from "../../components/ui.tsx";
import { useCall } from "../../hooks/useCall.ts";
import { useKusdTokenType } from "../../hooks/useKusd.ts";
import { CONTRACTS } from "../../lib/config.ts";
import { BATCH_TEMPLATE, type BatchRow, parseBatch } from "../../lib/csv.ts";
import { formatAmount, shortHex } from "../../lib/format.ts";
import { readerFor } from "../../lib/midnight/providers.ts";
import { readTagsLedger, sendShielded, shieldedAddressOf } from "../../lib/pay.ts";
import { localId, upsert } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";

/** Outputs per transaction. Small enough that one transaction stays well inside block limits. */
const PER_TRANSACTION = 8;

type Resolution =
  | { status: "pending" }
  | { status: "ok"; address: string }
  | { status: "missing" }
  | { status: "error"; message: string };

export default function Batch() {
  const { account, balance, update, refreshBalance } = useAccount();
  const kusd = useKusdTokenType();
  const call = useCall();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const batch = useMemo(() => parseBatch(text), [text]);

  // Resolve every tag in the file with one read of the registry.
  useEffect(() => {
    const tags = batch.rows.filter((r) => r.recipientKind === "tag").map((r) => r.recipient);
    const next: Record<string, Resolution> = {};
    for (const r of batch.rows)
      if (r.recipientKind === "address") next[r.recipient] = { status: "ok", address: r.recipient };
    if (tags.length === 0) {
      setResolved(next);
      return;
    }
    const tagsAddress = CONTRACTS.tags;
    if (!tagsAddress) {
      for (const t of tags) next[t] = { status: "error", message: "No tag registry in this build" };
      setResolved(next);
      return;
    }
    for (const t of tags) next[t] = { status: "pending" };
    setResolved(next);
    // An object, so the type checker does not assume the flag never changes.
    const run = { live: true };
    void (async () => {
      try {
        const ledger = await readTagsLedger(await readerFor(account), tagsAddress);
        if (!run.live) return;
        const done: Record<string, Resolution> = { ...next };
        for (const t of tags) {
          const r = resolveTag(ledger, t);
          done[t] = r
            ? { status: "ok", address: shieldedAddressOf(r.coinPublicKey, r.encryptionPublicKey) }
            : { status: "missing" };
        }
        setResolved(done);
      } catch (e) {
        if (!run.live) return;
        const message = e instanceof Error ? e.message : "The registry could not be read.";
        setResolved((s) =>
          Object.fromEntries(
            Object.entries(s).map(([k, v]) => [
              k,
              v.status === "pending" ? { status: "error", message } : v,
            ]),
          ),
        );
      }
    })();
    return () => {
      run.live = false;
    };
  }, [batch.rows, account]);

  const unresolved = batch.rows.filter((r) => resolved[r.recipient]?.status !== "ok");
  const short = balance.status === "ready" && balance.kusd < batch.total;
  const ready =
    batch.rows.length > 0 &&
    unresolved.length === 0 &&
    batch.issues.length === 0 &&
    !short &&
    Boolean(kusd);

  const load = async (f: File) => {
    if (f.size > 512 * 1024) {
      setText("");
      setFileName(`${f.name} is larger than 512 KB; a batch file is a few kilobytes.`);
      return;
    }
    setFileName(f.name);
    setText(await f.text());
  };

  const pay = () =>
    call.run(async (onStage) => {
      if (!account || !kusd) throw new Error("Connect your wallet first.");
      const outputs = batch.rows.map((r) => ({
        row: r,
        recipient: (resolved[r.recipient] as { address: string }).address,
        value: r.amount,
      }));
      setProgress({ done: 0, total: outputs.length });
      for (let i = 0; i < outputs.length; i += PER_TRANSACTION) {
        const chunk = outputs.slice(i, i + PER_TRANSACTION);
        onStage("balancing");
        await sendShielded(account, kusd, chunk);
        onStage("confirming");
        await update((doc) =>
          chunk.reduce(
            (d, o) =>
              upsert(d, "payments", {
                id: localId(),
                to: o.recipient,
                toLabel:
                  o.row.recipientKind === "tag"
                    ? o.row.recipient
                    : shortHex(o.row.recipient, 14, 6),
                amount: o.value.toString(),
                createdAt: Date.now(),
                kind: "batch",
                memo: o.row.memo || undefined,
              }),
            doc,
          ),
        );
        setProgress({ done: Math.min(i + PER_TRANSACTION, outputs.length), total: outputs.length });
      }
      refreshBalance();
    });

  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(BATCH_TEMPLATE)}`;

  return (
    <div>
      <PageHeader eyebrow="Batch pay" title="Pay a whole list at once">
        Payroll, contractors or suppliers from one file. The file is read on this device and never
        uploaded; the chain sees private transfers, not your payroll.
      </PageHeader>
      <ContractNotice contracts={["tags"]} />
      <ConnectGate what="pay a batch">
        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            <Card>
              <SectionTitle
                aside={
                  <a
                    href={template}
                    download="kinko-batch.csv"
                    className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-shu-ink hover:underline"
                  >
                    <Download aria-hidden className="h-4 w-4" /> Template
                  </a>
                }
              >
                Your file
              </SectionTitle>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={file}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="sr-only"
                  id="batch-file"
                  onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])}
                />
                <Button variant="secondary" onClick={() => file.current?.click()}>
                  <FileUp aria-hidden className="h-4 w-4" /> Choose a CSV file
                </Button>
                {fileName ? <span className="text-sm text-ink-2">{fileName}</span> : null}
              </div>
              <div className="mt-4">
                <Field label="Or paste it: recipient, amount, note" htmlFor="batch-text">
                  <TextArea
                    id="batch-text"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                    }}
                    placeholder={BATCH_TEMPLATE}
                    spellCheck={false}
                    className="font-mono text-sm"
                    rows={6}
                  />
                </Field>
              </div>
              {batch.issues.length > 0 ? (
                <div className="mt-4">
                  <Notice
                    tone="bad"
                    title={`${String(batch.issues.length)} line${batch.issues.length === 1 ? "" : "s"} to fix`}
                  >
                    <ul className="mt-1 space-y-1">
                      {batch.issues.slice(0, 8).map((i) => (
                        <li key={`${String(i.line)}-${i.message}`}>
                          Line {i.line}: {i.message}
                        </li>
                      ))}
                    </ul>
                  </Notice>
                </div>
              ) : null}
            </Card>
            {batch.rows.length > 0 ? (
              <Card>
                <SectionTitle
                  aside={
                    <span className="tabular text-sm text-ink-2">
                      {batch.rows.length} payments · ${formatAmount(batch.total)}
                    </span>
                  }
                >
                  Check before paying
                </SectionTitle>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                        <th className="py-2 pr-3 font-medium">Line</th>
                        <th className="py-2 pr-3 font-medium">Recipient</th>
                        <th className="py-2 pr-3 text-right font-medium">Amount</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {batch.rows.map((r: BatchRow) => {
                        const s = resolved[r.recipient];
                        return (
                          <tr key={`${String(r.line)}-${r.recipient}`}>
                            <td className="py-2.5 pr-3 text-ink-3">{r.line}</td>
                            <td className="py-2.5 pr-3">
                              <span className="font-medium text-ink">
                                {r.recipientKind === "tag"
                                  ? r.recipient
                                  : shortHex(r.recipient, 14, 6)}
                              </span>
                              {r.memo ? (
                                <span className="block text-xs text-ink-3">{r.memo}</span>
                              ) : null}
                            </td>
                            <td className="tabular py-2.5 pr-3 text-right text-ink">
                              ${formatAmount(r.amount)}
                            </td>
                            <td className="py-2.5">
                              {s?.status === "ok" ? (
                                <Badge tone="ok">Ready</Badge>
                              ) : s?.status === "missing" ? (
                                <Badge tone="bad">Tag not found</Badge>
                              ) : s?.status === "error" ? (
                                <Badge tone="warn">Unchecked</Badge>
                              ) : (
                                <Badge>Checking</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-5 space-y-3 border-t border-line pt-5">
                  {short ? (
                    <Notice tone="warn">
                      Your private balance ($
                      {formatAmount(balance.kusd)}) does not cover ${formatAmount(batch.total)}.
                    </Notice>
                  ) : null}
                  {unresolved.length > 0 && batch.issues.length === 0 ? (
                    <Notice tone="warn">
                      {unresolved.length} recipient{unresolved.length === 1 ? " is" : "s are"} not
                      ready. Fix or remove those lines.
                    </Notice>
                  ) : null}
                  <Button
                    onClick={() => void pay()}
                    busy={call.busy}
                    disabled={!ready || call.stage === "done"}
                  >
                    Pay {batch.rows.length} {batch.rows.length === 1 ? "person" : "people"} · $
                    {formatAmount(batch.total)}
                  </Button>
                  {progress ? (
                    <p className="text-sm text-ink-2" role="status">
                      {progress.done} of {progress.total} sent
                      {progress.total > PER_TRANSACTION
                        ? `, ${String(PER_TRANSACTION)} per transaction`
                        : ""}
                      .
                    </p>
                  ) : null}
                  <ProofProgress
                    stage={call.stage}
                    startedAt={call.startedAt}
                    error={call.error}
                    doneText="Every payment in the file was sent privately."
                  />
                </div>
              </Card>
            ) : null}
          </div>
          <aside className="space-y-4">
            <Card>
              <SectionTitle>The file format</SectionTitle>
              <p className="text-sm leading-relaxed text-ink-2">
                One payment per line: a @tag or a Midnight shielded address, then the amount in
                dollars, then an optional note. A header row is optional. Up to 200 lines.
              </p>
              <pre
                tabIndex={0}
                aria-label="Example batch file"
                className="mt-3 overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs text-ink focus-visible:outline-2 focus-visible:outline-shu"
              >
                {BATCH_TEMPLATE}
              </pre>
            </Card>
            <Card>
              <div className="space-y-3">
                <PrivacyLine>
                  Nothing in the file leaves this device except the transfers themselves.
                </PrivacyLine>
                <PrivacyLine>
                  Each transfer is shielded: amount, sender and recipient are hidden.
                </PrivacyLine>
                <PrivacyLine>
                  Notes stay in your encrypted records, for your accountant, not on chain.
                </PrivacyLine>
              </div>
            </Card>
          </aside>
        </div>
      </ConnectGate>
    </div>
  );
}

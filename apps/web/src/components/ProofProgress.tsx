// What a Midnight transaction is doing right now.
//
// A proof takes tens of seconds, nearly all of it on the person's own
// machine. An unexplained spinner for that long reads as a hang, so the four
// real stages are named as they begin, with a running clock.

import { useEffect, useState } from "react";

import { formatDuration } from "../lib/format.ts";
import type { CallStage } from "../lib/midnight/contracts.ts";
import { cx } from "./ui.tsx";

const ORDER: CallStage[] = ["proving", "balancing", "submitting", "confirming"];

const COPY: Record<string, { title: string; detail: string }> = {
  proving: {
    title: "Making the proof",
    detail: "Your device proves the transaction is valid without revealing what is private in it.",
  },
  balancing: {
    title: "Approving in your wallet",
    detail: "Your wallet adds the network fee and signs. Approve the request it shows you.",
  },
  submitting: { title: "Submitting", detail: "Sending the transaction to the Midnight network." },
  confirming: { title: "Confirming", detail: "Waiting for the network to include it." },
};

const LABEL: Record<string, string> = {
  proving: "Prove",
  balancing: "Approve",
  submitting: "Submit",
  confirming: "Confirm",
};

export function ProofProgress({
  stage,
  startedAt,
  error,
  doneText,
}: {
  stage: CallStage;
  startedAt: number | null;
  error?: string | null;
  doneText?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ORDER.includes(stage)) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [stage]);

  if (stage === "idle") return null;
  const seconds = startedAt ? (now - startedAt) / 1000 : 0;

  if (stage === "failed") {
    return (
      <div role="alert" className="rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm">
        <p className="font-semibold text-bad">Not sent</p>
        <p className="mt-0.5 text-ink-2">{error ?? "The transaction did not go through."}</p>
      </div>
    );
  }
  if (stage === "done") {
    return (
      <div role="status" className="rounded-xl border border-ok/30 bg-ok-soft px-4 py-3 text-sm">
        <p className="font-semibold text-ok">Confirmed on Midnight</p>
        <p className="mt-0.5 text-ink-2">{doneText ?? "The transaction is on chain."}</p>
      </div>
    );
  }
  const index = ORDER.indexOf(stage);
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-line bg-surface-2 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-ink">{COPY[stage]?.title}</p>
        <p className="tabular font-mono text-xs text-ink-3">{formatDuration(seconds)}</p>
      </div>
      <p className="mt-1 text-sm text-ink-2">{COPY[stage]?.detail}</p>
      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {ORDER.map((s, i) => (
          <div key={s}>
            <div
              className={cx(
                "h-1 rounded-full",
                i < index ? "bg-shu" : i === index ? "kinko-sweep bg-shu/25" : "bg-line",
              )}
            />
            <p
              className={cx(
                "mt-1.5 text-[11px] font-medium uppercase tracking-wider",
                i <= index ? "text-shu-ink" : "text-ink-3",
              )}
            >
              {LABEL[s]}
            </p>
          </div>
        ))}
      </div>
      {seconds > 90 && stage === "proving" ? (
        <p className="mt-3 text-xs text-ink-3">
          Proving is still running on your device. It is slow on some machines; keep this tab open.
        </p>
      ) : null}
    </div>
  );
}

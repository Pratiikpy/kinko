import { Check } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ButtonLink, Card, PageHeader } from "../components/ui.tsx";
import { storage } from "../lib/storage.ts";

interface Stop {
  readonly id: string;
  readonly title: string;
  readonly what: string;
  readonly lookFor: string[];
  readonly to: string;
  readonly cta: string;
}

const STOPS: Stop[] = [
  {
    id: "backing",
    title: "Count the money before you trust it",
    what: "Open the backing page with no wallet connected. It reads the vault's USDC from Ethereum and the KUSD in circulation from Midnight, in your browser.",
    lookFor: [
      'Both figures marked "read by your browser"',
      "The relayer's report beside them, and which one the verdict used",
      "The deployment's addresses, to check in any explorer",
    ],
    to: "/backing",
    cta: "Open Backing",
  },
  {
    id: "connect",
    title: "Open an account with an Ethereum wallet",
    what: "Press Connect and choose MetaMask. One signature opens a Midnight account inside NightKit's vault, on a separate origin this page cannot read.",
    lookFor: [
      "Your shielded address on the account home",
      '"Opened with MetaMask" beside your wallet name',
      'Your balance labelled "only you can see it"',
    ],
    to: "/app",
    cta: "Open the account",
  },
  {
    id: "deposit",
    title: "Deposit USDC and watch both chains move",
    what: "Add dollars: get your deposit address, send USDC and gas from the same wallet, start the deposit, then receive. Every relayed step appears in the stepper with who acts. On a test network you need free Sepolia test USDC (faucet.circle.com) and a little Sepolia ETH (the Google Cloud web3 faucet) first; the Add dollars page links both.",
    lookFor: [
      "The deposit address derived from your private identity",
      "Each relayer stage arriving in order",
      "The backing page rising by the same amount on both chains",
    ],
    to: "/app/add",
    cta: "Add dollars",
  },
  {
    id: "pay",
    title: "Pay a @tag, then request and pay an invoice",
    what: "Claim a tag, pay one, and create a request from a second account. Pay its link. Then look the transaction up on the indexer: there is a transaction, and no amount, sender or receiver.",
    lookFor: [
      "The tag resolving with no address shown to the payer",
      "The invoice's live status flipping to Paid",
      "A receipt saved on the payer's device",
    ],
    to: "/app/pay",
    cta: "Pay",
  },
  {
    id: "receipt",
    title: "Prove one payment, and nothing else",
    what: "From Receipts, make a proof link and open it in a private window. The verifier sees one payment checked against the chain, and no other payment or balance.",
    lookFor: [
      '"This payment is on chain" with the amount and invoice',
      'A tampered link showing "No such payment"',
    ],
    to: "/app/receipts",
    cta: "Open Receipts",
  },
  {
    id: "examine",
    title: "Let an examiner see exactly one case",
    what: "File a sealed statement, open a case naming it as an examiner, approve it from two keyholder slots, and open it. Try with one approval first: the record stays sealed.",
    lookFor: [
      "The deployment check passing in the browser",
      "The record opening only after the second approval, checked against its anchor",
      "Every step in the public disclosure log",
    ],
    to: "/examine",
    cta: "Open Examine",
  },
  {
    id: "withdraw",
    title: "Take it back out as USDC",
    what: "Withdraw part of the balance to an Ethereum address. The fee is read from the vault and shown before you sign; closing the withdrawal settles it, or mints it back if the transfer failed.",
    lookFor: [
      "The fee and the amount burned, shown up front",
      "USDC arriving at the address on Ethereum",
      "The backing page falling by the same amount on both chains",
    ],
    to: "/app/withdraw",
    cta: "Withdraw",
  },
];

const KEY = "tour";

const isDone = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export default function Walkthrough() {
  const [done, setDone] = useState<string[]>(() => storage.getJson(KEY, isDone) ?? []);
  const toggle = (id: string) => {
    const next = done.includes(id) ? done.filter((d) => d !== id) : [...done, id];
    setDone(next);
    storage.setJson(KEY, next);
  };
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader eyebrow="Guided tour" title="See the whole product in seven stops">
        For judges and first-time visitors. Each stop says what to do and what to look for. Tick
        them off as you go; the ticks stay in this browser.
      </PageHeader>
      <p className="mb-6 text-sm text-ink-2" role="status">
        {done.length} of {STOPS.length} done.
      </p>
      <ol className="space-y-4">
        {STOPS.map((s, i) => {
          const ticked = done.includes(s.id);
          return (
            <li key={s.id}>
              <Card className={ticked ? "border-ok/40" : undefined}>
                <div className="flex gap-4">
                  <button
                    type="button"
                    onClick={() => {
                      toggle(s.id);
                    }}
                    aria-pressed={ticked}
                    aria-label={
                      ticked
                        ? `Mark stop ${String(i + 1)} as not done`
                        : `Mark stop ${String(i + 1)} as done`
                    }
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition ${ticked ? "border-ok bg-ok text-surface" : "border-line-strong text-ink-2 hover:border-ink-3"}`}
                  >
                    {ticked ? <Check aria-hidden className="h-5 w-5" /> : i + 1}
                  </button>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-xl text-ink">{s.title}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.what}</p>
                    <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">
                      Look for
                    </p>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-ink-2">
                      {s.lookFor.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    <div className="mt-4">
                      <ButtonLink to={s.to} variant="secondary">
                        {s.cta}
                      </ButtonLink>
                    </div>
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 text-sm text-ink-3">
        What is public and private at each stop is stated on{" "}
        <Link to="/privacy" className="font-medium text-shu-ink hover:underline">
          Privacy and limits
        </Link>
        .
      </p>
    </div>
  );
}

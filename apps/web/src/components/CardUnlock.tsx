import { PIN_MAX_DIGITS, PIN_MIN_DIGITS, pinProblem } from "@kinko/card/seed";
import { CreditCard, Gift, KeyRound } from "lucide-react";
import { useState } from "react";

import type { CardSession } from "../hooks/useCardWallet.ts";
import { type CardInput, parseCardInput } from "../lib/card.ts";
import { formatAmount } from "../lib/format.ts";
import { Button, Notice, Skeleton, TextField } from "./ui.tsx";

const PIN_TEXT = {
  length: `${String(PIN_MIN_DIGITS)} to ${String(PIN_MAX_DIGITS)} digits.`,
  digits: "Digits only.",
  guessable: "Too easy to guess: no repeated or running digits.",
} as const;

const KIND_TEXT: Record<CardInput["kind"], { label: string; Icon: typeof Gift }> = {
  gift: { label: "Gift card", Icon: Gift },
  pin: { label: "PIN card", Icon: CreditCard },
  phrase: { label: "Card recovery phrase", Icon: KeyRound },
};

/**
 * Ask for a card (its link or recovery phrase) and, for a PIN card, its PIN,
 * then open it.
 */
export function CardUnlock({
  session,
  onOpen,
  initial,
  action = "Open the card",
}: {
  session: CardSession;
  onOpen: (input: CardInput, pin?: string) => void;
  /** A card already known, for example from the page's link: only its PIN is asked for. */
  initial?: CardInput;
  action?: string;
}) {
  const [text, setText] = useState("");
  const [pin, setPin] = useState("");
  const input = initial ?? parseCardInput(text);
  const needsPin = input?.kind === "pin";
  const problem = needsPin && pin ? pinProblem(pin) : undefined;
  const busy = session.status === "unlocking";
  const ready = input && (!needsPin || (pin && !problem));

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (input && ready) onOpen(input, needsPin ? pin : undefined);
      }}
    >
      {initial ? (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          {(() => {
            const { Icon, label } = KIND_TEXT[initial.kind];
            return (
              <>
                <Icon aria-hidden className="h-4 w-4 text-shu" /> {label}
              </>
            );
          })()}
        </p>
      ) : (
        <TextField
          label="Card link or 24-word recovery phrase"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          spellCheck={false}
          autoComplete="off"
          error={text.trim() && !input ? "That is not a Kinko card link or recovery phrase." : null}
          hint={
            input
              ? KIND_TEXT[input.kind].label
              : "Paste it, or open the card's link directly. A recovery phrase opens fastest with the card's birth after it."
          }
        />
      )}
      {needsPin ? (
        <TextField
          label="PIN"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          maxLength={PIN_MAX_DIGITS}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, ""));
          }}
          error={problem ? PIN_TEXT[problem] : null}
          hint="The PIN is checked by opening the card. It never leaves this page."
        />
      ) : null}
      <Button type="submit" busy={busy} disabled={!ready || busy}>
        {busy && needsPin ? "Checking the PIN…" : action}
      </Button>
      {session.status === "error" ? (
        <Notice tone="bad" title="The card could not be opened">
          {session.message}
        </Notice>
      ) : null}
    </form>
  );
}

/**
 * What an open card holds, and how far it has caught up with the chain. A
 * card opened with the wrong PIN is simply an empty card: there is no way, by
 * design, to tell a wrong PIN from an unused card.
 */
export function CardBalance({
  session,
  kusd,
  emptyText = "Nothing yet. A card that was just funded shows its balance once the transfer lands; a wrong PIN opens an empty card.",
}: {
  session: CardSession;
  kusd: string | null;
  /** What to say when the card holds nothing. */
  emptyText?: string;
}) {
  if (session.status === "closed" || session.status === "error") return null;
  if (session.status === "unlocking") {
    return (
      <div className="rounded-2xl bg-surface-2 p-5" aria-live="polite">
        <p className="text-sm text-ink-2">Opening the card…</p>
        <Skeleton className="mt-2 h-10 w-40" />
      </div>
    );
  }
  if (session.status === "syncing") {
    const pct = session.progress === null ? null : Math.round(session.progress * 100);
    return (
      <div className="rounded-2xl bg-surface-2 p-5" aria-live="polite">
        <p className="text-sm text-ink-2">
          Reading the card from the chain{pct === null ? "…" : ` · ${String(pct)}%`}
        </p>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-label="Card sync"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <div
            className="h-full rounded-full bg-shu transition-[width] duration-500"
            style={{ width: `${String(pct ?? 8)}%` }}
          />
        </div>
      </div>
    );
  }
  const balance = kusd ? (session.state.balances[kusd] ?? 0n) : 0n;
  return (
    <div className="rounded-2xl bg-surface-2 p-5" aria-live="polite">
      <p className="text-sm text-ink-2">This card holds</p>
      <p className="tabular mt-1 font-display text-4xl text-ink" data-testid="card-balance">
        ${formatAmount(balance)}
      </p>
      {balance === 0n ? <p className="mt-2 text-sm text-ink-3">{emptyText}</p> : null}
    </div>
  );
}

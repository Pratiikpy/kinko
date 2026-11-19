import { AtSign, Link2, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
import { InvoicePayment } from "../../components/InvoicePayment.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import {
  Button,
  Card,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  TextField,
} from "../../components/ui.tsx";
import { useCall } from "../../hooks/useCall.ts";
import { useKusdTokenType } from "../../hooks/useKusd.ts";
import { CONTRACTS } from "../../lib/config.ts";
import { classifyRecipient } from "../../lib/csv.ts";
import { AMOUNT_ERROR_TEXT, formatAmount, parseAmount, shortHex } from "../../lib/format.ts";
import { readerFor } from "../../lib/midnight/providers.ts";
import {
  lookupTag,
  parsePaymentLink,
  parseShieldedAddress,
  sendShielded,
  shieldedAddressOf,
} from "../../lib/pay.ts";
import { localId, upsert } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";

type Target =
  | { kind: "empty" }
  | { kind: "link"; link: NonNullable<ReturnType<typeof parsePaymentLink>> }
  | { kind: "tag"; tag: string }
  | { kind: "address"; address: string }
  | { kind: "invalid" };

function classify(text: string): Target {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  const link = parsePaymentLink(t);
  if (link) return { kind: "link", link };
  const r = classifyRecipient(t);
  if (r === "tag") return { kind: "tag", tag: t.replace(/^@/, "").toLowerCase() };
  if (r === "address" && parseShieldedAddress(t)) return { kind: "address", address: t };
  return { kind: "invalid" };
}

function DirectPay({ target }: { target: Extract<Target, { kind: "tag" | "address" }> }) {
  const { account, balance, update, refreshBalance } = useAccount();
  const kusd = useKusdTokenType();
  const call = useCall();
  const [amountText, setAmountText] = useState("");
  const [memo, setMemo] = useState("");
  const [resolved, setResolved] = useState<{ address: string; label: string } | null | "missing">(
    null,
  );
  const [resolveError, setResolveError] = useState<string | null>(null);
  const parsed = parseAmount(amountText);

  useEffect(() => {
    setResolved(null);
    setResolveError(null);
    if (target.kind === "address") {
      setResolved({ address: target.address, label: shortHex(target.address, 14, 6) });
      return;
    }
    const tagsAddress = CONTRACTS.tags;
    if (!tagsAddress) return;
    // An object, so the type checker does not assume the flag never changes.
    const run = { live: true };
    const id = window.setTimeout(
      () =>
        void (async () => {
          try {
            const r = await lookupTag(await readerFor(account), tagsAddress, target.tag);
            if (!run.live) return;
            setResolved(
              r
                ? {
                    address: shieldedAddressOf(r.coinPublicKey, r.encryptionPublicKey),
                    label: `@${r.name}`,
                  }
                : "missing",
            );
          } catch (e) {
            if (run.live)
              setResolveError(e instanceof Error ? e.message : "The tag could not be looked up.");
          }
        })(),
      300,
    );
    return () => {
      run.live = false;
      window.clearTimeout(id);
    };
  }, [target, account]);

  const short = parsed.ok && balance.status === "ready" && balance.kusd < parsed.value;
  const ready = resolved && resolved !== "missing" && parsed.ok && !short && kusd;

  const send = () =>
    call.run(async (onStage) => {
      if (!account || !resolved || resolved === "missing" || !parsed.ok || !kusd)
        throw new Error("Check the recipient and the amount.");
      onStage("balancing");
      await sendShielded(account, kusd, [{ recipient: resolved.address, value: parsed.value }]);
      onStage("confirming");
      await update((doc) =>
        upsert(doc, "payments", {
          id: localId(),
          to: resolved.address,
          toLabel: resolved.label,
          amount: parsed.value.toString(),
          createdAt: Date.now(),
          kind: target.kind === "tag" ? "tag" : "address",
          memo: memo || undefined,
        }),
      );
      refreshBalance();
    });

  return (
    <div className="grid gap-4 sm:max-w-md">
      {target.kind === "tag" ? (
        resolveError ? (
          <Notice tone="bad">{resolveError}</Notice>
        ) : resolved === "missing" ? (
          <Notice tone="warn" title={`@${target.tag} is not registered`}>
            Check the spelling. Tags are 3 to 20 letters, digits or underscores.
          </Notice>
        ) : resolved ? (
          <Notice tone="ok" title={`${resolved.label} found`}>
            Paying a tag sends to the receiving keys its owner registered. The chain does not record
            that this payment was for them.
          </Notice>
        ) : (
          <p className="text-sm text-ink-3">Looking up @{target.tag}…</p>
        )
      ) : null}
      <TextField
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        placeholder="40.00"
        value={amountText}
        onChange={(e) => {
          setAmountText(e.target.value);
        }}
        error={
          amountText && !parsed.ok
            ? AMOUNT_ERROR_TEXT[parsed.error]
            : short
              ? "Your private balance does not cover this."
              : null
        }
        hint={
          balance.status === "ready" ? `Private balance: $${formatAmount(balance.kusd)}` : undefined
        }
      />
      <TextField
        label="Note for your records (optional)"
        value={memo}
        onChange={(e) => {
          setMemo(e.target.value);
        }}
        maxLength={120}
        hint="Kept on this device only. It is not sent with the payment."
      />
      <Button
        onClick={() => void send()}
        busy={call.busy}
        disabled={!ready || call.stage === "done"}
      >
        Pay {parsed.ok ? `$${formatAmount(parsed.value)}` : ""}{" "}
        {resolved && resolved !== "missing" ? `to ${resolved.label}` : ""}
      </Button>
      <ProofProgress
        stage={call.stage}
        startedAt={call.startedAt}
        error={call.error}
        doneText="Sent privately. It reaches the recipient's wallet when it next syncs."
      />
    </div>
  );
}

export default function Pay() {
  const { hash } = useLocation();
  const [text, setText] = useState(() => (hash.length > 1 ? hash.slice(1) : ""));
  useEffect(() => {
    if (hash.length > 1) setText(hash.slice(1));
  }, [hash]);
  const target = useMemo(() => classify(text), [text]);

  return (
    <div>
      <PageHeader eyebrow="Pay" title="Pay anyone, privately">
        Pay a @tag, a Midnight address or a payment link. The chain sees a valid payment, not the
        amount, the payer or the payee.
      </PageHeader>
      {target.kind === "tag" ? <ContractNotice contracts={["tags"]} /> : null}
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <TextField
            label="Who are you paying?"
            placeholder="@alice, mn_shield-addr_…, or a payment link"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            error={
              target.kind === "invalid"
                ? "That is not a @tag, a shielded address on this network, or a Kinko payment link."
                : null
            }
          />
          {target.kind === "link" ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <Link2 aria-hidden className="h-4 w-4" /> Payment link
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  setText("");
                }}
              >
                Clear
              </Button>
            </div>
          ) : null}
          <div className="mt-6">
            {target.kind === "link" ? (
              // An invoice is payable without a connected wallet: from a Kinko card, or after
              // connecting from the invoice itself.
              <InvoicePayment link={target.link} />
            ) : (
              <ConnectGate what="pay">
                {target.kind === "tag" || target.kind === "address" ? (
                  <DirectPay target={target} />
                ) : (
                  <p className="text-sm text-ink-3">
                    Paste a payment link or type a @tag to begin.
                  </p>
                )}
              </ConnectGate>
            )}
          </div>
        </Card>
        <aside className="space-y-4">
          <Card>
            <SectionTitle>Three ways to pay</SectionTitle>
            <ul className="space-y-4 text-sm leading-relaxed text-ink-2">
              <li className="flex gap-3">
                <AtSign aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-shu" />{" "}
                <span>
                  <strong className="text-ink">A @tag</strong> resolves to the owner's private
                  receiving keys. Nobody learns which payments reached which tag.
                </span>
              </li>
              <li className="flex gap-3">
                <Link2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-shu" />{" "}
                <span>
                  <strong className="text-ink">A payment link</strong> carries invoice terms in its
                  fragment. Paying it leaves a receipt you can later prove.
                </span>
              </li>
              <li className="flex gap-3">
                <Wallet aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-shu" />{" "}
                <span>
                  <strong className="text-ink">An address</strong> is a plain private transfer,
                  built and signed by your wallet.
                </span>
              </li>
            </ul>
          </Card>
          <Card>
            <div className="space-y-3">
              <PrivacyLine>Amounts and parties never reach the public ledger.</PrivacyLine>
              <PrivacyLine>Your notes stay on this device, encrypted.</PrivacyLine>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

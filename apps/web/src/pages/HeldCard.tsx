import { giftCommitmentOf, KinkoGift } from "@kinko/kinko-pay";
import { ArrowDownToLine, CheckCircle2, KeyRound } from "lucide-react";
import { ConnectButton } from "nightkit-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { CardBalance, CardUnlock } from "../components/CardUnlock.tsx";
import { Seal } from "../components/Logo.tsx";
import { ProofProgress } from "../components/ProofProgress.tsx";
import { Button, Card, Copyable, EmptyState, Notice, PrivacyLine } from "../components/ui.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { useCall } from "../hooks/useCall.ts";
import { useCardWallet } from "../hooks/useCardWallet.ts";
import { useKusdTokenType } from "../hooks/useKusd.ts";
import {
  type CardInput,
  defaultFees,
  entropyOf,
  feePayer,
  parseCardInput,
  withoutBirth,
} from "../lib/card.ts";
import { CONTRACTS } from "../lib/config.ts";
import { formatAmount, fromHex, toHex } from "../lib/format.ts";
import { queryContractData, readerFor } from "../lib/midnight/providers.ts";
import { upsert } from "../lib/records.ts";
import { useAccount } from "../state/account.tsx";

/** Whether the gift registry knows this card, and whether its issuer voided it. */
function useGiftCheck(input: CardInput | undefined) {
  const { account } = useAccount();
  const gift = input?.kind === "gift" ? input : undefined;
  const address = gift?.contractAddress ?? CONTRACTS.gift;
  return useAsync(
    async () => {
      if (!gift || !address) throw new Error("Not a gift card.");
      const data = await queryContractData(await readerFor(account), address);
      if (!data) throw new Error("The gift card registry was not found on this network.");
      const ledger = KinkoGift.ledger(data);
      const commitment = giftCommitmentOf(fromHex(gift.issuerId), gift.token, gift.secret);
      return {
        commitment: toHex(commitment),
        issued: ledger.cards.member(commitment),
        voided: ledger.voided.member(commitment),
      };
    },
    [gift?.secret, address, account],
    { enabled: Boolean(gift && address) },
  );
}

function RecoveryPhrase({ input, pin }: { input: CardInput; pin?: string }) {
  const [phrase, setPhrase] = useState<string | null>(null);
  const reveal = async () => {
    const { recoveryPhrase } = await import("@kinko/card/seed");
    setPhrase(recoveryPhrase(await entropyOf(input, pin)));
  };
  return phrase ? (
    <div className="space-y-2">
      <p className="text-sm text-ink-2">
        These 24 words open this card in any Midnight wallet. Whoever has them has the card.
      </p>
      <Copyable value={phrase} label="Recovery phrase" />
      {input.birth ? (
        <>
          <p className="text-sm text-ink-2">
            The birth is not secret. Paste it after the phrase when you open the card in Kinko
            again, and the card starts from where it was made instead of reading the whole chain.
            Other wallets want the 24 words alone.
          </p>
          <Copyable value={input.birth} label="Card birth" />
        </>
      ) : null}
    </div>
  ) : (
    <button
      type="button"
      className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-shu-ink hover:underline"
      onClick={() => void reveal()}
    >
      <KeyRound aria-hidden className="h-4 w-4" /> Show the card's recovery phrase
    </button>
  );
}

/**
 * The page a card's link opens: a gift card someone sent, or a PIN card. It
 * reads the card from the chain without any wallet, and moves its balance into
 * the holder's own account when they connect one.
 */
export default function HeldCard() {
  const { hash, pathname } = useLocation();
  const { account, update } = useAccount();
  const kusd = useKusdTokenType();
  const { session, open } = useCardWallet();
  const move = useCall();
  const [pin, setPin] = useState<string | undefined>();
  const [moved, setMoved] = useState<bigint | null>(null);
  const input = useMemo(() => parseCardInput(hash.slice(1)), [hash]);
  const check = useGiftCheck(input);
  const isGift = input?.kind === "gift";

  // A gift card needs no PIN, so it opens as soon as the page does. Only a new
  // card reopens it: the account changing would resync the same card for nothing.
  const giftSecret = input?.kind === "gift" ? input.secret : null;
  useEffect(() => {
    if (input?.kind === "gift") void open(input, defaultFees(account));
  }, [giftSecret]);

  const ready = session.status === "ready" ? session : null;
  const balance = ready && kusd ? (ready.state.balances[kusd] ?? 0n) : 0n;

  const moveToAccount = () =>
    move.run(async (onStage) => {
      if (!ready || !account || !kusd) throw new Error("Connect your account first.");
      onStage("balancing");
      const payer = await feePayer({ kind: "wallet", api: account.api });
      onStage("submitting");
      const out = await ready.wallet.sweep(kusd, account.shieldedAddress, payer);
      if (isGift && check.status === "ready") {
        const gift = input;
        await update((doc) =>
          upsert(doc, "gifts", {
            commitment: check.value.commitment,
            secret: gift.secret,
            issuerId: gift.issuerId,
            amount: out.amount.toString(),
            role: "received",
            label: "Received card",
            createdAt: Date.now(),
            redeemedAt: Date.now(),
          }),
        );
      }
      setMoved(out.amount);
    });

  if (!input) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12">
        <EmptyState
          title="This card link is incomplete"
          action={
            <Link
              to="/"
              className="inline-flex min-h-11 items-center text-sm font-semibold text-shu-ink hover:underline"
            >
              What is Kinko?
            </Link>
          }
        >
          Everything after the # is the card. It is read in this browser and never sent to any
          server.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="mb-6 flex items-center justify-center gap-2 text-sm text-ink-3">
        <Seal size={22} /> {pathname.startsWith("/gift") ? "A Kinko gift card" : "A Kinko card"}
      </div>
      <Card className="space-y-5 p-6 sm:p-8">
        {isGift ? (
          check.status === "ready" ? (
            check.value.voided ? (
              <Notice tone="bad" title="Voided by its issuer">
                The issuer marked this card as issued in error. Do not accept it as payment.
              </Notice>
            ) : check.value.issued ? (
              <Notice tone="ok" title="Genuine">
                Registered by issuer{" "}
                <span className="font-mono text-xs">{input.issuerId.slice(0, 12)}…</span>.
              </Notice>
            ) : (
              <Notice tone="bad" title="Not registered">
                No card with these details was issued. It may be forged, or from another network.
              </Notice>
            )
          ) : check.status === "error" ? (
            <Notice tone="warn">
              The card's registration could not be checked: {check.message}
            </Notice>
          ) : null
        ) : null}

        {session.status === "closed" || session.status === "error" ? (
          isGift ? (
            session.status === "error" ? (
              <Notice tone="bad" title="The card could not be read">
                {session.message}
              </Notice>
            ) : null
          ) : (
            <CardUnlock
              session={session}
              initial={input}
              onOpen={(i, p) => {
                setPin(p);
                void open(i, defaultFees(account), p);
              }}
            />
          )
        ) : null}
        <CardBalance
          session={session}
          kusd={kusd}
          emptyText={moved !== null ? "Empty: its balance is now in your account." : undefined}
        />

        {moved !== null ? (
          <div className="rounded-2xl border border-ok/30 bg-ok-soft p-5">
            <p className="flex items-center gap-2 font-semibold text-ok">
              <CheckCircle2 aria-hidden className="h-5 w-5" /> ${formatAmount(moved)} moved to your
              account
            </p>
            <Link
              to="/app"
              className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-shu-ink hover:underline"
            >
              See your balance
            </Link>
          </div>
        ) : ready && balance > 0n ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="font-semibold text-ink">Spend it</p>
              <p className="text-sm text-ink-2">
                At any Kinko checkout or invoice, choose "Pay with a Kinko card" and paste this
                card's link. No wallet is needed.
              </p>
            </div>
            <div className="space-y-2 border-t border-line pt-4">
              <p className="font-semibold text-ink">Or keep it in your own account</p>
              {account ? (
                <>
                  <Button
                    onClick={() => void moveToAccount()}
                    busy={move.busy}
                    disabled={move.stage === "done"}
                  >
                    <ArrowDownToLine aria-hidden className="h-4 w-4" /> Move $
                    {formatAmount(balance)} to my account
                  </Button>
                  <p className="text-sm text-ink-3">Your wallet pays the network fee.</p>
                  <ProofProgress
                    stage={move.stage}
                    startedAt={move.startedAt}
                    error={move.error}
                    doneText="Moved."
                  />
                </>
              ) : (
                <ConnectButton label="Connect to keep it" />
              )}
            </div>
          </div>
        ) : null}

        {input.birth &&
        ((ready && balance === 0n && moved === null) || session.status === "error") ? (
          <div className="space-y-1">
            <p className="text-sm text-ink-2">
              This card started from a published copy of the chain as it was when the card was made.
              If its balance is not what you expect, read the whole chain instead. That takes much
              longer, and it does not depend on the copy at all.
            </p>
            <button
              type="button"
              className="inline-flex min-h-11 items-center text-sm font-semibold text-shu-ink hover:underline"
              onClick={() => void open(withoutBirth(input), defaultFees(account), pin)}
            >
              Read the whole chain
            </button>
          </div>
        ) : null}

        {ready ? <RecoveryPhrase input={input} pin={pin} /> : null}

        <div className="space-y-2 border-t border-line pt-4">
          <PrivacyLine>
            The balance is read from the chain in this browser. Nobody else can see it.
          </PrivacyLine>
          <PrivacyLine>
            {isGift
              ? "The card link is the money: share it with one person, privately."
              : "The card link opens nothing without its PIN. Keep the two apart."}
          </PrivacyLine>
        </div>
      </Card>
    </div>
  );
}

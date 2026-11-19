import {
  cardEntropy,
  newCardSecret,
  PIN_MAX_DIGITS,
  PIN_MIN_DIGITS,
  pinProblem,
} from "@kinko/card/seed";
import { encodePinCard } from "@kinko/kinko-pay";
import { CreditCard, Snowflake } from "lucide-react";
import { useEffect, useState } from "react";

import { CardBalance } from "../../components/CardUnlock.tsx";
import { ConnectGate } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { QR } from "../../components/QR.tsx";
import {
  Badge,
  Button,
  Card,
  Copyable,
  EmptyState,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  TextField,
} from "../../components/ui.tsx";
import { useCall } from "../../hooks/useCall.ts";
import { useCardWallet } from "../../hooks/useCardWallet.ts";
import { useKusdTokenType } from "../../hooks/useKusd.ts";
import { defaultFees, feePayer } from "../../lib/card.ts";
import { latestBirth } from "../../lib/card-snapshot.ts";
import { NETWORK_ID } from "../../lib/config.ts";
import {
  AMOUNT_ERROR_TEXT,
  formatAmount,
  parseAmount,
  relativeTime,
  toHex,
} from "../../lib/format.ts";
import { sendShielded } from "../../lib/pay.ts";
import { type CardRecord, patch, pinCards, upsert } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";

const PIN_TEXT = {
  length: `${String(PIN_MIN_DIGITS)} to ${String(PIN_MAX_DIGITS)} digits.`,
  digits: "Digits only.",
  guessable: "Too easy to guess: no repeated or running digits.",
} as const;

/** The link printed on a card. The PIN is never part of it. */
const cardLink = (card: Pick<CardRecord, "secret" | "birth">) =>
  `${window.location.origin}/card#${encodePinCard(card.secret, card.birth)}`;

/** The shielded address a card with this secret and PIN receives at. */
async function addressOf(secret: Uint8Array, pin: string): Promise<string> {
  const entropy = await cardEntropy({ kind: "pin", secret, pin });
  const { cardAddresses, deriveCardKeys, walletSeed } = await import("@kinko/card");
  return cardAddresses(deriveCardKeys(walletSeed(entropy), NETWORK_ID), NETWORK_ID).shielded;
}

function PinFields({
  pin,
  setPin,
  confirm,
  setConfirm,
}: {
  pin: string;
  setPin: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
}) {
  const problem = pin ? pinProblem(pin) : undefined;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="PIN"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        value={pin}
        maxLength={PIN_MAX_DIGITS}
        onChange={(e) => {
          setPin(e.target.value.replace(/\D/g, ""));
        }}
        error={problem ? PIN_TEXT[problem] : null}
      />
      <TextField
        label="PIN again"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        value={confirm}
        maxLength={PIN_MAX_DIGITS}
        onChange={(e) => {
          setConfirm(e.target.value.replace(/\D/g, ""));
        }}
        error={confirm && pin !== confirm ? "The PINs differ." : null}
      />
    </div>
  );
}

function Create() {
  const { account, update, balance, refreshBalance } = useAccount();
  const kusd = useKusdTokenType();
  const call = useCall();
  const [label, setLabel] = useState("");
  const [amountText, setAmountText] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [made, setMade] = useState<CardRecord | null>(null);
  const amount = amountText.trim() ? parseAmount(amountText) : null;
  const short = amount?.ok && balance.status === "ready" && balance.kusd < amount.value;
  const valid = (!amount || amount.ok) && !short && pin && !pinProblem(pin) && pin === confirm;

  const create = () =>
    call.run(async (onStage) => {
      if (!account || !kusd || !valid) throw new Error("Check the amount and the PIN.");
      const secret = newCardSecret();
      // Where the chain's published tree stands as the card is made, before it can be funded: the
      // card opens from there instead of replaying the chain. Without it, it still opens.
      const birth = await latestBirth();
      const record: CardRecord = {
        address: await addressOf(secret, pin),
        secret: toHex(secret),
        label: label.trim() || "Card",
        createdAt: Date.now(),
        ...(birth ? { birth } : {}),
      };
      // Kept before it is funded, so a failed transfer never loses the card.
      await update((doc) => upsert(doc, "cards", record));
      if (amount?.ok && amount.value > 0n) {
        onStage("balancing");
        await sendShielded(account, kusd, [{ recipient: record.address, value: amount.value }]);
        refreshBalance();
      }
      setMade(record);
      setPin("");
      setConfirm("");
    });

  return (
    <Card>
      <SectionTitle>Make a PIN card</SectionTitle>
      <form
        className="grid gap-4 sm:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TextField
          label="Name, for you"
          placeholder="Weekend card"
          value={label}
          maxLength={40}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
        <TextField
          label="Load it with"
          inputMode="decimal"
          placeholder="40.00"
          value={amountText}
          onChange={(e) => {
            setAmountText(e.target.value);
          }}
          error={
            amount && !amount.ok
              ? AMOUNT_ERROR_TEXT[amount.error]
              : short
                ? "Your private balance does not cover this."
                : null
          }
          hint="Optional. You can top it up later."
        />
        <PinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} />
        <Button type="submit" busy={call.busy} disabled={!valid || !kusd}>
          Make the card
        </Button>
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="The card is ready."
        />
      </form>
      {made ? (
        <div className="mt-6 grid gap-5 border-t border-line pt-5 md:grid-cols-[auto_1fr]">
          <QR value={cardLink(made)} label="QR code of the card" size={168} />
          <div className="min-w-0 space-y-3">
            <p className="font-display text-2xl text-ink">{made.label}</p>
            <Copyable value={cardLink(made)} label="Card link" />
            <Notice tone="warn" title="The PIN is not on the card">
              Give the card and the PIN separately. Neither opens it alone, and the PIN is stored
              nowhere: if it is forgotten, freeze the card from here to move its balance back.
            </Notice>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function TopUp({ card }: { card: CardRecord }) {
  const { account, update, balance, refreshBalance } = useAccount();
  const kusd = useKusdTokenType();
  const call = useCall();
  const [amountText, setAmountText] = useState("");
  const amount = parseAmount(amountText);
  const short = amount.ok && balance.status === "ready" && balance.kusd < amount.value;
  const topUp = () =>
    call.run(async (onStage) => {
      if (!account || !kusd || !amount.ok) throw new Error("Check the amount.");
      onStage("balancing");
      await sendShielded(account, kusd, [{ recipient: card.address, value: amount.value }]);
      await update((doc) => patch(doc, "cards", card.address, { frozenAt: undefined }));
      refreshBalance();
      setAmountText("");
    });
  return (
    <form
      className="grid gap-3 sm:max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void topUp();
      }}
    >
      <TextField
        label="Top up with"
        inputMode="decimal"
        placeholder="20.00"
        value={amountText}
        onChange={(e) => {
          setAmountText(e.target.value);
        }}
        error={
          amountText && !amount.ok
            ? AMOUNT_ERROR_TEXT[amount.error]
            : short
              ? "Your private balance does not cover this."
              : null
        }
      />
      <Button type="submit" variant="secondary" busy={call.busy} disabled={!amount.ok || short}>
        Top up
      </Button>
      <ProofProgress
        stage={call.stage}
        startedAt={call.startedAt}
        error={call.error}
        doneText="Sent to the card."
      />
    </form>
  );
}

function OpenAndFreeze({ card }: { card: CardRecord }) {
  const { account, update, refreshBalance } = useAccount();
  const kusd = useKusdTokenType();
  const { session, open, close } = useCardWallet();
  const freeze = useCall();
  const [pin, setPin] = useState("");
  const wrongPin =
    (session.status === "syncing" || session.status === "ready") &&
    session.wallet.addresses.shielded !== card.address;
  const [refused, setRefused] = useState(false);
  // A wrong PIN opens a different, empty wallet. The owner knows the card's
  // address, so it can say so plainly; a holder at a checkout cannot.
  useEffect(() => {
    if (!wrongPin) return;
    setRefused(true);
    close();
  }, [wrongPin, close]);
  const ready = session.status === "ready" && !wrongPin ? session : null;
  const held = ready && kusd ? (ready.state.balances[kusd] ?? 0n) : 0n;

  const moveBack = () =>
    freeze.run(async (onStage) => {
      if (!ready || !account || !kusd) throw new Error("Open the card first.");
      onStage("balancing");
      const payer = await feePayer({ kind: "wallet", api: account.api });
      onStage("submitting");
      await ready.wallet.sweep(kusd, account.shieldedAddress, payer);
      await update((doc) => patch(doc, "cards", card.address, { frozenAt: Date.now() }));
      refreshBalance();
    });

  if (!ready && session.status !== "syncing") {
    return (
      <form
        className="grid gap-3 sm:max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setRefused(false);
          void open(
            { kind: "pin", secret: card.secret, ...(card.birth ? { birth: card.birth } : {}) },
            defaultFees(account),
            pin,
          );
        }}
      >
        <TextField
          label="PIN, to open the card"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          maxLength={PIN_MAX_DIGITS}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, ""));
          }}
          error={refused ? "That PIN does not open this card." : null}
        />
        <Button
          type="submit"
          variant="secondary"
          busy={session.status === "unlocking"}
          disabled={!pin || Boolean(pinProblem(pin))}
        >
          Open
        </Button>
        {session.status === "error" ? <Notice tone="bad">{session.message}</Notice> : null}
      </form>
    );
  }
  return (
    <div className="grid gap-3 sm:max-w-sm">
      <CardBalance
        session={session}
        kusd={kusd}
        emptyText={
          card.frozenAt
            ? "Frozen: its balance was moved back to your account. Top it up to use it again."
            : "Empty. Top it up to use it."
        }
      />
      {ready && held > 0n ? (
        <>
          <Button variant="danger" onClick={() => void moveBack()} busy={freeze.busy}>
            <Snowflake aria-hidden className="h-4 w-4" /> Freeze: move ${formatAmount(held)} back
          </Button>
          <p className="text-sm text-ink-3">
            For a lost card or a forgotten PIN. The card stays usable if you top it up again. Your
            wallet pays the network fee.
          </p>
        </>
      ) : null}
      <ProofProgress
        stage={freeze.stage}
        startedAt={freeze.startedAt}
        error={freeze.error}
        doneText="Frozen. The balance is back in your account."
      />
    </div>
  );
}

function CardRow({ card }: { card: CardRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <CreditCard aria-hidden className="h-5 w-5 shrink-0 text-shu" />
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{card.label}</p>
            <p className="text-xs text-ink-3">Made {relativeTime(card.createdAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {card.frozenAt ? <Badge>Frozen</Badge> : <Badge tone="ok">Live</Badge>}
          <Button
            variant="ghost"
            aria-expanded={open}
            onClick={() => {
              setOpen((o) => !o);
            }}
          >
            {open ? "Close" : "Manage"}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-4 grid gap-6 border-t border-line pt-4">
          <TopUp card={card} />
          <div className="border-t border-line pt-4">
            <OpenAndFreeze card={card} />
          </div>
          <Copyable value={cardLink(card)} label="Card link" />
        </div>
      ) : null}
    </li>
  );
}

export default function CardPage() {
  const { records } = useAccount();
  const cards = pinCards(records);
  return (
    <div>
      <PageHeader eyebrow="PIN card" title="A card and a PIN, no wallet at the till">
        Load a card with private dollars and hand it to someone, or keep it for yourself. It pays
        any Kinko checkout with the card and its PIN: Kinko pays the network fee, so no wallet is
        needed.
      </PageHeader>
      <ConnectGate what="make PIN cards">
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <Create />
          <div className="space-y-6">
            <Card>
              <SectionTitle>Your cards</SectionTitle>
              {cards.length === 0 ? (
                <EmptyState title="No cards yet">Make one to pay with a card and a PIN.</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {cards.map((c) => (
                    <CardRow key={c.address} card={c} />
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <div className="space-y-3">
                <PrivacyLine>
                  The card is a private Midnight wallet. Its balance and what it pays are never
                  public.
                </PrivacyLine>
                <PrivacyLine>
                  Its keys come from the card and the PIN together, stretched so that each wrong
                  guess costs half a second and 128 MiB of memory.
                </PrivacyLine>
                <PrivacyLine>
                  Freezing is a transfer, not a flag: the balance moves back to you, so there is
                  nothing left to steal.
                </PrivacyLine>
              </div>
            </Card>
          </div>
        </div>
      </ConnectGate>
    </div>
  );
}

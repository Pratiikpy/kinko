import { createGiftCard, decodeGiftCard, encodeGiftCard, KinkoGift } from "@kinko/kinko-pay";
import { Gift } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
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
import { useKusdTokenType } from "../../hooks/useKusd.ts";
import { latestBirth } from "../../lib/card-snapshot.ts";
import { CONTRACTS } from "../../lib/config.ts";
import {
  AMOUNT_ERROR_TEXT,
  formatAmount,
  fromHex,
  parseAmount,
  relativeTime,
} from "../../lib/format.ts";
import { callCircuit } from "../../lib/midnight/contracts.ts";
import { sendShielded, shieldedAddressOf } from "../../lib/pay.ts";
import { type GiftRecord, patch, upsert } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";

/** The link a recipient opens: the card itself is in the fragment, which never leaves the browser. */
const cardLink = (card: Pick<GiftRecord, "secret" | "issuerId" | "birth">, address: string) =>
  `${window.location.origin}/gift#${encodeGiftCard(
    { secret: card.secret, token: KinkoGift.TokenKind.KUSD, issuerId: card.issuerId },
    address,
    card.birth,
  )}`;

function Issue() {
  const { account, update, secret, balance, refreshBalance } = useAccount();
  const kusd = useKusdTokenType();
  const call = useCall();
  const [amountText, setAmountText] = useState("");
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<GiftRecord | null>(null);
  const parsed = parseAmount(amountText);
  const short = parsed.ok && balance.status === "ready" && balance.kusd < parsed.value;

  const issue = () =>
    call.run(async (onStage) => {
      if (!account || !parsed.ok || !CONTRACTS.gift || !kusd) throw new Error("Check the amount.");
      const issuerSecret = await secret("issuer");
      const card = createGiftCard(issuerSecret, KinkoGift.TokenKind.KUSD);
      // Where the chain's published tree stands as the card is made, before it can be funded: the
      // recipient's wallet starts there instead of replaying the chain. Without it, it still opens.
      const birth = await latestBirth();
      // Register first, so a recipient can verify the card the moment it is funded.
      await callCircuit(
        account,
        "gift",
        CONTRACTS.gift,
        { cardSecret: fromHex(card.secret), issuerSecret },
        "issue",
        [KinkoGift.TokenKind.KUSD],
        onStage,
      );
      const record: GiftRecord = {
        commitment: card.commitment,
        secret: card.secret,
        issuerId: card.issuerId,
        amount: parsed.value.toString(),
        role: "issued",
        label: label.trim() || "Gift card",
        createdAt: Date.now(),
        ...(birth ? { birth } : {}),
      };
      await update((doc) => upsert(doc, "gifts", record));
      onStage("balancing");
      await sendShielded(account, kusd, [
        {
          recipient: shieldedAddressOf(
            fromHex(card.coinPublicKey),
            fromHex(card.encryptionPublicKey),
          ),
          value: parsed.value,
        },
      ]);
      await update((doc) => patch(doc, "gifts", card.commitment, { fundTxId: "sent" }));
      setIssued({ ...record, fundTxId: "sent" });
      refreshBalance();
    });

  return (
    <Card>
      <SectionTitle>Issue a gift card</SectionTitle>
      <form
        className="grid gap-4 sm:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          void issue();
        }}
      >
        <TextField
          label="Amount"
          inputMode="decimal"
          placeholder="50.00"
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
        />
        <TextField
          label="Label, for you"
          placeholder="Birthday, Aiko"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
          maxLength={60}
        />
        <Button
          type="submit"
          busy={call.busy}
          disabled={!parsed.ok || short || !CONTRACTS.gift || !kusd}
        >
          Issue and fund the card
        </Button>
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="Registered and funded."
        />
      </form>
      {issued && CONTRACTS.gift ? (
        <div className="mt-6 grid gap-5 border-t border-line pt-5 md:grid-cols-[auto_1fr]">
          <QR
            value={cardLink(issued, CONTRACTS.gift)}
            label="QR code of the gift card"
            size={168}
          />
          <div className="min-w-0 space-y-3">
            <p className="tabular font-display text-3xl text-ink">
              ${formatAmount(BigInt(issued.amount))}
            </p>
            <Copyable value={cardLink(issued, CONTRACTS.gift)} label="Card link" />
            <Notice tone="warn" title="This link is the money">
              Whoever holds it can spend the card. Give it to one person, privately.
            </Notice>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Received() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const card = text.trim() ? decodeGiftCard(text.trim()) : undefined;
  return (
    <Card>
      <SectionTitle>Open a card you received</SectionTitle>
      <form
        className="grid gap-4 sm:max-w-lg"
        onSubmit={(e) => {
          e.preventDefault();
          const payload = text.trim().split("#").pop();
          if (card && payload) void navigate(`/gift#${payload}`);
        }}
      >
        <TextField
          label="Card link"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          spellCheck={false}
          autoComplete="off"
          error={text.trim() && !card ? "That is not a Kinko gift card." : null}
          hint="It opens on its own page: check it, see what it holds, spend it or keep it."
        />
        <Button type="submit" variant="secondary" disabled={!card}>
          Open the card
        </Button>
      </form>
    </Card>
  );
}

function GiftRow({ gift }: { gift: GiftRecord }) {
  const { account, update, secret } = useAccount();
  const call = useCall();
  const voidIt = () =>
    call.run(async (onStage) => {
      if (!account || !CONTRACTS.gift) throw new Error("Connect your wallet first.");
      const issuerSecret = await secret("issuer");
      await callCircuit(
        account,
        "gift",
        CONTRACTS.gift,
        { cardSecret: fromHex(gift.secret), issuerSecret },
        "void_card",
        [KinkoGift.TokenKind.KUSD],
        onStage,
      );
      await update((doc) => patch(doc, "gifts", gift.commitment, { voided: true }));
    });
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Gift aria-hidden className="h-5 w-5 shrink-0 text-shu" />
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{gift.label}</p>
            <p className="text-xs text-ink-3">
              {gift.role === "issued" ? "Issued" : "Received"} {relativeTime(gift.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {gift.role === "issued" ? (
            <span className="tabular font-semibold text-ink">
              ${formatAmount(BigInt(gift.amount))}
            </span>
          ) : null}
          {gift.voided ? (
            <Badge>Void</Badge>
          ) : gift.role === "issued" && !gift.fundTxId ? (
            <Badge tone="warn">Not funded</Badge>
          ) : (
            <Badge tone="ok">Live</Badge>
          )}
          {gift.role === "issued" && !gift.voided ? (
            <Button variant="ghost" onClick={() => void voidIt()} busy={call.busy}>
              Void
            </Button>
          ) : null}
        </div>
      </div>
      {CONTRACTS.gift && !gift.voided ? (
        <Copyable className="mt-2" value={cardLink(gift, CONTRACTS.gift)} label="Card link" />
      ) : null}
      {call.stage !== "idle" ? (
        <div className="mt-2">
          <ProofProgress
            stage={call.stage}
            startedAt={call.startedAt}
            error={call.error}
            doneText="Voided. The card now fails verification."
          />
        </div>
      ) : null}
    </li>
  );
}

export default function Gifts() {
  return (
    <div>
      <PageHeader eyebrow="Gift cards" title="Private dollars, handed over as a link">
        A gift card is a link that holds private dollars. The recipient can spend it at any Kinko
        checkout without a wallet, or keep it in their own account. Anyone can check it is genuine;
        nobody can see what it holds.
      </PageHeader>
      <ContractNotice contracts={["gift"]} />
      <ConnectGate what="issue and check gift cards">
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            <Issue />
            <Received />
          </div>
          <div className="space-y-6">
            <MineList />
            <Card>
              <div className="space-y-3">
                <PrivacyLine>
                  The registry stores a commitment per card, not its value. Amounts are never on
                  chain.
                </PrivacyLine>
                <PrivacyLine>
                  A card is a Midnight wallet: its recovery phrase opens it in any Midnight wallet
                  too.
                </PrivacyLine>
                <PrivacyLine>
                  Only the issuer can void a card; a recipient can verify the issuer's public id.
                </PrivacyLine>
              </div>
            </Card>
          </div>
        </div>
      </ConnectGate>
    </div>
  );
}

function MineList() {
  const { records } = useAccount();
  const list = records?.gifts ?? [];
  return (
    <Card>
      <SectionTitle>Your cards</SectionTitle>
      {list.length === 0 ? (
        <EmptyState title="No cards yet">Cards you issue or keep appear here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((g) => (
            <GiftRow key={g.commitment} gift={g} />
          ))}
        </ul>
      )}
    </Card>
  );
}

import { encodeRefundCode } from "@kinko/kinko-pay";
import { CheckCircle2, CreditCard } from "lucide-react";
import { useState } from "react";

import { useCall } from "../hooks/useCall.ts";
import { useCardWallet } from "../hooks/useCardWallet.ts";
import { cardAccount, defaultFees } from "../lib/card.ts";
import { formatAmount, fromHex, toHex } from "../lib/format.ts";
import { type ParsedLink, payInvoice } from "../lib/pay.ts";
import type { PaymentQuote } from "../lib/quote.ts";
import { useAccount } from "../state/account.tsx";
import { CardBalance, CardUnlock } from "./CardUnlock.tsx";
import { ProofProgress } from "./ProofProgress.tsx";
import { Button, Copyable, Notice } from "./ui.tsx";

/**
 * Pay an invoice from a Kinko card: a gift card, a PIN card, or a card's
 * recovery phrase. No wallet is needed when Kinko's sponsor pays the fee; a
 * connected wallet pays it otherwise.
 */
export function PayWithCard({
  link,
  kusdColor,
  due,
  freshQuote,
  payable,
  onPaid,
}: {
  link: ParsedLink;
  /** KUSD's colour, once the invoice's contract has been read. */
  kusdColor: Uint8Array | null;
  /** What paying costs in KUSD; null while a NIGHT price is being read. */
  due: bigint | null;
  /** For a NIGHT-priced invoice: fetches the oracle's signed price right before paying. */
  freshQuote?: () => Promise<PaymentQuote>;
  payable: boolean;
  onPaid: () => void;
}) {
  const { account } = useAccount();
  const { session, open, close } = useCardWallet();
  const call = useCall();
  const [expanded, setExpanded] = useState(false);
  const [paid, setPaid] = useState<{ receipt: string; refundCode: string } | null>(null);
  const { terms, contractAddress, payoutEncryptionKey } = link;

  const fees = defaultFees(account);
  const ready = session.status === "ready" ? session : null;
  const tokenType = kusdColor ? toHex(kusdColor) : null;
  const balance = ready && tokenType ? (ready.state.balances[tokenType] ?? 0n) : 0n;
  // While a payment is in flight the card's coin is pending, so its spendable balance reads
  // lower than it is. Judge the balance only before paying or after a failure.
  const paying = call.stage !== "idle" && call.stage !== "failed";
  const short = ready !== null && !paying && due !== null && balance < due;

  const pay = () =>
    call.run(async (onStage) => {
      if (!ready || !kusdColor || !payoutEncryptionKey) throw new Error("Open the card first.");
      const card = cardAccount(ready.wallet, "settle_invoice");
      const out = await payInvoice({
        account: card,
        payAddress: contractAddress,
        terms,
        payoutEncryptionKey,
        kusdColor,
        quote: freshQuote ? await freshQuote() : undefined,
        onStage,
      });
      setPaid({
        receipt: out.receipt,
        // A refund goes back to the card, so the code names the card's key.
        refundCode: encodeRefundCode(
          { payerKey: fromHex(out.payerKey), refundTo: fromHex(out.refundTo), index: out.index },
          fromHex(card.encryptionPublicKey),
        ),
      });
      onPaid();
    });

  // Once the invoice is paid, the panel stays only for the payment made from it, to keep its
  // receipt on screen.
  if (!payable && !paid && call.stage !== "done") return null;
  if (!expanded) {
    return (
      <button
        type="button"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-shu-ink hover:underline"
        onClick={() => {
          setExpanded(true);
        }}
      >
        <CreditCard aria-hidden className="h-4 w-4" /> Pay with a Kinko card instead
      </button>
    );
  }

  return (
    <section
      className="space-y-4 rounded-2xl border border-line p-5"
      aria-labelledby="pay-with-card-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="pay-with-card-title" className="font-semibold text-ink">
          Pay with a Kinko card
        </h3>
        <button
          type="button"
          className="min-h-11 px-2 text-sm text-ink-3 hover:text-ink"
          onClick={() => {
            close();
            setExpanded(false);
          }}
        >
          Close
        </button>
      </div>
      {paid ? (
        <div className="rounded-2xl border border-ok/30 bg-ok-soft p-5">
          <p className="flex items-center gap-2 font-semibold text-ok">
            <CheckCircle2 aria-hidden className="h-5 w-5" /> Paid from the card
          </p>
          <p className="mt-2 text-sm text-ink-2">
            Keep the receipt: it proves this one payment and nothing else. A refund returns to the
            card.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Copyable value={paid.receipt} label="Receipt" />
            <Copyable value={paid.refundCode} label="Refund code" />
          </div>
        </div>
      ) : !fees ? (
        <Notice tone="warn" title="Connect a wallet to pay the network fee">
          This build has no fee sponsor, so the card's network fee is paid by a connected wallet.
        </Notice>
      ) : (
        <>
          {session.status === "closed" ||
          session.status === "error" ||
          session.status === "unlocking" ? (
            <CardUnlock session={session} onOpen={(input, pin) => void open(input, fees, pin)} />
          ) : null}
          {paying ? null : <CardBalance session={session} kusd={tokenType} />}
          {ready ? (
            <div className="space-y-3">
              {short ? (
                <Notice tone="warn" title="The card does not cover this invoice">
                  It holds ${formatAmount(balance)}. If this is a PIN card, check the PIN: a wrong
                  PIN opens an empty card.
                </Notice>
              ) : null}
              <Button
                onClick={() => void pay()}
                busy={call.busy}
                disabled={!payable || short || due === null || call.stage === "done"}
                className="w-full sm:w-auto"
              >
                Pay ${due === null ? "…" : formatAmount(due)} from the card
              </Button>
              <p className="text-sm text-ink-3">
                {fees.kind === "sponsor"
                  ? "Kinko pays the network fee. You need no wallet."
                  : "Your connected wallet pays the network fee."}
              </p>
              <ProofProgress
                stage={call.stage}
                startedAt={call.startedAt}
                error={call.error}
                doneText="Paid. The merchant receives the coin directly."
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

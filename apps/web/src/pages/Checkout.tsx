import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { InvoicePayment } from "../components/InvoicePayment.tsx";
import { Seal } from "../components/Logo.tsx";
import { Card, EmptyState } from "../components/ui.tsx";
import { parsePaymentLink } from "../lib/pay.ts";
import { type PublicSession, readSession, SessionStatus } from "../lib/session.ts";

/** A merchant checkout session as this page knows it. */
type SessionState =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly session: PublicSession }
  | { readonly kind: "error"; readonly message: string };

const STATUS_TEXT: Record<SessionStatus, string> = {
  [SessionStatus.Draft]: "The merchant has not finished creating this invoice yet.",
  [SessionStatus.Pending]: "Waiting for payment.",
  [SessionStatus.Settled]: "Paid. The merchant has been notified.",
  [SessionStatus.Cancelled]: "The merchant cancelled this checkout.",
  [SessionStatus.Expired]: "This checkout has expired.",
};

function SessionHeader({ state, paidOnChain }: { state: SessionState; paidOnChain: boolean }) {
  if (state.kind === "none") return null;
  if (state.kind === "loading") {
    return <p className="mb-4 text-center text-sm text-ink-3">Reading the checkout session…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="mb-4 text-center text-sm text-bad" role="alert">
        {state.message}
      </p>
    );
  }
  const s = state.session;
  return (
    <div className="mb-4 text-center">
      <p className="text-sm text-ink-3">Paying {s.merchantName}</p>
      {s.title ? <p className="font-display text-xl text-ink">{s.title}</p> : null}
      <p className="mt-1 text-sm text-ink-2" role="status">
        {s.status === SessionStatus.Pending && paidOnChain
          ? "Paid. The merchant is being notified."
          : STATUS_TEXT[s.status]}
      </p>
      {s.status === SessionStatus.Settled && s.successUrl ? (
        <a
          href={s.successUrl}
          className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-shu-ink hover:underline"
        >
          Return to {s.merchantName}
        </a>
      ) : null}
    </div>
  );
}

/**
 * The page a merchant sends customers to. The invoice terms are in the link's
 * fragment and never leave the browser; status is read from the chain every
 * few seconds, so the customer and the merchant both see the payment land
 * without a refresh. A link from a merchant's checkout system also names a
 * session, read from Kinko's merchant backend for its label and status.
 */
export default function Checkout() {
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const sessionId = params.get("session");
  const [fragment, setFragment] = useState(hash.slice(1));
  const [session, setSession] = useState<SessionState>({ kind: "none" });
  // The chain is the authority on payment; the merchant backend learns of it a
  // moment later. Once the chain shows it paid, say so, and ask the backend again.
  const [paidOnChain, setPaidOnChain] = useState(false);
  const [reload, setReload] = useState(0);
  const onPaid = useCallback(() => {
    setPaidOnChain((was) => {
      if (!was) setReload((n) => n + 1);
      return true;
    });
  }, []);
  useEffect(() => {
    setFragment(hash.slice(1));
  }, [hash]);

  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const s = await readSession(sessionId, abort.signal);
        setSession({ kind: "ready", session: s });
      } catch (e) {
        if (abort.signal.aborted) return;
        setSession({
          kind: "error",
          message: e instanceof Error ? e.message : "Unreadable session.",
        });
      }
    };
    if (reload === 0) setSession({ kind: "loading" });
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [sessionId, reload]);

  const link = fragment ? parsePaymentLink(fragment) : null;
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-center gap-2 text-sm text-ink-3">
        <Seal size={22} /> Private checkout by Kinko
      </div>
      <SessionHeader state={session} paidOnChain={paidOnChain} />
      {link ? (
        <Card className="p-6 sm:p-8">
          <InvoicePayment link={link} live onPaid={onPaid} />
        </Card>
      ) : (
        <EmptyState
          main
          title="This checkout link is incomplete"
          action={
            <Link
              to="/"
              className="inline-flex min-h-11 items-center text-sm font-semibold text-shu-ink hover:underline"
            >
              What is Kinko?
            </Link>
          }
        >
          Ask the merchant for the full link. Everything after the # is needed, and it is never sent
          to any server.
        </EmptyState>
      )}
      <p className="mt-6 text-center text-xs text-ink-3">
        The amount and the parties to this payment are not recorded on any public ledger.
      </p>
    </div>
  );
}

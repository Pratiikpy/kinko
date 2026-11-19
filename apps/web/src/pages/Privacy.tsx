import { Link } from "react-router-dom";

import { Prose } from "../components/Prose.tsx";
import { Card, PageHeader } from "../components/ui.tsx";

const ROWS: [string, string][] = [
  [
    "Each USDC deposit on Ethereum: the sending address and the amount",
    "Who holds KUSD on Midnight, and how much",
  ],
  [
    "Each withdrawal on Ethereum: the receiving address and the amount",
    "Every payment between people: amount, payer, payee",
  ],
  [
    "Each KUSD mint and burn amount, so the total in circulation",
    "Invoice terms, merchants and payers",
  ],
  ["The vault's USDC balance", "Which payments reached which @tag"],
  ["Tag names and the receiving keys behind them", "Payroll files and batch payment lists"],
  ["Invoice status and the number of payments, never amounts", "Gift card and PIN card values"],
  [
    "Disclosure log entries: case, scope hash, examiner, time",
    "The contents of any sealed record, until two keyholders approve",
  ],
];

export default function Privacy() {
  return (
    <div>
      <PageHeader
        eyebrow="Privacy and limits"
        title="What is public, what is private, and what Kinko does not promise"
      >
        A privacy product that does not say precisely what it hides is asking to be taken on faith.
        This page is the full statement.
      </PageHeader>
      <Card className="overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="px-5 py-3 font-display text-base font-semibold text-ink">
                Public
              </th>
              <th
                scope="col"
                className="px-5 py-3 font-display text-base font-semibold text-shu-ink"
              >
                Private
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ROWS.map(([pub, priv]) => (
              <tr key={pub}>
                <td className="px-5 py-3 align-top text-ink-2">{pub}</td>
                <td className="px-5 py-3 align-top text-ink-2">{priv}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Prose>
        <h2>Stated limits</h2>
        <h3>The way in and the way out are visible</h3>
        <p>
          Deposits and withdrawals happen on Ethereum, where everything is public. If you deposit
          1,000 USDC from your everyday address and later withdraw exactly 1,000 to the same
          address, an observer can guess they are linked. Privacy covers what happens between them.
          Withdrawing to a fresh address, at a different time or in different amounts, weakens that
          guess.
        </p>
        <h3>Total supply is public</h3>
        <p>
          The total KUSD minted and burned is public on Midnight. That is what lets anyone check the
          backing. Individual balances are not.
        </p>
        <h3>The vault's key is held by Sig Network's signers</h3>
        <p>
          The vault's Ethereum account is controlled by Sig Network's MPC signers jointly; no single
          party holds its key. You trust that enough of them will not collude. If they did, the
          backing page would show the USDC leaving within a block, but it could not stop it.
        </p>
        <h3>USDC is issued by Circle</h3>
        <p>
          Kinko's dollars are exactly as good as the USDC behind them, including Circle's ability to
          freeze addresses.
        </p>
        <h3>Deposits and withdrawals take several steps on two chains</h3>
        <p>
          A deposit is two transfers on Ethereum (the USDC, and a little ETH for the sweep's gas)
          and two signatures on Midnight; a withdrawal is two signatures. In between, a series of
          permissionless steps is carried by the relayer. It is not instant, and the app shows every
          step.
        </p>
        <h3>Your device keeps your records</h3>
        <p>
          Invoice owner secrets, receipts and card secrets live encrypted in your browser. If you
          lose that browser's data without a backup, you lose the ability to cancel or refund those
          invoices or to prove those payments. Your balance is not affected: it is held by your
          wallet.
        </p>
        <h3>The software is experimental</h3>
        <p>
          The vault, NightKit and Kinko's contracts are marked experimental by their authors and run
          on test networks. Do not use them with money you cannot afford to lose.
        </p>

        <h2>What this site collects</h2>
        <p>
          Nothing. There are no analytics, no cookies and no account on our side. Payment links
          carry their terms after the <code>#</code>, which your browser never sends to a server.
          The only network calls are to the Midnight indexer and node, the Ethereum RPC, and the
          relayer, backend, fee sponsor, card snapshot service, proof server and NightKit vault
          named in <Link to="/app/settings">Settings</Link>, and to your own wallet. None is given a
          key; the snapshot service sees when a card is made and opened, and the relayer sees the
          addresses it carries.
        </p>
      </Prose>
    </div>
  );
}

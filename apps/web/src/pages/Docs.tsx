import { Link } from "react-router-dom";

import { Prose, Toc } from "../components/Prose.tsx";
import { PageHeader } from "../components/ui.tsx";

const SECTIONS = [
  { id: "start", label: "Open an account" },
  { id: "add", label: "Add dollars" },
  { id: "pay", label: "Pay" },
  { id: "request", label: "Request and invoices" },
  { id: "batch", label: "Batch pay" },
  { id: "cards", label: "Gift cards and PIN cards" },
  { id: "receipts", label: "Receipts" },
  { id: "withdraw", label: "Withdraw" },
  { id: "backing", label: "Check the backing" },
  { id: "examine", label: "Examination" },
  { id: "recovery", label: "When something stops" },
  { id: "records", label: "Your records" },
];

export default function Docs() {
  return (
    <div>
      <PageHeader eyebrow="Docs" title="How to use Kinko">
        Every instruction here matches what the app does, in the order it does it.
      </PageHeader>
      <div className="grid gap-10 xl:grid-cols-[1fr_14rem]">
        <Prose>
          <h2 id="start">Open an account</h2>
          <p>
            Press <strong>Connect</strong>. Choose a Midnight wallet (such as 1AM) if you have one,
            or choose MetaMask, Phantom, Coinbase Wallet or another Ethereum or Solana wallet. With
            the second kind, NightKit asks your wallet for one signature and opens a Midnight
            account from it, inside a vault served from a separate site that this page cannot read.
            Signing in again with the same wallet opens the same account.
          </p>
          <p>
            A new account syncs with the network the first time. Addresses work immediately;
            balances and sending wait for the sync.
          </p>

          <h2 id="add">Add dollars</h2>
          <ol>
            <li>
              Open <Link to="/app/add">Add dollars</Link>, enter an amount and press{" "}
              <strong>Get my deposit address</strong>. The address is derived by Sig Network's
              signers from your private identity; nobody holds its key.
            </li>
            <li>
              Send the USDC to that address, and a little ETH for the gas of the sweep into the
              vault. Connect your Ethereum wallet on the page to do both with two buttons, or send
              from anywhere else.
            </li>
            <li>
              When both are there, press <strong>Start the deposit</strong> and approve in your
              Midnight wallet.
            </li>
            <li>
              The relayer carries the request: it moves the vault queue, has the signers sign the
              sweep, broadcasts it on Ethereum and brings the signers' attestation back to Midnight.
              Each step shows on the page as it happens.
            </li>
            <li>
              Press <strong>Receive</strong> and approve once more. The vault mints the same amount
              of KUSD to your shielded address.
            </li>
          </ol>
          <p>
            You can close the tab at any point. The request is saved, encrypted, on your device, and
            the page continues from where it stopped.
          </p>

          <h2 id="pay">Pay</h2>
          <p>
            On <Link to="/app/pay">Pay</Link>, type a <code>@tag</code>, paste a Midnight shielded
            address, or paste a payment link. A tag is looked up in the public registry and paid at
            the keys its owner registered. A link opens the invoice it describes, with its live
            status. Opening a link at <code>/pay#…</code> fills this in for you.
          </p>

          <h2 id="request">Request and invoices</h2>
          <p>
            On <Link to="/app/request">Request</Link>, give a title and an amount and choose who
            pays: one payment, many payers, or donations. Creating it puts a commitment on chain and
            gives you a link, a QR code and a hosted checkout page. The terms travel in the link's
            fragment, the part after <code>#</code>, which browsers never send to any server.
          </p>
          <p>
            <Link to="/app/invoices">Invoices</Link> lists what you issued with its live status.
            From an invoice you can close a multi-payer invoice to new payments, cancel an unpaid
            one, or refund a payment when its payer sends you their refund code.
          </p>

          <h2 id="batch">Batch pay</h2>
          <p>
            On <Link to="/app/batch">Batch pay</Link>, choose or paste a CSV with one payment per
            line: recipient (a <code>@tag</code> or shielded address), amount, and an optional note.
            Every line is checked on your device and every tag resolved before you pay. Payments are
            sent as shielded transfers, several per transaction.
          </p>

          <h2 id="cards">Gift cards and PIN cards</h2>
          <p>
            A <Link to="/app/gifts">gift card</Link> is a link that holds private dollars. Issuing
            registers the card's commitment and sends the dollars to the card's own wallet. The link
            is the money: give it to one person. Opening it shows, with no wallet, whether the card
            is genuine and what it holds. The recipient can spend it at any Kinko checkout, or move
            it into their own account.
          </p>
          <p>
            A <Link to="/app/card">PIN card</Link> works the same way, except that its wallet needs
            the card and its PIN together, so the printed card alone opens nothing. At any invoice
            or checkout, choose <strong>Pay with a Kinko card</strong>, paste the card's link and
            type the PIN: Kinko pays the network fee, so no wallet is needed. A lost card is frozen
            by moving its balance back to your account.
          </p>
          <p>
            Every card is a Midnight wallet. Its 24-word recovery phrase, shown on the card's page,
            opens it in any Midnight wallet too.
          </p>
          <p>
            A card opens in seconds because it never reads the chain's history from before it was
            made. Its link carries a birth, the point the chain had reached when the card was made,
            and the card's wallet starts from Kinko's published copy of the chain's tree at that
            point. The copy is public data and holds no key and no coin. If it does not match the
            chain, the card ignores it and reads the whole history instead, which takes longer. A
            recovery phrase carries no birth by itself: the card's page shows the birth beside the
            phrase, and a phrase pasted with its birth after it opens the same fast way. A phrase
            pasted alone reads the whole history.
          </p>

          <h2 id="receipts">Receipts</h2>
          <p>
            Paying an invoice leaves a receipt digest on chain. On{" "}
            <Link to="/app/receipts">Receipts</Link>, press <strong>Prove</strong> to get a link for
            one payment. Whoever opens it at <Link to="/verify">/verify</Link> sees that payment,
            its amount and the invoice it paid, checked against the chain, and nothing else about
            you.
          </p>

          <h2 id="withdraw">Withdraw</h2>
          <p>
            On <Link to="/app/withdraw">Withdraw</Link>, enter an amount and an Ethereum address.
            The vault's flat fee is read from the chain and shown before you sign. Your KUSD is
            burned at the start; the relayer carries the request; you close it with one more
            signature. If the Ethereum transfer fails, closing it mints your KUSD back.
          </p>

          <h2 id="backing">Check the backing</h2>
          <p>
            <Link to="/backing">Backing</Link> needs no wallet. It reads the vault's USDC balance
            from Ethereum and the KUSD minted and burned from Midnight, in your browser, and
            compares them. It also shows the relayer's report and says which figures it used.
          </p>

          <h2 id="examine">Examination</h2>
          <p>
            On <Link to="/examine">Examine</Link>, account holders file sealed statements; a
            registered examiner opens a case naming up to four of them; two of three keyholders
            approve; the examiner opens exactly those records in the browser, each checked against
            its anchor. Anyone can read the log of every step.
          </p>

          <h2 id="recovery">When something stops</h2>
          <ul>
            <li>
              <strong>The relayer is down.</strong> Requests already started are safe on Midnight.
              The page says so and resumes when it is back; any relayer can carry a request.
            </li>
            <li>
              <strong>The relayer reports a failure.</strong> Press <strong>Ask it to retry</strong>
              . The request id is fixed by the chain, so retrying cannot duplicate anything.
            </li>
            <li>
              <strong>The Ethereum transfer failed.</strong> The signers attest it. A deposit then
              closes with nothing minted; a withdrawal closes with your KUSD minted back.
            </li>
            <li>
              <strong>You declined in your wallet.</strong> Nothing was sent. Press the button again
              when ready.
            </li>
            <li>
              <strong>A contract refused.</strong> The page shows the contract's own reason, such as
              "invoice is not open". Nothing was submitted.
            </li>
          </ul>

          <h2 id="records">Your records</h2>
          <p>
            What only your device knows (invoice owner secrets, receipts, card secrets, tag
            ownership, requests in flight) is kept encrypted in this browser. With a NightKit
            account the key is derived from your account; with another wallet it is a key this
            browser keeps and cannot export. Make a backup in{" "}
            <Link to="/app/settings">Settings</Link> and store it like a password.
          </p>
        </Prose>
        <Toc items={SECTIONS} />
      </div>
    </div>
  );
}

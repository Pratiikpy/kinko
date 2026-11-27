import { Link } from "react-router-dom";

import { Prose, Toc } from "../components/Prose.tsx";
import { PageHeader } from "../components/ui.tsx";

const SECTIONS = [
  { id: "why-usdc", label: "Why it starts with USDC" },
  { id: "who", label: "Who it is for" },
  { id: "next", label: "What comes next" },
];

export default function Vision() {
  return (
    <div>
      <PageHeader eyebrow="Vision" title="Private payments, public reserves">
        A dollar account where the money can be counted by anyone and the payments seen by no one
        who is not shown them.
      </PageHeader>
      <div className="grid gap-10 xl:grid-cols-[1fr_14rem]">
        <Prose>
          <p>
            On a public chain, paying someone publishes it: a salary, a supplier's price, a customer
            list. The privacy tools people use to avoid that have their own problem, which is
            knowing the money is really there. Unbacked minting has broken stablecoins before. When
            FTX failed, the customers among the first to get their money back were those whose funds
            were held separately, at FTX Japan.
          </p>
          <p>
            Kinko puts both rules in code. Payments are private by default. The reserve is public by
            default. Neither depends on trusting us.
          </p>

          <h2 id="why-usdc">Why it starts with USDC</h2>
          <p>
            People do not move to a new chain to get privacy; they pay to make the assets they
            already hold private. Kinko takes the USDC you already have on Ethereum, keeps it in a
            vault anyone can inspect, and gives you the same amount as a private dollar on Midnight.
            Out is as easy as in.
          </p>

          <h2 id="who">Who it is for</h2>
          <ul>
            <li>A business paying contractors and staff, whose payroll should not be public.</li>
            <li>
              A freelancer or merchant, whose income from one client should not reveal another.
            </li>
            <li>
              An accountant, auditor or regulator, who needs exactly the records in one case, with
              every opening logged.
            </li>
            <li>
              An agent buying services, whose purchases should not reveal its owner's strategy.
            </li>
          </ul>

          <h2 id="next">What comes next</h2>
          <ul>
            <li>
              <strong>Public networks.</strong> Midnight's preprod with Ethereum Sepolia now, where
              Sig Network's test signers run; mainnet when Night Mode opens there.
            </li>
            <li>
              <strong>Fees paid for you, everywhere.</strong> A sponsor already covers the Midnight
              fees of a card paying an invoice, so that holder needs no wallet or DUST; the same for
              every action a new account takes is still to come.
            </li>
            <li>
              <strong>Earning on idle balance.</strong> The vault can already lend USDC on Aave;
              Kinko will offer it privately.
            </li>
            <li>
              <strong>Statements.</strong> Prove totals received or paid over a period without
              listing each payment.
            </li>
            <li>
              <strong>A clean-funds check at deposit</strong>, proving the depositing address is not
              on a published list, with the list's provider named.
            </li>
            <li>
              <strong>More stablecoins and networks</strong> as Night Mode adds them, and private
              swaps between them through the vault.
            </li>
          </ul>
          <p>
            What Kinko does and does not protect today is stated in full on{" "}
            <Link to="/privacy">Privacy and limits</Link>.
          </p>
        </Prose>
        <Toc items={SECTIONS} />
      </div>
    </div>
  );
}

import { Code, Prose, Toc } from "../components/Prose.tsx";
import { PageHeader } from "../components/ui.tsx";
import { SOURCE_URL } from "../lib/config.ts";
import { relayer } from "../lib/relayer.ts";

const SECTIONS = [
  { id: "parts", label: "The parts" },
  { id: "contracts", label: "Contract surface" },
  { id: "invoice", label: "Create a payment link" },
  { id: "verify", label: "Verify a receipt" },
  { id: "tags", label: "Resolve a tag" },
  { id: "relayer", label: "Relayer API" },
  { id: "backing", label: "Read the backing" },
  { id: "examiner", label: "Open a case" },
];

export default function Developer() {
  const base = relayer?.baseUrl ?? "<relayer>";
  return (
    <div>
      <PageHeader eyebrow="Developers" title="Build on Kinko">
        The contracts' TypeScript surface runs unchanged in a browser or a server. Every digest it
        returns comes from the contracts' own compiled circuits. The full source, the deployed
        addresses and how to run it are{" "}
        <a
          className="font-medium text-shu-ink hover:underline"
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
        >
          on GitHub
        </a>
        .
      </PageHeader>
      <div className="grid gap-10 xl:grid-cols-[1fr_14rem]">
        <Prose>
          <h2 id="parts">The parts</h2>
          <ul>
            <li>
              <strong>Vault</strong> (Sig Network's ERC20 vault): owns an Ethereum account through
              MPC, mints KUSD on an attested USDC deposit, burns it on withdrawal.
            </li>
            <li>
              <strong>kinko_pay</strong>: invoices (standard, multi-payer, donation), shielded
              settlement, receipts, refunds, revenue attestations, batch settlement.
            </li>
            <li>
              <strong>kinko_tags</strong>: <code>@name</code> to receiving keys.{" "}
              <strong>kinko_gift</strong>: the gift card registry.
            </li>
            <li>
              <strong>Card wallets</strong> (<code>@kinko/card</code>): a gift card or PIN card is a
              Midnight wallet opened from the card. It spends with real proofs and hands its fee to
              a payer.
            </li>
            <li>
              <strong>Fee sponsor</strong>: pays the network fee when a card pays an invoice, for
              that call only, under a budget and a rate limit.
            </li>
            <li>
              <strong>kinko_disclosure</strong>: sealed statements, examiner cases, two-of-three
              approval and the disclosure log.
            </li>
            <li>
              <strong>Relayer</strong>: carries vault requests through their permissionless steps.
              It holds no user key.
            </li>
          </ul>

          <h2 id="contracts">Contract surface</h2>
          <p>
            <code>@kinko/kinko-pay</code> exports the three compiled contracts as namespaces (
            <code>KinkoPay</code>, <code>KinkoTags</code>, <code>KinkoGift</code>), their witnesses,
            and helpers for links, tags and cards. <code>@kinko/kinko-disclosure</code> exports the
            disclosure contract, the sealing codec and the examiner's opening procedure.
          </p>

          <h2 id="invoice">Create a payment link</h2>
          <p>
            Draw fresh secrets, call <code>create_invoice</code> with them in private state, and put
            the terms in a link fragment. The terms carry the public tag of your owner secret, which
            is part of the commitment: anyone who sees the link can pay it, but only you can publish
            the invoice it names.
          </p>
          <Code>{`import {
  encodePaymentLink, invoiceCommitmentOf, KinkoPay, newInvoiceSecrets, ownerTagOf,
} from "@kinko/kinko-pay";

const { salt, ownerSecret } = newInvoiceSecrets();   // ownerSecret never leaves you
const terms = {
  merchantKey, payout: myCoinPublicKey, amount: 1_250_000_000n,   // $1,250.00
  kind: KinkoPay.InvoiceKind.STANDARD, token: KinkoPay.TokenKind.KUSD,
  salt, expiresAt: 0n,
  owner: ownerTagOf(ownerSecret),   // public: it is in the commitment, so only you can publish this invoice
};
// callTx.create_invoice(kind, token, expiresAt) with terms + ownerSecret as private state
const commitment = invoiceCommitmentOf(terms);       // what the ledger keys it by
// The payout wallet's encryption key lets the payer's wallet encrypt the coin to you.
const link = \`\${appOrigin}/pay#\${encodePaymentLink(terms, payContractAddress, payoutEncryptionKey)}\`;`}</Code>

          <h2 id="verify">Verify a receipt</h2>
          <p>
            A payer's proof carries the terms and their per-payment secrets. Recompute and look it
            up:
          </p>
          <Code>{`import { invoiceCommitmentOf, KinkoPay, receiptOf } from "@kinko/kinko-pay";
import { ContractState } from "@midnight-ntwrk/compact-runtime";

const commitment = invoiceCommitmentOf(terms);
const receipt = receiptOf(commitment, terms.kind, { payerKey, refundTo, refundEnc, index });
const read = await publicData.queryContractState(payAddress);
const ledger = KinkoPay.ledger(read.contractState.deserialize({ v9: ContractState }).data);
const paid = ledger.receipts.member(receipt);`}</Code>

          <h2 id="tags">Resolve a tag</h2>
          <Code>{`import { KinkoTags, resolveTag } from "@kinko/kinko-pay";
import { ContractState } from "@midnight-ntwrk/compact-runtime";

const read = await publicData.queryContractState(tagsAddress);
const ledger = KinkoTags.ledger(read.contractState.deserialize({ v9: ContractState }).data);
const to = resolveTag(ledger, "@aiko_design");   // { coinPublicKey, encryptionPublicKey } or undefined`}</Code>

          <h2 id="relayer">Relayer API</h2>
          <p>All responses are JSON. Amounts are decimal strings of base units (six decimals).</p>
          <Code>{`GET  ${base}/health
     → { ok, network, vaultContractAddress, evmVaultAddress, usdcAddress, evmChainId }

GET  ${base}/deposit-address?commitment=<64 hex>
     → { evmAddress }                      # derived from your identity commitment

POST ${base}/requests   { "kind": "deposit" | "withdraw", "requestId": "<64 hex>" }
     → 202 { requestId }                   # idempotent: the id is fixed by the chain

GET  ${base}/requests/<requestId>
     → { kind, stage, evmTxHash?, error?, updatedAt }
       stage: queued | flushed | sent | signed | broadcast | attested | ready | completed | failed

GET  ${base}/backing
     → { usdcInVault, kusdMinted, kusdBurned, vaultContractAddress, evmVaultAddress,
         usdcAddress, ethereumBlock, midnightBlock, updatedAt }`}</Code>
          <p>
            A deposit's request id can be computed before anything is flushed, from the sweep the
            vault will compose. A withdrawal's id covers the vault nonce its flush assigns, so a
            client reads it from the vault ledger after the flush and registers it then.
          </p>

          <h2 id="backing">Read the backing</h2>
          <Code>{`# USDC held by the vault on Ethereum
cast call <usdc> "balanceOf(address)(uint256)" <evmVaultAddress> --rpc-url <rpc>

# KUSD minted and burned, from the vault's own ledger
import { readVaultLedger, evmAddressBytes } from "@sig-net/midnight-examples-erc20-vault-contract";
const tally = (await readVaultLedger(publicData, vault)).supplyTally.lookup(evmAddressBytes(usdc));
const circulating = tally.minted - tally.burned;`}</Code>

          <h2 id="examiner">Open a case</h2>
          <Code>{`import { discloseCase, generateExaminerKey, ledger, readLog, verifyDeployment } from "@kinko/kinko-disclosure";
import { ContractState } from "@midnight-ntwrk/compact-runtime";

const read = await publicData.queryContractState(disclosureAddress);
const l = ledger(read.contractState.deserialize({ v9: ContractState }).data);
if (!verifyDeployment(l).ok) throw new Error("do not trust this deployment");
const { scalar, publicKey } = generateExaminerKey();   // operator registers publicKey
// callTx.open_case(publicKey, recordIds, count, expiry, nonce, now) with { scalar } as private state
const result = discloseCase(l, caseId, scalar);       // records open once two keyholders approve
const log = readLog(l);`}</Code>
        </Prose>
        <Toc items={SECTIONS} />
      </div>
    </div>
  );
}

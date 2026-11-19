import { CheckCircle2, CircleAlert, CircleHelp, RefreshCw } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  Copyable,
  ExternalA,
  Notice,
  PageHeader,
  SectionTitle,
  Skeleton,
} from "../components/ui.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { EVM_RPC_URL, MIDNIGHT_EXPLORER_URL, PUBLIC_INDEXER } from "../lib/config.ts";
import { evmTokenHolderUrl, latestBlock, usdcBalance } from "../lib/evm.ts";
import { formatAmount, relativeTime, toHex } from "../lib/format.ts";
import { publicDataProvider } from "../lib/midnight/providers.ts";
import { relayer } from "../lib/relayer.ts";
import { useDeployment } from "../state/deployment.tsx";

type Read<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string }
  | { status: "skipped"; reason: string };

const money = (v: bigint) => `$${formatAmount(v)}`;

function SourceRow({
  label,
  read,
  render,
}: {
  label: string;
  read: Read<bigint>;
  render?: (v: bigint) => string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
      <span className="text-sm text-ink-2">{label}</span>
      <span className="tabular text-sm font-semibold text-ink">
        {read.status === "ready" ? (
          (render ?? money)(read.value)
        ) : read.status === "loading" ? (
          <Skeleton className="h-4 w-24" />
        ) : read.status === "error" ? (
          <span className="font-normal text-bad">{read.message}</span>
        ) : (
          <span className="font-normal text-ink-3">{read.reason}</span>
        )}
      </span>
    </div>
  );
}

/**
 * A read's state with its value mapped, so one source's figures can be shown row by row.
 */
function toRead<T>(
  s: { status: string; value?: T; message?: string },
  pick: (v: T) => bigint,
): Read<bigint> {
  if (s.status === "ready" && s.value !== undefined)
    return { status: "ready", value: pick(s.value) };
  if (s.status === "error") return { status: "error", message: s.message ?? "Unavailable" };
  return { status: "loading" };
}

export default function Backing() {
  const { state } = useDeployment();
  const deployment = state.status === "ready" ? state.deployment : null;

  const reported = useAsync(
    async () => {
      if (!relayer) throw new Error("No relayer configured.");
      return relayer.backing();
    },
    [],
    { intervalMs: 30_000 },
  );

  const midnight = useAsync(
    async () => {
      if (!deployment) throw new Error("Vault address unknown.");
      const pdp = publicDataProvider();
      if (!pdp) throw new Error("No public indexer configured.");
      const { readVault, kusdSupply } = await import("../lib/vault.ts");
      const ledger = await readVault(pdp, deployment.vaultContractAddress);
      // The vault's own Ethereum account is named by the Midnight ledger, which is what the
      // vault's circuits release USDC from. It is the account whose balance backs the KUSD,
      // whatever address a relayer or a build file says.
      return {
        supply: kusdSupply(ledger, deployment.usdcAddress),
        evmVault: `0x${toHex(ledger.vaultEvmAddress)}`,
      };
    },
    [deployment?.vaultContractAddress, deployment?.usdcAddress],
    { intervalMs: 30_000, enabled: Boolean(deployment && PUBLIC_INDEXER) },
  );
  const ledgerEvmVault = midnight.status === "ready" ? midnight.value.evmVault : undefined;
  // A named account that is not the ledger's would make the balance below say nothing about the KUSD.
  const vaultAccountDisagrees =
    deployment !== null &&
    ledgerEvmVault !== undefined &&
    deployment.evmVaultAddress.toLowerCase() !== ledgerEvmVault.toLowerCase();

  const ethereum = useAsync(
    async () => {
      if (!deployment || !ledgerEvmVault) throw new Error("Vault address unknown.");
      const [balance, block] = await Promise.all([
        usdcBalance(deployment.usdcAddress, ledgerEvmVault),
        latestBlock(),
      ]);
      return { balance, block };
    },
    [deployment?.usdcAddress, ledgerEvmVault],
    { intervalMs: 30_000, enabled: Boolean(deployment && EVM_RPC_URL && ledgerEvmVault) },
  );

  const refresh = () => {
    reported.refresh();
    ethereum.refresh();
    midnight.refresh();
  };

  const ethRead: Read<bigint> = !EVM_RPC_URL
    ? { status: "skipped", reason: "No Ethereum RPC in this build" }
    : !deployment
      ? { status: "skipped", reason: "Vault unknown" }
      : vaultAccountDisagrees
        ? {
            status: "error",
            message:
              "The vault account this app was given is not the one the Midnight vault holds USDC in",
          }
        : toRead(ethereum, (v) => v.balance);
  const mnSupply = midnight.status === "ready" ? midnight.value.supply : null;
  const mnRead: Read<bigint> = !PUBLIC_INDEXER
    ? { status: "skipped", reason: "No public indexer in this build" }
    : !deployment
      ? { status: "skipped", reason: "Vault unknown" }
      : midnight.status === "ready" && midnight.value.supply === null
        ? { status: "skipped", reason: "The vault does not hold this token" }
        : toRead(midnight, (v) => (v.supply ? v.supply.minted - v.supply.burned : 0n));
  const rep = reported.status === "ready" ? reported.value : null;
  const repVault = toRead(reported, (v) => v.usdcInVault);
  const repCirc = toRead(reported, (v) => v.kusdMinted - v.kusdBurned);

  // The verdict uses the browser's own reads when it has them; the relayer's
  // report only fills a gap, and the page says which was used.
  const vaultHeld = ethRead.status === "ready" ? ethRead.value : rep?.usdcInVault;
  const circulating =
    mnRead.status === "ready" ? mnRead.value : rep ? rep.kusdMinted - rep.kusdBurned : undefined;
  const independent = ethRead.status === "ready" && mnRead.status === "ready";
  const verdict =
    vaultHeld === undefined || circulating === undefined
      ? "unknown"
      : vaultHeld >= circulating
        ? "backed"
        : "short";

  const disagree =
    rep &&
    ethRead.status === "ready" &&
    mnRead.status === "ready" &&
    (rep.usdcInVault !== ethRead.value || rep.kusdMinted - rep.kusdBurned !== mnRead.value);

  return (
    <div>
      <PageHeader
        eyebrow="Public · no wallet needed"
        title="Is every private dollar here?"
        actions={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw aria-hidden className="h-4 w-4" /> Read again
          </Button>
        }
      >
        Kinko's dollars are private, but their backing is not. This page reads the USDC held by the
        vault on Ethereum and the KUSD in circulation on Midnight, from your browser, and compares
        them.
        {deployment && deployment.evmChainId !== 1
          ? " On this build the USDC is Sepolia test USDC."
          : ""}
      </PageHeader>

      {state.status === "unavailable" ? (
        <div className="mb-6">
          <Notice tone="bad" title="This build cannot locate the vault">
            {state.reason}
          </Notice>
        </div>
      ) : null}

      <Card className="mb-6">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
          {verdict === "backed" ? (
            <CheckCircle2 aria-hidden className="h-10 w-10 text-ok" />
          ) : verdict === "short" ? (
            <CircleAlert aria-hidden className="h-10 w-10 text-bad" />
          ) : (
            <CircleHelp aria-hidden className="h-10 w-10 text-ink-3" />
          )}
          <div className="min-w-0 sm:flex-1">
            <p className="font-display text-2xl text-ink">
              {verdict === "backed"
                ? independent
                  ? "Fully backed"
                  : "Fully backed, by the relayer's report"
                : verdict === "short"
                  ? "The vault holds less than is in circulation"
                  : "Cannot be verified right now"}
            </p>
            <p className="mt-1 text-sm text-ink-2">
              {verdict === "unknown"
                ? "One of the two figures could not be read. Nothing is assumed in its place."
                : independent
                  ? "Both figures were read by this browser directly from the two chains."
                  : "At least one figure comes from the relayer's report, because this browser could not read that chain directly."}
            </p>
          </div>
          {verdict !== "unknown" && vaultHeld !== undefined && circulating !== undefined ? (
            <Badge tone={verdict === "backed" ? "ok" : "bad"}>
              {circulating === 0n
                ? "Nothing in circulation"
                : `${(Number((vaultHeld * 10000n) / (circulating === 0n ? 1n : circulating)) / 100).toFixed(2)}% covered`}
            </Badge>
          ) : null}
        </div>
        {disagree ? (
          <div className="mt-4">
            <Notice tone="warn" title="The relayer's report differs from the chains">
              The figures read directly from the chains are the ones that count. A difference
              usually means the report is a few blocks behind.
            </Notice>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">Ethereum</p>
          <h2 className="mt-1 font-display text-xl text-ink">USDC held by the vault</h2>
          <p className="tabular mt-3 font-display text-4xl text-ink">
            {vaultHeld !== undefined ? money(vaultHeld) : <Skeleton className="h-10 w-44" />}
          </p>
          <div className="mt-4 divide-y divide-line border-t border-line">
            <SourceRow label="Read by your browser" read={ethRead} />
            <SourceRow label="Reported by the relayer" read={repVault} />
            {ethereum.status === "ready" ? (
              <SourceRow
                label="At Ethereum block"
                read={{ status: "ready", value: ethereum.value.block }}
                render={(v) => v.toLocaleString()}
              />
            ) : null}
            {rep ? (
              <SourceRow
                label="Relayer's Ethereum block"
                read={{ status: "ready", value: BigInt(rep.ethereumBlock) }}
                render={(v) => v.toLocaleString()}
              />
            ) : null}
          </div>
          {deployment ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Copyable value={ledgerEvmVault ?? deployment.evmVaultAddress} label="Vault" />
              <Copyable value={deployment.usdcAddress} label="USDC" />
              {evmTokenHolderUrl(
                deployment.usdcAddress,
                ledgerEvmVault ?? deployment.evmVaultAddress,
              ) ? (
                <ExternalA
                  href={
                    evmTokenHolderUrl(
                      deployment.usdcAddress,
                      ledgerEvmVault ?? deployment.evmVaultAddress,
                    ) ?? undefined
                  }
                >
                  Open in the explorer
                </ExternalA>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">Midnight</p>
          <h2 className="mt-1 font-display text-xl text-ink">KUSD in circulation</h2>
          <p className="tabular mt-3 font-display text-4xl text-ink">
            {circulating !== undefined ? money(circulating) : <Skeleton className="h-10 w-44" />}
          </p>
          <div className="mt-4 divide-y divide-line border-t border-line">
            <SourceRow label="Read by your browser" read={mnRead} />
            <SourceRow label="Reported by the relayer" read={repCirc} />
            {mnSupply ? (
              <>
                <SourceRow
                  label="Minted in total"
                  read={{ status: "ready", value: mnSupply.minted }}
                />
                <SourceRow
                  label="Burned in total"
                  read={{ status: "ready", value: mnSupply.burned }}
                />
                <SourceRow
                  label="Of which fees"
                  read={{ status: "ready", value: mnSupply.feesMinted }}
                />
              </>
            ) : null}
          </div>
          {deployment ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Copyable value={deployment.vaultContractAddress} label="Vault contract" />
              {MIDNIGHT_EXPLORER_URL ? (
                <ExternalA
                  href={`${MIDNIGHT_EXPLORER_URL}/contract/${deployment.vaultContractAddress}`}
                >
                  Open in the explorer
                </ExternalA>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>

      {rep ? (
        <p className="mt-4 text-sm text-ink-3">
          Relayer report updated {relativeTime(Date.parse(rep.updatedAt))}, at Ethereum block{" "}
          {rep.ethereumBlock.toLocaleString()} and Midnight block{" "}
          {rep.midnightBlock.toLocaleString()}.
        </p>
      ) : null}

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle>What these numbers prove</SectionTitle>
          <ul className="space-y-3 text-sm leading-relaxed text-ink-2">
            <li>
              KUSD is minted only by the vault contract, and only after Sig Network's signers attest
              that USDC arrived in the vault on Ethereum. A mint without that attestation is refused
              by the contract itself.
            </li>
            <li>
              Every mint and burn is counted in the vault's public ledger. Minted minus burned is
              everything in circulation, whoever holds it.
            </li>
            <li>
              When the vault's USDC is at least that total, every private dollar can be redeemed one
              for one.
            </li>
          </ul>
        </Card>
        <Card>
          <SectionTitle>What they do not prove</SectionTitle>
          <ul className="space-y-3 text-sm leading-relaxed text-ink-2">
            <li>
              The vault's Ethereum key is held jointly by Sig Network's signers. If enough of them
              colluded they could move the USDC; this page would show it within a block.
            </li>
            <li>USDC is itself issued by Circle. Kinko's backing is exactly as good as USDC.</li>
            <li>
              Fees are minted as KUSD and stay in circulation, so they do not make the vault hold
              more. The vault can still hold more than circulates: USDC from a deposit that has not
              been completed yet, or sent to it directly. It should never hold less.
            </li>
          </ul>
        </Card>
      </div>

      <Card className="mt-6">
        <SectionTitle>Check it without this page</SectionTitle>
        <p className="text-sm text-ink-2">
          The Ethereum figure, from a terminal, with no account. The Midnight figure is the vault
          contract's public supply counters, which any Midnight indexer serves; the second command
          is the relayer's own report, so it answers only where this app is served.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-surface-2 p-4 font-mono text-xs leading-relaxed text-ink">
          {`# USDC held by the vault on Ethereum
cast call ${deployment?.usdcAddress ?? "<usdc>"} "balanceOf(address)(uint256)" ${ledgerEvmVault ?? deployment?.evmVaultAddress ?? "<vault>"} --rpc-url ${EVM_RPC_URL ?? "<rpc>"}

# The relayer's report of both chains
curl ${relayer?.baseUrl ?? "<relayer>"}/backing`}
        </pre>
      </Card>
    </div>
  );
}

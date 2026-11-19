import { ConnectButton as EvmConnectButton } from "@rainbow-me/rainbowkit";
import { CheckCircle2, Circle } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { erc20Abi, formatEther } from "viem";
import {
  useAccount as useEvmAccount,
  useSendTransaction,
  useSwitchChain,
  useWriteContract,
} from "wagmi";

import { ConnectGate, VaultNotice } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { QR } from "../../components/QR.tsx";
import { Stepper } from "../../components/Stepper.tsx";
import {
  Button,
  Card,
  Copyable,
  ExternalA,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  TextField,
} from "../../components/ui.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { useCall } from "../../hooks/useCall.ts";
import { useRelayedRequest } from "../../hooks/useRelayedRequest.ts";
import { explain } from "../../lib/errors.ts";
import { ethBalance, evmChain, evmTxUrl, type Hex, nextNonce, usdcBalance } from "../../lib/evm.ts";
import { stepsFor } from "../../lib/flow.ts";
import { AMOUNT_ERROR_TEXT, formatAmount, parseAmount } from "../../lib/format.ts";
import { walletPublicData } from "../../lib/midnight/providers.ts";
import { localId, patch, upsert, type VaultRequestRecord } from "../../lib/records.ts";
import { relayer } from "../../lib/relayer.ts";
import { useAccount } from "../../state/account.tsx";
import { type Deployment, useDeployment } from "../../state/deployment.tsx";

function NewDeposit({
  deployment,
  onCreated,
}: {
  deployment: Deployment;
  onCreated: (id: string) => void;
}) {
  const { update, secret } = useAccount();
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseAmount(amountText);

  const create = async () => {
    setTouched(true);
    if (!parsed.ok || !relayer) return;
    setBusy(true);
    setError(null);
    try {
      const { assertDepositAddress, identityCommitment } = await import("../../lib/vault.ts");
      const commitment = identityCommitment(await secret("vault"));
      const depositAddress = await relayer.depositAddress(commitment);
      await assertDepositAddress(depositAddress, commitment);
      const id = localId();
      const now = Date.now();
      await update((doc) =>
        upsert(doc, "requests", {
          localId: id,
          kind: "deposit",
          amount: parsed.value.toString(),
          createdAt: now,
          updatedAt: now,
          phase: "funding",
          depositAddress,
        } satisfies VaultRequestRecord),
      );
      onCreated(id);
    } catch (e) {
      setError(explain(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle>How much USDC?</SectionTitle>
      <form
        className="grid gap-4 sm:max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TextField
          label="Amount in USDC"
          inputMode="decimal"
          autoComplete="off"
          placeholder="100.00"
          value={amountText}
          onChange={(e) => {
            setAmountText(e.target.value);
          }}
          onBlur={() => {
            setTouched(true);
          }}
          error={touched && !parsed.ok ? AMOUNT_ERROR_TEXT[parsed.error] : null}
          hint="You will receive exactly this much KUSD. Deposits have no Kinko fee."
        />
        <Button type="submit" busy={busy} disabled={!relayer}>
          Get my deposit address
        </Button>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p className="text-sm text-ink-3">
          Vault on chain {deployment.evmChainId ?? evmChain.id}, USDC at{" "}
          <span className="font-mono text-xs">{deployment.usdcAddress}</span>.
        </p>
      </form>
    </Card>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      {ok ? (
        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
      ) : (
        <Circle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
      )}
      <span className={ok ? "text-ink" : "text-ink-2"}>
        {children}
        <span className="sr-only">{ok ? " (done)" : " (not yet)"}</span>
      </span>
    </li>
  );
}

function Funding({ record, deployment }: { record: VaultRequestRecord; deployment: Deployment }) {
  const amount = BigInt(record.amount);
  const address = record.depositAddress ?? "";
  const { DEPOSIT_GAS_CEILING_WEI } = useVaultConstants();
  const funds = useAsync(
    async () => {
      const [usdc, eth] = await Promise.all([
        usdcBalance(deployment.usdcAddress, address),
        ethBalance(address),
      ]);
      return { usdc, eth };
    },
    [address, deployment.usdcAddress],
    { intervalMs: 6_000 },
  );
  const evm = useEvmAccount();
  const { switchChainAsync } = useSwitchChain();
  const usdcTx = useWriteContract();
  const ethTx = useSendTransaction();
  const [sendError, setSendError] = useState<string | null>(null);

  const usdcOk = funds.status === "ready" && funds.value.usdc >= amount;
  const ethOk =
    funds.status === "ready" &&
    DEPOSIT_GAS_CEILING_WEI !== null &&
    funds.value.eth >= DEPOSIT_GAS_CEILING_WEI;

  const ensureChain = async () => {
    if (evm.chainId !== evmChain.id) await switchChainAsync({ chainId: evmChain.id });
  };

  const sendUsdc = async () => {
    setSendError(null);
    try {
      await ensureChain();
      await usdcTx.writeContractAsync({
        address: deployment.usdcAddress as Hex,
        abi: erc20Abi,
        functionName: "transfer",
        args: [address as Hex, amount],
        chainId: evmChain.id,
      });
      funds.refresh();
    } catch (e) {
      const x = explain(e);
      if (!x.declined) setSendError(x.message);
    }
  };
  const sendEth = async () => {
    setSendError(null);
    try {
      await ensureChain();
      if (DEPOSIT_GAS_CEILING_WEI === null) return;
      await ethTx.sendTransactionAsync({
        to: address as Hex,
        value: DEPOSIT_GAS_CEILING_WEI,
        chainId: evmChain.id,
      });
      funds.refresh();
    } catch (e) {
      const x = explain(e);
      if (!x.declined) setSendError(x.message);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[auto_1fr]">
      <div>
        <QR value={address} label={`QR code of your deposit address ${address}`} size={168} />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-ink-2">Your deposit address on Ethereum</p>
        <Copyable value={address} short={false} className="mt-1.5 w-full" label="Address" />
        <p className="mt-2 text-sm text-ink-3">
          Derived by the signer network from your private identity. Nobody holds its key; only the
          vault can move what arrives here, and only into the vault.
        </p>
        <ul className="mt-4 space-y-2">
          <Check ok={usdcOk}>
            ${formatAmount(amount)} USDC at the address
            {funds.status === "ready" ? (
              <span className="text-ink-3"> · holds ${formatAmount(funds.value.usdc)}</span>
            ) : null}
          </Check>
          <Check ok={ethOk}>
            Up to {DEPOSIT_GAS_CEILING_WEI !== null ? formatEther(DEPOSIT_GAS_CEILING_WEI) : "…"}{" "}
            ETH for the sweep's gas
            {funds.status === "ready" ? (
              <span className="text-ink-3"> · holds {formatEther(funds.value.eth)} ETH</span>
            ) : null}
          </Check>
        </ul>
        {funds.status === "error" ? (
          <p className="mt-2 text-sm text-bad">Balances could not be read: {funds.message}</p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <EvmConnectButton
            showBalance={false}
            chainStatus="icon"
            accountStatus="address"
            label="Connect Ethereum wallet"
          />
          {evm.isConnected ? (
            <>
              <Button onClick={() => void sendUsdc()} busy={usdcTx.isPending} disabled={usdcOk}>
                Send ${formatAmount(amount)} USDC
              </Button>
              <Button
                variant="secondary"
                onClick={() => void sendEth()}
                busy={ethTx.isPending}
                disabled={ethOk}
              >
                Send gas ETH
              </Button>
            </>
          ) : null}
        </div>
        {usdcTx.data && evmTxUrl(usdcTx.data) ? (
          <p className="mt-2 text-sm">
            <ExternalA href={evmTxUrl(usdcTx.data) ?? undefined}>
              USDC transfer on Ethereum
            </ExternalA>
          </p>
        ) : null}
        {sendError ? (
          <div className="mt-3">
            <Notice tone="bad">{sendError}</Notice>
          </div>
        ) : null}
        <p className="mt-3 text-sm text-ink-3">
          {deployment.evmChainId === 1
            ? "Any wallet works: you can also send to this address from an exchange or another app. "
            : "This build runs on Ethereum Sepolia, a test network. Send only Sepolia test USDC to this address, from a wallet connected to Sepolia. An exchange, or any other network, will not reach it and the USDC would be lost. "}
          {deployment.evmChainId === 1 ? null : (
            <>
              Test funds are free:{" "}
              <ExternalA href="https://faucet.circle.com/">Circle's faucet</ExternalA> gives Sepolia
              USDC, and{" "}
              <ExternalA href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia">
                Google Cloud's faucet
              </ExternalA>{" "}
              gives the Sepolia ETH the sweep needs.{" "}
            </>
          )}
          This page checks the address every few seconds.
        </p>
        <StartDeposit record={record} deployment={deployment} ready={usdcOk && ethOk} />
      </div>
    </div>
  );
}

let vaultConstants: { DEPOSIT_GAS_CEILING_WEI: bigint } | null = null;
function useVaultConstants() {
  const [c, setC] = useState(vaultConstants);
  useEffect(() => {
    if (c) return;
    void import("../../lib/vault.ts").then((m) => {
      vaultConstants = { DEPOSIT_GAS_CEILING_WEI: m.DEPOSIT_GAS_CEILING_WEI };
      setC(vaultConstants);
    });
  }, [c]);
  return { DEPOSIT_GAS_CEILING_WEI: c?.DEPOSIT_GAS_CEILING_WEI ?? null };
}

function StartDeposit({
  record,
  deployment,
  ready,
}: {
  record: VaultRequestRecord;
  deployment: Deployment;
  ready: boolean;
}) {
  const { account, update, secret } = useAccount();
  const call = useCall();
  const start = () =>
    call.run(async (onStage) => {
      if (!account || !relayer) throw new Error("Connect your wallet first.");
      const v = await import("../../lib/vault.ts");
      const s = await secret("vault");
      const amount = BigInt(record.amount);
      const pdp = await walletPublicData(account);
      const state = await v.readVault(pdp, deployment.vaultContractAddress);
      if (!state.initialised) throw new Error("The vault is not initialised yet.");
      const evmNonce = await nextNonce(record.depositAddress ?? "");
      const requestId = v.depositRequestId({
        vaultContractAddress: deployment.vaultContractAddress,
        state,
        commitmentHex: v.identityCommitment(s),
        usdcAddress: deployment.usdcAddress,
        amount,
        evmNonce,
      });
      await update((doc) =>
        patch(doc, "requests", record.localId, {
          phase: "starting",
          error: undefined,
          updatedAt: Date.now(),
        }),
      );
      let inIndex: bigint;
      try {
        ({ inIndex } = await v.startDeposit({
          account,
          vaultContractAddress: deployment.vaultContractAddress,
          secret: s,
          usdcAddress: deployment.usdcAddress,
          amount,
          evmNonce,
          onStage,
        }));
      } catch (e) {
        await update((doc) =>
          patch(doc, "requests", record.localId, {
            phase: "funding",
            error: explain(e).message,
            updatedAt: Date.now(),
          }),
        );
        throw e;
      }
      // The request is on Midnight now, whatever happens next. Tell the
      // relayer before the screen starts asking it for progress, so the first
      // read finds the request; if this fails, the progress screen registers
      // it again on its first poll.
      await relayer.register("deposit", requestId).catch((e: unknown) => {
        console.warn("[kinko] the relayer did not accept the deposit yet:", e);
      });
      await update((doc) =>
        patch(doc, "requests", record.localId, {
          phase: "relaying",
          requestId,
          inIndex: inIndex.toString(),
          error: undefined,
          updatedAt: Date.now(),
        }),
      );
    });
  return (
    <div className="mt-6 border-t border-line pt-5">
      <Button onClick={() => void start()} busy={call.busy} disabled={!ready || !relayer}>
        Start the deposit
      </Button>
      {!ready ? (
        <p className="mt-2 text-sm text-ink-3">
          Available once the address holds the USDC and the gas.
        </p>
      ) : null}
      <div className="mt-4">
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="Your deposit is on Midnight. The relayer takes it from here."
        />
      </div>
    </div>
  );
}

function Relaying({ record, deployment }: { record: VaultRequestRecord; deployment: Deployment }) {
  const { account, update, secret, refreshBalance } = useAccount();
  const { pollError, retry, retrying } = useRelayedRequest(record);
  const call = useCall();
  const complete = () =>
    call.run(async (onStage) => {
      if (!account || !record.requestId) throw new Error("Connect your wallet first.");
      const v = await import("../../lib/vault.ts");
      const state = await v.readVault(
        await walletPublicData(account),
        deployment.vaultContractAddress,
      );
      await update((doc) =>
        patch(doc, "requests", record.localId, { phase: "completing", updatedAt: Date.now() }),
      );
      try {
        const { minted } = await v.completeDeposit({
          account,
          vaultContractAddress: deployment.vaultContractAddress,
          state,
          secret: await secret("vault"),
          requestId: record.requestId,
          onStage,
        });
        await update((doc) =>
          patch(doc, "requests", record.localId, {
            phase: "done",
            outcome: minted ? "succeeded" : "nothing-minted",
            lastStage: "completed",
            updatedAt: Date.now(),
          }),
        );
        refreshBalance();
      } catch (e) {
        await update((doc) =>
          patch(doc, "requests", record.localId, { phase: "relaying", updatedAt: Date.now() }),
        );
        throw e;
      }
    });

  return (
    <div className="space-y-4">
      {record.phase === "failed" ? (
        <Notice
          tone="warn"
          title="The relayer stopped carrying this deposit"
          action={
            <Button variant="secondary" onClick={() => void retry()} busy={retrying}>
              Ask it to retry
            </Button>
          }
        >
          {record.error ?? "It did not say why."} Your USDC is either still at your deposit address
          or already in the vault; either way the request stays open on Midnight and can be carried
          again.
        </Notice>
      ) : null}
      {pollError ? (
        <Notice tone="warn" title="Progress could not be read">
          {pollError} It is retried every few seconds.
        </Notice>
      ) : null}
      {record.evmTxHash && evmTxUrl(record.evmTxHash) ? (
        <p className="text-sm">
          <ExternalA href={evmTxUrl(record.evmTxHash) ?? undefined}>
            The sweep into the vault, on Ethereum
          </ExternalA>
        </p>
      ) : null}
      {record.lastStage === "ready" || record.phase === "completing" ? (
        <div className="rounded-xl border border-shu/30 bg-shu-soft/50 p-4">
          <p className="font-semibold text-ink">Your dollars are ready to mint</p>
          <p className="mt-1 text-sm text-ink-2">
            Sign once more and ${formatAmount(BigInt(record.amount))} KUSD arrives at your shielded
            address, under a fresh random nonce nobody can link to this deposit.
          </p>
          <Button className="mt-3" onClick={() => void complete()} busy={call.busy}>
            Receive ${formatAmount(BigInt(record.amount))}
          </Button>
          <div className="mt-3">
            <ProofProgress
              stage={call.stage}
              startedAt={call.startedAt}
              error={call.error}
              doneText="KUSD minted to your shielded address."
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Add() {
  const { records } = useAccount();
  const { state } = useDeployment();
  const [params, setParams] = useSearchParams();
  const requested = params.get("request");
  const deposits = useMemo(
    () => (records?.requests ?? []).filter((r) => r.kind === "deposit"),
    [records],
  );
  const record =
    deposits.find((r) => r.localId === requested) ??
    (requested ? undefined : deposits.find((r) => r.phase !== "done"));
  const deployment = state.status === "ready" ? state.deployment : null;

  return (
    <div>
      <PageHeader eyebrow="Add dollars" title="Turn USDC into private dollars">
        Send USDC on Ethereum and receive the same amount of KUSD on Midnight, where only you can
        see it.
      </PageHeader>
      <VaultNotice />
      <ConnectGate what="add dollars">
        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            {!deployment ? null : !record ? (
              <NewDeposit
                deployment={deployment}
                onCreated={(id) => {
                  setParams({ request: id });
                }}
              />
            ) : (
              <Card>
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                  <SectionTitle>Deposit of ${formatAmount(BigInt(record.amount))}</SectionTitle>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setParams({ request: "new" });
                    }}
                  >
                    New deposit
                  </Button>
                </div>
                {record.error && record.phase === "funding" ? (
                  <div className="mb-4">
                    <Notice tone="bad" title="The deposit did not start">
                      {record.error} Nothing was submitted to the vault; your funds are still at the
                      deposit address.
                    </Notice>
                  </div>
                ) : null}
                {record.phase === "funding" || record.phase === "starting" ? (
                  <Funding record={record} deployment={deployment} />
                ) : record.phase === "done" ? (
                  <Notice
                    tone={record.outcome === "nothing-minted" ? "warn" : "ok"}
                    title={record.outcome === "nothing-minted" ? "Closed without a mint" : "Done"}
                  >
                    {record.outcome === "nothing-minted"
                      ? "The signers attested that the sweep did not move the USDC, so nothing was minted. The USDC is still at your deposit address; start a new deposit to sweep it."
                      : `$${formatAmount(BigInt(record.amount))} KUSD is in your private balance.`}
                  </Notice>
                ) : (
                  <Relaying record={record} deployment={deployment} />
                )}
              </Card>
            )}
            {record ? (
              <Card>
                <Stepper steps={stepsFor("deposit", record)} label="Progress" />
              </Card>
            ) : null}
          </div>
          <aside className="space-y-4">
            <Card>
              <SectionTitle>Public and private</SectionTitle>
              <div className="space-y-3">
                <PrivacyLine>
                  The deposit itself is public on Ethereum: your deposit address and the amount.
                </PrivacyLine>
                <PrivacyLine>
                  Once minted, nobody can see who holds the KUSD or what they do with it.
                </PrivacyLine>
                <PrivacyLine>
                  The mint uses a fresh random nonce, so the coin cannot be linked back to this
                  deposit.
                </PrivacyLine>
              </div>
            </Card>
            <Card>
              <SectionTitle>If something stops</SectionTitle>
              <p className="text-sm leading-relaxed text-ink-2">
                Every step after your first signature is permissionless. If the relayer stalls, your
                request stays open on Midnight and any relayer can carry it. If the Ethereum sweep
                fails, the signers attest that, and the request closes with nothing lost. You can
                close this tab at any point; this page resumes from where it stopped.
              </p>
            </Card>
          </aside>
        </div>
      </ConnectGate>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAccount as useEvmAccount } from "wagmi";

import { ConnectGate, VaultNotice } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { Stepper } from "../../components/Stepper.tsx";
import {
  Button,
  Card,
  ExternalA,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  Skeleton,
  TextField,
} from "../../components/ui.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { useCall } from "../../hooks/useCall.ts";
import { useRelayedRequest } from "../../hooks/useRelayedRequest.ts";
import { explain } from "../../lib/errors.ts";
import { evmTxUrl } from "../../lib/evm.ts";
import { stepsFor } from "../../lib/flow.ts";
import { AMOUNT_ERROR_TEXT, formatAmount, isEvmAddress, parseAmount } from "../../lib/format.ts";
import { walletPublicData } from "../../lib/midnight/providers.ts";
import { localId, patch, upsert, type VaultRequestRecord } from "../../lib/records.ts";
import { relayer } from "../../lib/relayer.ts";
import { useAccount } from "../../state/account.tsx";
import { type Deployment, useDeployment } from "../../state/deployment.tsx";

function NewWithdrawal({
  deployment,
  onCreated,
}: {
  deployment: Deployment;
  onCreated: (id: string) => void;
}) {
  const { account, balance, update, secret } = useAccount();
  const evm = useEvmAccount();
  const [amountText, setAmountText] = useState("");
  const [dest, setDest] = useState("");
  const [touched, setTouched] = useState(false);
  const call = useCall();

  useEffect(() => {
    if (!dest && evm.address) setDest(evm.address);
  }, [evm.address, dest]);

  const fee = useAsync(async () => {
    if (!account) throw new Error("Connect first.");
    const v = await import("../../lib/vault.ts");
    const state = await v.readVault(
      await walletPublicData(account),
      deployment.vaultContractAddress,
    );
    return v.withdrawFee(state, deployment.usdcAddress);
  }, [account, deployment.vaultContractAddress, deployment.usdcAddress]);

  const parsed = parseAmount(amountText);
  const feeValue = fee.status === "ready" ? fee.value : null;
  const total = parsed.ok && feeValue !== null ? parsed.value + feeValue : null;
  const short = total !== null && balance.status === "ready" && balance.kusd < total;
  const destOk = isEvmAddress(dest);
  const canSubmit = parsed.ok && destOk && feeValue !== null && !short && Boolean(relayer);

  const submit = () =>
    call.run(async (onStage) => {
      setTouched(true);
      if (!account || !parsed.ok || !destOk) throw new Error("Check the amount and the address.");
      const v = await import("../../lib/vault.ts");
      const state = await v.readVault(
        await walletPublicData(account),
        deployment.vaultContractAddress,
      );
      const id = localId();
      const now = Date.now();
      const { inIndex, fee: charged } = await v.startWithdraw({
        account,
        vaultContractAddress: deployment.vaultContractAddress,
        state,
        secret: await secret("vault"),
        usdcAddress: deployment.usdcAddress,
        amount: parsed.value,
        destination: dest,
        onStage,
      });
      await update((doc) =>
        upsert(doc, "requests", {
          localId: id,
          kind: "withdraw",
          amount: parsed.value.toString(),
          fee: charged.toString(),
          destination: dest,
          createdAt: now,
          updatedAt: Date.now(),
          phase: "relaying",
          inIndex: inIndex.toString(),
        } satisfies VaultRequestRecord),
      );
      onCreated(id);
    });

  return (
    <Card>
      <SectionTitle>Withdraw to Ethereum</SectionTitle>
      <form
        className="grid gap-4 sm:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Amount in USDC"
          inputMode="decimal"
          autoComplete="off"
          placeholder="40.00"
          value={amountText}
          onChange={(e) => {
            setAmountText(e.target.value);
          }}
          onBlur={() => {
            setTouched(true);
          }}
          error={
            touched && !parsed.ok
              ? AMOUNT_ERROR_TEXT[parsed.error]
              : short
                ? "Your private balance does not cover this amount plus the fee."
                : null
          }
          hint={
            balance.status === "ready"
              ? `Private balance: $${formatAmount(balance.kusd)}`
              : undefined
          }
        />
        <TextField
          label="Ethereum address that receives the USDC"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={dest}
          onChange={(e) => {
            setDest(e.target.value.trim());
          }}
          error={touched && !destOk ? "Enter a 0x address of 40 hex characters." : null}
          hint="Any address you control. It becomes public on Ethereum when the USDC arrives."
        />
        <div className="rounded-xl bg-surface-2 p-4 text-sm">
          <div className="flex justify-between py-1">
            <span className="text-ink-2">You receive on Ethereum</span>
            <span className="tabular font-semibold text-ink">
              {parsed.ok ? `$${formatAmount(parsed.value)}` : "—"}
            </span>
          </div>
          <div className="flex justify-between py-1">
            <span className="text-ink-2">Vault fee, set on chain</span>
            <span className="tabular text-ink">
              {feeValue !== null ? (
                `$${formatAmount(feeValue)}`
              ) : fee.status === "error" ? (
                "unavailable"
              ) : (
                <Skeleton className="h-4 w-12" />
              )}
            </span>
          </div>
          <div className="mt-1 flex justify-between border-t border-line pt-2">
            <span className="text-ink-2">KUSD burned</span>
            <span className="tabular font-semibold text-ink">
              {total !== null ? `$${formatAmount(total)}` : "—"}
            </span>
          </div>
        </div>
        {fee.status === "error" ? (
          <Notice tone="bad">The fee could not be read from the vault: {fee.message}</Notice>
        ) : null}
        <Button type="submit" busy={call.busy} disabled={!canSubmit}>
          Start the withdrawal
        </Button>
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="Your withdrawal is on Midnight. The relayer takes it from here."
        />
      </form>
    </Card>
  );
}

/**
 * A withdrawal's request id exists only after its flush; find it, then hand it to the relayer.
 */
function useWithdrawRegistration(
  record: VaultRequestRecord | undefined,
  deployment: Deployment | null,
) {
  const { account, update } = useAccount();
  const [waitingSince] = useState(() => Date.now());
  const [note, setNote] = useState<string | null>(null);
  const needs = Boolean(
    record?.kind === "withdraw" &&
    record.phase === "relaying" &&
    !record.requestId &&
    record.inIndex,
  );
  useEffect(() => {
    const client = relayer;
    if (!needs || !record || !deployment || !account || !client) return;
    let live = true;
    const tick = async () => {
      try {
        const v = await import("../../lib/vault.ts");
        const state = await v.readVault(
          await walletPublicData(account),
          deployment.vaultContractAddress,
        );
        const inIndex = BigInt(record.inIndex ?? "0");
        if (!v.isFlushed(state, inIndex)) {
          if (live)
            setNote(
              Date.now() - waitingSince > 120_000
                ? "Still waiting for the vault queue to move. The relayer moves it for everyone; this can take a few minutes when it is busy."
                : null,
            );
          return;
        }
        const id = v.withdrawRequestId({
          vaultContractAddress: deployment.vaultContractAddress,
          state,
          inIndex,
          usdcAddress: deployment.usdcAddress,
          amount: BigInt(record.amount),
          destination: record.destination ?? "",
        });
        if (!id || !live) return;
        await client.register("withdraw", id);
        await update((doc) =>
          patch(doc, "requests", record.localId, {
            requestId: id,
            lastStage: "flushed",
            updatedAt: Date.now(),
          }),
        );
      } catch (e) {
        if (live) setNote(explain(e).message);
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 6_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [needs, record, deployment, account, update, waitingSince]);
  return note;
}

function Relaying({ record, deployment }: { record: VaultRequestRecord; deployment: Deployment }) {
  const { account, update, secret, refreshBalance } = useAccount();
  const { pollError, retry, retrying } = useRelayedRequest(record);
  const registrationNote = useWithdrawRegistration(record, deployment);
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
        const { refunded } = await v.completeWithdraw({
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
            outcome: refunded ? "refunded" : "succeeded",
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
      <p className="text-sm text-ink-2">
        ${formatAmount(BigInt(record.amount))} to{" "}
        <span className="break-all font-mono text-xs">{record.destination}</span>
        {record.fee ? <> · fee ${formatAmount(BigInt(record.fee))}</> : null}
      </p>
      {registrationNote ? <Notice tone="warn">{registrationNote}</Notice> : null}
      {record.phase === "failed" ? (
        <Notice
          tone="warn"
          title="The relayer stopped carrying this withdrawal"
          action={
            <Button variant="secondary" onClick={() => void retry()} busy={retrying}>
              Ask it to retry
            </Button>
          }
        >
          {record.error ?? "It did not say why."} Your KUSD is not lost: if the transfer never
          happens, closing the withdrawal returns it to you.
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
            The USDC transfer, on Ethereum
          </ExternalA>
        </p>
      ) : null}
      {record.lastStage === "ready" || record.phase === "completing" ? (
        <div className="rounded-xl border border-shu/30 bg-shu-soft/50 p-4">
          <p className="font-semibold text-ink">Close the withdrawal</p>
          <p className="mt-1 text-sm text-ink-2">
            The signers have attested the outcome. Sign once more to close it; if the transfer did
            not go through, this mints your KUSD back.
          </p>
          <Button className="mt-3" onClick={() => void complete()} busy={call.busy}>
            Close the withdrawal
          </Button>
          <div className="mt-3">
            <ProofProgress stage={call.stage} startedAt={call.startedAt} error={call.error} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Withdraw() {
  const { records } = useAccount();
  const { state } = useDeployment();
  const [params, setParams] = useSearchParams();
  const requested = params.get("request");
  const list = useMemo(
    () => (records?.requests ?? []).filter((r) => r.kind === "withdraw"),
    [records],
  );
  const record =
    list.find((r) => r.localId === requested) ??
    (requested ? undefined : list.find((r) => r.phase !== "done"));
  const deployment = state.status === "ready" ? state.deployment : null;
  return (
    <div>
      <PageHeader eyebrow="Withdraw" title="Take your dollars back out as USDC">
        Burn KUSD on Midnight and receive the same amount of USDC at any Ethereum address, minus a
        flat fee shown before you sign.
      </PageHeader>
      <VaultNotice />
      <ConnectGate what="withdraw">
        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            {!deployment ? null : !record ? (
              <NewWithdrawal
                deployment={deployment}
                onCreated={(id) => {
                  setParams({ request: id });
                }}
              />
            ) : (
              <Card>
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                  <SectionTitle>Withdrawal of ${formatAmount(BigInt(record.amount))}</SectionTitle>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setParams({ request: "new" });
                    }}
                  >
                    New withdrawal
                  </Button>
                </div>
                {record.phase === "done" ? (
                  <Notice
                    tone={record.outcome === "refunded" ? "warn" : "ok"}
                    title={record.outcome === "refunded" ? "Returned to your balance" : "Done"}
                  >
                    {record.outcome === "refunded"
                      ? "The Ethereum transfer did not go through, so the vault minted your KUSD back. The fee is not refunded."
                      : `$${formatAmount(BigInt(record.amount))} USDC was sent to ${record.destination ?? "your address"}.`}
                  </Notice>
                ) : (
                  <Relaying record={record} deployment={deployment} />
                )}
              </Card>
            )}
            {record ? (
              <Card>
                <Stepper steps={stepsFor("withdraw", record)} label="Progress" />
              </Card>
            ) : null}
          </div>
          <aside className="space-y-4">
            <Card>
              <SectionTitle>Public and private</SectionTitle>
              <div className="space-y-3">
                <PrivacyLine>
                  The withdrawal is public on Ethereum: the receiving address and the amount.
                </PrivacyLine>
                <PrivacyLine>
                  Which private account it came from is not. The burn on Midnight shows an amount,
                  not an owner.
                </PrivacyLine>
                <PrivacyLine>
                  Use a fresh Ethereum address if you do not want this withdrawal linked to your
                  other activity there.
                </PrivacyLine>
              </div>
            </Card>
          </aside>
        </div>
      </ConnectGate>
    </div>
  );
}

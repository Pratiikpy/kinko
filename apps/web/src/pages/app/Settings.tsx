import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { ConnectGate } from "../../components/Gates.tsx";
import {
  Badge,
  Button,
  Card,
  Copyable,
  Notice,
  PageHeader,
  SectionTitle,
  Segmented,
} from "../../components/ui.tsx";
import {
  CONTRACT_ENV,
  CONTRACTS,
  EVM_CHAIN_ID,
  EVM_RPC_URL,
  NETWORK_ID,
  NIGHTKIT_VAULT_URL,
  PUBLIC_INDEXER,
  RELAYER_URL,
  ZK_BASE_URL,
} from "../../lib/config.ts";
import { isRecordsDoc } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";
import { useDeployment } from "../../state/deployment.tsx";
import { type Theme, useTheme } from "../../state/theme.tsx";

function Backup() {
  const { records, recordsSource, replaceRecords } = useAccount();
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const download = () => {
    if (!records) return;
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kinko-records-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setConfirm(false);
  };

  const restore = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isRecordsDoc(parsed)) throw new Error("This file is not a Kinko records backup.");
      await replaceRecords(parsed);
      setMessage({
        tone: "ok",
        text: `Restored ${String(parsed.invoices.length)} invoices, ${String(parsed.payments.length)} payments, ${String(parsed.requests.length)} deposits and withdrawals.`,
      });
    } catch (e) {
      setMessage({
        tone: "bad",
        text: e instanceof Error ? e.message : "The backup could not be read.",
      });
    }
  };

  return (
    <Card>
      <SectionTitle
        aside={
          <Badge tone={recordsSource === "account" ? "ok" : "neutral"}>
            {recordsSource === "account" ? "Key from your account" : "Key from this device"}
          </Badge>
        }
      >
        Your private records
      </SectionTitle>
      <p className="text-sm leading-relaxed text-ink-2">
        Invoice owner secrets, receipts, gift and card secrets, tag ownership and deposits in flight
        are kept encrypted in this browser.{" "}
        {recordsSource === "account"
          ? "The key is derived from your account, so it is the same wherever you sign in."
          : "The key is held by this browser and cannot be read out of it. Losing this browser's data loses these records, so keep a backup."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {confirm ? (
          <>
            <Notice tone="warn" title="A backup holds secrets">
              It contains the secrets that control your invoices, gift cards and tags. Store it like
              a password.
            </Notice>
            <Button onClick={download}>
              <Download aria-hidden className="h-4 w-4" /> Download the backup
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirm(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setConfirm(true);
            }}
            disabled={!records}
          >
            <Download aria-hidden className="h-4 w-4" /> Back up records
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => e.target.files?.[0] && void restore(e.target.files[0])}
        />
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <Upload aria-hidden className="h-4 w-4" /> Restore a backup
        </Button>
      </div>
      {message ? (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="min-w-0">
        {value ? <Copyable value={value} /> : <span className="text-sm text-ink-3">Not set</span>}
      </dd>
    </div>
  );
}

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const { state, relayerUp } = useDeployment();
  const { walletName, openedWith, fees } = useAccount();
  const d = state.status === "ready" ? state.deployment : null;
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Settings" />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <SectionTitle>Appearance</SectionTitle>
            <Segmented<Theme>
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", label: "Paper (light)" },
                { value: "dark", label: "Sumi (dark)" },
              ]}
            />
          </Card>
          <ConnectGate what="manage your records">
            <div className="space-y-6">
              <Card>
                <SectionTitle>Account</SectionTitle>
                <dl className="divide-y divide-line text-sm">
                  <div className="flex justify-between py-2.5">
                    <dt className="text-ink-2">Wallet</dt>
                    <dd className="text-ink">{walletName}</dd>
                  </div>
                  {openedWith ? (
                    <div className="flex flex-wrap justify-between gap-2 py-2.5">
                      <dt className="text-ink-2">Opened with</dt>
                      <dd className="break-all font-mono text-xs text-ink">{openedWith}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between py-2.5">
                    <dt className="text-ink-2">Network fees</dt>
                    <dd className="text-ink">
                      {fees === "sponsor"
                        ? "Paid by a sponsor"
                        : fees === "self"
                          ? "Paid from this account's DUST"
                          : "Paid by your wallet"}
                    </dd>
                  </div>
                </dl>
              </Card>
              <Backup />
            </div>
          </ConnectGate>
        </div>
        <Card>
          <SectionTitle
            aside={
              <Badge tone={relayerUp ? "ok" : "warn"}>
                {relayerUp ? "Relayer up" : "Relayer down"}
              </Badge>
            }
          >
            This deployment
          </SectionTitle>
          <dl className="divide-y divide-line">
            <div className="flex justify-between py-2.5 text-sm">
              <dt className="text-ink-2">Midnight network</dt>
              <dd className="font-mono text-xs text-ink">{NETWORK_ID}</dd>
            </div>
            <div className="flex justify-between py-2.5 text-sm">
              <dt className="text-ink-2">Ethereum chain</dt>
              <dd className="font-mono text-xs text-ink">{d?.evmChainId ?? EVM_CHAIN_ID}</dd>
            </div>
            <Row label="Relayer" value={RELAYER_URL} />
            <Row label="Public indexer" value={PUBLIC_INDEXER?.http} />
            <Row label="Ethereum RPC" value={EVM_RPC_URL} />
            <Row label="NightKit vault" value={NIGHTKIT_VAULT_URL} />
            <Row label="Proving keys" value={ZK_BASE_URL} />
            <Row label="Vault contract" value={d?.vaultContractAddress} />
            <Row label="Vault on Ethereum" value={d?.evmVaultAddress} />
            <Row label="USDC" value={d?.usdcAddress} />
            {(Object.keys(CONTRACTS) as (keyof typeof CONTRACTS)[]).map((k) => (
              <Row
                key={k}
                label={`${CONTRACT_ENV[k].replace("VITE_KINKO_", "").replace("_ADDRESS", "").toLowerCase()} contract`}
                value={CONTRACTS[k]}
              />
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}

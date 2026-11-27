import { generateExaminerKey, pureCircuits } from "@kinko/kinko-disclosure";
import { CheckCircle2, CircleAlert, KeyRound, Lock, ScrollText } from "lucide-react";
import { useMemo, useState } from "react";

import { ContractNotice } from "../components/Gates.tsx";
import { ProofProgress } from "../components/ProofProgress.tsx";
import {
  Badge,
  Button,
  Card,
  Copyable,
  EmptyState,
  Notice,
  PageHeader,
  PrivacyLine,
  SectionTitle,
  Segmented,
  Skeleton,
  TextField,
} from "../components/ui.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { useCall } from "../hooks/useCall.ts";
import { CONTRACTS } from "../lib/config.ts";
import {
  approversOf,
  type CaseDisclosure,
  discloseCase,
  examinerIdForScalar,
  fieldText,
  listCases,
  LOG_TEXT,
  parseScalar,
  readDisclosure,
  readLog,
  scalarHex,
  statementFor,
  utf8Length,
  verifyDeployment,
} from "../lib/disclosure.ts";
import {
  AMOUNT_ERROR_TEXT,
  formatAmount,
  fromHex,
  parseAmount,
  shortHex,
  toHex,
} from "../lib/format.ts";
import { callCircuit } from "../lib/midnight/contracts.ts";
import { readerFor } from "../lib/midnight/providers.ts";
import { useAccount } from "../state/account.tsx";

type Role = "public" | "operator" | "examiner" | "keyholder" | "filer";

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

/** How many disclosure-log entries show before the rest is asked for. */
const LOG_PREVIEW = 10;

function useLedger(tick: number) {
  const { account } = useAccount();
  return useAsync(
    async () => {
      if (!CONTRACTS.disclosure)
        throw new Error("The disclosure contract is not deployed in this build.");
      return readDisclosure(await readerFor(account), CONTRACTS.disclosure);
    },
    [account, tick],
    { enabled: Boolean(CONTRACTS.disclosure), intervalMs: 20_000 },
  );
}

function PublicView({ ledger }: { ledger: NonNullable<ReturnType<typeof useLedger>["value"]> }) {
  const [wholeLog, setWholeLog] = useState(false);
  const check = verifyDeployment(ledger);
  const log = readLog(ledger).reverse();
  const cases = listCases(ledger);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Sealed records", ledger.records.size()],
          ["Examiners", ledger.examiners.size()],
          ["Cases", ledger.cases.size()],
          ["Log entries", ledger.logLength],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-3">{label}</p>
            <p className="tabular mt-1.5 font-display text-3xl text-ink">{String(value)}</p>
          </Card>
        ))}
      </div>
      <Card>
        <SectionTitle
          aside={
            check.ok ? (
              <Badge tone="ok">Checks pass</Badge>
            ) : (
              <Badge tone="bad">Problems found</Badge>
            )
          }
        >
          Is this deployment sound?
        </SectionTitle>
        {check.ok ? (
          <p className="flex gap-2 text-sm text-ink-2">
            <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> No key is the
            identity, no keyholder holds the whole secret, every pair of keyholders reconstructs the
            disclosure key, and the threshold is two of three. Checked in this browser from the
            public ledger.
          </p>
        ) : (
          <ul className="space-y-1 text-sm text-bad">
            {check.problems.map((p) => (
              <li key={p} className="flex gap-2">
                <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> {p}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle>Cases</SectionTitle>
        {cases.length === 0 ? (
          <EmptyState title="No cases yet">
            A registered examiner opens a case naming the records it wants. Its scope is public
            before anyone approves.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {cases.map(({ id, c }) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-ink">{shortHex(id, 10, 8)}</p>
                  <p className="text-xs text-ink-3">
                    {String(c.count)} record{c.count === 1n ? "" : "s"} · examiner{" "}
                    {shortHex(toHex(c.examinerId), 6, 4)} · expires{" "}
                    {new Date(Number(c.expiry) * 1000).toLocaleString()}
                  </p>
                </div>
                <div
                  className="flex items-center gap-1.5"
                  aria-label={`${String(approversOf(c).length)} of 3 keyholders approved`}
                >
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className={`h-2.5 w-6 rounded-full ${c.approvals[i] ? "bg-shu" : "bg-line-strong"}`}
                      aria-hidden
                    />
                  ))}
                  <Badge tone={c.approvalCount >= 2n ? "ok" : "neutral"}>
                    {c.approvalCount >= 2n
                      ? "Open to examiner"
                      : `${String(c.approvalCount)} of 2 approvals`}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle aside={<ScrollText aria-hidden className="h-5 w-5 text-ink-3" />}>
          Disclosure log
        </SectionTitle>
        {log.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing has been logged yet.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-3 md:hidden">Swipe sideways to see every column.</p>
            <div
              className="overflow-x-auto"
              role="region"
              aria-label="Disclosure log, scrolls sideways"
              tabIndex={0}
            >
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">What</th>
                    <th className="py-2 pr-3 font-medium">Case</th>
                    <th className="py-2 pr-3 font-medium">Scope</th>
                    <th className="py-2 font-medium">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(wholeLog ? log : log.slice(0, LOG_PREVIEW)).map((e, i) => (
                    <tr key={`${String(e.at)}-${String(i)}`}>
                      <td className="tabular py-2.5 pr-3 text-ink-2">
                        {new Date(Number(e.at) * 1000).toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-3 text-ink">{LOG_TEXT[e.kind]}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-ink-2">
                        {e.caseId.every((b) => b === 0) ? "—" : shortHex(toHex(e.caseId), 6, 4)}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-ink-2">
                        {e.scopeHash.every((b) => b === 0)
                          ? "—"
                          : shortHex(toHex(e.scopeHash), 6, 4)}
                      </td>
                      <td className="py-2.5 text-ink-2">
                        {e.keyholder === 255n
                          ? `Examiner ${shortHex(toHex(e.examinerId), 4, 4)}`
                          : `Keyholder ${String(e.keyholder)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {log.length > LOG_PREVIEW ? (
              <Button
                variant="ghost"
                className="mt-3"
                aria-expanded={wholeLog}
                onClick={() => {
                  setWholeLog((w) => !w);
                }}
              >
                {wholeLog
                  ? `Show the latest ${String(LOG_PREVIEW)}`
                  : `Show all ${String(log.length)} entries`}
              </Button>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

function Disclosed({ d }: { d: CaseDisclosure }) {
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs text-ink">Case {shortHex(toHex(d.caseId), 10, 8)}</p>
        <Badge tone={d.approvers.length >= 2 ? "ok" : "neutral"}>
          {d.approvers.length >= 2
            ? `Approved by keyholders ${d.approvers.join(" and ")}`
            : "Waiting for approvals"}
        </Badge>
      </div>
      <ul className="space-y-3">
        {d.records.map((r) => (
          <li key={toHex(r.recordId)} className="rounded-xl bg-surface-2 p-3 text-sm">
            <p className="mb-1 font-mono text-xs text-ink-3">
              Record {shortHex(toHex(r.recordId), 8, 6)}
            </p>
            {r.status === "disclosed" ? (
              <>
                <p className="flex items-center gap-2 font-semibold text-ink">
                  <span className="tabular">${formatAmount(r.statement.amount)}</span>{" "}
                  {r.statement.direction === "sent" ? "sent to" : "received from"}{" "}
                  {fieldText(r.statement.counterparty) || "an unnamed party"}
                </p>
                <p className="text-ink-2">
                  {new Date(Number(r.statement.time) * 1000).toLocaleString()}
                  {r.statement.reference ? ` · ref ${r.statement.reference}` : ""}
                  {r.statement.memo ? ` · ${r.statement.memo}` : ""}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-ok">
                  <CheckCircle2 aria-hidden className="h-3.5 w-3.5" /> Matches its anchor on chain.
                  Filed by filer {r.filerId.toString(16).slice(0, 12)}…
                </p>
              </>
            ) : r.status === "sealed" ? (
              <p className="flex items-center gap-2 text-ink-2">
                <Lock aria-hidden className="h-4 w-4" /> Still sealed: two keyholders must approve.
              </p>
            ) : (
              <p className="flex items-center gap-2 text-bad">
                <CircleAlert aria-hidden className="h-4 w-4" /> Not opened: {r.reason}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Read an examiner's public key as the examiner page hands it over: `{"x":"…","y":"…"}`.
 *
 * @param text - What the operator pasted.
 * @returns The point, or null when it is not one.
 */
function parseExaminerKey(text: string): { x: bigint; y: bigint } | null {
  try {
    const raw = JSON.parse(text.trim()) as { x?: unknown; y?: unknown };
    if (typeof raw.x !== "string" || typeof raw.y !== "string") return null;
    if (!/^\d+$/.test(raw.x) || !/^\d+$/.test(raw.y)) return null;
    return { x: BigInt(raw.x), y: BigInt(raw.y) };
  } catch {
    return null;
  }
}

function OperatorView({
  ledger,
  onChanged,
}: {
  ledger: NonNullable<ReturnType<typeof useLedger>["value"]>;
  onChanged: () => void;
}) {
  const { account } = useAccount();
  const call = useCall();
  const [secretText, setSecretText] = useState("");
  const [keyText, setKeyText] = useState("");
  const clean = secretText.trim().replace(/^0x/i, "").toLowerCase();
  const secret = /^[0-9a-f]{64}$/.test(clean) ? fromHex(clean) : null;
  const isOperator =
    secret !== null &&
    toHex(pureCircuits.operatorCommitmentOf(secret)) === toHex(ledger.operatorCommitment);
  const examinerKey = keyText.trim() ? parseExaminerKey(keyText) : null;
  const examinerId = examinerKey ? toHex(pureCircuits.examinerIdOf(examinerKey)) : null;
  const known = examinerId ? ledger.examiners.member(fromHex(examinerId)) : false;
  const examiners = useMemo(() => {
    const out: { id: string; active: boolean }[] = [];
    for (const [id, e] of ledger.examiners) out.push({ id: toHex(id), active: e.active });
    return out;
  }, [ledger]);

  const run = (circuit: "register_examiner" | "revoke_examiner", args: unknown[]) =>
    call.run(async (onStage) => {
      if (!account || !CONTRACTS.disclosure || !secret)
        throw new Error("Enter the operator secret.");
      await callCircuit(
        account,
        "disclosure",
        CONTRACTS.disclosure,
        { secretKey: secret },
        circuit,
        args,
        onStage,
      );
      if (circuit === "register_examiner") setKeyText("");
      onChanged();
    });

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle aside={<KeyRound aria-hidden className="h-5 w-5 text-ink-3" />}>
          The operator secret
        </SectionTitle>
        <p className="mb-4 text-sm text-ink-2">
          Made at deployment and held by the compliance operator alone. It only registers and
          revokes examiners; it opens nothing. It stays in this tab and is never stored or sent.
        </p>
        <TextField
          label="Operator secret"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secretText}
          onChange={(e) => {
            setSecretText(e.target.value);
          }}
          error={
            secretText.trim() && !secret
              ? "Enter the secret as 64 hex characters."
              : secret && !isOperator
                ? "This is not this deployment's operator secret."
                : null
          }
        />
        {isOperator ? (
          <p className="mt-2 text-sm">
            <Badge tone="ok">Operator</Badge>{" "}
            <span className="text-ink-2">Matches the commitment sealed at deployment.</span>
          </p>
        ) : null}
      </Card>
      {isOperator ? (
        <Card>
          <SectionTitle>Register an examiner</SectionTitle>
          <div className="grid gap-4 sm:max-w-xl">
            <TextField
              label="Examiner public key, as the examiner page gives it"
              autoComplete="off"
              spellCheck={false}
              value={keyText}
              onChange={(e) => {
                setKeyText(e.target.value);
              }}
              error={
                keyText.trim() && !examinerKey
                  ? "Paste the public key exactly as the examiner copied it."
                  : known
                    ? "This examiner is already registered."
                    : null
              }
            />
            <Button
              className="w-fit"
              onClick={() => void run("register_examiner", [examinerKey, nowSeconds()])}
              busy={call.busy}
              disabled={!examinerKey || known}
            >
              Register the examiner
            </Button>
          </div>
          {examiners.length > 0 ? (
            <ul className="mt-6 divide-y divide-line border-t border-line">
              {examiners.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="font-mono text-xs text-ink-2">{shortHex(e.id, 10, 8)}</span>
                  {e.active ? (
                    <Button
                      variant="ghost"
                      onClick={() => void run("revoke_examiner", [fromHex(e.id), nowSeconds()])}
                      busy={call.busy}
                    >
                      Revoke
                    </Button>
                  ) : (
                    <Badge tone="bad">Revoked</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4">
            <ProofProgress
              stage={call.stage}
              startedAt={call.startedAt}
              error={call.error}
              doneText="Done and logged."
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function ExaminerView({
  ledger,
  onChanged,
}: {
  ledger: NonNullable<ReturnType<typeof useLedger>["value"]>;
  onChanged: () => void;
}) {
  const { account } = useAccount();
  const [text, setText] = useState("");
  const [fresh, setFresh] = useState<{ scalar: bigint; pk: string } | null>(null);
  const scalar = parseScalar(text);
  const examinerId = scalar ? examinerIdForScalar(scalar) : null;
  const registered = examinerId ? ledger.examiners.member(fromHex(examinerId)) : false;
  const active =
    registered && examinerId ? ledger.examiners.lookup(fromHex(examinerId)).active : false;
  const mine = useMemo(
    () =>
      examinerId ? listCases(ledger).filter(({ c }) => toHex(c.examinerId) === examinerId) : [],
    [ledger, examinerId],
  );
  const opened = useMemo(
    () => (scalar ? mine.map(({ id }) => discloseCase(ledger, fromHex(id), scalar)) : []),
    [mine, ledger, scalar],
  );

  const [ids, setIds] = useState("");
  const [days, setDays] = useState("7");
  const call = useCall();
  const scope = ids
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^0x/i, "").toLowerCase())
    .filter(Boolean);
  const scopeOk =
    scope.length >= 1 &&
    scope.length <= 4 &&
    scope.every((s) => /^[0-9a-f]{64}$/.test(s) && ledger.records.member(fromHex(s))) &&
    new Set(scope).size === scope.length;

  const openCase = () =>
    call.run(async (onStage) => {
      if (!account || !CONTRACTS.disclosure || !scalar) throw new Error("Enter your examiner key.");
      const recordIds = [
        ...scope.map(fromHex),
        ...Array.from({ length: 4 - scope.length }, () => new Uint8Array(32)),
      ];
      const expiry = nowSeconds() + BigInt(Number(days) * 86_400);
      await callCircuit(
        account,
        "disclosure",
        CONTRACTS.disclosure,
        { scalar },
        "open_case",
        [
          pureCircuits.pubKeyOf(scalar),
          recordIds,
          BigInt(scope.length),
          expiry,
          crypto.getRandomValues(new Uint8Array(32)),
          nowSeconds(),
        ],
        onStage,
      );
      setIds("");
      onChanged();
    });

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle aside={<KeyRound aria-hidden className="h-5 w-5 text-ink-3" />}>
          Your examiner key
        </SectionTitle>
        <p className="mb-4 text-sm text-ink-2">
          Your key stays in this tab and is never stored or sent. The records a case names are
          opened here, in your browser, and checked against their anchors.
        </p>
        <div className="grid gap-3 sm:max-w-xl">
          <TextField
            label="Examiner scalar"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            error={
              text.trim() && !scalar ? "Enter the scalar as decimal or 64 hex characters." : null
            }
          />
          {examinerId ? (
            <p className="text-sm">
              {registered ? (
                active ? (
                  <Badge tone="ok">Registered</Badge>
                ) : (
                  <Badge tone="bad">Revoked</Badge>
                )
              ) : (
                <Badge tone="warn">Not registered</Badge>
              )}{" "}
              <span className="text-ink-2">Examiner id {shortHex(examinerId, 8, 6)}</span>
            </p>
          ) : null}
          {!text ? (
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  const key = generateExaminerKey();
                  setFresh({
                    scalar: key.scalar,
                    pk: JSON.stringify({
                      x: key.publicKey.x.toString(),
                      y: key.publicKey.y.toString(),
                    }),
                  });
                }}
              >
                Make a new examiner key
              </Button>
            </div>
          ) : null}
          {fresh ? (
            <Notice tone="warn" title="Save the scalar now. It is shown once.">
              <div className="mt-2 grid gap-2">
                <Copyable value={scalarHex(fresh.scalar)} label="Scalar (secret)" />
                <Copyable value={fresh.pk} label="Public key, for the operator" />
              </div>
            </Notice>
          ) : null}
        </div>
      </Card>
      {scalar && active ? (
        <Card>
          <SectionTitle>Open a case</SectionTitle>
          <p className="mb-4 text-sm text-ink-2">
            Name up to four record ids. The scope is public from this moment and can never be
            widened.
          </p>
          <div className="grid gap-3 sm:max-w-xl">
            <TextField
              label="Record ids, separated by spaces or commas"
              value={ids}
              onChange={(e) => {
                setIds(e.target.value);
              }}
              spellCheck={false}
              autoComplete="off"
              error={
                ids.trim() && !scopeOk
                  ? "Each id must be a record on this ledger, one to four of them, no repeats."
                  : null
              }
            />
            <Segmented
              label="Case expires in"
              value={days}
              onChange={setDays}
              options={[
                { value: "1", label: "1 day" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
              ]}
            />
            <Button onClick={() => void openCase()} busy={call.busy} disabled={!scopeOk}>
              Open the case
            </Button>
            <ProofProgress
              stage={call.stage}
              startedAt={call.startedAt}
              error={call.error}
              doneText="Case opened. Keyholders can now see its scope and decide."
            />
          </div>
        </Card>
      ) : null}
      {scalar ? (
        <Card>
          <SectionTitle>Your cases</SectionTitle>
          {opened.length === 0 ? (
            <EmptyState title="No cases for this key">Cases you open appear here.</EmptyState>
          ) : (
            <div className="space-y-4">
              {opened.map((d) => (
                <Disclosed key={toHex(d.caseId)} d={d} />
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function KeyholderView({
  ledger,
  onChanged,
}: {
  ledger: NonNullable<ReturnType<typeof useLedger>["value"]>;
  onChanged: () => void;
}) {
  const { account } = useAccount();
  const [slot, setSlot] = useState<"0" | "1" | "2">("0");
  const [share, setShare] = useState("");
  const [binding, setBinding] = useState("");
  const s = parseScalar(share);
  const k = parseScalar(binding);
  const call = useCall();
  const pending = listCases(ledger).filter(
    ({ c }) =>
      !c.approvals[Number(slot)] &&
      c.approvalCount < 2n &&
      BigInt(Math.floor(Date.now() / 1000)) < c.expiry,
  );
  const approve = (caseId: string) =>
    call.run(async (onStage) => {
      if (!account || !CONTRACTS.disclosure || !s || !k)
        throw new Error("Enter your share and the binding scalar.");
      await callCircuit(
        account,
        "disclosure",
        CONTRACTS.disclosure,
        { scalar: s, bindingScalar: k },
        "approve_case",
        [fromHex(caseId), BigInt(slot), nowSeconds()],
        onStage,
      );
      onChanged();
    });
  return (
    <Card>
      <SectionTitle>Approve a case as a keyholder</SectionTitle>
      <p className="mb-4 text-sm text-ink-2">
        Read each case's scope before approving. Your approval posts your share for exactly those
        records, sealed to that examiner, and is logged.
      </p>
      <div className="grid gap-3 sm:max-w-xl">
        <Segmented
          label="Your keyholder slot"
          value={slot}
          onChange={setSlot}
          options={[
            { value: "0", label: "Slot 0" },
            { value: "1", label: "Slot 1" },
            { value: "2", label: "Slot 2" },
          ]}
        />
        <TextField
          label="Your share scalar"
          type="password"
          autoComplete="off"
          value={share}
          onChange={(e) => {
            setShare(e.target.value);
          }}
          error={share.trim() && !s ? "Not a valid scalar." : null}
        />
        <TextField
          label="Binding scalar"
          type="password"
          autoComplete="off"
          value={binding}
          onChange={(e) => {
            setBinding(e.target.value);
          }}
          error={binding.trim() && !k ? "Not a valid scalar." : null}
        />
      </div>
      <div className="mt-5">
        {pending.length === 0 ? (
          <p className="text-sm text-ink-3">No open case is waiting for this slot.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map(({ id, c }) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 text-sm">
                  <p className="font-mono text-xs text-ink">{shortHex(id, 10, 8)}</p>
                  <p className="text-ink-2">
                    Scope:{" "}
                    {c.recordIds
                      .slice(0, Number(c.count))
                      .map((r) => shortHex(toHex(r), 4, 4))
                      .join(", ")}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => void approve(id)}
                  busy={call.busy}
                  disabled={!s || !k}
                >
                  Approve
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <ProofProgress
            stage={call.stage}
            startedAt={call.startedAt}
            error={call.error}
            doneText="Approved and logged."
          />
        </div>
      </div>
    </Card>
  );
}

function FilerView({ onChanged }: { onChanged: () => void }) {
  const { account, secret } = useAccount();
  const call = useCall();
  const [amountText, setAmountText] = useState("");
  const [direction, setDirection] = useState<"sent" | "received">("received");
  const [counterparty, setCounterparty] = useState("");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const amount = parseAmount(amountText);
  const tooLong =
    utf8Length(counterparty) > 31 || utf8Length(reference) > 31 || utf8Length(memo) > 62;
  const file = () =>
    call.run(async (onStage) => {
      if (!account || !CONTRACTS.disclosure || !amount.ok) throw new Error("Check the amount.");
      const statement = statementFor({
        amount: amount.value,
        time: nowSeconds(),
        direction,
        counterparty,
        reference,
        memo,
      });
      // The filer secret is derived from the account like its other secrets, so every
      // statement it files is attributable to the same filer once opened.
      const filerSecret = await secret("filer");
      const { result } = await callCircuit<Uint8Array>(
        account,
        "disclosure",
        CONTRACTS.disclosure,
        { secretKey: filerSecret, statement },
        "file_record",
        [],
        onStage,
      );
      setRecordId(toHex(result));
      onChanged();
    });
  return (
    <Card>
      <SectionTitle>File a sealed statement</SectionTitle>
      <p className="mb-4 text-sm text-ink-2">
        Seal a payment statement to the disclosure key so an approved examiner can later read it,
        and nobody else ever can. Give its record id to your accountant to name in a case.
      </p>
      <div className="grid gap-4 sm:max-w-xl">
        <TextField
          label="Amount"
          inputMode="decimal"
          value={amountText}
          onChange={(e) => {
            setAmountText(e.target.value);
          }}
          error={amountText && !amount.ok ? AMOUNT_ERROR_TEXT[amount.error] : null}
        />
        <Segmented
          label="Direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "received", label: "Received" },
            { value: "sent", label: "Sent" },
          ]}
        />
        <TextField
          label="Counterparty"
          placeholder="@aiko_design"
          value={counterparty}
          onChange={(e) => {
            setCounterparty(e.target.value);
          }}
          error={utf8Length(counterparty) > 31 ? "At most 31 bytes." : null}
        />
        <TextField
          label="Reference"
          placeholder="INV-2026-114"
          value={reference}
          onChange={(e) => {
            setReference(e.target.value);
          }}
          error={utf8Length(reference) > 31 ? "At most 31 bytes." : null}
        />
        <TextField
          label="Memo"
          value={memo}
          onChange={(e) => {
            setMemo(e.target.value);
          }}
          error={utf8Length(memo) > 62 ? "At most 62 bytes." : null}
        />
        <Button
          onClick={() => void file()}
          busy={call.busy}
          disabled={!amount.ok || tooLong || !account}
        >
          File the statement
        </Button>
        {!account ? <p className="text-sm text-ink-3">Connect a wallet to file.</p> : null}
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="Sealed and filed."
        />
        {recordId ? <Copyable value={recordId} label="Record id" /> : null}
      </div>
    </Card>
  );
}

export default function Examine() {
  const [role, setRole] = useState<Role>("public");
  const [tick, setTick] = useState(0);
  const ledger = useLedger(tick);
  const bump = () => {
    setTick((t) => t + 1);
  };
  return (
    <div>
      <PageHeader eyebrow="Examine" title="Exactly the records a case names, and nothing more">
        An accountant, auditor or regulator sees only the records named in one case, after two of
        three independent keyholders approve. Every step is in the public log below.
      </PageHeader>
      <ContractNotice contracts={["disclosure"]} />
      <div className="mb-6 max-w-2xl">
        <Segmented<Role>
          label="I am"
          value={role}
          onChange={setRole}
          options={[
            {
              value: "public",
              label: "Anyone",
              hint: "The deployment check, every case and the disclosure log. No key needed.",
            },
            {
              value: "operator",
              label: "The operator",
              hint: "Register and revoke examiners. Opens nothing.",
            },
            {
              value: "examiner",
              label: "An examiner",
              hint: "Open a case and read the records it names, once two keyholders approve.",
            },
            {
              value: "keyholder",
              label: "A keyholder",
              hint: "Review a case's scope and approve it with your share.",
            },
            {
              value: "filer",
              label: "An account holder",
              hint: "File a sealed statement an approved examiner can read.",
            },
          ]}
        />
      </div>
      {role === "filer" ? (
        <FilerView onChanged={bump} />
      ) : !CONTRACTS.disclosure ? (
        <EmptyState title="Nothing to read yet">
          The deployment check, the cases and the disclosure log are read from the disclosure
          contract. They appear here once this build names one.
        </EmptyState>
      ) : ledger.status === "error" ? (
        <Notice tone="bad" title="The disclosure contract could not be read">
          {ledger.message}
        </Notice>
      ) : !ledger.value ? (
        <Skeleton className="h-64 w-full" />
      ) : role === "public" ? (
        <PublicView ledger={ledger.value} />
      ) : role === "operator" ? (
        <OperatorView ledger={ledger.value} onChanged={bump} />
      ) : role === "examiner" ? (
        <ExaminerView ledger={ledger.value} onChanged={bump} />
      ) : (
        <KeyholderView ledger={ledger.value} onChanged={bump} />
      )}
      <Card className="mt-6">
        <SectionTitle>How it works</SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          <PrivacyLine>
            Filing seals each field of a statement to a disclosure key nobody holds. It was split
            two of three between keyholders at deployment and destroyed.
          </PrivacyLine>
          <PrivacyLine>
            The operator registers vetted examiners. An examiner opens a case naming up to four
            records; the scope is public before anyone approves.
          </PrivacyLine>
          <PrivacyLine>
            Each approving keyholder posts shares sealed to that examiner and bound to that case, so
            shares from two different cases never combine.
          </PrivacyLine>
          <PrivacyLine>
            The examiner combines two shares in the browser, opens each record and checks it against
            its on-chain anchor. A record counts as disclosed only if that check passes.
          </PrivacyLine>
        </div>
      </Card>
    </div>
  );
}

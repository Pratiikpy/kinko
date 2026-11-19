import {
  decodeLinkPayload,
  encodeLinkPayload,
  normaliseTag,
  ownsTag,
  TAG_MAX_LENGTH,
  TAG_MIN_LENGTH,
  tagOwnerOf,
} from "@kinko/kinko-pay";
import { AtSign } from "lucide-react";
import { useEffect, useState } from "react";

import { ConnectGate, ContractNotice } from "../../components/Gates.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
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
  TextField,
} from "../../components/ui.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { useCall } from "../../hooks/useCall.ts";
import { CONTRACTS } from "../../lib/config.ts";
import { fromHex, relativeTime, toHex } from "../../lib/format.ts";
import { callCircuit } from "../../lib/midnight/contracts.ts";
import { readerFor } from "../../lib/midnight/providers.ts";
import { readTagsLedger } from "../../lib/pay.ts";
import { patch, remove, type TagRecordLocal, upsert } from "../../lib/records.ts";
import { useAccount } from "../../state/account.tsx";

const tagError = (input: string): string | null => {
  if (!input.trim()) return null;
  const n = normaliseTag(input);
  return n.ok
    ? null
    : `Use ${String(TAG_MIN_LENGTH)} to ${String(TAG_MAX_LENGTH)} lowercase letters, digits or underscores.`;
};

/** What a person who wants to receive a tag hands its current owner. */
interface ReceiveCode {
  v: 1;
  n: string;
  o: string;
  c: string;
  e: string;
}

function useTagsLedger(deps: unknown[]) {
  const { account } = useAccount();
  return useAsync(
    async () => {
      if (!CONTRACTS.tags) throw new Error("The tag registry is not deployed in this build.");
      return readTagsLedger(await readerFor(account), CONTRACTS.tags);
    },
    [account, ...deps],
    { enabled: Boolean(CONTRACTS.tags), intervalMs: 30_000 },
  );
}

function Claim({ onDone }: { onDone: () => void }) {
  const { account, update } = useAccount();
  const call = useCall();
  const [name, setName] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebounced(name);
    }, 300);
    return () => {
      window.clearTimeout(t);
    };
  }, [name]);
  const n = normaliseTag(debounced);
  const ledger = useTagsLedger([debounced]);
  const taken = n.ok && ledger.status === "ready" ? ledger.value.tags.member(n.bytes) : undefined;

  const claim = () =>
    call.run(async (onStage) => {
      const tag = normaliseTag(name);
      if (!account || !CONTRACTS.tags || !tag.ok) throw new Error("Choose a valid tag.");
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const { txId } = await callCircuit(
        account,
        "tags",
        CONTRACTS.tags,
        { tagSecret: secret },
        "register_tag",
        [
          tag.bytes,
          { bytes: fromHex(account.coinPublicKey) },
          fromHex(account.encryptionPublicKey),
        ],
        onStage,
      );
      await update((doc) =>
        upsert(doc, "tags", {
          name: tag.name,
          secret: toHex(secret),
          registeredAt: Date.now(),
          txId,
        } satisfies TagRecordLocal),
      );
      setName("");
      onDone();
    });

  return (
    <Card>
      <SectionTitle>Claim a tag</SectionTitle>
      <form
        className="grid gap-4 sm:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          void claim();
        }}
      >
        <TextField
          label="Your tag"
          placeholder="aiko_design"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          error={tagError(name) ?? (taken ? `@${n.ok ? n.name : ""} is taken.` : null)}
          hint={
            n.ok && taken === false
              ? `@${n.name} is available.`
              : "People pay you by this name instead of an address."
          }
        />
        <Button
          type="submit"
          busy={call.busy}
          disabled={!n.ok || taken !== false || !CONTRACTS.tags}
        >
          Claim {n.ok ? `@${n.name}` : "it"}
        </Button>
        <ProofProgress
          stage={call.stage}
          startedAt={call.startedAt}
          error={call.error}
          doneText="The tag is yours."
        />
      </form>
    </Card>
  );
}

function Owned({ tag, onChange }: { tag: TagRecordLocal; onChange: () => void }) {
  const { account, update } = useAccount();
  const call = useCall();
  const [code, setCode] = useState("");
  const [confirmRelease, setConfirmRelease] = useState(false);
  const ledger = useTagsLedger([tag.name, call.stage]);
  const n = normaliseTag(tag.name);
  const owns =
    ledger.status === "ready" && n.ok
      ? ownsTag(ledger.value, n.bytes, fromHex(tag.secret))
      : undefined;
  const record =
    ledger.status === "ready" && n.ok && ledger.value.tags.member(n.bytes)
      ? ledger.value.tags.lookup(n.bytes)
      : undefined;
  const pointsHere =
    record && account ? toHex(record.coin_pk.bytes) === account.coinPublicKey : undefined;
  // A tag that was waiting to be transferred here becomes ours once the ledger says so.
  useEffect(() => {
    if (owns && !tag.registeredAt)
      void update((doc) => patch(doc, "tags", tag.name, { registeredAt: Date.now() }));
  }, [owns, tag.registeredAt, tag.name, update]);
  const receive = code.trim()
    ? (decodeLinkPayload(code.trim()) as Partial<ReceiveCode> | undefined)
    : undefined;
  const receiveOk =
    receive?.v === 1 &&
    receive.n === tag.name &&
    [receive.o, receive.c, receive.e].every(
      (h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
    );

  const run = (circuit: "update_tag_keys" | "release_tag" | "transfer_tag") =>
    call.run(async (onStage) => {
      if (!account || !CONTRACTS.tags || !n.ok) throw new Error("Connect your wallet first.");
      const args =
        circuit === "update_tag_keys"
          ? [
              n.bytes,
              { bytes: fromHex(account.coinPublicKey) },
              fromHex(account.encryptionPublicKey),
            ]
          : circuit === "release_tag"
            ? [n.bytes]
            : [
                n.bytes,
                fromHex(receive?.o ?? ""),
                { bytes: fromHex(receive?.c ?? "") },
                fromHex(receive?.e ?? ""),
              ];
      await callCircuit(
        account,
        "tags",
        CONTRACTS.tags,
        { tagSecret: fromHex(tag.secret) },
        circuit,
        args,
        onStage,
      );
      if (circuit !== "update_tag_keys") await update((doc) => remove(doc, "tags", tag.name));
      onChange();
    });

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AtSign aria-hidden className="h-5 w-5 text-shu" />
          <div>
            <p className="font-display text-lg text-ink">@{tag.name}</p>
            <p className="text-xs text-ink-3">
              {tag.registeredAt
                ? `Claimed ${relativeTime(tag.registeredAt)}`
                : "Waiting to be transferred to you"}
            </p>
          </div>
        </div>
        {owns === undefined ? (
          <Badge>Checking</Badge>
        ) : owns ? (
          <Badge tone="ok">Yours</Badge>
        ) : tag.registeredAt ? (
          <Badge tone="bad">No longer yours</Badge>
        ) : (
          <Badge tone="warn">Pending</Badge>
        )}
      </div>
      {owns ? (
        <div className="mt-4 space-y-4">
          {pointsHere === false ? (
            <Notice
              tone="warn"
              title="Payments to this tag go to another wallet"
              action={
                <Button
                  variant="secondary"
                  onClick={() => void run("update_tag_keys")}
                  busy={call.busy}
                >
                  Point it here
                </Button>
              }
            >
              The tag's receiving keys are not this wallet's. Point it at this wallet to receive
              here.
            </Notice>
          ) : null}
          <div className="grid gap-3 sm:max-w-lg">
            <TextField
              label="Transfer to someone: paste their receive code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              spellCheck={false}
              autoComplete="off"
              error={
                code.trim() && !receiveOk ? `That is not a receive code for @${tag.name}.` : null
              }
            />
            <Button
              variant="secondary"
              onClick={() => void run("transfer_tag")}
              busy={call.busy}
              disabled={!receiveOk}
            >
              Transfer @{tag.name}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {confirmRelease ? (
              <>
                <span className="text-sm text-bad">
                  Anyone can claim it next, and payments to @{tag.name} will go to them.
                </span>
                <Button variant="danger" onClick={() => void run("release_tag")} busy={call.busy}>
                  Release it
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConfirmRelease(false);
                  }}
                >
                  Keep it
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmRelease(true);
                }}
              >
                Release this tag
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {owns === false && tag.registeredAt ? (
        <Button
          className="mt-3"
          variant="ghost"
          onClick={() => void update((doc) => remove(doc, "tags", tag.name))}
        >
          Remove from this list
        </Button>
      ) : null}
      {call.stage !== "idle" ? (
        <div className="mt-3">
          <ProofProgress stage={call.stage} startedAt={call.startedAt} error={call.error} />
        </div>
      ) : null}
    </li>
  );
}

function Receive() {
  const { account, update, records } = useAccount();
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const n = normaliseTag(name);
  const make = async () => {
    if (!account || !n.ok) return;
    const existing = records?.tags.find((t) => t.name === n.name && !t.registeredAt);
    const secret = existing ? fromHex(existing.secret) : crypto.getRandomValues(new Uint8Array(32));
    if (!existing)
      await update((doc) =>
        upsert(doc, "tags", { name: n.name, secret: toHex(secret), registeredAt: 0 }),
      );
    const payload: ReceiveCode = {
      v: 1,
      n: n.name,
      o: toHex(tagOwnerOf(n.bytes, secret)),
      c: account.coinPublicKey,
      e: account.encryptionPublicKey,
    };
    setCode(encodeLinkPayload(payload));
  };
  useEffect(() => {
    setCode(null);
  }, [name]);
  return (
    <Card>
      <SectionTitle>Receive a tag from its owner</SectionTitle>
      <p className="mb-4 text-sm text-ink-2">
        Make a receive code and give it to the current owner. Their transfer names you as owner and
        points the tag at this wallet in one step.
      </p>
      <div className="grid gap-3 sm:max-w-md">
        <TextField
          label="Tag"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
          error={tagError(name)}
        />
        <Button variant="secondary" onClick={() => void make()} disabled={!n.ok}>
          Make a receive code
        </Button>
        {code ? <Copyable value={code} label="Receive code" /> : null}
      </div>
    </Card>
  );
}

export default function Tags() {
  const { records } = useAccount();
  const [, setTick] = useState(0);
  const tags = records?.tags ?? [];
  return (
    <div>
      <PageHeader eyebrow="Your @tag" title="Be paid by name, not by address">
        A tag points at your private receiving keys. People pay @you; the chain never records which
        payments reached which tag.
      </PageHeader>
      <ContractNotice contracts={["tags"]} />
      <ConnectGate what="claim a tag">
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            <Claim
              onDone={() => {
                setTick((t) => t + 1);
              }}
            />
            <Receive />
          </div>
          <div className="space-y-6">
            <Card>
              <SectionTitle>Your tags</SectionTitle>
              {tags.length === 0 ? (
                <EmptyState title="No tag yet">Claim one to be paid by name.</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {tags.map((t) => (
                    <Owned
                      key={t.name}
                      tag={t}
                      onChange={() => {
                        setTick((x) => x + 1);
                      }}
                    />
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <div className="space-y-3">
                <PrivacyLine>Public: the tag name and the receiving keys it points at.</PrivacyLine>
                <PrivacyLine>
                  Private: who owns it (only a hash bound to the tag is stored) and every payment
                  made to it.
                </PrivacyLine>
                <PrivacyLine>
                  Your owner secret for each tag is kept in your encrypted records. Back them up in
                  Settings.
                </PrivacyLine>
              </div>
            </Card>
          </div>
        </div>
      </ConnectGate>
    </div>
  );
}

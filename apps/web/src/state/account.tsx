import { useNightKit } from "nightkit-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { explain } from "../lib/errors.ts";
import { fromHex, toHex } from "../lib/format.ts";
import type { Account } from "../lib/midnight/providers.ts";
import { emptyRecords, isRecordsDoc, type RecordsDoc } from "../lib/records.ts";
import { type KeySource, openSlot, type SecureSlot } from "../lib/secure-store.ts";
import { useDeployment } from "./deployment.tsx";

/** Labels for the secrets an account derives; changing one orphans what it protects. */
const SECRET_LABELS = {
  records: "kinko:records:v1",
  vault: "kinko:vault-identity:v1",
  merchant: "kinko:merchant-key:v1",
  issuer: "kinko:gift-issuer:v1",
  filer: "kinko:disclosure-filer:v1",
} as const;

type SecretKind = "vault" | "merchant" | "issuer" | "filer";
const RECORD_FIELD: Record<
  SecretKind,
  "vaultSecret" | "merchantKey" | "issuerSecret" | "filerSecret"
> = {
  vault: "vaultSecret",
  merchant: "merchantKey",
  issuer: "issuerSecret",
  filer: "filerSecret",
};

export type BalanceState =
  | { readonly status: "unknown" }
  | { readonly status: "ready"; readonly kusd: bigint; readonly night: bigint; readonly at: number }
  | { readonly status: "error"; readonly message: string };

interface AccountValue {
  readonly account: Account | null;
  readonly walletName: string | null;
  /** The Ethereum account a NightKit account was opened from, if any. */
  readonly openedWith: string | null;
  readonly fees: "sponsor" | "self" | "wallet";
  readonly sync: { synced: boolean; progress: number | null } | null;
  readonly records: RecordsDoc | null;
  readonly recordsSource: KeySource | null;
  readonly recordsError: string | null;
  readonly balance: BalanceState;
  readonly update: (change: (doc: RecordsDoc) => RecordsDoc) => Promise<void>;
  /** A 32-byte secret of this account: derived when the wallet can, otherwise kept in the records. */
  readonly secret: (kind: SecretKind) => Promise<Uint8Array>;
  readonly refreshBalance: () => void;
  readonly replaceRecords: (doc: RecordsDoc) => Promise<void>;
}

const Ctx = createContext<AccountValue | null>(null);

const NIGHT_TOKEN = "0".repeat(64);

export function AccountProvider({ children }: { children: ReactNode }) {
  const { kit, session, sync } = useNightKit();

  // A returning visitor stays signed in across reloads: reconnect to the
  // Midnight wallet used last time, which NightKit forgets on disconnect. Only
  // injected wallets reconnect on their own; 1AM's vault and Ethereum sign-in
  // open a sheet, which must follow a click.
  useEffect(() => {
    const last = kit.lastWalletId();
    if (!last?.startsWith("midnight:")) return;
    let tries = 0;
    const attempt = () => {
      if (kit.getState().status !== "disconnected") return;
      if (kit.wallets().some((w) => w.id === last && w.installed)) {
        // A wallet that now refuses simply leaves the Connect button in place.
        void kit.connect(last).catch(() => undefined);
      } else if (++tries < 10) {
        // Extensions can inject a moment after the page starts.
        window.setTimeout(attempt, 200);
      }
    };
    attempt();
  }, [kit]);
  const { state: deployment } = useDeployment();
  const [records, setRecords] = useState<RecordsDoc | null>(null);
  const [recordsSource, setSource] = useState<KeySource | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState>({ status: "unknown" });
  const [balanceTick, setBalanceTick] = useState(0);
  const slotRef = useRef<SecureSlot | null>(null);
  const docRef = useRef<RecordsDoc | null>(null);
  const writeChain = useRef<Promise<void>>(Promise.resolve());

  const account = useMemo<Account | null>(
    () =>
      session
        ? {
            api: session.api,
            coinPublicKey: session.addresses.coinPublicKey.toLowerCase(),
            encryptionPublicKey: session.addresses.encryptionPublicKey.toLowerCase(),
            shieldedAddress: session.addresses.shielded,
          }
        : null,
    [session],
  );

  // Open the encrypted records whenever the account changes.
  useEffect(() => {
    // An object, so the type checker does not assume the flag never changes.
    const run = { live: true };
    slotRef.current = null;
    docRef.current = null;
    setRecords(null);
    setSource(null);
    setRecordsError(null);
    if (!session || !account) return;
    void (async () => {
      try {
        const appSecret = session.vault
          ? await session.vault.appSecret(SECRET_LABELS.records)
          : undefined;
        const slot = await openSlot(account.coinPublicKey, appSecret);
        const loaded = await slot.load();
        if (!run.live) return;
        const doc = isRecordsDoc(loaded) ? loaded : emptyRecords();
        slotRef.current = slot;
        docRef.current = doc;
        setRecords(doc);
        setSource(slot.source);
      } catch (e) {
        if (run.live) setRecordsError(explain(e).message);
      }
    })();
    return () => {
      run.live = false;
    };
  }, [session, account]);

  const persist = useCallback(async (next: RecordsDoc) => {
    const slot = slotRef.current;
    if (!slot) throw new Error("Your records are not open yet.");
    docRef.current = next;
    setRecords(next);
    // Writes are serialised so a slow encrypt can never land after a newer one.
    writeChain.current = writeChain.current
      .then(() => slot.save(next))
      .catch((e: unknown) => {
        setRecordsError(explain(e).message);
      });
    await writeChain.current;
  }, []);

  const update = useCallback(
    async (change: (doc: RecordsDoc) => RecordsDoc) => {
      const current = docRef.current;
      if (!current) throw new Error("Your records are not open yet. Connect your wallet first.");
      await persist(change(current));
    },
    [persist],
  );

  const secret = useCallback(
    async (kind: SecretKind): Promise<Uint8Array> => {
      if (!session) throw new Error("Connect your wallet first.");
      if (session.vault) return session.vault.appSecret(SECRET_LABELS[kind]);
      const current = docRef.current;
      if (!current) throw new Error("Your records are not open yet.");
      const field = RECORD_FIELD[kind];
      const existing = current[field];
      if (existing) return fromHex(existing);
      const fresh = crypto.getRandomValues(new Uint8Array(32));
      await persist({ ...current, [field]: toHex(fresh) });
      return fresh;
    },
    [session, persist],
  );

  // KUSD and NIGHT balances, from the wallet itself.
  useEffect(() => {
    if (!account) {
      setBalance({ status: "unknown" });
      return;
    }
    // An object, so the type checker does not assume the flag never changes.
    const run = { live: true };
    const read = async () => {
      try {
        const balances = await account.api.getShieldedBalances();
        const unshielded = await account.api.getUnshieldedBalances().catch(() => ({}));
        // The vault's colour derivation loads the contract runtime, so it is
        // fetched only once someone is connected, never on the landing page.
        const { kusdTokenType } = await import("../lib/vault.ts");
        if (!run.live) return;
        const kusdKey =
          deployment.status === "ready"
            ? kusdTokenType(
                deployment.deployment.usdcAddress,
                deployment.deployment.vaultContractAddress,
              ).toLowerCase()
            : null;
        const lower = Object.fromEntries(
          Object.entries(balances).map(([k, v]) => [k.toLowerCase(), v]),
        );
        const unshieldedLower = Object.fromEntries(
          Object.entries(unshielded).map(([k, v]) => [k.toLowerCase(), v]),
        );
        setBalance({
          status: "ready",
          kusd: kusdKey ? (lower[kusdKey] ?? 0n) : 0n,
          night: unshieldedLower[NIGHT_TOKEN] ?? 0n,
          at: Date.now(),
        });
      } catch (e) {
        if (run.live) setBalance({ status: "error", message: explain(e).message });
      }
    };
    void read();
    const id = window.setInterval(() => void read(), 20_000);
    return () => {
      run.live = false;
      window.clearInterval(id);
    };
  }, [account, deployment, balanceTick]);

  const value = useMemo<AccountValue>(
    () => ({
      account,
      walletName: session?.name ?? null,
      openedWith: session?.vault
        ? `${session.vault.signer.walletName} · ${session.vault.signer.address}`
        : null,
      fees: session?.vault ? session.vault.fees : "wallet",
      sync: sync ?? null,
      records,
      recordsSource,
      recordsError,
      balance,
      update,
      secret,
      refreshBalance: () => {
        setBalanceTick((t) => t + 1);
      },
      replaceRecords: persist,
    }),
    [
      account,
      session,
      sync,
      records,
      recordsSource,
      recordsError,
      balance,
      update,
      secret,
      persist,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount must be used inside AccountProvider");
  return v;
}

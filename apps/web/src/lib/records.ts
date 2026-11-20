// The account's private records: what this device knows that the chain does not.
//
// Invoice terms and owner secrets, payment receipts, gift card secrets, card
// secrets, tag ownership, and the vault requests in flight. None of it is ever
// sent anywhere. It is kept encrypted at rest (see secure-store.ts) and only
// ever changed through the pure functions below, which return a new document.

import type { RequestKind, Stage } from "./relayer.ts";

/** The records format; a document of another version is not read. */
export const RECORDS_VERSION = 1;

/** A deposit or withdrawal this device started, persisted so a closed tab can resume it. */
export interface VaultRequestRecord {
  readonly localId: string;
  readonly kind: RequestKind;
  /** Base units, as a decimal string (JSON has no bigint). */
  readonly amount: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Where this device is in the flow:
   *  funding     waiting for USDC at the deposit address (deposit only)
   *  starting    the start circuit is being proved and submitted
   *  relaying    the relayer is carrying it; `lastStage` mirrors its report
   *  completing  the complete circuit is being proved and submitted
   *  done        closed on chain
   *  failed      stopped; `error` says why and the screen offers the way on
   */
  readonly phase: "funding" | "starting" | "relaying" | "completing" | "done" | "failed";
  readonly requestId?: string;
  /** The vault's input buffer index the start circuit used, as a decimal string. */
  readonly inIndex?: string;
  readonly depositAddress?: string;
  readonly destination?: string;
  readonly fee?: string;
  readonly lastStage?: Stage;
  readonly evmTxHash?: string;
  readonly error?: string;
  /** For a settled withdrawal or deposit: what the attestation said. */
  readonly outcome?: "succeeded" | "refunded" | "nothing-minted";
}

/** Who pays an invoice: once, many payers, or open-ended gifts. */
export type InvoiceKindName = "standard" | "multipay" | "donation";

/** An invoice this account issued. Holds the owner secret, so it never leaves the device. */
export interface InvoiceRecord {
  readonly commitment: string;
  readonly title: string;
  readonly memo: string;
  readonly amount: string;
  readonly kind: InvoiceKindName;
  /** The asset it is paid in. Absent on records made before NIGHT invoices could be imported: KUSD. */
  readonly token?: "KUSD" | "NATIVE";
  readonly merchantKey: string;
  readonly payout: string;
  readonly salt: string;
  readonly ownerSecret: string;
  readonly expiresAt: string;
  readonly createdAt: number;
  readonly link: string;
  readonly createTxId?: string;
  /** Last status read from the ledger, cached for the list view. */
  readonly status?: "open" | "settled" | "cancelled" | "unknown";
  readonly contributions?: number;
  readonly checkedAt?: number;
}

/** A payment this account made. The receipt digest is public; what it binds is not. */
export interface PaymentRecord {
  readonly id: string;
  readonly to: string;
  readonly toLabel: string;
  readonly amount: string;
  readonly createdAt: number;
  readonly kind: "invoice" | "tag" | "address" | "batch" | "gift";
  readonly txId?: string;
  /** Invoice payments only: everything needed to prove this one payment later. */
  readonly invoiceCommitment?: string;
  /** The payment link that was paid: its fragment holds the invoice terms. */
  readonly invoiceLink?: string;
  readonly invoiceKind?: InvoiceKindName;
  readonly receipt?: string;
  readonly payerKey?: string;
  readonly refundTo?: string;
  readonly refundEnc?: string;
  readonly index?: string;
  readonly memo?: string;
}

/** A gift card this account issued or received. The secret is the money. */
export interface GiftRecord {
  readonly commitment: string;
  readonly secret: string;
  readonly issuerId: string;
  readonly amount: string;
  readonly role: "issued" | "received";
  readonly label: string;
  readonly createdAt: number;
  readonly fundTxId?: string;
  readonly redeemedAt?: number;
  readonly voided?: boolean;
  /** Where on the chain the card was made, so it opens without replaying the chain. */
  readonly birth?: string;
}

/**
 * A PIN card made on this device. Its PIN is never stored, so these records
 * alone cannot open it: someone with the records still needs the PIN.
 */
export interface CardRecord {
  /** The card's shielded address, which is also its id here. */
  readonly address: string;
  /** The card's 32 bytes, hex: what is printed on it. */
  readonly secret: string;
  readonly label: string;
  readonly createdAt: number;
  /** When its owner froze it by moving the balance back. */
  readonly frozenAt?: number;
  /** Where on the chain the card was made, so it opens without replaying the chain. */
  readonly birth?: string;
}

/**
 * The PIN cards in a document. Cards from before cards were wallets carry no
 * address; they held no money and are left out.
 *
 * @param doc - The records.
 * @returns The current PIN cards.
 */
export const pinCards = (doc: RecordsDoc | null | undefined): readonly CardRecord[] =>
  (doc?.cards ?? []).filter((c) => typeof (c as Partial<CardRecord>).address === "string");

/** A tag this account controls. */
export interface TagRecordLocal {
  readonly name: string;
  readonly secret: string;
  readonly registeredAt: number;
  readonly txId?: string;
}

/** Everything this device keeps for one account, encrypted at rest. */
export interface RecordsDoc {
  readonly version: typeof RECORDS_VERSION;
  /** Vault identity secret for wallets that cannot derive one (hex). */
  readonly vaultSecret?: string;
  /** This account's merchant identity key for invoices (hex). */
  readonly merchantKey?: string;
  /** Issuer secret for gift cards (hex). */
  readonly issuerSecret?: string;
  /** Filer secret for sealed disclosure statements (hex). */
  readonly filerSecret?: string;
  readonly requests: readonly VaultRequestRecord[];
  readonly invoices: readonly InvoiceRecord[];
  readonly payments: readonly PaymentRecord[];
  readonly gifts: readonly GiftRecord[];
  readonly cards: readonly CardRecord[];
  readonly tags: readonly TagRecordLocal[];
}

/**
 * A fresh, empty records document.
 *
 * @returns The document.
 */
export const emptyRecords = (): RecordsDoc => ({
  version: RECORDS_VERSION,
  requests: [],
  invoices: [],
  payments: [],
  gifts: [],
  cards: [],
  tags: [],
});

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

/**
 * Shape check for a document read back from storage or an imported backup.
 *
 * @param v - The parsed value.
 * @returns True when it is a records document of this version.
 */
export function isRecordsDoc(v: unknown): v is RecordsDoc {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.version === RECORDS_VERSION &&
    isArray(d.requests) &&
    isArray(d.invoices) &&
    isArray(d.payments) &&
    isArray(d.gifts) &&
    isArray(d.cards) &&
    isArray(d.tags)
  );
}

type Keyed = "requests" | "invoices" | "payments" | "gifts" | "cards" | "tags";
type Item<K extends Keyed> = RecordsDoc[K][number];

const keyOf: { [K in Keyed]: (item: Item<K>) => string } = {
  requests: (r) => r.localId,
  invoices: (r) => r.commitment,
  payments: (r) => r.id,
  gifts: (r) => r.commitment,
  cards: (r) => r.address,
  tags: (r) => r.name,
};

/**
 * Insert or replace one record, newest first.
 *
 * @param doc - The current document.
 * @param collection - Which kind of record.
 * @param item - The record.
 * @returns A new document; the current one is unchanged.
 */
export function upsert<K extends Keyed>(doc: RecordsDoc, collection: K, item: Item<K>): RecordsDoc {
  const get = keyOf[collection];
  const key = get(item);
  const rest = (doc[collection] as readonly Item<K>[]).filter((existing) => get(existing) !== key);
  return { ...doc, [collection]: [item, ...rest] };
}

/**
 * Merge fields into one record by key.
 *
 * @param doc - The current document.
 * @param collection - Which kind of record.
 * @param key - The record's key.
 * @param fields - The fields to set.
 * @returns A new document, or the same one when no record has that key.
 */
export function patch<K extends Keyed>(
  doc: RecordsDoc,
  collection: K,
  key: string,
  fields: Partial<Item<K>>,
): RecordsDoc {
  const list = doc[collection] as readonly Item<K>[];
  const get = keyOf[collection];
  if (!list.some((i) => get(i) === key)) return doc;
  return { ...doc, [collection]: list.map((i) => (get(i) === key ? { ...i, ...fields } : i)) };
}

/**
 * Remove one record by key.
 *
 * @param doc - The current document.
 * @param collection - Which kind of record.
 * @param key - The record's key.
 * @returns A new document without that record.
 */
export function remove(doc: RecordsDoc, collection: Keyed, key: string): RecordsDoc {
  const get = keyOf[collection] as (i: Item<Keyed>) => string;
  return {
    ...doc,
    [collection]: (doc[collection] as readonly Item<Keyed>[]).filter((i) => get(i) !== key),
  };
}

/**
 * Requests the user still has to see through, oldest first.
 *
 * @param doc - The records.
 * @returns The unfinished deposits and withdrawals.
 */
export const openRequests = (doc: RecordsDoc): VaultRequestRecord[] =>
  doc.requests.filter((r) => r.phase !== "done").sort((a, b) => a.createdAt - b.createdAt);

/**
 * A short random id for local records.
 *
 * @returns 18 hex characters.
 */
export const localId = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** One entry of the account's activity feed, merged across record kinds. */
export interface ActivityItem {
  readonly id: string;
  readonly at: number;
  readonly title: string;
  readonly detail: string;
  readonly amount: string;
  readonly direction: "in" | "out" | "neutral";
  readonly href: string;
}

/**
 * The account's recent activity, merged from requests, payments and invoices.
 *
 * @param doc - The records.
 * @param limit - How many entries to return.
 * @returns The newest entries first.
 */
export function activity(doc: RecordsDoc, limit = 12): ActivityItem[] {
  const items: ActivityItem[] = [
    ...doc.requests.map((r): ActivityItem => ({
      id: `r-${r.localId}`,
      at: r.updatedAt,
      title: r.kind === "deposit" ? "Added from Ethereum" : "Withdrew to Ethereum",
      detail:
        r.phase === "done" ? "Settled" : r.phase === "failed" ? "Needs attention" : "In progress",
      amount: r.amount,
      direction: r.kind === "deposit" ? "in" : "out",
      href:
        r.kind === "deposit"
          ? `/app/add?request=${r.localId}`
          : `/app/withdraw?request=${r.localId}`,
    })),
    ...doc.payments.map((p): ActivityItem => ({
      id: `p-${p.id}`,
      at: p.createdAt,
      title: `Paid ${p.toLabel}`,
      detail:
        p.kind === "invoice"
          ? "Invoice, private receipt kept"
          : p.kind === "batch"
            ? "Batch payment"
            : "Private transfer",
      amount: p.amount,
      direction: "out",
      href: "/app/receipts",
    })),
    ...doc.invoices.map((i): ActivityItem => ({
      id: `i-${i.commitment}`,
      at: i.createdAt,
      title: `Requested: ${i.title || "Invoice"}`,
      detail:
        i.status === "settled"
          ? "Paid"
          : i.status === "cancelled"
            ? "Cancelled"
            : "Waiting for payment",
      amount: i.amount,
      direction: "in",
      href: `/app/invoices/${i.commitment}`,
    })),
  ];
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

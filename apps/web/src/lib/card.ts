// Cards in the browser: reading what a holder typed or scanned, opening the
// card as a wallet, and handing it to the rest of the app as an Account.
//
// The card wallet (the wallet SDK and its WASM) is loaded only when a card is
// opened, so pages that never see a card never pay for it.

import type * as CardModuleNamespace from "@kinko/card";
import type { CardWallet, FeePayer } from "@kinko/card";
import { cardEntropy, entropyOfPhrase } from "@kinko/card/seed";
import { decodeGiftCard, decodePinCard, isBirth, type ReceivedCard } from "@kinko/kinko-pay";
import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";

import { snapshotFor } from "./card-snapshot.ts";
import { NETWORK_ID, NODE_URL, PROOF_SERVER_URL, PUBLIC_INDEXER, SPONSOR_URL } from "./config.ts";
import { fromHex } from "./format.ts";
import type { Account } from "./midnight/providers.ts";

type CardModule = typeof CardModuleNamespace;
/** A card opened as a wallet, and what it holds as last read from the chain. */
export type { CardState, CardWallet } from "@kinko/card";

/** A card as the holder presents it, before any PIN. */
export type CardInput =
  | ({ readonly kind: "gift" } & ReceivedCard)
  | { readonly kind: "pin"; readonly secret: string; readonly birth?: string }
  | { readonly kind: "phrase"; readonly entropy: Uint8Array; readonly birth?: string };

/** Words in a card's recovery phrase. */
const PHRASE_WORDS = 24;

/**
 * A birth as a holder may have typed it: with a label, in capitals, or with a trailing stop.
 *
 * @param text - The 25th item after a recovery phrase.
 * @returns The birth, or undefined when it cannot be read as one.
 */
function readBirth(text: string): string | undefined {
  const candidate = text
    .replace(/^birth[:=]?/i, "")
    .replace(/[.,;]+$/, "")
    .toLowerCase();
  return isBirth(candidate) ? candidate : undefined;
}

/**
 * Read a card from what a holder pasted: a gift card link, a PIN card link, or
 * a 24-word recovery phrase, which may be followed by the card's birth (the card's page shows it
 * beside the phrase) so that the card opens from its start instead of replaying the chain.
 *
 * @param text - The pasted text.
 * @returns The card, or undefined when it is none of those.
 */
export function parseCardInput(text: string): CardInput | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const gift = decodeGiftCard(t);
  if (gift) return { kind: "gift", ...gift };
  const pin = decodePinCard(t);
  if (pin) return { kind: "pin", secret: pin.secret, ...(pin.birth ? { birth: pin.birth } : {}) };
  const words = t.split(/\s+/);
  // 24 words, then optionally a 25th item: the birth, which a holder may have typed with a label,
  // capitals or a full stop. One that cannot be read is dropped, as a link's is, and the card opens
  // the slow way rather than refusing a phrase that is right.
  const extra = words.length === PHRASE_WORDS + 1 ? words[PHRASE_WORDS] : undefined;
  const birth = extra === undefined ? undefined : readBirth(extra);
  const entropy = entropyOfPhrase(extra === undefined ? t : words.slice(0, PHRASE_WORDS).join(" "));
  return entropy ? { kind: "phrase", entropy, ...(birth ? { birth } : {}) } : undefined;
}

/**
 * The same card without its birth, to open the slow way: the whole chain is read, so a snapshot
 * that was wrong in any way cannot matter.
 *
 * @param input - The card.
 * @returns The card with no birth.
 */
export function withoutBirth(input: CardInput): CardInput {
  if (input.kind === "pin") return { kind: "pin", secret: input.secret };
  if (input.kind === "phrase") return { kind: "phrase", entropy: input.entropy };
  const { birth: _birth, ...gift } = input;
  return gift;
}

/**
 * The card's wallet entropy. For a PIN card this runs the PIN stretch, which
 * takes about half a second on purpose.
 *
 * @param input - The card.
 * @param pin - Its PIN, for a PIN card.
 * @returns The entropy.
 * @throws {Error} When a PIN card's PIN is missing or refused.
 */
export async function entropyOf(input: CardInput, pin?: string): Promise<Uint8Array> {
  if (input.kind === "phrase") return input.entropy;
  if (input.kind === "gift") return cardEntropy({ kind: "gift", secret: fromHex(input.secret) });
  if (!pin) throw new Error("This card needs its PIN.");
  return cardEntropy({ kind: "pin", secret: fromHex(input.secret), pin });
}

/** Who pays a card's fee for one action. */
export type FeeSource =
  { readonly kind: "sponsor" } | { readonly kind: "wallet"; readonly api: ConnectedAPI };

/** @returns True when this build names Kinko's fee sponsor. */
export const sponsorAvailable = (): boolean => SPONSOR_URL !== undefined;

/**
 * Who pays a card's fees unless an action says otherwise: Kinko's sponsor when
 * this build has one, otherwise the connected wallet.
 *
 * @param account - The connected account, if any.
 * @returns The source, or undefined when neither exists yet.
 */
export function defaultFees(account: Account | null): FeeSource | undefined {
  if (sponsorAvailable()) return { kind: "sponsor" };
  return account ? { kind: "wallet", api: account.api } : undefined;
}

function feePayerFor(mod: CardModule, source: FeeSource | undefined): FeePayer {
  if (!source) {
    return {
      kind: "wallet" as const,
      pay: () => Promise.reject(new Error("Connect a wallet to pay this card's network fee.")),
    };
  }
  if (source.kind === "wallet") return mod.walletFeePayer(source.api);
  if (!SPONSOR_URL)
    throw new Error(
      "This build has no fee sponsor (VITE_SPONSOR_URL), so a card cannot pay without a wallet.",
    );
  return mod.sponsorFeePayer({ endpoint: SPONSOR_URL });
}

/**
 * Open a card and start syncing it.
 *
 * @param entropy - From {@link entropyOf}.
 * @param fees - Who pays its fees unless an action says otherwise; nobody yet when undefined.
 * @param birth - Where on the chain the card was made, when its link or record says. The card then
 *   starts from Kinko's published tree at that point instead of replaying the whole chain.
 * @returns The card wallet. Stop it when done.
 * @throws {Error} When this build cannot reach the chain without a wallet.
 */
export async function openCard(
  entropy: Uint8Array,
  fees: FeeSource | undefined,
  birth?: string,
): Promise<CardWallet> {
  if (!PUBLIC_INDEXER || !NODE_URL) {
    throw new Error(
      "This build names no public Midnight indexer (VITE_INDEXER_URL), so a card cannot be read.",
    );
  }
  const [mod, snapshot] = await Promise.all([import("@kinko/card"), snapshotFor(birth)]);
  return mod.CardWallet.open(
    entropy,
    {
      networkId: NETWORK_ID,
      indexerHttpUrl: PUBLIC_INDEXER.http,
      indexerWsUrl: PUBLIC_INDEXER.ws,
      proofServerUrl: PROOF_SERVER_URL,
      nodeUrl: NODE_URL,
    },
    feePayerFor(mod, fees),
    snapshot === undefined ? {} : { snapshot },
  );
}

/**
 * A fee payer for one action, separate from the card's default.
 *
 * @param fees - Who pays.
 * @returns The payer.
 */
export async function feePayer(fees: FeeSource) {
  return feePayerFor(await import("@kinko/card"), fees);
}

/**
 * The card as the app's Account, so any flow that pays from a wallet pays from it.
 *
 * @param wallet - The open card.
 * @param circuit - What the card is about to call, told to the sponsor.
 * @returns The account.
 */
export function cardAccount(wallet: CardWallet, circuit?: string): Account {
  return {
    api: wallet.connector(circuit),
    coinPublicKey: wallet.addresses.coinPublicKey,
    encryptionPublicKey: wallet.addresses.encryptionPublicKey,
    shieldedAddress: wallet.addresses.shielded,
  };
}

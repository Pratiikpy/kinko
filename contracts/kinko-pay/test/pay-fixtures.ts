// Fixtures for the kinko_pay suites: a deployment, a default party, coins.

import {
  createConstructorContext,
  ecMulGenerator,
  type JubjubPoint,
} from "@midnight-ntwrk/compact-runtime";

import {
  emptyPayPrivateState,
  KinkoPay,
  NATIVE_COLOR,
  type PayPrivateState,
  payWitnesses,
} from "../src/index.ts";
import { bytes32, CPK, Harness, T0 } from "./harness.ts";

export const { InvoiceKind, InvoiceStatus, TokenKind } = KinkoPay;

/**
 * The KUSD colour these suites seal in. On chain it is derived from the vault
 * (see kusd-colour.test.ts); here it only has to differ from the native
 * colour, which is what the wrong-asset checks turn on.
 */
export const KUSD = bytes32(0xc1);
export const NATIVE = NATIVE_COLOR;

export const MERCHANT = bytes32(0x11);
export const PAYOUT = bytes32(0x12);
export const SALT = bytes32(0xaa);
export const PAYER = bytes32(0x33);
export const REFUND_TO = bytes32(0x34);
export const OWNER = bytes32(0xee);
export const AMOUNT = 42_500n;
export const NO_EXPIRY = 0n;

/** The default party: a merchant whose payment link a payer also holds. */
export const base = (over: Partial<PayPrivateState> = {}): PayPrivateState => ({
  ...emptyPayPrivateState(),
  merchantKey: MERCHANT,
  merchantPayout: { bytes: PAYOUT },
  salt: SALT,
  amount: AMOUNT,
  payerKey: PAYER,
  payerRefund: { bytes: REFUND_TO },
  ownerSecret: OWNER,
  ...over,
});

export type PayHarness = Harness<PayPrivateState, KinkoPay.Circuits<PayPrivateState>>;

/**
 * Deploy kinko_pay and return a harness at the deployment clock.
 *
 * @param initial - The first caller's private state.
 * @param oraclePk - Oracle key sealed at construction; a fixed real point by default.
 * @param kusd - KUSD colour sealed at construction.
 */
export const deployPay = async (
  initial: PayPrivateState = base(),
  oraclePk: JubjubPoint = ecMulGenerator(7n),
  kusd: Uint8Array = KUSD,
): Promise<PayHarness> => {
  const contract = new KinkoPay.Contract<PayPrivateState>(payWitnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext<PayPrivateState>(initial, CPK),
    oraclePk,
    kusd,
  );
  return new Harness(contract.circuits, currentContractState, initial).at(T0);
};

export const ledgerOf = (h: PayHarness): KinkoPay.Ledger => KinkoPay.ledger(h.charged());

/** A shielded coin as a payer's wallet hands it to a circuit. */
export interface Coin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

let nonceCounter = 0;

/**
 * A fresh shielded coin. Every coin gets a distinct nonce, as real coins do.
 * The colour defaults to native, which is what a NIGHT coin carries.
 */
export const coin = (value: bigint, color: Uint8Array = NATIVE): Coin => {
  nonceCounter += 1;
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setUint32(0, nonceCounter);
  return { nonce, color, value };
};

/** An open invoice from the default merchant. */
export const openInvoice = async (
  kind: KinkoPay.InvoiceKind = InvoiceKind.STANDARD,
  token: KinkoPay.TokenKind = TokenKind.NATIVE,
  expiresAt: bigint = NO_EXPIRY,
  over: Partial<PayPrivateState> = {},
): Promise<{ h: PayHarness; commitment: Uint8Array }> => {
  const h = await deployPay(base(over));
  const commitment = await h.call("create_invoice", kind, token, expiresAt);
  return { h, commitment };
};

/** The colour a coin must carry for `token` in these suites. */
export const colorFor = (token: KinkoPay.TokenKind): Uint8Array =>
  token === TokenKind.KUSD ? KUSD : NATIVE;

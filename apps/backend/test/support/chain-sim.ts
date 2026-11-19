// An in-process `kinko_pay`: the compiled contract running on the Compact
// runtime, with no node, indexer or prover. The tests use it as the chain.
//
// Everything the watcher reads in production comes from a real contract state,
// built here by calling the real circuits: an invoice is created, paid, closed
// or cancelled by the same code a wallet would prove. The state is then served
// through a fake indexer, so the decoding path under test is the shipped one.

import {
  emptyPayPrivateState,
  invoiceCommitmentOf,
  type InvoiceTerms,
  KinkoPay,
  NATIVE_COLOR,
  newInvoiceSecrets,
  type PayPrivateState,
  payWitnesses,
  toHex,
} from "@kinko/kinko-pay";
import {
  type ChargedState,
  type CircuitContext,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  type JubjubPoint,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { LedgerParameters } from "@midnightntwrk/ledger-v9";

/** The coin public key every simulated caller signs with. */
const CALLER = "c0".repeat(32);

/** Seconds since the epoch at which every simulated chain starts. */
/**
 * The `block` a 2.1.101 indexer returns beside a contract's state: its protocol version, which
 * names the ledger era, and that era's serialised ledger parameters. The provider refuses a
 * state it cannot date to an era.
 */
export const INDEXER_BLOCK = {
  protocolVersion: 2_001_101,
  ledgerParameters: Buffer.from(LedgerParameters.initialParameters().serialize()).toString("hex"),
} as const;

export const START = 1_800_000_000n;

/** A KUSD colour distinct from native, as in the contract's own suites. */
export const KUSD_COLOR = new Uint8Array(32).fill(0xc1);

/** A merchant's side of one invoice: its terms, and the secret that closes it. */
export interface TestInvoice {
  readonly terms: InvoiceTerms;
  readonly ownerSecret: Uint8Array;
  readonly commitment: string;
}

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

/** Build invoice terms for one merchant, with fresh randomness. */
export const newTestInvoice = (over: Partial<InvoiceTerms> = {}): TestInvoice => {
  const secrets = newInvoiceSecrets();
  const terms: InvoiceTerms = {
    merchantKey: fill(0x11),
    payout: fill(0x12),
    amount: 42_500n,
    kind: KinkoPay.InvoiceKind.STANDARD,
    token: KinkoPay.TokenKind.NATIVE,
    salt: secrets.salt,
    expiresAt: 0n,
    ...over,
  };
  return { terms, ownerSecret: secrets.ownerSecret, commitment: toHex(invoiceCommitmentOf(terms)) };
};

let nonce = 0;

/** A simulated chain holding one `kinko_pay` contract. */
export class ChainSim {
  readonly address = sampleContractAddress();
  /** Block time, in seconds, that the next call sees. */
  now: bigint = START;
  #state: ContractState | ChargedState;
  readonly #base: ContractState;
  readonly #contract = new KinkoPay.Contract<PayPrivateState>(payWitnesses);

  private constructor(base: ContractState) {
    this.#base = base;
    this.#state = base;
  }

  /**
   * Deploy the contract.
   *
   * @param oraclePk - The conversion oracle's public key to seal in.
   * @returns The chain.
   */
  static async deploy(oraclePk: JubjubPoint): Promise<ChainSim> {
    const contract = new KinkoPay.Contract<PayPrivateState>(payWitnesses);
    const initial = emptyPayPrivateState();
    const { currentContractState } = await contract.initialState(
      createConstructorContext<PayPrivateState>(initial, CALLER),
      oraclePk,
      KUSD_COLOR,
    );
    return new ChainSim(currentContractState);
  }

  async #call<R>(
    circuit: keyof KinkoPay.Circuits<PayPrivateState>,
    privateState: PayPrivateState,
    ...args: unknown[]
  ): Promise<R> {
    const context: CircuitContext<PayPrivateState> = createCircuitContext<PayPrivateState>({
      circuitId: circuit,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: CALLER,
      contractState: this.#state,
      privateState,
      time: Number(this.now),
    });
    type Run = (
      c: CircuitContext<PayPrivateState>,
      ...a: unknown[]
    ) => Promise<{
      result: R;
      context: { callContext: { currentQueryContext: { state: ContractState | ChargedState } } };
    }>;
    // The circuits are plain functions on a record; reading one by name is not a detached method.
    const circuits = this.#contract.circuits as unknown as Record<string, Run>;
    const run = circuits[circuit];
    if (!run) throw new Error(`the contract has no circuit ${circuit}`);
    const outcome = await run(context, ...args);
    this.#state = outcome.context.callContext.currentQueryContext.state;
    return outcome.result;
  }

  #merchantState(invoice: TestInvoice): PayPrivateState {
    return {
      ...emptyPayPrivateState(),
      merchantKey: invoice.terms.merchantKey,
      merchantPayout: { bytes: invoice.terms.payout },
      salt: invoice.terms.salt,
      amount: invoice.terms.amount,
      ownerSecret: invoice.ownerSecret,
    };
  }

  /** The merchant creates the invoice on chain. */
  async create(invoice: TestInvoice): Promise<void> {
    await this.#call(
      "create_invoice",
      this.#merchantState(invoice),
      invoice.terms.kind,
      invoice.terms.token,
      invoice.terms.expiresAt,
    );
  }

  /** A payer settles the invoice with a coin of exactly its amount. */
  async pay(invoice: TestInvoice, payerSeed = 0x33): Promise<void> {
    nonce += 1;
    const coinNonce = new Uint8Array(32);
    new DataView(coinNonce.buffer).setUint32(0, nonce);
    const state: PayPrivateState = {
      ...this.#merchantState(invoice),
      payerKey: fill(payerSeed),
      payerRefund: { bytes: fill(payerSeed + 1) },
      paymentIndex: BigInt(nonce),
    };
    const color = invoice.terms.token === KinkoPay.TokenKind.KUSD ? KUSD_COLOR : NATIVE_COLOR;
    await this.#call("settle_invoice", state, invoice.terms.kind, invoice.terms.token, {
      nonce: coinNonce,
      color,
      value: invoice.terms.amount,
    });
  }

  /**
   * A payer settles in the other asset with a coin of the converted value and
   * the oracle's signed quote. The contract verifies the signature in-circuit.
   */
  async payConverted(
    invoice: TestInvoice,
    paid: { readonly token: KinkoPay.TokenKind; readonly value: bigint },
    quote: {
      readonly expiresAt: bigint;
      readonly signature: { announcement: JubjubPoint; response: bigint };
    },
  ): Promise<void> {
    nonce += 1;
    const coinNonce = new Uint8Array(32);
    new DataView(coinNonce.buffer).setUint32(0, nonce);
    const state: PayPrivateState = {
      ...this.#merchantState(invoice),
      payerKey: fill(0x33),
      payerRefund: { bytes: fill(0x34) },
      paymentIndex: BigInt(nonce),
      convertedAmount: paid.value,
    };
    await this.#call(
      "settle_invoice_converted",
      state,
      invoice.terms.kind,
      invoice.terms.token,
      paid.token,
      {
        nonce: coinNonce,
        color: paid.token === KinkoPay.TokenKind.KUSD ? KUSD_COLOR : NATIVE_COLOR,
        value: paid.value,
      },
      quote.expiresAt,
      quote.signature,
    );
  }

  /** The merchant closes a multipay or donation invoice. */
  async close(invoice: TestInvoice): Promise<void> {
    await this.#call(
      "close_invoice",
      this.#merchantState(invoice),
      invoice.terms.kind,
      invoice.terms.token,
    );
  }

  /** The merchant cancels an unpaid invoice. */
  async cancel(invoice: TestInvoice): Promise<void> {
    await this.#call(
      "cancel_invoice",
      this.#merchantState(invoice),
      invoice.terms.kind,
      invoice.terms.token,
    );
  }

  /** The contract state as an indexer would hold it. */
  contractState(): ContractState {
    this.#base.data = "data" in this.#state ? this.#state.data : this.#state;
    return this.#base;
  }
}

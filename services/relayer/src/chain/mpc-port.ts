// The MPC network's answers, read from the Signet contract's emitted events. Every read is
// a single shot: the engine's tick owns the cadence.

import {
  bytesToHex,
  deriveSignBidirectionalEventSignerEvmAddress,
  parseRequestIdHex,
  type Secp256k1Point,
  type SignetRequestResponseReader,
  verifyRespondBidirectionalAttestation,
} from "@sig-net/midnight";
import type { Transaction } from "ethers";

import type { AttestationCandidate, MpcPort } from "../ports.ts";
import type { RequestKind } from "../types.ts";

/** What {@link SignetMpcPort} reads through. */
export interface SignetMpcPortOptions {
  /** One reader per request kind, over that kind's request map in the vault. */
  readonly readers: ReadonlyMap<RequestKind, SignetRequestResponseReader>;
  /** The MPC network's secp256k1 public key, which fixes the account every request is signed from. */
  readonly mpcPublicKey: string;
}

/** The relayer's reader of the MPC's signature responses and attestations. */
export class SignetMpcPort implements MpcPort {
  private readonly options: SignetMpcPortOptions;

  /**
   * Bind to the readers.
   *
   * @param options - The per-kind readers and the MPC's public key.
   */
  constructor(options: SignetMpcPortOptions) {
    this.options = options;
  }

  private reader(kind: RequestKind): SignetRequestResponseReader {
    const reader = this.options.readers.get(kind);
    if (reader === undefined) throw new Error(`no reader for ${kind} requests`);
    return reader;
  }

  /** @inheritdoc */
  async signedTransaction(kind: RequestKind, requestId: string): Promise<Transaction | undefined> {
    const reader = this.reader(kind);
    const id = parseRequestIdHex(requestId);
    // The signature counts only if it recovers to the account the MPC derives for the
    // request's own sender and path: the event log is unauthenticated.
    const request = await reader.getSignatureRequest(id);
    const signer = deriveSignBidirectionalEventSignerEvmAddress(this.options.mpcPublicKey, request);
    return reader.getSignedEvmTransaction(id, signer);
  }

  /** @inheritdoc */
  async attestations(
    kind: RequestKind,
    requestId: string,
    responseKey: Secp256k1Point,
  ): Promise<AttestationCandidate[]> {
    const events = await this.reader(kind).getRespondBidirectionalEvents(
      parseRequestIdHex(requestId),
    );
    // The vault's queue circuit checks the same signature, so a forged post only wastes a
    // proof: filtering here keeps the relayer from paying for one.
    return events
      .filter((event) => verifyRespondBidirectionalAttestation(event, responseKey))
      .map((event) => ({
        fingerprint: `${String(event.blockHeight)}:${String(event.outputKind)}:${bytesToHex(event.outputHash)}`,
        event,
      }));
  }
}

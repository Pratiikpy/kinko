// In-memory stand-ins for the chains, shared by the engine and HTTP tests. They keep the
// small amount of state the stage machine reads (where the vault holds each request, what
// the MPC posted, what Ethereum knows) and record every write, so a test states the
// scenario and asserts what the relayer did.

import { bytesToHex, OutputKind, type RespondBidirectionalEvent } from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
import type { FlushItems } from "@sig-net/midnight-examples-erc20-vault-contract";
import { Transaction, Wallet } from "ethers";

import {
  type AttestationCandidate,
  AttestationPosition,
  AttestationRejectedError,
  BroadcastOutcome,
  type EvmPort,
  type GasSponsor,
  GasTopUpRefusedError,
  type Logger,
  type MpcPort,
  type RequestPosition,
  type VaultPort,
  VaultPosition,
  type VaultView,
  type WaitingWork,
} from "../src/ports.ts";
import type { RequestKind } from "../src/types.ts";

/** The secret of the MPC response key the fake vault pins. */
export const RESPONSE_SECRET = new Uint8Array(32).fill(0x42);

/** The MPC response key the fake vault pins. */
export const RESPONSE_KEY = secp256k1PublicKeyOf(RESPONSE_SECRET);

/** A request id of 64 repeated hex digits, so a failing assertion names it at a glance. */
export const idOf = (digit: string): string => digit.repeat(64);

const positionKey = (kind: RequestKind, requestId: string): string => `${kind}:${requestId}`;

/** The vault's ledger as the stage machine sees it, and the writes the relayer made to it. */
export class FakeVault implements VaultPort {
  readonly positions = new Map<string, RequestPosition>();
  readonly writes: string[] = [];
  readonly flushes: FlushItems[] = [];
  readonly rejectedAttestations = new Set<string>();
  waiting: WaitingWork = { open: [], queuedInIndexes: [], queuedAttestationIds: [], unsent: [] };
  failures: Error[] = [];
  delayMs = 0;
  activeWrites = 0;
  maxActiveWrites = 0;

  set(kind: RequestKind, requestId: string, position: RequestPosition): void {
    this.positions.set(positionKey(kind, requestId), position);
  }

  remove(kind: RequestKind, requestId: string): void {
    this.positions.delete(positionKey(kind, requestId));
  }

  at(kind: RequestKind, requestId: string): RequestPosition | undefined {
    return this.positions.get(positionKey(kind, requestId));
  }

  readView(): Promise<VaultView> {
    const positions = this.positions;
    const waiting = this.waiting;
    return Promise.resolve({
      mpcResponseKey: RESPONSE_KEY,
      waiting,
      position: (kind, requestId) =>
        positions.get(positionKey(kind, requestId)) ?? {
          vault: VaultPosition.Absent,
          attestation: AttestationPosition.None,
        },
    });
  }

  private async write(name: string): Promise<void> {
    this.writes.push(name);
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const failure = this.failures.shift();
      if (failure !== undefined) throw failure;
    } finally {
      this.activeWrites -= 1;
    }
  }

  async flush(first: FlushItems): Promise<number> {
    await this.write("flush");
    this.flushes.push(first);
    let carried = 0;
    for (const [key, position] of this.positions) {
      if (
        position.vault === VaultPosition.Queued &&
        position.inIndex !== undefined &&
        first.inIndexes.includes(position.inIndex)
      ) {
        this.positions.set(key, {
          ...position,
          vault: VaultPosition.Flushed,
          outIndex: Uint8Array.of(Number(position.inIndex)),
        });
        carried += 1;
      }
      const id = key.split(":")[1] ?? "";
      if (
        position.attestation === AttestationPosition.Queued &&
        first.requestIds.some((requestId) => bytesToHex(requestId) === id)
      ) {
        this.positions.set(key, { ...position, attestation: AttestationPosition.Flushed });
        carried += 1;
      }
    }
    return carried;
  }

  async send(kind: RequestKind, outIndex: Uint8Array): Promise<void> {
    await this.write(`send:${bytesToHex(outIndex)}`);
    for (const [key, position] of this.positions) {
      if (
        key.startsWith(`${kind}:`) &&
        position.vault === VaultPosition.Flushed &&
        position.outIndex !== undefined &&
        bytesToHex(position.outIndex) === bytesToHex(outIndex)
      ) {
        this.positions.set(key, {
          vault: VaultPosition.Open,
          attestation: AttestationPosition.None,
        });
      }
    }
  }

  async queueAttestation(event: RespondBidirectionalEvent): Promise<void> {
    const id = bytesToHex(event.requestId);
    await this.write(`queueAttestation:${String(event.blockHeight)}`);
    if (this.rejectedAttestations.has(String(event.blockHeight))) {
      throw new AttestationRejectedError("Stale attestation");
    }
    for (const [key, position] of this.positions) {
      if (key.endsWith(`:${id}`)) {
        this.positions.set(key, { ...position, attestation: AttestationPosition.Queued });
      }
    }
  }
}

/** A signed deposit sweep, the way the MPC would have signed it. */
export async function signedSweep(nonce: number): Promise<Transaction> {
  const signer = new Wallet(`0x${"11".repeat(32)}`);
  const serialized = await signer.signTransaction({
    type: 2,
    chainId: 31337,
    nonce,
    to: `0x${"aa".repeat(20)}`,
    value: 0n,
    gasLimit: 100_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    data: "0xa9059cbb",
  });
  return Transaction.from(serialized);
}

/** The MPC's posted responses, set by the test. */
export class FakeMpc implements MpcPort {
  signed = new Map<string, Transaction>();
  attestationPosts = new Map<string, AttestationCandidate[]>();
  signatureReads = 0;
  failures: Error[] = [];

  signedTransaction(_kind: RequestKind, requestId: string): Promise<Transaction | undefined> {
    this.signatureReads += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.signed.get(requestId));
  }

  attestations(_kind: RequestKind, requestId: string): Promise<AttestationCandidate[]> {
    return Promise.resolve(this.attestationPosts.get(requestId) ?? []);
  }
}

/** An attestation of `requestId`, signed the way the MPC signs, at `blockHeight`. */
export function attestation(requestId: string, blockHeight: bigint): AttestationCandidate {
  const event = attestRespondBidirectional(
    {
      requestId: Uint8Array.from(requestId.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
      blockHeight,
      outputKind: OutputKind.executed,
      serializedOutput: Uint8Array.of(1),
    },
    RESPONSE_SECRET,
  );
  return { fingerprint: `${String(blockHeight)}:${requestId}`, event };
}

/** Ethereum, as far as the relayer asks. */
export class FakeEvm implements EvmPort {
  readonly broadcasts: string[] = [];
  readonly mined = new Set<string>();
  readonly balances = new Map<string, bigint>();
  outcome: BroadcastOutcome = BroadcastOutcome.Accepted;
  failures: Error[] = [];

  isMined(hash: string): Promise<boolean> {
    return Promise.resolve(this.mined.has(hash));
  }

  balance(address: string): Promise<bigint> {
    return Promise.resolve(this.balances.get(address.toLowerCase()) ?? 0n);
  }

  broadcast(transaction: Transaction): Promise<BroadcastOutcome> {
    this.broadcasts.push(transaction.hash ?? "");
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.outcome);
  }
}

/** A gas sponsor that records what it was asked and can refuse. */
export class FakeGas implements GasSponsor {
  readonly requests: { address: string; shortfallWei: bigint }[] = [];
  refuse = false;

  topUp(address: string, shortfallWei: bigint): Promise<bigint> {
    this.requests.push({ address, shortfallWei });
    if (this.refuse) return Promise.reject(new GasTopUpRefusedError("limit reached"));
    return Promise.resolve(shortfallWei);
  }
}

/** A logger that keeps what it is told. */
export class RecordingLogger implements Logger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

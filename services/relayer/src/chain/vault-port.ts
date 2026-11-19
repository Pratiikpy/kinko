// The relayer's Midnight side over the vault's midnight-js bindings: one ledger read per
// tick, and the three permissionless circuits it submits (flush, send, queue attestation).

import { TxFailedError } from "@midnight-ntwrk/midnight-js/contracts";
import { FailFallible } from "@midnight-ntwrk/midnight-js/types";
import {
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
} from "@sig-net/midnight";
import {
  type DeployedVaultContract,
  type FlushItems,
  flushPending,
  readVaultLedger,
  type VaultCompiledContract,
  type VaultProviders,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { AttestationRejectedError, type VaultPort, type VaultView } from "../ports.ts";
import { RequestKind } from "../types.ts";
import { buildVaultView } from "./vault-view.ts";

/** What {@link MidnightVaultPort} runs against. */
export interface MidnightVaultPortOptions {
  /** The vault's midnight-js provider set, over the relayer's wallet. */
  readonly providers: VaultProviders;
  /** The vault joined with the relayer's private state. */
  readonly vault: DeployedVaultContract;
  /** The vault's compiled contract. */
  readonly compiledContract: VaultCompiledContract;
  /** The vault's contract address, bare hex. */
  readonly vaultContractAddress: string;
}

// The asserts flushQueue trips on a slot another flush already moved. They are the
// contract's own messages: a flush that loses this race has nothing left to do.
const FLUSH_RACE = /Request not queued|Identical request open|Attestation not queued/;

// The send and queue circuits' asserts that mean the work is already done.
const ALREADY_SENT = /Request already sent|Request not flushed/;
const ALREADY_ATTESTED = /Attestation already queued|Attestation already flushed/;

// The queue circuit's asserts that mean this attestation can never be queued.
const ATTESTATION_REFUSED =
  /Stale attestation|Invalid attestation signature|Request not sent|Request not open/;

function messageOf(error: Error): string {
  return error.message;
}

/** The relayer's access to the vault contract. */
export class MidnightVaultPort implements VaultPort {
  private readonly options: MidnightVaultPortOptions;

  /**
   * Bind to a vault.
   *
   * @param options - The providers and the joined vault.
   */
  constructor(options: MidnightVaultPortOptions) {
    this.options = options;
  }

  /** @inheritdoc */
  async readView(): Promise<VaultView> {
    const state = await readVaultLedger(
      this.options.providers.publicDataProvider,
      this.options.vaultContractAddress,
    );
    return buildVaultView(state, this.options.vaultContractAddress);
  }

  /** @inheritdoc */
  async flush(first: FlushItems): Promise<number> {
    try {
      return await flushPending(
        this.options.providers,
        this.options.compiledContract,
        this.options.vaultContractAddress,
        first,
      );
    } catch (error) {
      const lostRace =
        error instanceof TxFailedError
          ? error.record.status === FailFallible
          : error instanceof Error && FLUSH_RACE.test(messageOf(error));
      if (lostRace) return 0;
      throw error;
    }
  }

  /** @inheritdoc */
  async send(kind: RequestKind, outIndex: Uint8Array): Promise<void> {
    const { callTx } = this.options.vault;
    try {
      if (kind === RequestKind.Deposit) await callTx.sendDeposit(outIndex);
      else await callTx.sendWithdraw(outIndex);
    } catch (error) {
      if (error instanceof Error && ALREADY_SENT.test(messageOf(error))) return;
      throw error;
    }
  }

  /** @inheritdoc */
  async queueAttestation(event: RespondBidirectionalEvent): Promise<void> {
    try {
      await this.options.vault.callTx.queueAttestation(
        respondBidirectionalEventToCircuitInput(event),
      );
    } catch (error) {
      if (error instanceof Error) {
        const message = messageOf(error);
        if (ALREADY_ATTESTED.test(message)) return;
        if (ATTESTATION_REFUSED.test(message)) throw new AttestationRejectedError(message);
      }
      throw error;
    }
  }
}

// Turns one read of the vault's ledger into the questions the stage machine asks: where
// does the vault hold this request, and what is waiting for a flush or a send. A deposit's
// id is known from the moment it is queued, a withdrawal's only once a flush gave it its
// vault nonce, so the id of every such entry is computed here the way the contract's send
// circuit will record it and matched against what a user registers.

import {
  bytesToHex,
  calculateRequestId,
  evmAddressAbiWord,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  pureCircuits as signetCircuits,
  requestIdHex,
  type SignBidirectionalEvent,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";
import {
  Action,
  pureCircuits as vaultCircuits,
  VAULT_PATH_BYTES,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import {
  AttestationPosition,
  type OpenRequest,
  type RequestPosition,
  type UnsentRequest,
  VaultPosition,
  type VaultView,
} from "../ports.ts";
import { RequestKind } from "../types.ts";

/** The ledger fields a {@link VaultView} reads. */
export type ViewableLedger = Pick<
  VaultLedgerState,
  | "mpcResponseKey"
  | "mpcKeyVersion"
  | "evmChainId"
  | "vaultEvmAddress"
  | "inputRequestBuffer"
  | "outputRequestBuffer"
  | "evictionMap"
  | "inputAttestationBuffer"
  | "outputAttestationBuffer"
  | "bidirectionalDepositMap"
  | "bidirectionalWithdrawMap"
  | "depositArgsMap"
  | "withdrawArgsMap"
>;

/** The ERC20 `transfer(address,uint256)` selector the vault's send circuits put in calldata. */
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

/** The routing the vault bakes into every deposit and withdraw event. */
const TRANSFER_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  executionDest: signetCircuits.ethereumCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: vaultCircuits.vaultOutputSchema(),
  respondSerializationSchema: new Uint8Array(0),
};

/** What a deposit or withdrawal's signature request is built from. */
interface TransferRecordInput {
  readonly path: Uint8Array;
  readonly erc20Address: Uint8Array;
  readonly recipient: Uint8Array;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly gas: {
    readonly gasLimit: bigint;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  };
}

function transferRequestId(
  state: ViewableLedger,
  vaultContractAddress: Uint8Array,
  input: TransferRecordInput,
): string {
  const record: SignBidirectionalEvent = {
    sender: { bytes: vaultContractAddress },
    keyVersion: state.mpcKeyVersion,
    path: input.path,
    ...TRANSFER_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: input.erc20Address,
      chainId: state.evmChainId,
      nonce: input.nonce,
      gasLimit: input.gas.gasLimit,
      maxFeePerGas: input.gas.maxFeePerGas,
      maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [evmAddressAbiWord(input.recipient), numericAbiWord(input.amount)],
        },
      },
    },
  };
  return requestIdHex(calculateRequestId(record));
}

// The request id of a deposit or withdrawal entry, or undefined for any other action or a withdrawal not yet flushed.
function prospectiveId(
  state: ViewableLedger,
  vaultContractAddress: Uint8Array,
  inIndex: bigint,
  action: Action,
  nonce: bigint,
  flushed: boolean,
): { kind: RequestKind; id: string } | undefined {
  if (action === Action.deposit && state.depositArgsMap.member(inIndex)) {
    const args = state.depositArgsMap.lookup(inIndex);
    return {
      kind: RequestKind.Deposit,
      id: transferRequestId(state, vaultContractAddress, {
        path: args.path,
        erc20Address: args.request.erc20Address,
        recipient: state.vaultEvmAddress,
        amount: args.request.amount,
        nonce,
        gas: args.gas,
      }),
    };
  }
  // A queued withdrawal takes its nonce from the flush, so only a flushed one has an id yet.
  if (action === Action.withdraw && flushed && state.withdrawArgsMap.member(inIndex)) {
    const args = state.withdrawArgsMap.lookup(inIndex);
    return {
      kind: RequestKind.Withdraw,
      id: transferRequestId(state, vaultContractAddress, {
        path: VAULT_PATH_BYTES,
        erc20Address: args.request.erc20Address,
        recipient: args.request.destEvmAddress,
        amount: args.request.amount,
        nonce,
        gas: args.gas,
      }),
    };
  }
  return undefined;
}

function kindOf(action: Action): RequestKind | undefined {
  if (action === Action.deposit) return RequestKind.Deposit;
  if (action === Action.withdraw) return RequestKind.Withdraw;
  return undefined;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Index one read of the vault's ledger.
 *
 * @param state - The decoded ledger.
 * @param vaultContractAddress - The vault's contract address, bare hex.
 * @returns A view answering where each deposit and withdrawal stands and what waits to move.
 */
export function buildVaultView(state: ViewableLedger, vaultContractAddress: string): VaultView {
  const vaultAddressBytes = hexBytes(vaultContractAddress);
  const open = new Map<RequestKind, ReadonlySet<string>>([
    [
      RequestKind.Deposit,
      new Set(toSignBidirectionalEventIndex(state.bidirectionalDepositMap).keys()),
    ],
    [
      RequestKind.Withdraw,
      new Set(toSignBidirectionalEventIndex(state.bidirectionalWithdrawMap).keys()),
    ],
  ]);

  const queued = new Map<string, { inIndex: bigint }>();
  const queuedInIndexes: bigint[] = [];
  for (const [inIndex, entry] of state.inputRequestBuffer) {
    queuedInIndexes.push(inIndex);
    const found = prospectiveId(
      state,
      vaultAddressBytes,
      inIndex,
      entry.action,
      entry.evmNonce,
      false,
    );
    if (found !== undefined) queued.set(`${found.kind}:${found.id}`, { inIndex });
  }

  const sentOutIndexes = new Set<string>();
  for (const [, outIndex] of state.evictionMap) sentOutIndexes.add(bytesToHex(outIndex));

  const flushed = new Map<string, { inIndex: bigint; outIndex: Uint8Array }>();
  const unsent: UnsentRequest[] = [];
  for (const [outIndex, { entry }] of state.outputRequestBuffer) {
    const found = prospectiveId(
      state,
      vaultAddressBytes,
      entry.inIndex,
      entry.action,
      entry.evmNonce,
      true,
    );
    if (found === undefined) continue;
    flushed.set(`${found.kind}:${found.id}`, { inIndex: entry.inIndex, outIndex });
    const kind = kindOf(entry.action);
    if (kind !== undefined && !sentOutIndexes.has(bytesToHex(outIndex))) {
      unsent.push({ kind, outIndex });
    }
  }

  const queuedAttestationIds: Uint8Array[] = [];
  for (const [requestId] of state.inputAttestationBuffer) queuedAttestationIds.push(requestId);

  const openRequests: OpenRequest[] = [];
  for (const [kind, ids] of open) {
    for (const requestId of ids) openRequests.push({ kind, requestId });
  }

  return {
    mpcResponseKey: state.mpcResponseKey,
    waiting: { open: openRequests, queuedInIndexes, queuedAttestationIds, unsent },
    position(kind: RequestKind, requestId: string): RequestPosition {
      if (open.get(kind)?.has(requestId) === true) {
        const id = hexBytes(requestId);
        let attestation = AttestationPosition.None;
        if (state.outputAttestationBuffer.member(id)) attestation = AttestationPosition.Flushed;
        else if (state.inputAttestationBuffer.member(id)) attestation = AttestationPosition.Queued;
        return { vault: VaultPosition.Open, attestation };
      }
      const key = `${kind}:${requestId}`;
      const inOutput = flushed.get(key);
      if (inOutput !== undefined) {
        return { vault: VaultPosition.Flushed, ...inOutput, attestation: AttestationPosition.None };
      }
      const inInput = queued.get(key);
      if (inInput !== undefined) {
        return { vault: VaultPosition.Queued, ...inInput, attestation: AttestationPosition.None };
      }
      return { vault: VaultPosition.Absent, attestation: AttestationPosition.None };
    },
  };
}

// The user's side of the vault: the two circuits they sign for each deposit
// and withdrawal, and the pure derivations around them.
//
// A deposit is: send USDC to your deposit address on Ethereum, sign
// `startDeposit`, let the relayer carry the request, sign `completeDeposit`.
// A withdrawal is: sign `startWithdraw` with a KUSD coin, let the relayer
// carry it, sign `completeWithdraw`. Everything here mirrors the vault's own
// flow code; every value the circuits check is read from the vault's ledger.

import { rawTokenType } from "@midnight-ntwrk/compact-runtime";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import {
  calculateRequestId,
  evmAddressAbiWord,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  OutputKind,
  pureCircuits as signetCircuits,
  requestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  TxParamType,
} from "@sig-net/midnight";
import {
  Action,
  evmAddressBytes,
  feeRecipientEncryptionMapping,
  newInputIndex,
  pureCircuits as vaultCircuits,
  readVaultLedger,
  VAULT_PATH_BYTES,
  type VaultLedgerState,
  vaultTokenFees,
  type VaultTokenSupply,
  vaultTokenSupply,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { fromHex, toHex } from "./format.ts";
import { callCircuit, callCircuitScoped, type CallStage } from "./midnight/contracts.ts";
import type { Account } from "./midnight/providers.ts";

/**
 * The gas envelope a deposit's sweep is signed with; the deposit address pays it. Sepolia's
 * USDC estimates 154,478 gas for the first transfer into an empty vault, where the recipient's
 * balance slot is written for the first time. At 100,000 and at 150,000 the sweep ran out of
 * gas on the public network, and a signed transaction that reverts cannot be retried, so the
 * limit keeps a margin above the estimate.
 */
export const DEPOSIT_GAS = {
  gasLimit: 200_000n,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
} as const;

/** The most ETH the sweep can cost, which the deposit address must hold beside the USDC. */
export const DEPOSIT_GAS_CEILING_WEI = DEPOSIT_GAS.gasLimit * DEPOSIT_GAS.maxFeePerGas;

const TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  executionDest: signetCircuits.ethereumCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: vaultCircuits.vaultOutputSchema(),
  respondSerializationSchema: new Uint8Array(0),
};

/**
 * The commitment the vault stores for an identity secret: the user's MPC derivation path.
 *
 * @param secret - The 32-byte identity secret.
 * @returns The commitment as hex.
 */
export const identityCommitment = (secret: Uint8Array): string =>
  toHex(vaultCircuits.userCommitment(secret));

/**
 * The shielded token type KUSD carries, as the wallet keys its balances.
 *
 * @param usdcAddress - The USDC token on Ethereum.
 * @param vaultContractAddress - The vault on Midnight.
 * @returns The token type as hex.
 */
export const kusdTokenType = (usdcAddress: string, vaultContractAddress: string): string =>
  rawTokenType(
    vaultCircuits.vaultTokenDomainSeparator(evmAddressBytes(usdcAddress)),
    vaultContractAddress,
  );

/**
 * Read the vault's public ledger.
 *
 * @param pdp - Where to read the chain.
 * @param vaultContractAddress - The vault on Midnight.
 * @returns The decoded ledger.
 */
export async function readVault(
  pdp: PublicDataProvider,
  vaultContractAddress: string,
): Promise<VaultLedgerState> {
  return readVaultLedger(pdp, vaultContractAddress);
}

/**
 * What the vault has minted and burned of KUSD, straight from the supply
 * counters in its public ledger. `circulating` is minted minus burned, which
 * the vault's USDC balance on Ethereum backs one to one.
 *
 * @param state - The vault ledger.
 * @param usdcAddress - The USDC token on Ethereum.
 * @returns The totals, or null when the vault does not allow this token (it then has no
 *   counters, and the caller says so instead of showing a zero).
 */
export function kusdSupply(state: VaultLedgerState, usdcAddress: string): VaultTokenSupply | null {
  const key = evmAddressBytes(usdcAddress);
  return state.allowedTokens.member(key) ? vaultTokenSupply(state, key) : null;
}

/**
 * The flat withdraw fee for USDC, read from the ledger.
 *
 * @param state - The vault ledger.
 * @param usdcAddress - The USDC token on Ethereum.
 * @returns The fee in base units.
 */
export const withdrawFee = (state: VaultLedgerState, usdcAddress: string): bigint =>
  vaultTokenFees(state, evmAddressBytes(usdcAddress)).withdraw;

const transferCalldata = (to: Uint8Array, amount: bigint) => ({
  is_some: true,
  value: {
    selector: TRANSFER_SELECTOR,
    noWords: 2n,
    words: [evmAddressAbiWord(to), numericAbiWord(amount)],
  },
});

/** What fixes a deposit's request id. */
export interface DepositIdInput {
  readonly vaultContractAddress: string;
  readonly state: VaultLedgerState;
  readonly commitmentHex: string;
  readonly usdcAddress: string;
  readonly amount: bigint;
  readonly evmNonce: bigint;
}

/**
 * The id the vault will give a deposit's signature request, computed before
 * anything is flushed: every field of the sweep is fixed at start.
 *
 * @param p - The vault, its ledger, the depositor's commitment, the amount and the sweep's nonce.
 * @returns The request id as hex.
 */
export function depositRequestId(p: DepositIdInput): string {
  const record: SignBidirectionalEvent = {
    sender: { bytes: fromHex(p.vaultContractAddress) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: fromHex(p.commitmentHex),
    ...ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: evmAddressBytes(p.usdcAddress),
      chainId: p.state.evmChainId,
      nonce: p.evmNonce,
      ...DEPOSIT_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: transferCalldata(p.state.vaultEvmAddress, p.amount),
    },
  };
  return requestIdHex(calculateRequestId(record));
}

/** What fixes a withdrawal's request id, once its flush has assigned a nonce. */
export interface WithdrawIdInput {
  readonly vaultContractAddress: string;
  readonly state: VaultLedgerState;
  readonly inIndex: bigint;
  readonly usdcAddress: string;
  readonly amount: bigint;
  readonly destination: string;
}

/**
 * The id of a withdrawal's signature request. It covers the vault nonce the
 * flush assigns, so it exists only once the request has been flushed.
 *
 * @param p - The vault, its ledger, the start's index, the amount and the destination.
 * @returns The request id as hex, or null before the flush.
 */
export function withdrawRequestId(p: WithdrawIdInput): string | null {
  let evmNonce: bigint | undefined;
  for (const [, out] of p.state.outputRequestBuffer) {
    if (out.entry.action === Action.withdraw && out.entry.inIndex === p.inIndex)
      evmNonce = out.entry.evmNonce;
  }
  if (evmNonce === undefined || !p.state.withdrawArgsMap.member(p.inIndex)) return null;
  const { gas } = p.state.withdrawArgsMap.lookup(p.inIndex);
  const record: SignBidirectionalEvent = {
    sender: { bytes: fromHex(p.vaultContractAddress) },
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: VAULT_PATH_BYTES,
    ...ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: evmAddressBytes(p.usdcAddress),
      chainId: p.state.evmChainId,
      nonce: evmNonce,
      gasLimit: gas.gasLimit,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: transferCalldata(evmAddressBytes(p.destination), p.amount),
    },
  };
  return requestIdHex(calculateRequestId(record));
}

/**
 * Whether a start has left the vault's input queue.
 *
 * @param state - The vault ledger.
 * @param inIndex - The start's input index.
 * @returns True once it has been flushed.
 */
export const isFlushed = (state: VaultLedgerState, inIndex: bigint): boolean =>
  !state.inputRequestBuffer.member(inIndex);

/** What every vault call from the person's wallet needs. */
interface VaultCall {
  readonly account: Account;
  readonly vaultContractAddress: string;
  readonly secret: Uint8Array;
  readonly onStage?: (s: CallStage) => void;
}

/** What starting a deposit needs. */
export interface StartDepositInput extends VaultCall {
  readonly usdcAddress: string;
  readonly amount: bigint;
  readonly evmNonce: bigint;
}

/**
 * Sign `startDeposit`: queue a deposit of USDC already at the deposit address.
 *
 * @param p - The account, the vault, the identity secret, the amount and the sweep's nonce.
 * @returns The input index the request was queued under, and the transaction id.
 */
export async function startDeposit(
  p: StartDepositInput,
): Promise<{ inIndex: bigint; txId: string }> {
  const inIndex = newInputIndex();
  const { txId } = await callCircuit(
    p.account,
    "vault",
    p.vaultContractAddress,
    { secretKey: p.secret },
    "startDeposit",
    [
      inIndex,
      p.evmNonce,
      DEPOSIT_GAS,
      { erc20Address: evmAddressBytes(p.usdcAddress), amount: p.amount },
    ],
    p.onStage,
  );
  return { inIndex, txId };
}

/** What starting a withdrawal needs. */
export interface StartWithdrawInput extends VaultCall {
  readonly state: VaultLedgerState;
  readonly usdcAddress: string;
  readonly amount: bigint;
  readonly destination: string;
}

/**
 * Sign `startWithdraw`: burn KUSD worth the amount plus the fee, and queue the transfer.
 *
 * @param p - The account, the vault and its ledger, the identity secret, the amount and the destination.
 * @returns The input index, the transaction id and the fee charged.
 */
export async function startWithdraw(
  p: StartWithdrawInput,
): Promise<{ inIndex: bigint; txId: string; fee: bigint }> {
  const fee = withdrawFee(p.state, p.usdcAddress);
  const inIndex = newInputIndex();
  // The surrendered coin: KUSD of exactly amount plus fee under a fresh nonce.
  // midnight-js funds its value from the wallet's shielded balance.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: fromHex(kusdTokenType(p.usdcAddress, p.vaultContractAddress)),
    value: p.amount + fee,
  };
  const { txId } = await callCircuitScoped(
    p.account,
    "vault",
    p.vaultContractAddress,
    { secretKey: p.secret },
    "startWithdraw",
    [
      inIndex,
      {
        erc20Address: evmAddressBytes(p.usdcAddress),
        amount: p.amount,
        destEvmAddress: evmAddressBytes(p.destination),
      },
      coin,
    ],
    feeRecipientEncryptionMapping(p.state),
    p.onStage,
  );
  return { inIndex, txId, fee };
}

/**
 * What the MPC attested for a request, read from the vault's attestation buffer.
 *
 * @param state - The vault ledger.
 * @param requestIdHexValue - The request id.
 * @returns The attested outcome, or null while the attestation is not in the vault.
 */
export function attestedKind(
  state: VaultLedgerState,
  requestIdHexValue: string,
): OutputKind | null {
  const id = fromHex(requestIdHexValue);
  if (!state.outputAttestationBuffer.member(id)) return null;
  return state.outputAttestationBuffer.lookup(id).outputKind;
}

// The attested output of an ERC20 transfer is its bool return, Borsh-encoded
// as one byte. The circuit checks the bytes against the attested hash, so the
// honest choice is tried first and the other only if the circuit refuses it
// locally, before any proof is made.
const SUCCESS = new Uint8Array([1]);
const RETURNED_FALSE = new Uint8Array([0]);
const OUTPUT_MISMATCH = "Output does not match the attestation";

async function completeWith(
  run: (output: Uint8Array) => Promise<{ txId: string }>,
  executed: boolean,
): Promise<{ txId: string; transferred: boolean }> {
  if (!executed) return { ...(await run(RETURNED_FALSE)), transferred: false };
  try {
    return { ...(await run(SUCCESS)), transferred: true };
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes(OUTPUT_MISMATCH)) throw e;
    return { ...(await run(RETURNED_FALSE)), transferred: false };
  }
}

/** What closing a deposit or withdrawal needs. */
export interface CompleteInput extends VaultCall {
  readonly state: VaultLedgerState;
  readonly requestId: string;
}

/**
 * Sign `completeDeposit`: mint KUSD for a deposit the signers attested.
 *
 * @param p - The account, the vault and its ledger, the identity secret and the request id.
 * @returns The transaction id, and whether KUSD was minted.
 * @throws {Error} When the attestation is not in the vault yet.
 */
export async function completeDeposit(
  p: CompleteInput,
): Promise<{ txId: string; minted: boolean }> {
  const kind = attestedKind(p.state, p.requestId);
  if (kind === null) throw new Error("The attestation for this deposit is not in the vault yet.");
  const recipient = {
    is_some: false,
    value: {
      is_left: true,
      left: { bytes: new Uint8Array(32) },
      right: { bytes: new Uint8Array(32) },
    },
  };
  const out = await completeWith(
    async (output) =>
      callCircuit(
        p.account,
        "vault",
        p.vaultContractAddress,
        { secretKey: p.secret },
        "completeDeposit",
        [fromHex(p.requestId), output, crypto.getRandomValues(new Uint8Array(32)), recipient],
        p.onStage,
      ),
    kind === OutputKind.executed,
  );
  return { txId: out.txId, minted: out.transferred };
}

/**
 * Sign `completeWithdraw`: close a withdrawal the signers attested, minting the KUSD back if the transfer failed.
 *
 * @param p - The account, the vault and its ledger, the identity secret and the request id.
 * @returns The transaction id, and whether the KUSD was returned.
 * @throws {Error} When the attestation is not in the vault yet.
 */
export async function completeWithdraw(
  p: CompleteInput,
): Promise<{ txId: string; refunded: boolean }> {
  const kind = attestedKind(p.state, p.requestId);
  if (kind === null)
    throw new Error("The attestation for this withdrawal is not in the vault yet.");
  const out = await completeWith(
    async (output) =>
      callCircuit(
        p.account,
        "vault",
        p.vaultContractAddress,
        { secretKey: p.secret },
        "completeWithdraw",
        [fromHex(p.requestId), output, crypto.getRandomValues(new Uint8Array(32))],
        p.onStage,
      ),
    kind === OutputKind.executed,
  );
  return { txId: out.txId, refunded: !out.transferred };
}

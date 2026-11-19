// The vault view against the REAL compiled contract, run in-process through the compact
// runtime: the request ids the relayer derives for queued and flushed requests are checked
// against the ids the contract's own send circuit stores, so a drift between the two
// shows as a failure here instead of as a request nobody can register.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { ContractOperation, ContractState } from "@midnightntwrk/onchain-runtime-v4";
import {
  bytesToHex,
  hexToBytes,
  OutputKind,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  toSignBidirectionalEventIndex,
} from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
import {
  Action,
  Contract,
  createVaultPrivateState,
  flushedRequestIndex,
  flushSlots,
  ledger,
  pureCircuits,
  queuedRequestIndex,
  type VaultPrivateState,
  witnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import * as SignetSigner from "@sig-net/midnight-signer/managed/contract/index.js";
import { describe, expect, it } from "vitest";

import { buildVaultView } from "../src/chain/vault-view.ts";
import { AttestationPosition, VaultPosition } from "../src/ports.ts";
import { RequestKind } from "../src/types.ts";

const CPK = "c0".repeat(32);
const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill);

const SECRET_KEY = bytes(32, 7);
const MPC_SECRET = bytes(32, 0x42);
const VAULT_ADDRESS = sampleContractAddress();
const SIGNET_ADDRESS = sampleContractAddress();
const STATA_UNDERLYING = bytes(20, 0xdd);
const STATA_TOKEN = bytes(20, 0xcc);
const DEST = bytes(20, 0x77);
const WITHDRAW_FEE = 31n;
const AMOUNT = 1_000_000n;

type Context = CircuitContext<VaultPrivateState>;

const viewOf = (context: Context) =>
  buildVaultView(ledger(context.callContext.currentQueryContext.state), VAULT_ADDRESS);

const stateOf = (context: Context) => ledger(context.callContext.currentQueryContext.state);

const require = createRequire(import.meta.url);

/** The verifier key the signet signer package ships for each provable circuit. */
const SIGNET_VERIFIER_KEYS: ReadonlyMap<string, Uint8Array> = new Map(
  Object.entries(SignetSigner.circuitSignatures)
    .filter(([, signature]) => signature.provable)
    .map(([circuitId]) => [
      circuitId,
      readFileSync(require.resolve(`@sig-net/midnight-signer/managed/keys/${circuitId}.verifier`)),
    ]),
);

/**
 * The signet callee's deployed state, which the send circuits' cross-contract call reads:
 * its initial state carrying the shipped verifier keys the runtime checks the module against.
 */
async function deployedSignetState(): Promise<ContractState> {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
  );
  const state = ContractState.deserialize(currentContractState.serialize());
  for (const [circuitId, verifierKey] of SIGNET_VERIFIER_KEYS) {
    const operation = new ContractOperation();
    operation.verifierKey = verifierKey;
    state.setOperation(circuitId, operation);
  }
  return state;
}

/** How the send circuits reach the signet signer in-process: every callee is the signer. */
const signetCrossContract = {
  stateProvider: { getContractState: deployedSignetState },
  moduleProvider: { resolve: () => () => Promise.resolve(SignetSigner) },
};

/** A fresh vault, initialised, and the contexts of every step a request takes. */
async function arrange() {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = await contract.initialState(
    createConstructorContext(createVaultPrivateState(SECRET_KEY), CPK),
    pureCircuits.userCommitment(SECRET_KEY),
    { bytes: hexToBytes(SIGNET_ADDRESS) },
  );
  const deployed = createCircuitContext({
    circuitId: "initialise",
    contractAddress: VAULT_ADDRESS,
    coinPublicKeyOrZswapState: CPK,
    contractState: currentContractState,
    privateState: currentPrivateState,
    parentBlockHash: "0".repeat(64),
    crossContract: signetCrossContract,
  });
  const initialised = (
    await contract.circuits.initialise(
      deployed,
      bytes(20, 0xee),
      bytes(20, 0x11),
      STATA_UNDERLYING,
      STATA_TOKEN,
      11155111n,
      secp256k1PublicKeyOf(MPC_SECRET),
      1n,
      100n,
      { withdraw: WITHDRAW_FEE, swap: 37n, supply: 41n, redeem: 43n },
      { withdraw: 53n, swap: 59n, supply: 61n, redeem: 67n },
      { bytes: bytes(32, 0xfe) },
      bytes(32, 0xef),
    )
  ).context;
  return { contract, initialised };
}

const GAS = {
  gasLimit: 100_000n,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
};

/** A withdrawal's coin: the vault token of STATA_UNDERLYING for the amount plus the fee. */
const withdrawCoin = () => ({
  nonce: bytes(32, 0x0c),
  color: hexToBytes(
    rawTokenType(pureCircuits.vaultTokenDomainSeparator(STATA_UNDERLYING), VAULT_ADDRESS),
  ),
  value: AMOUNT + WITHDRAW_FEE,
});

/** The MPC's executed-and-succeeded attestation of `requestId`, as the queue circuit takes it. */
function attestationOf(requestId: Uint8Array) {
  const output = serializeRespondOutput(pureCircuits.vaultOutputSchema(), { success: true });
  return respondBidirectionalEventToCircuitInput(
    attestRespondBidirectional(
      { requestId, blockHeight: 101n, outputKind: OutputKind.executed, serializedOutput: output },
      MPC_SECRET,
    ),
  );
}

describe("a deposit, from start to attestation", () => {
  it("has the id the contract's send circuit stores, found at every stage before and after the send", async () => {
    const { contract, initialised } = await arrange();
    const inIndex = 21n;

    const queued = (
      await contract.circuits.startDeposit(initialised, inIndex, 4n, GAS, {
        erc20Address: STATA_UNDERLYING,
        amount: AMOUNT,
      })
    ).context;
    const outIndex = queuedRequestIndex(stateOf(queued), inIndex);
    const flushed = (await contract.circuits.flushQueue(queued, flushSlots([inIndex], []))).context;
    const sent = (await contract.circuits.sendDeposit(flushed, outIndex)).context;
    const [requestId] = [
      ...toSignBidirectionalEventIndex(stateOf(sent).bidirectionalDepositMap).keys(),
    ];
    if (requestId === undefined) throw new Error("the deposit was not sent");

    const atQueued = viewOf(queued).position(RequestKind.Deposit, requestId);
    expect(atQueued).toMatchObject({ vault: VaultPosition.Queued, inIndex });
    const atFlushed = viewOf(flushed).position(RequestKind.Deposit, requestId);
    expect(atFlushed).toMatchObject({ vault: VaultPosition.Flushed, inIndex });
    expect(bytesToHex(atFlushed.outIndex ?? new Uint8Array())).toBe(bytesToHex(outIndex));
    expect(viewOf(sent).position(RequestKind.Deposit, requestId)).toEqual({
      vault: VaultPosition.Open,
      attestation: AttestationPosition.None,
    });
  });

  it("lists work waiting for a flush and a send, whoever queued it", async () => {
    const { contract, initialised } = await arrange();
    const inIndex = 21n;
    const queued = (
      await contract.circuits.startDeposit(initialised, inIndex, 4n, GAS, {
        erc20Address: STATA_UNDERLYING,
        amount: AMOUNT,
      })
    ).context;
    const outIndex = queuedRequestIndex(stateOf(queued), inIndex);
    const flushed = (await contract.circuits.flushQueue(queued, flushSlots([inIndex], []))).context;
    const sent = (await contract.circuits.sendDeposit(flushed, outIndex)).context;

    expect(viewOf(initialised).waiting).toEqual({
      open: [],
      queuedInIndexes: [],
      queuedAttestationIds: [],
      unsent: [],
    });
    expect(viewOf(queued).waiting.queuedInIndexes).toEqual([inIndex]);
    const awaitingSend = viewOf(flushed).waiting;
    expect(awaitingSend.queuedInIndexes).toEqual([]);
    expect(awaitingSend.unsent.map((work) => [work.kind, bytesToHex(work.outIndex)])).toEqual([
      [RequestKind.Deposit, bytesToHex(outIndex)],
    ]);
    expect(viewOf(sent).waiting.unsent).toEqual([]);
  });

  it("follows the attestation from queued to flushed", async () => {
    const { contract, initialised } = await arrange();
    const inIndex = 21n;
    const queued = (
      await contract.circuits.startDeposit(initialised, inIndex, 4n, GAS, {
        erc20Address: STATA_UNDERLYING,
        amount: AMOUNT,
      })
    ).context;
    const outIndex = queuedRequestIndex(stateOf(queued), inIndex);
    const flushed = (await contract.circuits.flushQueue(queued, flushSlots([inIndex], []))).context;
    const sent = (await contract.circuits.sendDeposit(flushed, outIndex)).context;
    const [requestId] = [
      ...toSignBidirectionalEventIndex(stateOf(sent).bidirectionalDepositMap).keys(),
    ];
    if (requestId === undefined) throw new Error("the deposit was not sent");
    const id = hexToBytes(requestId);

    const attestationQueued = (await contract.circuits.queueAttestation(sent, attestationOf(id)))
      .context;
    const attestationFlushed = (
      await contract.circuits.flushQueue(attestationQueued, flushSlots([], [id]))
    ).context;

    expect(viewOf(attestationQueued).position(RequestKind.Deposit, requestId).attestation).toBe(
      AttestationPosition.Queued,
    );
    expect(
      viewOf(attestationQueued).waiting.queuedAttestationIds.map((queuedId) =>
        bytesToHex(queuedId),
      ),
    ).toEqual([requestId]);
    expect(viewOf(attestationFlushed).position(RequestKind.Deposit, requestId).attestation).toBe(
      AttestationPosition.Flushed,
    );
    expect(viewOf(attestationFlushed).waiting.queuedAttestationIds).toEqual([]);
  });
});

describe("a withdrawal, from start to send", () => {
  it("has no id while queued, and from its flush the id the send circuit stores", async () => {
    const { contract, initialised } = await arrange();
    const inIndex = 31n;
    const queued = (
      await contract.circuits.startWithdraw(
        initialised,
        inIndex,
        { erc20Address: STATA_UNDERLYING, amount: AMOUNT, destEvmAddress: DEST },
        withdrawCoin(),
      )
    ).context;
    const flushed = (await contract.circuits.flushQueue(queued, flushSlots([inIndex], []))).context;
    const outIndex = flushedRequestIndex(stateOf(flushed), Action.withdraw, inIndex);
    const sent = (await contract.circuits.sendWithdraw(flushed, outIndex)).context;
    const [requestId] = [
      ...toSignBidirectionalEventIndex(stateOf(sent).bidirectionalWithdrawMap).keys(),
    ];
    if (requestId === undefined) throw new Error("the withdrawal was not sent");

    expect(viewOf(queued).position(RequestKind.Withdraw, requestId).vault).toBe(
      VaultPosition.Absent,
    );
    expect(viewOf(queued).waiting.queuedInIndexes).toEqual([inIndex]);
    const atFlushed = viewOf(flushed).position(RequestKind.Withdraw, requestId);
    expect(atFlushed).toMatchObject({ vault: VaultPosition.Flushed, inIndex });
    expect(viewOf(flushed).waiting.unsent.map((work) => work.kind)).toEqual([RequestKind.Withdraw]);
    expect(viewOf(sent).position(RequestKind.Withdraw, requestId).vault).toBe(VaultPosition.Open);
    expect(viewOf(sent).waiting.unsent).toEqual([]);
  });

  it("never mistakes one kind's id for the other's, or an unknown id for either", async () => {
    const { contract, initialised } = await arrange();
    const inIndex = 31n;
    const queued = (
      await contract.circuits.startWithdraw(
        initialised,
        inIndex,
        { erc20Address: STATA_UNDERLYING, amount: AMOUNT, destEvmAddress: DEST },
        withdrawCoin(),
      )
    ).context;
    const flushed = (await contract.circuits.flushQueue(queued, flushSlots([inIndex], []))).context;
    const outIndex = flushedRequestIndex(stateOf(flushed), Action.withdraw, inIndex);
    const sent = (await contract.circuits.sendWithdraw(flushed, outIndex)).context;
    const [requestId] = [
      ...toSignBidirectionalEventIndex(stateOf(sent).bidirectionalWithdrawMap).keys(),
    ];
    if (requestId === undefined) throw new Error("the withdrawal was not sent");

    expect(viewOf(sent).position(RequestKind.Deposit, requestId).vault).toBe(VaultPosition.Absent);
    expect(viewOf(sent).position(RequestKind.Withdraw, "ab".repeat(32)).vault).toBe(
      VaultPosition.Absent,
    );
  });
});

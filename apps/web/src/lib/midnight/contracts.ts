// Kinko's contracts as midnight-js sees them, and one way to call any circuit.
//
// Each contract is joined once per account and page load. A call sets the
// private state that circuit needs, runs it, and reports which real stage it
// is in (proving, balancing, submitting, confirming) by watching the
// providers themselves, so the UI never shows a spinner it cannot explain.

import {
  Contract as DisclosureContract,
  witnesses as disclosureWitnesses,
} from "@kinko/kinko-disclosure";
import {
  giftWitnesses,
  KinkoGift,
  KinkoPay,
  KinkoTags,
  payWitnesses,
  tagsWitnesses,
} from "@kinko/kinko-pay";
import {
  findDeployedContract,
  withContractScopedTransaction,
} from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/v9/compact-js";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import {
  Contract as VaultContract,
  witnesses as vaultWitnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { type Account, providersFor } from "./providers.ts";

/** Where an on-chain action is: the four real stages, and how it ended. */
export type CallStage =
  "idle" | "proving" | "balancing" | "submitting" | "confirming" | "done" | "failed";

/** Kinko's contracts, and the vault it builds on. */
export type ContractName = "pay" | "tags" | "gift" | "disclosure" | "vault";

interface Spec {
  /** Directory under ZK_BASE_URL with this contract's keys and ZK IR. */
  readonly dir: string;
  readonly privateStateId: string;
  readonly compiled: CompiledContract.CompiledContract<never, never>;
}

// In the browser the keys and ZK IR come from the zk config provider, not
// from this path; compact-js still requires one to call the contract complete.
const build = (name: string, contract: unknown, witnesses: unknown, dir: string) =>
  CompiledContract.withCompiledFileAssets(
    CompiledContract.withWitnesses(
      CompiledContract.make(name as never, contract as never),
      witnesses as never,
    ),
    dir as never,
  ) as unknown as CompiledContract.CompiledContract<never, never>;

const SPECS: Record<ContractName, Spec> = {
  pay: {
    dir: "kinko_pay",
    privateStateId: "kinko-pay",
    compiled: build("kinko_pay", KinkoPay.Contract, payWitnesses, "kinko_pay"),
  },
  tags: {
    dir: "kinko_tags",
    privateStateId: "kinko-tags",
    compiled: build("kinko_tags", KinkoTags.Contract, tagsWitnesses, "kinko_tags"),
  },
  gift: {
    dir: "kinko_gift",
    privateStateId: "kinko-gift",
    compiled: build("kinko_gift", KinkoGift.Contract, giftWitnesses, "kinko_gift"),
  },
  disclosure: {
    dir: "kinko_disclosure",
    privateStateId: "kinko-disclosure",
    compiled: build(
      "kinko_disclosure",
      DisclosureContract,
      disclosureWitnesses,
      "kinko_disclosure",
    ),
  },
  vault: {
    dir: "erc20-vault",
    privateStateId: "erc20-vault",
    compiled: build("erc20-vault", VaultContract, vaultWitnesses, "erc20-vault"),
  },
};

type Listener = (stage: CallStage) => void;

interface Joined {
  readonly providers: MidnightProviders<string, string, unknown>;
  readonly found: {
    callTx: Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>;
  };
  listener: Listener;
}

const joined = new Map<string, Promise<Joined>>();

// Wrap the providers so each stage transition reaches the current call's listener.
function instrument(p: MidnightProviders<string, string, unknown>, holder: { listener: Listener }) {
  return {
    ...p,
    proofProvider: {
      supportedEras: p.proofProvider.supportedEras,
      proveTx: async (...args: Parameters<typeof p.proofProvider.proveTx>) => {
        holder.listener("proving");
        return p.proofProvider.proveTx(...args);
      },
    },
    walletProvider: {
      supportedEras: p.walletProvider.supportedEras,
      getCoinPublicKey: () => p.walletProvider.getCoinPublicKey(),
      getEncryptionPublicKey: () => p.walletProvider.getEncryptionPublicKey(),
      balanceTx: async (...args: Parameters<typeof p.walletProvider.balanceTx>) => {
        holder.listener("balancing");
        return p.walletProvider.balanceTx(...args);
      },
    },
    midnightProvider: {
      supportedEras: p.midnightProvider.supportedEras,
      submitTx: async (...args: Parameters<typeof p.midnightProvider.submitTx>) => {
        holder.listener("submitting");
        const id = await p.midnightProvider.submitTx(...args);
        holder.listener("confirming");
        return id;
      },
    },
  } as MidnightProviders<string, string, unknown>;
}

async function join(
  account: Account,
  name: ContractName,
  address: string,
  initial: unknown,
): Promise<Joined> {
  const spec = SPECS[name];
  const holder: { listener: Listener } = { listener: () => undefined };
  const providers = instrument(await providersFor<string, unknown>(account, spec.dir), holder);
  const found = (await findDeployedContract(
    providers as never,
    {
      contractAddress: address,
      compiledContract: spec.compiled,
      privateStateId: spec.privateStateId,
      initialPrivateState: initial as never,
    } as never,
  )) as unknown as Joined["found"];
  return Object.assign(holder, { providers, found });
}

function joinedFor(
  account: Account,
  name: ContractName,
  address: string,
  initial: unknown,
): Promise<Joined> {
  const key = `${account.coinPublicKey}:${name}:${address}`;
  let j = joined.get(key);
  if (!j) {
    j = join(account, name, address, initial);
    // A failed join is forgotten, so the next call tries again.
    j.catch(() => {
      joined.delete(key);
    });
    joined.set(key, j);
  }
  return j;
}

async function prepare(
  account: Account,
  name: ContractName,
  address: string,
  privateState: unknown,
  circuit: string,
  onStage: Listener,
) {
  const j = await joinedFor(account, name, address, privateState);
  j.listener = onStage;
  await j.providers.privateStateProvider
    .forContract(address)
    .set(SPECS[name].privateStateId, privateState);
  const fn = j.found.callTx[circuit];
  if (!fn) throw new Error(`The ${name} contract has no circuit called ${circuit}.`);
  return { j, fn };
}

/** A confirmed call: its transaction id and the circuit's return value. */
export interface CallResult<R = unknown> {
  readonly txId: string;
  readonly result: R;
}

interface CallTxOutcome {
  readonly public?: { readonly txId?: string };
  readonly private?: { readonly result?: unknown };
}

/**
 * Run one circuit of one contract for the connected account.
 *
 * @param account - Who signs and pays.
 * @param name - Which contract.
 * @param address - Its deployed address.
 * @param privateState - Exactly what this circuit's witnesses need.
 * @param circuit - The circuit id.
 * @param args - The circuit's public arguments.
 * @param onStage - Told about each real stage as it begins.
 * @param encryptionKeys - For a circuit that creates coins for someone else's
 *   coin public key, that key's encryption public key (both hex): midnight-js
 *   needs it to encrypt the output to its owner.
 * @returns The transaction id and the circuit's return value.
 * @throws {Error} When the contract has no such circuit, the contract refuses, or the wallet declines.
 */
export async function callCircuit<R = unknown>(
  account: Account,
  name: ContractName,
  address: string,
  privateState: unknown,
  circuit: string,
  args: readonly unknown[],
  onStage: Listener = () => undefined,
  encryptionKeys?: ReadonlyMap<string, string>,
): Promise<CallResult<R>> {
  const { j, fn } = await prepare(account, name, address, privateState, circuit, onStage);
  onStage("proving");
  if (!encryptionKeys || encryptionKeys.size === 0) {
    const out = (await fn(...args)) as CallTxOutcome;
    onStage("done");
    return { txId: out.public?.txId ?? "", result: out.private?.result as R };
  }
  let inner: CallTxOutcome | undefined;
  const out = (await withContractScopedTransaction(
    j.providers as never,
    async (txCtx: unknown) => {
      inner = (await fn(txCtx, ...args)) as CallTxOutcome;
    },
    { additionalCoinEncPublicKeyMappings: new Map(encryptionKeys) },
  )) as CallTxOutcome;
  onStage("done");
  return {
    txId: out.public?.txId ?? inner?.public?.txId ?? "",
    result: (inner?.private?.result ?? out.private?.result) as R,
  };
}

/**
 * Run a circuit inside a scoped transaction, for calls that create coins for
 * someone else's key (the vault's fee coin): midnight-js needs that key's
 * encryption key to build the output.
 *
 * @param account - Who signs and pays.
 * @param name - Which contract.
 * @param address - Its deployed address.
 * @param privateState - Exactly what this circuit's witnesses need.
 * @param circuit - The circuit id.
 * @param args - The circuit's public arguments.
 * @param encryptionKeys - Coin public key to encryption public key, for each other recipient.
 * @param onStage - Told about each real stage as it begins.
 * @returns The transaction id.
 * @throws {Error} When the contract has no such circuit, the contract refuses, or the wallet declines.
 */
export async function callCircuitScoped(
  account: Account,
  name: ContractName,
  address: string,
  privateState: unknown,
  circuit: string,
  args: readonly unknown[],
  encryptionKeys: ReadonlyMap<string, string>,
  onStage: Listener = () => undefined,
): Promise<{ txId: string }> {
  const { j, fn } = await prepare(account, name, address, privateState, circuit, onStage);
  onStage("proving");
  const out = (await withContractScopedTransaction(
    j.providers as never,
    async (txCtx: unknown) => {
      await fn(txCtx, ...args);
    },
    { additionalCoinEncPublicKeyMappings: new Map(encryptionKeys) },
  )) as CallTxOutcome;
  onStage("done");
  return { txId: out.public?.txId ?? "" };
}

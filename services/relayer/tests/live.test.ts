// The relayer against the live local stack, end to end, the way a real user meets it:
// the user signs the start circuit and the complete circuit and nothing else on Midnight,
// the relayer carries every step in between, and the numbers on both chains and on
// `/backing` are checked against what the user did.
//
// Skipped unless RUN_INTEGRATION_TESTS=1. It needs the stack up and the vault deployed:
// `docker compose up -d`, then `yarn setup-local:erc20-vault` from the repository root,
// which writes the addresses and wallet seeds this test reads from `.env`. Run it with
// `RUN_INTEGRATION_TESTS=1 yarn workspace @kinko/relayer test tests/live.test.ts`.
//
// Three journeys, in order, because each feeds the next:
//   1. a deposit from an account that already holds its sweep's gas,
//   2. a deposit from a fresh identity whose deposit address holds USDC and no ETH, which
//      only the relayer's gas top-up lets through,
//   3. a withdrawal of the first deposit's coin.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCallTxOptions, submitCallTx } from "@midnight-ntwrk/midnight-js/contracts";
import {
  calculateRequestId,
  deriveEvmAddress,
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWord,
  parseRequestIdHex,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";
import {
  deriveWalletAddresses,
  generateHexSeed,
  getMidnightNodeConfig,
  readAccountFunding,
  WalletRegistry,
} from "@sig-net/midnight-contract-deploy";
import {
  evmAddressBytes,
  feeRecipientEncryptionMapping,
  newInputIndex,
  readVaultLedger,
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_PRIVATE_STATE_ID,
  VAULT_WITHDRAW_REQUESTS_PATH,
  vaultTokenFees,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { vaultCompiledContract } from "@sig-net/midnight-examples-erc20-vault-deploy";
import {
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
  ERC20_TRANSFER_SELECTOR,
} from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/evm-transfer.ts";
import { settleDeposit } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/flows/complete-deposit.ts";
import { settleWithdraw } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/flows/complete-withdraw.ts";
import { pollRespondBidirectional } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/flows/poll-respond-bidirectional.ts";
import { dealFork } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/fork-funding.ts";
import { TRANSFER_RESULT_MPC_ROUTING } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/mpc-routing.ts";
import { POLL_TIMEOUT_MS } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/poll-timeout.ts";
import type { VaultContext } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/vault-context.ts";
import { resolveUserIdentity } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/vault-identity.ts";
import { createVaultSession } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/vault-session.ts";
import { vaultTokenType } from "@sig-net/midnight-examples-erc20-vault-integration-tests/src/vault-token.ts";
import { buildBaseEnv } from "@sig-net/midnight-examples-lib";
import {
  appendRepoDotEnv,
  fundWalletsFromRoot,
  getErc20Balance,
  getTransactionNonce,
  requireEnv,
} from "@sig-net/midnight-examples-test-harness";
import { JsonRpcProvider, parseEther, parseUnits, Wallet } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { type RelayerRuntime, startRelayer } from "../src/runtime.ts";
import { RequestKind, RequestStage, stageRank } from "../src/types.ts";

const MINUTE = 60_000;
const PORT = 18_787;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const DEPOSIT_ONE = parseUnits("0.3", 6);
const DEPOSIT_TWO = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = parseUnits("0.2", 6);

interface BackingBody {
  readonly usdcInVault: string;
  readonly kusdMinted: string;
  readonly kusdBurned: string;
  readonly evmVaultAddress: string;
  readonly ethereumBlock: number;
  readonly midnightBlock: number;
}

interface StatusBody {
  readonly kind: RequestKind;
  readonly stage: RequestStage;
  readonly evmTxHash?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

/** The stages a request moved through, with when each was first seen, polled over HTTP. */
interface Journey {
  readonly stages: RequestStage[];
  readonly seenAtMs: number[];
  readonly last: StatusBody;
}

/** Whether the stages seen only ever moved forward along the healthy path. */
const isInOrder = (stages: readonly RequestStage[]): boolean =>
  stages.every((stage, index) => {
    const previous = stages[index - 1];
    return previous === undefined || stageRank(stage) > stageRank(previous);
  });

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== "1")("the relayer, live", () => {
  // What the setup pipeline holds in memory and never writes to .env: the local fork's RPC
  // and tracing the EVM node for the attested output.
  const env: NodeJS.ProcessEnv = {
    RESPOND_OUTPUT_SOURCE: "evm-node",
    EVM_RPC_URL: "http://127.0.0.1:8545",
    ...buildBaseEnv(),
  };
  const provider = new JsonRpcProvider(env.EVM_RPC_URL ?? "http://127.0.0.1:8545");
  const sponsor = Wallet.createRandom();
  const stateDirectory = mkdtempSync(join(tmpdir(), "relayer-live-"));
  let relayer: RelayerRuntime | undefined;
  const sessions: ReturnType<typeof createVaultSession>[] = [];

  const erc20 = (): string => requireEnv(env, "ERC20_ADDRESS");
  const rpc = (): string => env.EVM_RPC_URL ?? "http://127.0.0.1:8545";

  const getBacking = async (): Promise<{ status: number; body: BackingBody }> => {
    const response = await fetch(`${BASE}/backing`);
    return { status: response.status, body: (await response.json()) as BackingBody };
  };

  const getStatus = async (requestId: string): Promise<{ status: number; body: StatusBody }> => {
    const response = await fetch(`${BASE}/requests/${requestId}`);
    return { status: response.status, body: (await response.json()) as StatusBody };
  };

  /** What backs the dollar right now, in base units. */
  const backing = async (): Promise<{ usdc: bigint; minted: bigint; burned: bigint }> => {
    const { status, body } = await getBacking();
    expect(status).toBe(200);
    console.log(`[live] /backing ${JSON.stringify(body)}`);
    return {
      usdc: BigInt(body.usdcInVault),
      minted: BigInt(body.kusdMinted),
      burned: BigInt(body.kusdBurned),
    };
  };

  /** Poll a request over HTTP until it reaches `target`, recording every stage seen. */
  const followUntil = async (requestId: string, target: RequestStage): Promise<Journey> => {
    const stages: RequestStage[] = [];
    const seenAtMs: number[] = [];
    const started = Date.now();
    for (;;) {
      const { status, body } = await getStatus(requestId);
      expect(status).toBe(200);
      if (stages.at(-1) !== body.stage) {
        stages.push(body.stage);
        seenAtMs.push(Date.now() - started);
        console.log(
          `[live] ${requestId.slice(0, 8)} -> ${body.stage} (+${String(Date.now() - started)}ms)`,
        );
      }
      if (body.stage === target) return { stages, seenAtMs, last: body };
      if (body.stage === RequestStage.Failed) {
        throw new Error(`the relayer failed the request: ${body.error ?? "no reason given"}`);
      }
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        throw new Error(`still ${body.stage} after ${String(POLL_TIMEOUT_MS)}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };

  /** Queue a deposit and stop: the relayer flushes and sends it. Returns the request id the ledger will hold. */
  const queueDeposit = async (
    context: VaultContext,
    amount: bigint,
  ): Promise<{ requestId: RequestIdHex; inIndex: bigint }> => {
    const before = await readVaultLedger(
      context.providers.publicDataProvider,
      context.vaultContractAddress,
    );
    const evmNonce = await getTransactionNonce(context.evmRpcUrl, context.evmUserAddress);
    const erc20Bytes = evmAddressBytes(context.erc20Address);
    const expected: SignBidirectionalEvent = {
      sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
      keyVersion: SIGNET_DEFAULT_KEY_VERSION,
      path: context.identity.commitment,
      ...TRANSFER_RESULT_MPC_ROUTING,
      txParamType: TxParamType.evmType2,
      txParams: {
        to: erc20Bytes,
        chainId: before.evmChainId,
        nonce: evmNonce,
        gasLimit: ERC20_TRANSFER_GAS_LIMIT,
        maxFeePerGas: ERC20_TRANSFER_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
        value: 0n,
        accessListEntryCount: 0n,
        accessList: [],
        calldata: {
          is_some: true,
          value: {
            selector: ERC20_TRANSFER_SELECTOR,
            noWords: 2n,
            words: [evmAddressAbiWord(before.vaultEvmAddress), numericAbiWord(amount)],
          },
        },
      },
    };
    const inIndex = newInputIndex();
    const queued = await context.vault.callTx.startDeposit(
      inIndex,
      evmNonce,
      {
        gasLimit: ERC20_TRANSFER_GAS_LIMIT,
        maxFeePerGas: ERC20_TRANSFER_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
      },
      { erc20Address: erc20Bytes, amount },
    );
    console.log(`[live] startDeposit tx ${queued.public.txId}`);
    return { requestId: requestIdHex(calculateRequestId(expected)), inIndex };
  };

  const register = async (kind: RequestKind, requestId: string): Promise<Response> =>
    fetch(`${BASE}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, requestId }),
    });

  const shieldedBalance = async (
    session: ReturnType<typeof createVaultSession>,
    context: VaultContext,
  ): Promise<bigint> => {
    const wallet = await session.wallet();
    const color = vaultTokenType(context.erc20Address, context.vaultContractAddress);
    return (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;
  };

  beforeAll(async () => {
    const node = getMidnightNodeConfig(env);

    // The relayer's own wallet: seeded once, kept in .env, funded from root.
    let relayerSeed = env.RELAYER_SEED;
    if (relayerSeed === undefined || relayerSeed === "") {
      relayerSeed = generateHexSeed();
      appendRepoDotEnv({ RELAYER_SEED: relayerSeed }, "relayer wallet (live test)");
    }
    const wallets = new WalletRegistry(node, env);
    try {
      const root = await readAccountFunding(wallets, requireEnv(env, "ROOT_SEED"), "root");
      const relayerFunding = await readAccountFunding(wallets, relayerSeed, "relayer");
      console.log(`[live] relayer wallet ${deriveWalletAddresses(relayerSeed, node).unshielded}`);
      if (relayerFunding.night === 0n && relayerFunding.dust === 0n) {
        await fundWalletsFromRoot(wallets, requireEnv(env, "ROOT_SEED"), [
          { seed: relayerSeed, label: "relayer", amount: root.night / 10n },
        ]);
      }
    } finally {
      await wallets.close();
    }

    // The gas sponsor holds ETH on the fork and nothing else.
    await provider.send("anvil_setBalance", [
      sponsor.address,
      `0x${parseEther("50").toString(16)}`,
    ]);

    const config = loadConfig({
      ...env,
      RELAYER_SEED: relayerSeed,
      USDC_ADDRESS: erc20(),
      EVM_RPC_URL: rpc(),
      RELAYER_PORT: String(PORT),
      RELAYER_STATE_FILE: join(stateDirectory, "state.json"),
      RELAYER_POLL_INTERVAL_MS: "2000",
      RELAYER_BACKING_CACHE_MS: "0",
      RELAYER_CORS_ORIGINS: "http://localhost:3000",
      RELAYER_EVM_PRIVATE_KEY: sponsor.privateKey,
      RELAYER_GAS_MAX_PER_ADDRESS_WEI: parseEther("0.5").toString(),
      RELAYER_GAS_MAX_PER_DAY_WEI: parseEther("2").toString(),
    });
    relayer = await startRelayer(
      config,
      {
        info: (message) => {
          console.log(`[relayer] ${message}`);
        },
        warn: (message) => {
          console.warn(`[relayer] WARN ${message}`);
        },
      },
      env,
    );
  }, 30 * MINUTE);

  afterAll(async () => {
    await relayer?.stop();
    for (const session of sessions) await session.stop();
    rmSync(stateDirectory, { recursive: true, force: true });
    provider.destroy();
  });

  it("reports its network, contracts and chain on /health", async () => {
    const response = await fetch(`${BASE}/health`);
    const body = (await response.json()) as Record<string, string | number | boolean>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      network: env.NETWORK_ID ?? "undeployed",
      vaultContractAddress: requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
      evmVaultAddress: requireEnv(env, "EVM_VAULT_ADDRESS").toLowerCase(),
      usdcAddress: erc20().toLowerCase(),
      evmChainId: Number(requireEnv(env, "EVM_CHAIN_ID")),
    });
  });

  it("derives the deposit address a user's wallet derives for the same commitment", async () => {
    const session = createVaultSession(env, "user");
    sessions.push(session);
    const context = await session.vaultContext();

    const response = await fetch(
      `${BASE}/deposit-address?commitment=${context.identity.commitmentHex}`,
    );
    const body = (await response.json()) as { evmAddress: string };

    expect(response.status).toBe(200);
    expect(body.evmAddress.toLowerCase()).toBe(context.evmUserAddress.toLowerCase());
  });

  // The first deposit's session, whose coin the withdrawal spends.
  let firstUser: ReturnType<typeof createVaultSession> | undefined;

  it(
    "carries a deposit from the user's start to ready, and the user's complete mints exactly the deposit",
    async () => {
      const session = createVaultSession(env, "user");
      sessions.push(session);
      firstUser = session;
      const context = await session.vaultContext();
      const before = await backing();
      const shieldedBefore = await shieldedBalance(session, context);
      const userUsdcBefore = (await getErc20Balance(rpc(), erc20(), context.evmUserAddress))
        .balance;
      expect(userUsdcBefore).toBeGreaterThanOrEqual(DEPOSIT_ONE);

      const { requestId } = await queueDeposit(context, DEPOSIT_ONE);

      // The vault holds the request only in its input buffer: the relayer must derive its
      // id from the queued entry, and the stage it reports first is the one it found.
      const registered = await register(RequestKind.Deposit, requestId);
      expect(registered.status).toBe(202);

      const journey = await followUntil(requestId, RequestStage.Ready);
      expect(journey.stages[0]).toBe(RequestStage.Queued);
      expect(isInOrder(journey.stages)).toBe(true);
      expect(journey.last.evmTxHash).toMatch(/^0x[0-9a-f]{64}$/);

      // The user's one remaining step.
      const outcome = await pollRespondBidirectional(context, {
        requestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
      });
      expect(outcome.succeeded).toBe(true);
      await settleDeposit(context, outcome);

      const completed = await followUntil(requestId, RequestStage.Completed);
      expect(completed.last.stage).toBe(RequestStage.Completed);

      const after = await backing();
      expect({
        usdc: after.usdc - before.usdc,
        minted: after.minted - before.minted,
        burned: after.burned - before.burned,
      }).toEqual({ usdc: DEPOSIT_ONE, minted: DEPOSIT_ONE, burned: 0n });
      expect((await getErc20Balance(rpc(), erc20(), context.evmUserAddress)).balance).toBe(
        userUsdcBefore - DEPOSIT_ONE,
      );
      expect(await shieldedBalance(session, context)).toBe(shieldedBefore + DEPOSIT_ONE);
      console.log(`[live] deposit one journey: ${JSON.stringify(journey)}`);
    },
    40 * MINUTE,
  );

  it(
    "funds the gas of a deposit address that holds USDC and no ETH, within its limits, and carries that deposit too",
    async () => {
      // The bearer wallet is a second user, with its own identity and deposit address.
      const bearerEnv = { ...env, USER_SEED: requireEnv(env, "BEARER_SEED") };
      const derived = deriveEvmAddress(
        requireEnv(env, "MPC_SECP256K1_PUBKEY"),
        requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
        resolveUserIdentity(bearerEnv).commitmentHex,
      );
      const session = createVaultSession({ ...bearerEnv, EVM_USER_ADDRESS: derived }, "bearer");
      sessions.push(session);
      const context = await session.vaultContext();
      await dealFork(provider, derived, DEPOSIT_TWO);
      await provider.send("anvil_setBalance", [derived, "0x0"]);
      expect(await provider.getBalance(derived)).toBe(0n);
      const sponsorBefore = await provider.getBalance(sponsor.address);
      const before = await backing();

      const { requestId } = await queueDeposit(context, DEPOSIT_TWO);
      expect((await register(RequestKind.Deposit, requestId)).status).toBe(202);
      const journey = await followUntil(requestId, RequestStage.Ready);
      const outcome = await pollRespondBidirectional(context, {
        requestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
      });
      expect(outcome.succeeded).toBe(true);
      await settleDeposit(context, outcome);
      await followUntil(requestId, RequestStage.Completed);

      const after = await backing();
      expect(after.usdc - before.usdc).toBe(DEPOSIT_TWO);
      expect(after.minted - before.minted).toBe(DEPOSIT_TWO);
      // The relayer sent the sweep's gas ceiling and no more, and the sponsor paid for it.
      const sent = sponsorBefore - (await provider.getBalance(sponsor.address));
      expect(sent).toBeGreaterThan(0n);
      expect(sent).toBeLessThanOrEqual(
        ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS + parseEther("0.001"),
      );
      expect(isInOrder(journey.stages)).toBe(true);
      expect(journey.last.evmTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      console.log(
        `[live] deposit two (gas top-up ${String(sent)} wei) journey: ${JSON.stringify(journey)}`,
      );
    },
    40 * MINUTE,
  );

  it(
    "carries a withdrawal: the relayer flushes and sends it unasked, and the user's complete settles it",
    async () => {
      const session = firstUser;
      if (session === undefined) throw new Error("the first deposit did not run");
      const context = await session.vaultContext();
      const ledgerBefore = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      const fee = vaultTokenFees(ledgerBefore, evmAddressBytes(erc20())).withdraw;
      const destination = Wallet.createRandom().address;
      const before = await backing();
      const destinationBefore = (await getErc20Balance(rpc(), erc20(), destination)).balance;
      const knownBefore = new Set(
        toSignBidirectionalEventIndex(ledgerBefore.bidirectionalWithdrawMap).keys(),
      );

      const inIndex = newInputIndex();
      const coin = {
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        color: hexToBytes(vaultTokenType(erc20(), context.vaultContractAddress)),
        value: WITHDRAW_AMOUNT + fee,
      };
      const queued = await submitCallTx(context.providers, {
        ...createCallTxOptions(
          vaultCompiledContract,
          "startWithdraw",
          context.vaultContractAddress,
          VAULT_PRIVATE_STATE_ID,
          feeRecipientEncryptionMapping(ledgerBefore),
          [
            inIndex,
            {
              erc20Address: evmAddressBytes(erc20()),
              amount: WITHDRAW_AMOUNT,
              destEvmAddress: evmAddressBytes(destination),
            },
            coin,
          ],
        ),
        privateStateId: VAULT_PRIVATE_STATE_ID,
      });
      console.log(`[live] startWithdraw tx ${queued.public.txId}`);

      // Nobody registered it: the relayer flushes and sends it, then its id appears.
      let requestId: string | undefined;
      const waitStarted = Date.now();
      while (requestId === undefined) {
        const state = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        requestId = [...toSignBidirectionalEventIndex(state.bidirectionalWithdrawMap).keys()].find(
          (id) => !knownBefore.has(id),
        );
        if (requestId === undefined) {
          if (Date.now() - waitStarted > 15 * MINUTE) {
            throw new Error("the relayer did not flush and send the withdrawal within 15 minutes");
          }
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
      console.log(
        `[live] withdrawal sent by the relayer after ${String(Date.now() - waitStarted)}ms: ${requestId}`,
      );

      expect((await register(RequestKind.Withdraw, requestId)).status).toBe(202);
      const journey = await followUntil(requestId, RequestStage.Ready);
      expect(isInOrder(journey.stages)).toBe(true);
      const outcome = await pollRespondBidirectional(context, {
        requestId: parseRequestIdHex(requestId),
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        requestsPath: VAULT_WITHDRAW_REQUESTS_PATH,
      });
      expect(outcome.succeeded).toBe(true);
      await settleWithdraw(context, outcome);
      await followUntil(requestId, RequestStage.Completed);

      const after = await backing();
      expect({
        usdc: after.usdc - before.usdc,
        minted: after.minted - before.minted,
        burned: after.burned - before.burned,
      }).toEqual({ usdc: -WITHDRAW_AMOUNT, minted: 0n, burned: WITHDRAW_AMOUNT });
      expect((await getErc20Balance(rpc(), erc20(), destination)).balance - destinationBefore).toBe(
        WITHDRAW_AMOUNT,
      );
      console.log(`[live] withdraw journey: ${JSON.stringify(journey)}`);
    },
    40 * MINUTE,
  );

  it("shows the vault holding at least the dollar it has in circulation", async () => {
    const { usdc, minted, burned } = await backing();

    expect(usdc).toBeGreaterThanOrEqual(minted - burned);
  });
});

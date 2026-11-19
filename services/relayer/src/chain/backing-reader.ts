// What backs the dollar: the vault's USDC on Ethereum against the KUSD the vault has
// minted and burned on Midnight, read from the two chains' public state.

import {
  evmAddressBytes,
  readVaultLedger,
  type VaultProviders,
  vaultTokenSupply,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { Contract, type JsonRpcProvider } from "ethers";

import type { BackingPort, BackingReading } from "../backing.ts";

const ERC20_BALANCE_OF = ["function balanceOf(address owner) view returns (uint256)"];

/** What {@link ChainBackingReader} reads through. */
export interface ChainBackingReaderOptions {
  /** The vault's provider set, read for its public ledger. */
  readonly providers: VaultProviders;
  /** The vault's contract address, bare hex. */
  readonly vaultContractAddress: string;
  /** A provider on the vault's Ethereum chain. */
  readonly evmProvider: JsonRpcProvider;
  /** The USDC contract, 0x-prefixed. */
  readonly usdcAddress: string;
  /** The indexer's GraphQL endpoint, for the Midnight block height. */
  readonly indexerUrl: string;
}

/** Reads the backing from the chains. */
export class ChainBackingReader implements BackingPort {
  private readonly options: ChainBackingReaderOptions;
  private readonly usdc: Contract;

  /**
   * Bind to the chains.
   *
   * @param options - The providers and addresses to read.
   */
  constructor(options: ChainBackingReaderOptions) {
    this.options = options;
    this.usdc = new Contract(options.usdcAddress, ERC20_BALANCE_OF, options.evmProvider);
  }

  /** @inheritdoc */
  async read(): Promise<BackingReading> {
    const { providers, vaultContractAddress, evmProvider, usdcAddress } = this.options;
    const [state, ethereumBlock, midnightBlock] = await Promise.all([
      readVaultLedger(providers.publicDataProvider, vaultContractAddress),
      evmProvider.getBlockNumber(),
      this.midnightBlock(),
    ]);
    const evmVaultAddress = `0x${Buffer.from(state.vaultEvmAddress).toString("hex")}`;
    const supply = vaultTokenSupply(state, evmAddressBytes(usdcAddress));
    // Read the balance after the ledger: a deposit's sweep lands on Ethereum before the
    // vault mints for it, so a later balance can only err toward over-backed.
    const usdcInVault = (await this.usdc.getFunction("balanceOf")(evmVaultAddress)) as bigint;
    return {
      usdcInVault,
      kusdMinted: supply.minted,
      kusdBurned: supply.burned,
      evmVaultAddress,
      ethereumBlock,
      midnightBlock,
    };
  }

  private async midnightBlock(): Promise<number> {
    const response = await fetch(this.options.indexerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ block { height } }" }),
    });
    if (!response.ok) throw new Error(`the indexer answered ${String(response.status)}`);
    const body = (await response.json()) as { data?: { block?: { height?: number } } };
    const height = body.data?.block?.height;
    if (typeof height !== "number") throw new Error("the indexer returned no block height");
    return height;
  }
}

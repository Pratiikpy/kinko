// The sponsor's wallet, narrowed to the four things the service asks of it.
//
// It balances DUST only. The holder's transaction arrives bound, with its own
// value already balanced, so the sponsor adds a fee offer and nothing else:
// the binding makes any other change invalid on chain.

import * as ledger from "@midnightntwrk/ledger-v9";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import type { AccountKeys } from "@sig-net/midnight-contract-deploy";

import type { SponsorSigner } from "./service.ts";

/** How long the sponsor's fee offer stays valid. The holder's own TTL still binds. */
const FEE_TTL_MS = 30 * 60 * 1000;

type FinalizedTx = Awaited<ReturnType<WalletFacade["finalizeRecipe"]>>;

/**
 * A signer over a started, synced wallet. The service speaks ledger transactions and the
 * facade its own handles, so each crosses between the two as bytes.
 *
 * @param facade - The sponsor's facade.
 * @param keys - The sponsor's keys.
 * @returns The signer.
 */
export function facadeSigner(facade: WalletFacade, keys: AccountKeys): SponsorSigner {
  const handle = (tx: ledger.FinalizedTransaction): FinalizedTx =>
    facade.adoptTransaction(tx.serialize(), "Finalized");
  const unwrap = (tx: FinalizedTx): ledger.FinalizedTransaction =>
    ledger.Transaction.deserialize(
      "signature",
      "proof",
      "binding",
      tx.serialize(),
    ) as unknown as ledger.FinalizedTransaction;
  return {
    address: keys.unshieldedKeystore.getBech32Address().asString(),
    async dustSpeck() {
      const state = await facade.waitForSyncedState();
      // The projection throws while the dust tree catches up; a sponsor in that
      // state has nothing it can spend yet.
      try {
        return state.dust.balance(new Date());
      } catch {
        return 0n;
      }
    },
    estimateFee: (tx: ledger.FinalizedTransaction) => facade.estimateTransactionFee(handle(tx)),
    async addDustFees(tx: ledger.FinalizedTransaction) {
      const recipe = await facade.balanceFinalizedTransaction(handle(tx), {
        ttl: new Date(Date.now() + FEE_TTL_MS),
        tokenKindsToBalance: ["dust"],
      });
      const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
      return unwrap(await facade.finalizeRecipe(signed));
    },
    submit: (tx: ledger.FinalizedTransaction) => facade.submitTransaction(handle(tx)),
  };
}

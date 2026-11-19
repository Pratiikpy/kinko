import { useEffect } from "react";

import { CONTRACTS } from "../lib/config.ts";
import { readerFor } from "../lib/midnight/providers.ts";
import { invoiceView, readPayLedger } from "../lib/pay.ts";
import { patch, type RecordsDoc } from "../lib/records.ts";
import { useAccount } from "../state/account.tsx";
import { useAsync } from "./useAsync.ts";

/**
 * Read the public status of every invoice this account issued, in one ledger
 * read, and cache it in the records for the list views.
 *
 * @param intervalMs - How often to read the ledger again.
 * @returns The ledger read's state.
 */
export function useInvoiceStatuses(intervalMs = 20_000) {
  const { account, records, update } = useAccount();
  const count = records?.invoices.length ?? 0;
  const read = useAsync(
    async () => {
      if (!CONTRACTS.pay) throw new Error("kinko_pay is not deployed in this build.");
      return readPayLedger(await readerFor(account), CONTRACTS.pay);
    },
    [account, count],
    { intervalMs, enabled: Boolean(account && count > 0) },
  );

  useEffect(() => {
    if (read.status !== "ready" || !records) return;
    const ledger = read.value;
    const changes = records.invoices
      .map((i) => ({ i, v: invoiceView(ledger, i.commitment) }))
      .filter(
        ({ i, v }) =>
          (v?.status ?? "unknown") !== i.status || (v?.contributions ?? 0) !== i.contributions,
      );
    if (changes.length === 0) return;
    void update((doc: RecordsDoc) =>
      changes.reduce(
        (d, { i, v }) =>
          patch(d, "invoices", i.commitment, {
            status: v?.status ?? "unknown",
            contributions: v?.contributions ?? 0,
            checkedAt: Date.now(),
          }),
        doc,
      ),
    );
  }, [read, records, update]);

  return read;
}

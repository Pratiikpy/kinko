import { useCallback, useEffect, useState } from "react";

import { explain } from "../lib/errors.ts";
import { patch, type VaultRequestRecord } from "../lib/records.ts";
import { isTerminal, relayer, RelayerError } from "../lib/relayer.ts";
import { useAccount } from "../state/account.tsx";

const POLL_MS = 5_000;

/** What the request screens need from {@link useRelayedRequest}. */
export interface RelayedRequest {
  readonly pollError: string | null;
  readonly retry: () => Promise<void>;
  readonly retrying: boolean;
}

/**
 * Follow one request through the relayer and mirror each reported stage into
 * the encrypted records, so a closed tab resumes exactly where it stopped.
 * A relayer that forgets the request (404) is told about it again: the
 * registration is idempotent and the id is fixed by the chain.
 *
 * @param record - The request this device started, or undefined when there is none.
 * @returns The last polling error, and a way to ask the relayer to retry.
 */
export function useRelayedRequest(record: VaultRequestRecord | undefined): RelayedRequest {
  const { update } = useAccount();
  const [pollError, setPollError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const requestId =
    record?.phase === "relaying" && !(record.lastStage && isTerminal(record.lastStage))
      ? record.requestId
      : undefined;
  const localId = record?.localId;
  const kind = record?.kind;

  useEffect(() => {
    const client = relayer;
    if (!requestId || !localId || !kind || !client) return;
    let live = true;
    const tick = async () => {
      try {
        const s = await client.status(requestId);
        if (!live) return;
        setPollError(null);
        await update((doc) =>
          patch(doc, "requests", localId, {
            lastStage: s.stage,
            evmTxHash: s.evmTxHash,
            error: s.error,
            updatedAt: Date.now(),
            ...(s.stage === "failed" ? { phase: "failed" as const } : {}),
          }),
        );
      } catch (e) {
        if (!live) return;
        if (e instanceof RelayerError && e.kind === "not-found") {
          await client.register(kind, requestId).catch(() => undefined);
          return;
        }
        setPollError(explain(e).message);
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [requestId, localId, kind, update]);

  const retry = useCallback(async () => {
    if (!record?.requestId || !relayer) return;
    setRetrying(true);
    try {
      await relayer.register(record.kind, record.requestId);
      await update((doc) =>
        patch(doc, "requests", record.localId, {
          phase: "relaying",
          lastStage: undefined,
          error: undefined,
          updatedAt: Date.now(),
        }),
      );
      setPollError(null);
    } catch (e) {
      setPollError(explain(e).message);
    } finally {
      setRetrying(false);
    }
  }, [record, update]);

  return { pollError, retry, retrying };
}

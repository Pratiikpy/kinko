import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CardInput,
  type CardState,
  type CardWallet,
  entropyOf,
  type FeeSource,
  openCard,
} from "../lib/card.ts";
import { explain } from "../lib/errors.ts";

/** Where opening a card is. */
export type CardSession =
  | { readonly status: "closed" }
  | { readonly status: "unlocking" }
  | { readonly status: "syncing"; readonly wallet: CardWallet; readonly progress: number | null }
  | { readonly status: "ready"; readonly wallet: CardWallet; readonly state: CardState }
  | { readonly status: "error"; readonly message: string };

/**
 * Open one card at a time, follow its balance as the chain moves, and stop it
 * when the page goes away or another card is opened.
 *
 * @returns The session, and controls to open and close it.
 */
export function useCardWallet(): {
  session: CardSession;
  open: (input: CardInput, fees: FeeSource | undefined, pin?: string) => Promise<void>;
  close: () => void;
} {
  const [session, setSession] = useState<CardSession>({ status: "closed" });
  const current = useRef<{ wallet?: CardWallet; stop: () => void } | null>(null);

  const close = useCallback(() => {
    current.current?.stop();
    current.current = null;
    setSession({ status: "closed" });
  }, []);

  const open = useCallback(
    async (input: CardInput, fees: FeeSource | undefined, pin?: string) => {
      close();
      // An object, not a `let`: it is flipped from closures the type checker cannot follow.
      const run = { cancelled: false };
      const handle: { wallet?: CardWallet; stop: () => void } = {
        stop: () => {
          run.cancelled = true;
          void handle.wallet?.stop();
        },
      };
      current.current = handle;
      setSession({ status: "unlocking" });
      try {
        const wallet = await openCard(await entropyOf(input, pin), fees, input.birth);
        handle.wallet = wallet;
        if (run.cancelled) {
          void wallet.stop();
          return;
        }
        setSession({ status: "syncing", wallet, progress: null });
        const sub = wallet.state().subscribe({
          next: (state: CardState) => {
            if (run.cancelled) return;
            setSession(
              state.synced
                ? { status: "ready", wallet, state }
                : { status: "syncing", wallet, progress: state.progress },
            );
          },
          error: (e: unknown) => {
            if (!run.cancelled) setSession({ status: "error", message: explain(e).message });
          },
        });
        handle.stop = () => {
          run.cancelled = true;
          sub.unsubscribe();
          void wallet.stop();
        };
      } catch (e) {
        if (!run.cancelled) setSession({ status: "error", message: explain(e).message });
      }
    },
    [close],
  );

  useEffect(() => close, [close]);
  return { session, open, close };
}

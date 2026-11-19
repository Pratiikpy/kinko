import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

import { explain } from "../lib/errors.ts";

/** One async read's state; the last good value is kept while it refreshes or fails. */
export type AsyncState<T> =
  | { readonly status: "loading"; readonly value?: T }
  | { readonly status: "ready"; readonly value: T; readonly at: number }
  | { readonly status: "error"; readonly message: string; readonly value?: T };

/**
 * Run an async read, keep its last good value while refreshing, and refresh
 * on an interval when asked. Errors become sentences, never thrown renders.
 *
 * @param read - The read to run. The latest closure is always used.
 * @param deps - Values whose change starts a fresh read.
 * @param options - How often to re-read, and whether to read at all.
 * @param options.intervalMs - Re-read every this many milliseconds; never when absent.
 * @param options.enabled - When false, nothing is read and the state stays as it is.
 * @returns The read's state and a function that reads again now.
 */
export function useAsync<T>(
  read: () => Promise<T>,
  deps: DependencyList,
  options: { intervalMs?: number; enabled?: boolean } = {},
): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const enabled = options.enabled ?? true;
  const intervalMs = options.intervalMs;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const run = async () => {
      setState((s) => (s.status === "ready" ? s : { status: "loading", value: s.value }));
      try {
        const value = await readRef.current();
        if (live) setState({ status: "ready", value, at: Date.now() });
      } catch (e) {
        if (live)
          setState((s) => ({ status: "error", message: explain(e).message, value: s.value }));
      }
    };
    void run();
    const id = intervalMs
      ? window.setInterval(() => {
          void run();
        }, intervalMs)
      : undefined;
    return () => {
      live = false;
      if (id) window.clearInterval(id);
    };
    // The caller's deps list is spread in deliberately: it is this hook's contract.
  }, [...deps, tick, enabled, intervalMs]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  return { ...state, refresh };
}

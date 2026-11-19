import { useCallback, useRef, useState } from "react";

import { explain } from "../lib/errors.ts";
import type { CallStage } from "../lib/midnight/contracts.ts";

/** One on-chain action's progress, and the controls to run or reset it. */
export interface CallRunner {
  readonly stage: CallStage;
  readonly startedAt: number | null;
  readonly error: string | null;
  readonly busy: boolean;
  /** Run the work, reporting each stage it enters; resolves to undefined when it did not finish. */
  run<T>(work: (onStage: (s: CallStage) => void) => Promise<T>): Promise<T | undefined>;
  /** Forget the last outcome. */
  reset(): void;
}

const IN_FLIGHT: readonly CallStage[] = ["proving", "balancing", "submitting", "confirming"];

/**
 * Tracks one on-chain action from first click to confirmation. A refusal by
 * the person in their wallet resets quietly; anything else is explained.
 *
 * @returns The action's state and controls.
 */
export function useCall(): CallRunner {
  const [stage, setStage] = useState<CallStage>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async <T>(work: (onStage: (s: CallStage) => void) => Promise<T>) => {
    if (running.current) return undefined;
    running.current = true;
    setError(null);
    setStartedAt(Date.now());
    setStage("proving");
    try {
      const out = await work(setStage);
      setStage("done");
      return out;
    } catch (e) {
      const x = explain(e);
      // The plain-language message replaces the raw one on screen; the raw
      // one stays in the console for whoever has to diagnose the failure.
      if (!x.declined) console.warn("[kinko] the action failed:", e);
      if (x.declined) {
        setStage("idle");
        setError(null);
      } else {
        setError(x.message);
        setStage("failed");
      }
      return undefined;
    } finally {
      running.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setStartedAt(null);
  }, []);

  return { stage, startedAt, error, busy: IN_FLIGHT.includes(stage), run, reset };
}

// The steps of a deposit or withdrawal as a person sees them, derived from
// what this device did and what the relayer last reported. Pure, so every
// combination of the two is covered by tests rather than by hope.

import type { VaultRequestRecord } from "./records.ts";
import { PROGRESS_STAGES, type RequestKind, type Stage, STAGE_COPY } from "./relayer.ts";

/** Where one step stands. */
export type StepState = "done" | "current" | "todo" | "failed";

/** One step of a deposit or withdrawal, as the stepper shows it. */
export interface Step {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly who: "you" | "relayer";
  readonly state: StepState;
  readonly typicalSeconds: number;
}

const RELAYED: readonly Exclude<Stage, "failed" | "completed">[] = PROGRESS_STAGES.filter(
  (s): s is Exclude<Stage, "failed" | "completed"> => s !== "completed",
);

const USER_FIRST: Record<RequestKind, { key: string; title: string; detail: string }[]> = {
  deposit: [
    {
      key: "fund",
      title: "Send USDC to your deposit address",
      detail: "From your Ethereum wallet, plus a little ETH for the sweep's gas.",
    },
    {
      key: "start",
      title: "Start the deposit",
      detail: "You sign once on Midnight. This fixes the amount and where it goes.",
    },
  ],
  withdraw: [
    {
      key: "start",
      title: "Start the withdrawal",
      detail: "You sign once on Midnight. Your KUSD is burned and the destination fixed.",
    },
  ],
};

const USER_LAST: Record<RequestKind, { title: string; detail: string }> = {
  deposit: {
    title: "Receive your private dollars",
    detail: "You sign once more and the vault mints KUSD to you.",
  },
  withdraw: {
    title: "Close the withdrawal",
    detail: "You sign once more. If the transfer failed, this returns your KUSD.",
  },
};

/**
 * The full list of steps and where this request is in it.
 *
 * @param kind - Deposit or withdrawal.
 * @param record - What this device knows about the request.
 * @returns Every step, each marked done, current, to do or failed.
 */
export function stepsFor(
  kind: RequestKind,
  record: Pick<VaultRequestRecord, "phase" | "lastStage">,
): Step[] {
  const { phase, lastStage } = record;
  const failed = phase === "failed";
  // How far the request has got, as an index into the combined list.
  const first = USER_FIRST[kind];
  const relayedFrom = first.length;
  // The final slot is "ready", presented as the person's last signature.
  const readySlot = relayedFrom + RELAYED.length - 1;
  const total = readySlot + 1;

  // A reported stage is a stage reached: the step after it is the current one.
  const afterReported = (): number => {
    if (!lastStage || lastStage === "failed") return relayedFrom;
    if (lastStage === "completed") return total;
    return Math.min(relayedFrom + RELAYED.indexOf(lastStage) + 1, readySlot);
  };

  let current: number;
  if (phase === "done") current = total;
  else if (phase === "funding") current = 0;
  else if (phase === "starting") current = first.length - 1;
  else if (phase === "completing") current = readySlot;
  else current = afterReported();

  const stateAt = (i: number): StepState => {
    if (i < current) return "done";
    if (i === current) return failed ? "failed" : "current";
    return "todo";
  };

  const steps: Step[] = [
    ...first.map((s, i): Step => ({
      ...s,
      who: "you",
      state: stateAt(i),
      typicalSeconds: s.key === "fund" ? 30 : 45,
    })),
    ...RELAYED.map((stage, j): Step => ({
      key: stage,
      title: STAGE_COPY[kind][stage].title,
      detail: STAGE_COPY[kind][stage].detail,
      who: stage === "ready" ? "you" : "relayer",
      state: stateAt(relayedFrom + j),
      typicalSeconds: STAGE_COPY[kind][stage].typicalSeconds,
    })),
  ];
  // "ready" is where the person signs the last time; present it as their step.
  const ready = steps[steps.length - 1];
  if (ready) {
    steps[steps.length - 1] = {
      ...ready,
      title: USER_LAST[kind].title,
      detail: USER_LAST[kind].detail,
    };
  }
  return steps;
}

/**
 * Seconds the remaining steps usually take, for "about N minutes left".
 *
 * @param steps - The request's steps.
 * @returns The estimated seconds still to go.
 */
export const secondsLeft = (steps: readonly Step[]): number =>
  steps.filter((s) => s.state !== "done").reduce((sum, s) => sum + s.typicalSeconds, 0);

import { Check, CircleAlert, User, Workflow } from "lucide-react";

import { secondsLeft, type Step } from "../lib/flow.ts";
import { formatDuration } from "../lib/format.ts";
import { cx } from "./ui.tsx";

/**
 * A request's steps, top to bottom, with who acts at each and roughly how long it takes.
 */
export function Stepper({ steps, label }: { steps: readonly Step[]; label: string }) {
  const left = secondsLeft(steps);
  const active = steps.some((s) => s.state === "current");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{label}</p>
        {active && left > 0 ? (
          <p className="text-sm text-ink-3">Estimated {formatDuration(left)} left</p>
        ) : null}
      </div>
      <ol className="relative space-y-0">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className="relative flex gap-4 pb-5 last:pb-0"
            aria-current={s.state === "current" ? "step" : undefined}
          >
            {i < steps.length - 1 ? (
              <span
                aria-hidden
                className={cx(
                  "absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px",
                  s.state === "done" ? "bg-shu" : "bg-line-strong",
                )}
              />
            ) : null}
            <span
              aria-hidden
              className={cx(
                "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                s.state === "done" && "border-shu bg-shu text-on-shu",
                s.state === "current" && "border-shu bg-surface text-shu-ink ring-4 ring-shu/15",
                s.state === "todo" && "border-line-strong bg-surface text-ink-3",
                s.state === "failed" && "border-bad bg-bad-soft text-bad",
              )}
            >
              {s.state === "done" ? (
                <Check className="h-4 w-4" />
              ) : s.state === "failed" ? (
                <CircleAlert className="h-4 w-4" />
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0 pt-1">
              <p
                className={cx(
                  "flex flex-wrap items-center gap-2 text-sm font-semibold",
                  s.state === "todo" ? "text-ink-3" : "text-ink",
                )}
              >
                {s.title}
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3">
                  {s.who === "you" ? (
                    <User aria-hidden className="h-3 w-3" />
                  ) : (
                    <Workflow aria-hidden className="h-3 w-3" />
                  )}
                  {s.who === "you" ? "You" : "Relayer"}
                </span>
                {s.state === "current" ? (
                  <span className="kinko-pulse text-xs font-medium text-shu-ink">in progress</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{s.detail}</p>
              <span className="sr-only">
                {s.state === "done"
                  ? "Done."
                  : s.state === "current"
                    ? "In progress."
                    : s.state === "failed"
                      ? "Stopped."
                      : "Not started."}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

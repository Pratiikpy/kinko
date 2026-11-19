// Kinko's interface primitives. Every control is at least 44px tall, every
// colour is a theme token, and every state a person can be in has a look.

import { Check, Copy, ExternalLink } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from "react";
import { Link, type LinkProps } from "react-router-dom";

import { shortHex } from "../lib/format.ts";

const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export function Card({
  children,
  className,
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <As
      className={cx(
        "min-w-0 rounded-2xl border border-line bg-surface p-5 sm:p-6 shadow-[0_1px_0_rgba(0,0,0,0.02)]",
        className,
      )}
    >
      {children}
    </As>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-shu text-on-shu hover:brightness-105 active:brightness-95 disabled:bg-line-strong disabled:text-ink-3",
  secondary: "border border-line-strong bg-surface text-ink hover:border-ink-3 disabled:text-ink-3",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink disabled:text-ink-3",
  danger: "border border-bad/40 text-bad hover:bg-bad-soft disabled:opacity-60",
};

const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition disabled:cursor-not-allowed";

export /**
 */
const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }
>(function Button({ variant = "primary", className, busy, children, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      disabled={disabled === true || busy === true}
      aria-busy={busy === true ? true : undefined}
      className={cx(BUTTON_BASE, VARIANTS[variant], className)}
    >
      {busy ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});

export function ButtonLink({
  variant = "primary",
  className,
  ...props
}: LinkProps & { variant?: Variant }) {
  return <Link {...props} className={cx(BUTTON_BASE, VARIANTS[variant], className)} />;
}

export function ExternalA({
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      className={cx(
        "inline-flex items-center gap-1 font-medium text-shu-ink underline-offset-4 hover:underline",
        className,
      )}
    >
      {children}
      <ExternalLink aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-sm text-bad [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "w-full min-h-11 rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-base text-ink placeholder:text-ink-3 outline-none transition focus:border-shu focus:ring-2 focus:ring-shu/20 disabled:bg-surface-2 disabled:text-ink-3";

export /**
 */
const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} {...props} className={cx(CONTROL, className)} />;
});

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(CONTROL, "min-h-24", className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        CONTROL,
        "appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-10",
        className,
      )}
    >
      {children}
    </select>
  );
}

/**
 * A labelled input in one: the common case.
 */
export function TextField({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input id={id} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}

type Tone = "neutral" | "shu" | "ok" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "border-line-strong text-ink-2 bg-surface-2",
  shu: "border-shu/30 text-shu-ink bg-shu-soft",
  ok: "border-ok/30 text-ok bg-ok-soft",
  warn: "border-warn/30 text-warn bg-warn-soft",
  bad: "border-bad/30 text-bad bg-bad-soft",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cx("rounded-xl border px-4 py-3 text-sm", TONES[tone])}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          {/* A 64-character hash in a message wraps instead of widening the page. */}
          {children ? (
            <div
              className={cx(
                title && "mt-0.5",
                "leading-relaxed text-ink-2 [overflow-wrap:anywhere] [&_a]:text-shu-ink",
              )}
            >
              {children}
            </div>
          ) : null}
        </div>
        {action}
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {eyebrow ? (
          <p className="mb-3 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.18em] text-shu-ink">
            <span className="rule-shu" aria-hidden />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">{title}</h1>
        {children ? (
          <div className="mt-3 text-base leading-relaxed text-ink-2">{children}</div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-display text-xl text-ink">{children}</h2>
      {aside}
    </div>
  );
}

/**
 * A full value with a copy button. Hashes are never shown truncated without a way to the whole.
 */
export function Copyable({
  value,
  label,
  short = true,
  className,
}: {
  value: string;
  label?: string;
  short?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={value}
      aria-label={`Copy ${label ?? "value"}: ${value}`}
      className={cx(
        "inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs text-ink-2 transition hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      {label ? <span className="font-sans text-ink-3">{label}</span> : null}
      <span className="min-w-0 truncate">{short ? shortHex(value, 8, 6) : value}</span>
      {copied ? (
        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-ok" />
      ) : (
        <Copy aria-hidden className="h-3.5 w-3.5 shrink-0" />
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block animate-pulse rounded-md bg-surface-2", className)}
    />
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-3">{label}</p>
      <p className="tabular mt-1.5 font-display text-2xl text-ink sm:text-3xl">{value}</p>
      {hint ? <p className="mt-1 text-sm text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="font-display text-lg text-ink">{title}</p>
      {children ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-2">{children}</p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A plain statement of what the chain can and cannot see.
 */
export function PrivacyLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
      <span
        aria-hidden
        className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-shu"
      />
      <span>{children}</span>
    </p>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; hint?: string }[];
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-ink" id={`${label}-label`}>
        {label}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${label}-label`}
        className="flex flex-wrap gap-1 rounded-xl border border-line-strong bg-surface-2 p-1"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => {
              onChange(o.value);
            }}
            className={cx(
              // Long option sets wrap to a second row rather than breaking words.
              // Each option is at least as wide as its label and shares the spare width.
              "min-h-11 min-w-[6rem] flex-auto whitespace-nowrap rounded-lg px-3 text-sm font-medium transition",
              o.value === value
                ? "bg-surface text-ink shadow-sm ring-1 ring-line-strong"
                : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {selected?.hint ? <p className="mt-1.5 text-sm text-ink-3">{selected.hint}</p> : null}
    </div>
  );
}

export { cx };

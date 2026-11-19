import { Link } from "react-router-dom";

/**
 * The Kinko seal: a vermilion hanko with 金, the first character of 金庫
 * ("safe"), cut in paper white inside a fine inner border.
 */
export function Seal({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={className}>
      <rect x="2" y="2" width="60" height="60" rx="13" fill="#c23a22" />
      <rect
        x="6.5"
        y="6.5"
        width="51"
        height="51"
        rx="9"
        fill="none"
        stroke="#fbf5ec"
        strokeWidth="1.6"
      />
      <g
        fill="none"
        stroke="#fbf5ec"
        strokeWidth="4.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      >
        <path d="M14.5 27 L32 12.5 L49.5 27" />
        <path d="M23 30.5 H41" />
        <path d="M18 39 H46" />
        <path d="M32 30.5 V51" />
        <path d="M21 42.5 L23.5 46" />
        <path d="M43 42.5 L40.5 46" />
        <path d="M14.5 51.5 H49.5" />
      </g>
    </svg>
  );
}

export function Wordmark({ to = "/" }: { to?: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex min-h-11 items-center gap-2.5"
      aria-label="Kinko, home"
    >
      <Seal size={34} className="transition-transform group-hover:-rotate-3" />
      <span className="flex items-baseline gap-2">
        <span className="font-display text-xl font-bold tracking-tight text-ink">Kinko</span>
        <span className="hidden font-display text-sm text-ink-3 sm:inline" lang="ja">
          金庫
        </span>
      </span>
    </Link>
  );
}

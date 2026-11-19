import {
  ArrowDownToLine,
  ArrowUpFromLine,
  AtSign,
  BadgeCheck,
  BookOpen,
  Building2,
  CreditCard,
  FileText,
  Gift,
  HandCoins,
  Home,
  Menu,
  Moon,
  ReceiptText,
  Send,
  Settings,
  Sun,
  Users,
  X,
} from "lucide-react";
import { ConnectButton } from "nightkit-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { NETWORK_ID } from "../lib/config.ts";
import { useTheme } from "../state/theme.tsx";
import { Wordmark } from "./Logo.tsx";
import { cx } from "./ui.tsx";

const SITE_LINKS = [
  { to: "/app", label: "Account" },
  { to: "/backing", label: "Backing" },
  { to: "/examine", label: "Examine" },
  { to: "/docs", label: "Docs" },
  { to: "/walkthrough", label: "Tour" },
];

export /**
 */
const APP_GROUPS: {
  title: string;
  links: { to: string; label: string; icon: typeof Home; end?: boolean }[];
}[] = [
  {
    title: "Account",
    links: [
      { to: "/app", label: "Home", icon: Home, end: true },
      { to: "/app/add", label: "Add dollars", icon: ArrowDownToLine },
      { to: "/app/withdraw", label: "Withdraw", icon: ArrowUpFromLine },
    ],
  },
  {
    title: "Pay and get paid",
    links: [
      { to: "/app/pay", label: "Pay", icon: Send },
      { to: "/app/request", label: "Request", icon: HandCoins },
      { to: "/app/invoices", label: "Invoices", icon: FileText },
      { to: "/app/batch", label: "Batch pay", icon: Users },
      { to: "/app/receipts", label: "Receipts", icon: ReceiptText },
    ],
  },
  {
    title: "Cards",
    links: [
      { to: "/app/gifts", label: "Gift cards", icon: Gift },
      { to: "/app/card", label: "PIN card", icon: CreditCard },
    ],
  },
  {
    title: "Business and identity",
    links: [
      { to: "/app/merchant", label: "Merchant", icon: Building2 },
      { to: "/app/tags", label: "Your @tag", icon: AtSign },
      { to: "/app/settings", label: "Settings", icon: Settings },
    ],
  },
];

const BOTTOM_LINKS = [
  { to: "/app", label: "Home", icon: Home, end: true },
  { to: "/app/add", label: "Add", icon: ArrowDownToLine },
  { to: "/app/pay", label: "Pay", icon: Send },
  { to: "/app/request", label: "Request", icon: HandCoins },
];

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={dark}
      className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2 hover:text-ink"
    >
      {dark ? <Sun aria-hidden className="h-5 w-5" /> : <Moon aria-hidden className="h-5 w-5" />}
    </button>
  );
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLElement>("a,button")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <button
        type="button"
        aria-label="Close menu"
        className="absolute inset-0 bg-ink/30"
        onClick={onClose}
      />
      <div
        ref={ref}
        className="absolute inset-y-0 right-0 flex w-[min(22rem,88vw)] flex-col overflow-y-auto border-l border-line bg-paper p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <Wordmark />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-surface-2"
          >
            <X aria-hidden className="h-5 w-5" />
          </button>
        </div>
        <nav aria-label="Site" className="grid gap-1 border-b border-line pb-4">
          {SITE_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              onClick={onClose}
              className={({ isActive }) =>
                cx(
                  "flex min-h-11 items-center rounded-xl px-3 text-base font-medium",
                  isActive ? "bg-surface text-ink" : "text-ink-2",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        {APP_GROUPS.map((g) => (
          <nav key={g.title} aria-label={g.title} className="mt-4">
            <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">
              {g.title}
            </p>
            {g.links.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={onClose}
                className={({ isActive }) =>
                  cx(
                    "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm",
                    isActive ? "bg-surface font-semibold text-ink" : "text-ink-2",
                  )
                }
              >
                <Icon aria-hidden className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        ))}
      </div>
    </div>
  );
}

export function SiteHeader() {
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    setMenu(false);
  }, [pathname]);
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-paper/90 backdrop-blur">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Wordmark />
        <nav aria-label="Site" className="hidden items-center gap-1 lg:flex">
          {SITE_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cx(
                  "inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium transition",
                  isActive ? "text-ink" : "text-ink-2 hover:text-ink",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1 sm:gap-2">
          <span
            className="hidden rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-ink-3 md:inline"
            title="The Midnight network this build uses"
          >
            {NETWORK_ID}
          </span>
          <ThemeToggle />
          <div className="hidden sm:block">
            <ConnectButton label="Connect" />
          </div>
          <button
            type="button"
            onClick={() => {
              setMenu(true);
            }}
            aria-label="Open menu"
            aria-expanded={menu}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 lg:hidden"
          >
            <Menu aria-hidden className="h-5 w-5" />
          </button>
        </div>
      </div>
      {menu ? (
        <MobileMenu
          onClose={() => {
            setMenu(false);
          }}
        />
      ) : null}
    </header>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 px-4 pb-28 pt-6 sm:px-6 lg:pb-16">
      <aside className="hidden w-52 shrink-0 lg:block" aria-label="Account sections">
        <div className="sticky top-24 space-y-6">
          {APP_GROUPS.map((g) => (
            <nav key={g.title} aria-label={g.title}>
              <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">
                {g.title}
              </p>
              {g.links.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cx(
                      "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition",
                      isActive
                        ? "bg-surface font-semibold text-ink shadow-sm ring-1 ring-line"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                    )
                  }
                >
                  <Icon aria-hidden className="h-4 w-4" />
                  {label}
                </NavLink>
              ))}
            </nav>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mb-5 sm:hidden">
          <ConnectButton label="Connect wallet" />
        </div>
        {children}
      </div>
      <nav
        aria-label="Quick actions"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto grid max-w-md grid-cols-4">
          {BOTTOM_LINKS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium",
                  isActive ? "text-shu-ink" : "text-ink-2",
                )
              }
            >
              <Icon aria-hidden className="h-5 w-5" />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-xs leading-relaxed text-ink-2">
            A private dollar account on Midnight. Every private dollar is a real USDC held in a
            vault on Ethereum that anyone can count.
          </p>
        </div>
        <nav aria-label="Product" className="grid content-start gap-1">
          <p className="mb-1 font-semibold text-ink">Product</p>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/app">
            Account
          </Link>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/backing">
            Backing
          </Link>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/examine">
            Examine
          </Link>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/walkthrough">
            Guided tour
          </Link>
        </nav>
        <nav aria-label="Learn" className="grid content-start gap-1">
          <p className="mb-1 font-semibold text-ink">Learn</p>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/docs">
            Docs
          </Link>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/developer">
            Developers
          </Link>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/vision">
            Vision
          </Link>
          <Link className="py-1 text-ink-2 hover:text-ink" to="/privacy">
            Privacy and limits
          </Link>
        </nav>
        <div className="grid content-start gap-2 text-ink-2">
          <p className="font-semibold text-ink">Status</p>
          <p className="flex items-center gap-2">
            <BadgeCheck aria-hidden className="h-4 w-4 text-ok" /> Network:{" "}
            <span className="font-mono text-xs">{NETWORK_ID}</span>
          </p>
          <p className="flex items-center gap-2">
            <BookOpen aria-hidden className="h-4 w-4" /> Experimental software
          </p>
        </div>
      </div>
    </footer>
  );
}

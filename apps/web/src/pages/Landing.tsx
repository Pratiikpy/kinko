import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, Landmark, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { Seal } from "../components/Logo.tsx";
import { ButtonLink, Skeleton } from "../components/ui.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { VAULT_SIGN_IN } from "../lib/config.ts";
import { formatAmount } from "../lib/format.ts";
import { coverageBps, kusdInCirculation, relayer } from "../lib/relayer.ts";

// A short rise as sections enter view. Opacity is never animated, so content
// is readable before any script runs, in a printed page and in a screenshot.
const rise = {
  initial: { y: 14 },
  whileInView: { y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.5, ease: [0.2, 0.7, 0.2, 1] as const },
};

function LiveBacking() {
  const backing = useAsync(
    async () => {
      if (!relayer) throw new Error("No relayer is configured for this build.");
      return relayer.backing();
    },
    [],
    { intervalMs: 30_000 },
  );

  const value = backing.status === "ready" ? backing.value : undefined;
  const circulating = value ? kusdInCirculation(value) : undefined;
  const bps = value ? coverageBps(value) : null;

  return (
    <div className="relative rounded-3xl border border-line bg-surface p-6 shadow-[0_20px_60px_-30px_rgba(60,30,10,0.35)] sm:p-8">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-3">
          Backing, read live
        </p>
        <Seal size={36} />
      </div>
      <dl className="mt-6 grid gap-6">
        <div>
          <dt className="text-sm text-ink-2">USDC held by the vault on Ethereum</dt>
          <dd className="tabular mt-1 font-display text-4xl text-ink">
            {value ? (
              `$${formatAmount(value.usdcInVault)}`
            ) : backing.status === "loading" ? (
              <Skeleton className="h-10 w-48" />
            ) : (
              "Unavailable"
            )}
          </dd>
        </div>
        <div className="h-px bg-line" />
        <div>
          <dt className="text-sm text-ink-2">Private dollars (KUSD) in circulation on Midnight</dt>
          <dd className="tabular mt-1 font-display text-4xl text-ink">
            {circulating !== undefined ? (
              `$${formatAmount(circulating)}`
            ) : backing.status === "loading" ? (
              <Skeleton className="h-10 w-48" />
            ) : (
              "Unavailable"
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-6 rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2" role="status">
        {backing.status === "error" ? (
          <>
            The backing service did not answer: {backing.message} The figures can still be checked
            on the chains themselves.
          </>
        ) : bps === null ? (
          value ? (
            "Nothing is in circulation yet. The first deposit will show here."
          ) : (
            "Reading both chains…"
          )
        ) : (
          <>
            Covered <strong className="tabular text-ink">{(Number(bps) / 100).toFixed(2)}%</strong>.
            Ethereum block {value?.ethereumBlock.toLocaleString()}, Midnight block{" "}
            {value?.midnightBlock.toLocaleString()}.
          </>
        )}
      </div>
      <Link
        to="/backing"
        className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-shu-ink hover:underline"
      >
        Check it yourself <ArrowRight aria-hidden className="h-4 w-4" />
      </Link>
    </div>
  );
}

const STEPS = [
  {
    n: "一",
    title: "Put in USDC",
    body: "Send USDC from your Ethereum wallet to your own deposit address. A vault on Ethereum, whose key no single party holds, takes custody.",
  },
  {
    n: "二",
    title: "Hold private dollars",
    body: "The vault mints the same amount of KUSD to your shielded address on Midnight. Your balance is visible to you alone.",
  },
  {
    n: "三",
    title: "Pay anyone, privately",
    body: "Pay a @tag, an invoice or a whole payroll file. The chain records that a valid payment happened, not who paid whom or how much.",
  },
  {
    n: "四",
    title: "Take USDC back out",
    body: "Withdraw to any Ethereum address. The KUSD is burned and the vault sends real USDC, one for one, minus a flat fee shown up front.",
  },
];

export default function Landing() {
  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <p className="mb-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.18em] text-shu-ink">
            <span className="rule-shu" aria-hidden /> Private dollars, counted in public
          </p>
          <h1 className="font-display text-[2.6rem] leading-[1.08] text-ink sm:text-6xl">
            A private dollar account. <span className="text-shu-ink">Every dollar</span> real, and
            countable by anyone.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
            Put in the USDC you already hold. Pay and get paid without publishing the amounts or the
            people. Take it out as USDC whenever you want.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/app" className="px-6">
              Open your account <ArrowRight aria-hidden className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink to="/backing" variant="secondary">
              See the backing
            </ButtonLink>
          </div>
          <p className="mt-5 text-sm text-ink-3">
            Runs on Midnight with USDC on Ethereum. Experimental software on test networks.
          </p>
        </div>
        <LiveBacking />
      </section>

      <section className="border-y border-line bg-surface/60">
        <motion.div
          {...rise}
          className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-[1fr_1.4fr]"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-shu-ink">
              Why it is built this way
            </p>
            <h2 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
              Money held separately is money you get back.
            </h2>
          </div>
          <div className="space-y-5 text-lg leading-relaxed text-ink-2">
            <p>
              When FTX collapsed in November 2022, customers of FTX Japan were among the first to
              get their money back. Japanese law required the exchange to keep customer funds apart
              from its own, so the money was still there when it was needed.
            </p>
            <p>
              Kinko turns that rule into code. Every private dollar on Midnight is a real USDC
              sitting in a vault on Ethereum. The vault cannot mint without an attested deposit, and
              anyone can compare what it holds with what is in circulation, at any time, without
              asking us.
            </p>
            <p className="text-ink">
              Payments stay private. The reserve stays public. You do not have to trust a report.
            </p>
          </div>
        </motion.div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <motion.div {...rise}>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-shu-ink">
            How it works
          </p>
          <h2 className="mt-3 font-display text-3xl text-ink sm:text-4xl">
            Four steps, two chains, one balance only you can see.
          </h2>
        </motion.div>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <motion.li
              {...rise}
              key={s.title}
              className="rounded-2xl border border-line bg-surface p-6"
            >
              <span lang="ja" aria-hidden className="font-display text-3xl text-shu">
                {s.n}
              </span>
              <h3 className="mt-3 font-display text-lg text-ink">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.body}</p>
            </motion.li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <motion.div {...rise} className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <Eye aria-hidden className="h-5 w-5 text-ink-2" />
              <h2 className="font-display text-xl text-ink">Public, by design</h2>
            </div>
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-2">
              <li>Each deposit on Ethereum: the sending address and the amount.</li>
              <li>Each withdrawal on Ethereum: the receiving address and the amount.</li>
              <li>The vault's USDC balance, and the total KUSD minted and burned.</li>
              <li>Tag names, and the disclosure log: case, scope and time.</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-shu/30 bg-shu-soft/60 p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <EyeOff aria-hidden className="h-5 w-5 text-shu-ink" />
              <h2 className="font-display text-xl text-ink">Private, by default</h2>
            </div>
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-2">
              <li>Who holds KUSD, and how much.</li>
              <li>Every payment between people: the amount, the payer and the payee.</li>
              <li>Invoice terms, payroll files and which payments reached which tag.</li>
              <li>Records you file for an examiner, until two of three keyholders approve.</li>
            </ul>
          </div>
        </motion.div>
        <p className="mt-4 text-sm text-ink-3">
          The way in and the way out are visible on Ethereum. What happens in between is not.{" "}
          <Link to="/privacy" className="font-medium text-shu-ink hover:underline">
            Read the stated limits.
          </Link>
        </p>
      </section>

      <section className="border-t border-line bg-surface/60">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-16 sm:px-6 md:grid-cols-3">
          {[
            {
              icon: Landmark,
              title: "For a business",
              body: "Pay contractors and staff from one file. Nobody learns your payroll from the chain. Hand your accountant exactly the records a case needs.",
            },
            {
              icon: ShieldCheck,
              title: "For a freelancer",
              body: "Share a @tag or a payment link. Income from one client never reveals income from another.",
            },
            {
              icon: Eye,
              title: "For an examiner",
              body: "See only the records named in your case, after two of three keyholders approve, each checked against its anchor on chain. Every opening is logged.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <motion.div {...rise} key={title}>
              <Icon aria-hidden className="h-6 w-6 text-shu" />
              <h3 className="mt-3 font-display text-lg text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-ink px-6 py-10 text-paper sm:flex-row sm:items-center sm:px-10">
          <div>
            <h2 className="font-display text-3xl">
              {VAULT_SIGN_IN
                ? "Open an account with the wallet you have."
                : "Open an account with your Midnight wallet."}
            </h2>
            <p className="mt-2 max-w-xl text-paper/80">
              {VAULT_SIGN_IN
                ? "MetaMask, Phantom, Coinbase Wallet or a Midnight wallet. One signature opens your private account."
                : "1AM or Lace. Connect once and your private account is ready, with its keys still in your wallet."}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <ButtonLink to="/app">Open your account</ButtonLink>
            <Link
              to="/walkthrough"
              className="inline-flex min-h-11 items-center rounded-xl border border-paper/30 px-5 text-sm font-semibold text-paper hover:border-paper/60"
            >
              Take the tour
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

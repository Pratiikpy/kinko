import type { ReactNode } from "react";

/**
 * Long-form text with Kinko's typography: serif headings, generous measure.
 */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 max-w-3xl text-base leading-relaxed text-ink-2 [&_a]:font-medium [&_a]:text-shu-ink [&_a:hover]:underline [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-ink [&_h2]:mb-3 [&_h2]:mt-12 [&_h2]:font-display [&_h2]:text-2xl [&_h2]:text-ink [&_h3]:mb-2 [&_h3]:mt-8 [&_h3]:font-display [&_h3]:text-lg [&_h3]:text-ink [&_li]:mt-1.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mt-4 [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-6 [&_dl]:mt-4 [&_dt]:mt-5 [&_dt]:font-semibold [&_dt]:text-ink [&_dd]:mt-1">
      {children}
    </div>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre
      tabIndex={0}
      className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface-2 p-4 font-mono text-[13px] leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-shu"
    >
      {children}
    </pre>
  );
}

export function Toc({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="On this page" className="hidden xl:block">
      <div className="sticky top-24">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">
          On this page
        </p>
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.id}>
              <a href={`#${i.id}`} className="block py-1 text-ink-2 hover:text-ink">
                {i.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

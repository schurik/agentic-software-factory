import type { ComponentProps, ReactNode } from "react";
import { toneOf } from "./session/words";

/**
 * The few primitives every page shares (#105), drawn in the tokens of
 * app/globals.css: buttons, cards, notices, tags, a status pill, tables, form
 * controls and tabs. A page composes these and lays them out with utilities;
 * it does not invent a button of its own.
 *
 * Status is coloured and nothing else is: ok (green), wait (amber), bad (red)
 * and running (the accent). A status reads as a pill next to the title it
 * qualifies; `Tag` is a quiet label, coloured only when it says a status too.
 */

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger" | "approve";
type Size = "sm" | "md";

/** A button's look, for a link that acts as one too. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md"): string {
  return cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap no-underline transition-colors",
    "hover:no-underline disabled:pointer-events-none disabled:opacity-50",
    size === "sm" ? "h-7 px-2.5 text-sm" : "h-9 px-3.5 text-base",
    variant === "primary" && "bg-accent-strong text-accent-fg shadow-card hover:brightness-110",
    variant === "approve" && "bg-ok text-bg shadow-card hover:brightness-110",
    variant === "secondary" && "border border-line-strong bg-surface text-fg shadow-card hover:bg-surface-2",
    variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-fg",
    variant === "danger" && "border border-line-strong bg-surface text-bad shadow-card hover:bg-bad-soft",
  );
}

export function Button({ variant, size, className, type = "button", ...rest }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button type={type} {...rest} className={cx(buttonClass(variant, size), className)} />;
}

/** A button that reads as a link: for a quiet verb inside a line of text. */
export function LinkButton({ className, type = "button", ...rest }: ComponentProps<"button">) {
  return <button type={type} {...rest} className={cx("text-accent underline-offset-2 hover:underline disabled:text-muted disabled:no-underline", className)} />;
}

export function Card({ className, children, ...rest }: ComponentProps<"div">) {
  return <div {...rest} className={cx("rounded-xl border border-line bg-surface shadow-card", className)}>{children}</div>;
}

type Tone = "ok" | "wait" | "bad" | "run" | "none";

const SOFT: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok", wait: "bg-wait-soft text-wait", bad: "bg-bad-soft text-bad",
  run: "bg-accent-soft text-accent", none: "bg-surface-2 text-muted",
};

/** A status, as a pill beside the title it qualifies: the word, coloured by what it means. */
export function StatusPill({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", SOFT[toneOf(status) as Tone])}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children ?? status}
    </span>
  );
}

const TAG: Record<Tone | "mine", string> = {
  none: "border-line-strong text-muted", ok: "border-ok/40 text-ok", wait: "border-wait/40 text-wait",
  bad: "border-bad/40 text-bad", run: "border-accent/40 text-accent", mine: "border-accent bg-accent-soft text-fg font-medium",
};

/** A short label: quiet by default, coloured only when it says a status; `mine` marks what is the viewer's own. */
export function Tag({ tone = "none", title, children }: { tone?: Tone | "mine"; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cx("inline-flex max-w-full items-center rounded-md border px-1.5 text-xs leading-5", TAG[tone])}>
      {children}
    </span>
  );
}

const EDGE: Record<"wait" | "bad" | "ok" | "none", string> = {
  wait: "border-l-wait", bad: "border-l-bad", ok: "border-l-ok", none: "border-l-line-strong",
};

/** Something the page says about itself — a refusal, an outcome, a missing piece — set apart from what it shows. */
export function Notice({ tone = "wait", className, children, ...rest }: ComponentProps<"div"> & { tone?: keyof typeof EDGE }) {
  return (
    <div {...rest} className={cx("my-3 rounded-lg border border-l-[3px] border-line bg-surface px-3.5 py-2.5", EDGE[tone], className)}>
      {children}
    </div>
  );
}

/** What a page shows while its query is unanswered. */
export function Loading({ what = "Loading…" }: { what?: string }) {
  return <p className="text-muted">{what}</p>;
}

/** A page's title row: what it is, a line under it, and anything that acts on the whole page at the right. */
export function PageHeader({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="min-w-0 grow">
        <h1>{title}</h1>
        {sub ? <div className="mt-1 text-muted">{sub}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** A titled part of a page. */
export function Section({ title, right, className, children }: { title: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cx("mt-8 first:mt-0", className)}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2>{title}</h2>
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Label and value pairs, two columns that stay two columns on a phone. */
export function Facts({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cx("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 [&_dd]:min-w-0 [&_dt]:text-muted", className)}>{children}</dl>;
}

/**
 * A table on a card. On a narrow screen it scrolls inside its own box, so the
 * page around it never scrolls sideways. `num` right-aligns a column of figures.
 */
export function Table({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("overflow-x-auto rounded-xl border border-line bg-surface shadow-card", className)}>
      <table className={cx(
        "w-full border-collapse text-left [overflow-wrap:normal]",
        "[&_th]:border-b [&_th]:border-line [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted",
        "[&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_tbody_tr:last-child_td]:border-b-0",
      )}>
        {children}
      </table>
    </div>
  );
}

export const num = "text-right tabular-nums whitespace-nowrap";

/** An input, select or textarea. */
export const control = cx(
  "rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-base text-fg outline-none placeholder:text-faint",
  "focus:border-accent focus:ring-4 focus:ring-accent-soft disabled:opacity-60",
);

/** A form field: its label over its control, and what it means under it. */
export function Field({ label, hint, className, children }: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cx("grid gap-1", className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

/** A key to press; hidden on a touch screen, which has none. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-surface px-1 font-mono text-[11px] leading-none text-muted pointer-coarse:hidden">
      {children}
    </kbd>
  );
}

/**
 * A row of tabs over one panel, underlined in the accent like the header's
 * places. It scrolls sideways on its own when the tabs outgrow the screen.
 */
export function Tabs<T extends string>({ tabs, selected, onSelect, label, className }: {
  tabs: { id: T; label: ReactNode }[];
  selected: T;
  onSelect: (tab: T) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cx("flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]", className)}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={tab.id === selected} onClick={() => onSelect(tab.id)}
                className={cx(
                  "relative -mb-px shrink-0 border-b-2 px-2.5 py-2 text-sm font-medium whitespace-nowrap",
                  tab.id === selected ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
                )}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A block of text exactly as it was written: output, a file, a payload. */
export function Pre({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <pre className={cx("max-h-[32rem] overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs leading-relaxed", className)}>
      {children}
    </pre>
  );
}

/** A unified diff, its added and removed lines marked. */
export function DiffBlock({ text }: { text: string }) {
  return (
    <Pre className="px-0">
      {text.replace(/\n$/, "").split("\n").map((line, at) => {
        // "+++ b/path" and "--- a/path" name the file; every other leading + or - is a line.
        const added = /^\+(?!\+\+ )/.test(line);
        const removed = /^-(?!-- )/.test(line);
        return (
          <span key={at} data-line={added ? "add" : removed ? "del" : undefined}
                className={cx("block px-3", added && "bg-add-bg", removed && "bg-del-bg")}>{line}{"\n"}</span>
        );
      })}
    </Pre>
  );
}

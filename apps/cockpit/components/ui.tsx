import { Dialog } from "@base-ui/react/dialog";
import { Field as BaseField } from "@base-ui/react/field";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { Check, ChevronsUpDown, X } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, Fragment, type MouseEvent, type ReactNode } from "react";
import { type Tone, toneOf } from "./session/words";

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

/** Where a link that changes what a page shows goes: an address to link to, and what following it does in place. */
export interface Go {
  href: string;
  onClick: () => void;
}

/** A link's click, followed in place — but a modified click (a new tab, a new window) left to the browser. */
export function followInPlace(onClick: () => void): (event: MouseEvent) => void {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onClick();
  };
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

/** A button's look, for a link that acts as one too. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md"): string {
  return cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap no-underline transition-colors",
    "hover:no-underline disabled:pointer-events-none disabled:opacity-50",
    size === "sm" ? "h-7 px-2.5 text-sm" : size === "icon" ? "size-9" : "h-9 px-3.5 text-base",
    variant === "primary" && "bg-accent-strong text-accent-fg shadow-card hover:brightness-110",
    variant === "secondary" && "border border-line-strong bg-surface text-fg shadow-card hover:bg-surface-2",
    variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-fg",
    variant === "danger" && "border border-line-strong bg-surface text-bad shadow-card hover:bg-bad-soft",
  );
}

/** A pill's look, for a link that picks one of a few: the picked one filled. */
export function pillClass(picked: boolean): string {
  return cx("rounded-full border px-2.5 py-0.5 text-sm no-underline hover:no-underline",
            picked ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg");
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

const SOFT: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok", wait: "bg-wait-soft text-wait", bad: "bg-bad-soft text-bad",
  run: "bg-accent-soft text-accent", none: "bg-surface-2 text-muted",
};

/** A status, as a pill beside the title it qualifies: the word, coloured by what it means. */
export function StatusPill({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", SOFT[toneOf(status)])}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children ?? status}
    </span>
  );
}

const DOT: Record<Tone, string> = { ok: "bg-ok", wait: "bg-wait", bad: "bg-bad", run: "bg-accent", none: "bg-faint" };

/**
 * A status, as a dot in a table cell: coloured by what it means, its word —
 * or `label`, when the status needs saying otherwise — on hover and to a screen reader.
 */
export function StatusDot({ status, label = status, className }: { status: string; label?: string; className?: string }) {
  return <span role="img" title={label} aria-label={label} className={cx("block size-2 rounded-full", DOT[toneOf(status)], className)} />;
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

/*
 * One vertical rhythm (#154): a block — a Notice, a PageHeader, a Section —
 * carries no outer margin; where it is put decides the space around it. On a
 * page that is the column's gap, and in a card's running text the margin its
 * siblings take there too. A block's own margin would add to a gap rather
 * than replace it.
 */

/** Something the page says about itself — a refusal, an outcome, a missing piece — set apart from what it shows. */
export function Notice({ tone = "wait", className, children, ...rest }: ComponentProps<"div"> & { tone?: keyof typeof EDGE }) {
  return (
    <div {...rest} className={cx("rounded-lg border border-l-[3px] border-line bg-surface px-3.5 py-2.5", EDGE[tone], className)}>
      {children}
    </div>
  );
}

/** What a page shows while its query is unanswered. */
export function Loading({ what = "Loading…" }: { what?: string }) {
  return <p className="text-muted">{what}</p>;
}

/** One step back up a page's breadcrumbs: what it is called, and where it goes. */
export interface Crumb {
  label: ReactNode;
  href: string;
}

/**
 * Where a page sits (#153): each place above it, a link back to it, and then
 * `here` — the page you are on, which is never a link. The one breadcrumb
 * every page draws, so a session's and a factory's read alike.
 */
export function Crumbs({ trail, here }: { trail: Crumb[]; here: ReactNode }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
      {trail.map((crumb) => (
        <Fragment key={crumb.href}>
          <Link href={crumb.href} className="text-muted hover:text-fg">{crumb.label}</Link>
          <span aria-hidden="true" className="text-faint">/</span>
        </Fragment>
      ))}
      <span aria-current="page">{here}</span>
    </nav>
  );
}

/**
 * A page's title row: its breadcrumbs over what it is, a line under it, and
 * anything that acts on the whole page at the right.
 */
export function PageHeader({ crumbs, title, sub, children }: { crumbs?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="min-w-0 grow">
        {crumbs ? <div className="mb-1.5">{crumbs}</div> : null}
        <h1>{title}</h1>
        {sub ? <div className="mt-1 text-muted">{sub}</div> : null}
      </div>
      {children}
    </header>
  );
}

/**
 * A page outside the three places (#122) — setting up the App, signing in,
 * approving a station: one card, centred and no wider than a line reads
 * well, its title on top and what it says spaced under it.
 */
export function Standalone({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card className="mx-auto max-w-2xl px-4 py-5 sm:mt-4 sm:px-6 sm:py-6">
      <h1>{title}</h1>
      <div className="mt-3 [&>*+*]:mt-3 [&>:first-child]:mt-0 [&>:last-child]:mb-0">{children}</div>
    </Card>
  );
}

/** A titled part of a page. */
export function Section({ title, right, className, children }: { title: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
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
 * page around it never scrolls sideways; a `fixed` one is laid out to the
 * box's width instead, its columns as its `<colgroup>` sizes them, and never
 * scrolls at all. `num` right-aligns a column of figures.
 */
export function Table({ fixed = false, className, children }: { fixed?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cx("overflow-x-auto rounded-xl border border-line bg-surface shadow-card", className)}>
      <table className={cx(
        "w-full border-collapse text-left [overflow-wrap:normal]", fixed && "table-fixed",
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

/**
 * A form field, base-ui's Field drawn once: its label over its control, what
 * it means under it, and — once a `Form` is submitted with what `validate`
 * refuses — why, under that. The control is a `Control`, which the label
 * names; `name` is what the form calls its value.
 */
export function Field({ label, hint, name, validate, className, children }: {
  label: ReactNode;
  hint?: ReactNode;
  name?: string;
  /** Why the value will not do, or null when it will. */
  validate?: (value: unknown) => string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <BaseField.Root name={name} validate={validate} className={cx("grid gap-1", className)}>
      <BaseField.Label className="text-sm font-medium">{label}</BaseField.Label>
      {children}
      {hint ? <BaseField.Description className="text-sm text-muted">{hint}</BaseField.Description> : null}
      <BaseField.Error className="text-sm text-bad" />
    </BaseField.Root>
  );
}

/** A field's input — or, with `render={<textarea />}`, its textarea — drawn as a control. */
export function Control({ className, ...rest }: Omit<ComponentProps<typeof BaseField.Control>, "className"> & { className?: string }) {
  return <BaseField.Control className={cx(control, className)} {...rest} />;
}

/** A menu's or a select's popup, and one item in it. */
export const menuPopup = cx(
  "min-w-56 origin-[var(--transform-origin)] rounded-lg border border-line bg-surface p-1 text-sm text-fg shadow-pop outline-none",
  "transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
);
export const menuItem = "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 outline-none select-none data-highlighted:bg-surface-2";

/** One choice in a `Select`: what it is, and how it reads. */
export interface Choice {
  value: string;
  label: string;
}

/**
 * A labelled choice of one among `items`, drawn like a control and opened
 * as a menu: a field of its own, which a `Form` knows by `name`. An item that
 * reads other than as itself is a `Choice`. With nothing to choose it is
 * disabled, and says `placeholder`.
 */
export function Select({ label, items, value, name, placeholder, onChange, className }: {
  label: ReactNode;
  items: (string | Choice)[];
  value: string;
  name?: string;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const options = items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));
  return (
    <BaseField.Root name={name} className={cx("grid min-w-0 gap-1", className)}>
      <BaseSelect.Root items={options} value={value || null} disabled={!options.length}
                       onValueChange={(chosen) => { if (typeof chosen === "string") onChange(chosen); }}>
        <BaseSelect.Label className="text-sm font-medium">{label}</BaseSelect.Label>
        <BaseSelect.Trigger className={cx(control, "flex h-9 min-w-0 items-center justify-between gap-2 text-left hover:bg-surface-2 data-popup-open:border-accent")}>
          <BaseSelect.Value placeholder={placeholder} className="truncate data-placeholder:text-faint" />
          <BaseSelect.Icon><ChevronsUpDown size={14} className="text-muted" aria-hidden="true" /></BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
            <BaseSelect.Popup className={cx(menuPopup, "max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto")}>
              <BaseSelect.List>
                {options.map((option) => (
                  <BaseSelect.Item key={option.value} value={option.value} className={menuItem}>
                    <BaseSelect.ItemText className="grow">{option.label}</BaseSelect.ItemText>
                    <BaseSelect.ItemIndicator><Check size={14} className="text-accent" aria-hidden="true" /></BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </BaseField.Root>
  );
}

/**
 * A dialog over the page, as the header's actions open one (#108): a card
 * near the top of the screen, its title and what it does over its body, and
 * a close button; Escape and the backdrop close it too. The body is drawn
 * only while it is open, so a closed one asks the backend nothing.
 */
export function Modal({ open, onClose, title, description, children }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(opened) => { if (!opened) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={cx(
          "fixed inset-0 z-40 bg-black/25 transition-opacity dark:bg-black/60",
          "data-ending-style:opacity-0 data-starting-style:opacity-0",
        )} />
        <Dialog.Popup className={cx(
          "fixed top-[8dvh] left-1/2 z-50 max-h-[84dvh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto",
          "rounded-xl border border-line bg-surface p-5 shadow-pop transition-[scale,opacity] duration-150",
          "data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
        )}>
          <div className="mb-4 flex items-start gap-3">
            <div className="grow">
              <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close"
                          className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {open ? children : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
 * A row of tabs over its panels, base-ui's Tabs drawn once: the arrow keys
 * move between tabs, and the selected one is underlined in the accent, like
 * the header's places, by the row's Indicator — never by a tab's own border
 * pulled over the row's with a negative margin, which overflowed the row by a
 * pixel and so scrolled it vertically. The row's line is an inset shadow, so
 * the Indicator covers it under the selected tab without leaving the box. It
 * scrolls sideways, scrollbar hidden, when the tabs outgrow the screen; `end`
 * sits at its far end — a link away, say — and scrolls with it, while
 * `pinned` sits beyond it, outside the scroll, for what must stay in reach
 * however many tabs there are: an action on the tab shown.
 *
 * The panels are `children`, each a `TabPanel` naming the tab it belongs to.
 * One that is drawn only while shown can be one panel valued `selected`.
 */
export function Tabs<T extends string>({ tabs, selected, onSelect, label, className, barClassName, end, pinned, children }: {
  tabs: { id: T; label: ReactNode }[];
  selected: T;
  onSelect: (tab: T) => void;
  label?: string;
  className?: string;
  barClassName?: string;
  end?: ReactNode;
  pinned?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <BaseTabs.Root value={selected} onValueChange={(value: T) => onSelect(value)} className={className}>
      <div className={cx("flex shadow-[inset_0_-1px_0_var(--line)]", barClassName)}>
        <div className="no-scrollbar flex min-w-0 grow overflow-x-auto">
          <BaseTabs.List aria-label={label} className="relative flex shrink-0 gap-1">
            {tabs.map((tab) => (
              <BaseTabs.Tab key={tab.id} value={tab.id}
                            className="shrink-0 px-2.5 py-2 text-sm font-medium whitespace-nowrap text-muted hover:text-fg focus-visible:-outline-offset-2 data-active:text-fg">
                {tab.label}
              </BaseTabs.Tab>
            ))}
            <BaseTabs.Indicator renderBeforeHydration className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) bg-accent transition-[translate,width] duration-150 motion-reduce:transition-none" />
          </BaseTabs.List>
          {end ? <div className="ml-auto flex shrink-0 items-center pl-4">{end}</div> : null}
        </div>
        {pinned ? <div className="flex shrink-0 items-center pl-2">{pinned}</div> : null}
      </div>
      {children}
    </BaseTabs.Root>
  );
}

/** One tab's panel, under a `Tabs`: `value` is the tab's id. */
export const TabPanel = BaseTabs.Panel;

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

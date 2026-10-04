"use client";
// PROTOTYPE, throwaway. Now (/): Inbox → Needs attention → Running → Waiting on others.
// Answers "what needs me, and what's moving" on the first screen.
//
// Every list here is drawn with one Row, so the four line up on one vertical grid:
// icon · title + detail lines · where (factory) above when/what-next on the right.
// The icon says what the row is about: a gate's stage in amber (Inbox, Waiting on others), the
// stage a session is in, in blue (Running), and a status mark for what needs attention.
import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useState, type ReactNode } from "react";
import { ATTENTION, GATES, NOW, OTHERS, SESSIONS, type Attention } from "@/lib/data";
import { cost, elapsed, fmtAgo, fmtCost, fmtDur, inPhaseFor, sessionPhases, whereNow } from "@/lib/model";
import { MiniGraph } from "./Graph";
import { IssueRef, PrRef, StageIcon } from "./icons";
import { PLink, useProto } from "./state";
import { Card, Chevron, Kbd, StatusIcon, cx } from "./ui";

/** A stage's icon on a tinted square: amber when it waits on a person, blue while it runs. */
export function StageGlyph({ name, tone }: { name: string; tone: "wait" | "run" }) {
  return (
    <span className={cx("-mt-0.5 -ml-1 grid size-6 place-items-center rounded-md", tone === "wait" ? "bg-wait-soft text-wait" : "bg-accent-soft text-accent")} title={name}>
      <StageIcon name={name} size={14} />
    </span>
  );
}

const STUCK_AFTER = 10 * 60;
const EXPENSIVE_AT = 0.8;

type Icon = "waiting" | "failed" | "running";

export function Row({ icon, glyph, title, lines, where, when, whenTone, href, onClick, active }: {
  icon: Icon;
  /** Drawn in the icon column instead of the status icon. */
  glyph?: ReactNode;
  title: ReactNode;
  lines?: ReactNode[];
  where: ReactNode;
  when: ReactNode;
  whenTone?: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      {active ? <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
      {glyph ?? <StatusIcon status={icon} size={16} className="mt-0.5" />}
      <span className="min-w-0">
        <span className="block truncate font-semibold">{title}</span>
        {lines?.map((l, i) => <span key={i} className="mt-0.5 block min-w-0 truncate text-sm text-muted">{l}</span>)}
        <span className="mt-1 flex items-center gap-1 truncate text-sm text-muted sm:hidden">{where ? <>{where} · </> : null}<span className={whenTone}>{when}</span></span>
      </span>
      <span className="hidden w-44 flex-col items-end gap-0.5 text-right text-sm sm:flex">
        <span className="flex max-w-full items-center gap-1 truncate text-muted">{where}</span>
        <span className={cx("max-w-full truncate tabular-nums", whenTone ?? "text-faint")}>{when}</span>
      </span>
    </>
  );
  const cls = cx(
    "relative grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2 sm:grid-cols-[16px_minmax(0,1fr)_auto] md:px-5",
    active && "bg-surface-2",
  );
  if (href) return <PLink href={href} className={cls}>{body}</PLink>;
  if (onClick) return <button onClick={onClick} className={cx(cls, "cursor-pointer")}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

export function Section({ title, count, right, children }: { title: ReactNode; count?: number; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {count !== undefined ? <span className="text-sm text-faint tabular-nums">{count}</span> : null}
        <span className="grow" />
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * A Section whose list folds away behind Show/Hide; Inbox is the one section that never folds.
 * Base UI's Collapsible, animated the way a session's chapters are: the title row keeps one
 * size, and the panel grows to its list's height and fades in (and back on close).
 */
export function CollapsibleSection({ title, count, defaultOpen, children }: { title: ReactNode; count: number; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} render={<section />}>
      <Collapsible.Trigger className="group flex w-full items-baseline gap-2 text-left cursor-pointer">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <span className="text-sm text-faint tabular-nums">{count}</span>
        <span className="grow" />
        <span className="flex items-center gap-1 text-sm text-muted group-hover:text-fg">
          <span className="group-data-panel-open:hidden">Show</span><span className="hidden group-data-panel-open:inline">Hide</span>
          <Chevron className="transition-transform duration-200 group-data-panel-open:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
        {/* The gap under the title lives inside the panel, so it folds away with the list. */}
        <div className="pt-3 pb-0.5">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const waited = (since: number) => `waiting ${fmtAgo(NOW - since).replace(" ago", "")}`;
const late = (since: number) => (NOW - since > 30 * 60_000 ? "text-wait" : undefined);

function Inbox() {
  const { answered, open, drawer } = useProto();
  const gates = GATES.filter((g) => !answered[g.id]);
  const [sel, setSel] = useState(0);
  const openGate = drawer.find((d) => d.type === "gate");

  // j/k move, Enter (or a/r) opens — the drawer takes the keys over once it is open.
  useEffect(() => {
    if (drawer.length) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "j") setSel((s) => Math.min(s + 1, gates.length - 1));
      else if (e.key === "k") setSel((s) => Math.max(s - 1, 0));
      else if ((e.key === "Enter" || e.key === "a" || e.key === "r") && gates[sel]) open({ type: "gate", gateId: gates[sel].id });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Section title="Inbox" count={gates.length} right={
      <span className="hidden items-center gap-1 text-xs text-faint md:flex">
        <Kbd>j</Kbd><Kbd>k</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
      </span>
    }>
      {gates.length === 0 ? (
        <Card className="px-5 py-6 text-center text-muted">Nothing is waiting on you.</Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {gates.map((g, i) => (
            <Row
              key={g.id}
              icon="waiting"
              glyph={<StageGlyph name={g.gate} tone="wait" />}
              title={g.title}
              lines={[<><span className="font-medium text-fg">{g.question}</span> {g.gate} gate · round {g.round}</>, g.subject]}
              where={<>{g.factory} <IssueRef plain factory={g.factory} n={Number(g.ref.slice(1))} state="open" /></>}
              when={waited(g.since)}
              whenTone={late(g.since)}
              onClick={() => { setSel(i); open({ type: "gate", gateId: g.id }); }}
              active={openGate?.type === "gate" ? openGate.gateId === g.id : i === sel}
            />
          ))}
        </Card>
      )}
    </Section>
  );
}

function attentionRow(a: Attention): { icon: Icon; title: ReactNode; line: ReactNode; href: string; action: string } {
  const ref = (r: string) => <IssueRef plain factory={a.factory} n={Number(r.slice(1))} state="open" />;
  switch (a.kind) {
    case "failed": return { icon: "failed", title: <>Session failed: {a.title}</>, line: <span className="inline-flex items-center gap-1.5">{ref(a.ref)} · {a.reason} · {fmtAgo(a.ago)}</span>, href: `/sessions/${a.session}`, action: "Open" };
    case "check": return { icon: "failed", title: "Check failing on main", line: a.what, href: `/factories/${a.factory}?tab=config`, action: "See config" };
    case "claim": return { icon: "waiting", title: <>Claim held by a station away for {Math.round(a.away / 3_600_000)}h</>, line: <span className="inline-flex items-center gap-1.5">{a.station} · {ref(a.ref)}</span>, href: `/sessions/${a.session}`, action: "Release" };
    case "unwatched": return { icon: "waiting", title: <>{a.issues.length} queued issues, no online station watching</>, line: <span className="inline-flex items-center gap-2">{a.issues.map((n) => <IssueRef key={n} plain factory={a.factory} n={n} state="open" />)}</span>, href: `/factories/${a.factory}?tab=stations`, action: "Stations" };
    case "drift": return { icon: "waiting", title: "Station config drifted", line: <>{a.station} · {a.what}</>, href: `/factories/${a.factory}?tab=stations`, action: "Compare" };
  }
}

/** Attention rows, for all factories (Now) or one (a factory's Overview). */
export function AttentionRows({ items, showFactory = true }: { items: Attention[]; showFactory?: boolean }) {
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {items.map((a, i) => {
        const r = attentionRow(a);
        return <Row key={i} icon={r.icon} title={r.title} lines={[r.line]} where={showFactory ? a.factory : ""} when={<span className="text-accent">{r.action} →</span>} href={r.href} />;
      })}
    </Card>
  );
}

/** Running sessions as rows: the stage they are in, the mini graph, stuck and expensive said in amber. */
export function RunningRows({ sessions, showFactory = true }: { sessions: typeof SESSIONS; showFactory?: boolean }) {
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {sessions.map((s) => {
        const { chapter, stage } = whereNow(s);
        const spent = cost(sessionPhases(s));
        const stuck = inPhaseFor(s) > STUCK_AFTER;
        const expensive = spent >= s.budget * EXPENSIVE_AT;
        return (
          <Row
            key={s.id}
            icon="running"
            glyph={<StageGlyph name={stage?.name ?? ""} tone="run" />}
            title={s.title}
            lines={[
              <span key="g" className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <MiniGraph chapter={chapter} />
                {stuck ? <span className="font-medium text-wait">{fmtDur(inPhaseFor(s))} in {stage?.name}</span> : null}
              </span>,
            ]}
            where={<>{showFactory ? s.factory : null} {s.pr ? <PrRef plain factory={s.factory} n={s.pr.n} state={s.pr.state} /> : s.issue ? <IssueRef plain factory={s.factory} n={s.issue.n} state={s.issue.state} /> : "· prompt"}</>}
            when={<>{expensive ? <span className="font-medium text-wait">{fmtCost(spent)} of {fmtCost(s.budget)}</span> : fmtCost(spent)} · {fmtDur(elapsed(s))}</>}
            href={`/sessions/${s.id}`}
          />
        );
      })}
    </Card>
  );
}

/** Gates as rows, each opening its drawer. Inbox adds the keyboard; a factory's Overview does not. */
export function GateRows({ gates }: { gates: typeof GATES }) {
  const { open } = useProto();
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {gates.map((g) => (
        <Row
          key={g.id}
          icon="waiting"
          glyph={<StageGlyph name={g.gate} tone="wait" />}
          title={g.title}
          lines={[<><span className="font-medium text-fg">{g.question}</span> {g.gate} gate · round {g.round}</>, g.subject]}
          where={<IssueRef plain factory={g.factory} n={Number(g.ref.slice(1))} state="open" />}
          when={waited(g.since)}
          whenTone={late(g.since)}
          onClick={() => open({ type: "gate", gateId: g.id })}
        />
      ))}
    </Card>
  );
}

function NeedsAttention() {
  return (
    <CollapsibleSection title="Needs attention" count={ATTENTION.length} defaultOpen>
      <AttentionRows items={ATTENTION} />
    </CollapsibleSection>
  );
}

function Running() {
  const running = SESSIONS.filter((s) => s.status === "running");
  return (
    <CollapsibleSection title="Running" count={running.length} defaultOpen>
      <RunningRows sessions={running} />
    </CollapsibleSection>
  );
}

function WaitingOnOthers() {
  return (
    <CollapsibleSection title="Waiting on others" count={OTHERS.length}>
      <Card className="divide-y divide-line overflow-hidden">
        {OTHERS.map((g) => (
          <Row
            key={g.id}
            icon="waiting"
            glyph={<StageGlyph name={g.gate} tone="wait" />}
            title={g.title}
            lines={[<>{g.question} {g.gate} gate · round {g.round} · asked of {g.askedOf}</>]}
            where={<>{g.factory} <IssueRef plain factory={g.factory} n={Number(g.ref.slice(1))} state="open" /></>}
            when={waited(g.since)}
            whenTone={late(g.since)}
            href={`/sessions/${g.session}`}
          />
        ))}
      </Card>
    </CollapsibleSection>
  );
}

export function NowPage() {
  return (
    <div className="flex max-w-[960px] flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight">Now</h1>
      <Inbox />
      <NeedsAttention />
      <Running />
      <WaitingOnOthers />
    </div>
  );
}

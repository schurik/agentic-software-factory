"use client";
// PROTOTYPE, throwaway. Now (/): Inbox → Needs attention → Running → Waiting on others.
// Answers "what needs me, and what's moving" on the first screen.
//
// Every list here is drawn with one Row, so the four line up on one vertical grid:
// status icon · title + detail lines · where (factory) above when/what-next on the right.
import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useState, type ReactNode } from "react";
import { ATTENTION, GATES, NOW, OTHERS, SESSIONS, type Attention } from "@/lib/data";
import { cost, elapsed, fmtAgo, fmtCost, fmtDur, sessionPhases, whereNow } from "@/lib/model";
import { MiniGraph } from "./Graph";
import { PLink, useProto } from "./state";
import { Card, Chevron, Kbd, StatusIcon, cx } from "./ui";

type Icon = "waiting" | "failed" | "running";

function Row({ icon, title, lines, where, when, whenTone, href, onClick, active }: {
  icon: Icon;
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
      <StatusIcon status={icon} size={16} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block truncate font-semibold">{title}</span>
        {lines?.map((l, i) => <span key={i} className="mt-0.5 block min-w-0 truncate text-sm text-muted">{l}</span>)}
        <span className="mt-1 block truncate text-sm text-muted sm:hidden">{where} · <span className={whenTone}>{when}</span></span>
      </span>
      <span className="hidden w-44 flex-col items-end gap-0.5 text-right text-sm sm:flex">
        <span className="max-w-full truncate text-muted">{where}</span>
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

function Section({ title, count, right, children }: { title: ReactNode; count: number; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <span className="text-sm text-faint tabular-nums">{count}</span>
        <span className="grow" />
        {right}
      </div>
      {children}
    </section>
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
              title={g.title}
              lines={[<><span className="font-medium text-fg">{g.question}</span> {g.gate} gate · round {g.round}</>, g.subject]}
              where={<>{g.factory} · {g.ref}</>}
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

function attentionRow(a: Attention): { icon: Icon; title: ReactNode; line: ReactNode; href?: string; action: string } {
  switch (a.kind) {
    case "failed": return { icon: "failed", title: <>Session failed: {a.title}</>, line: <>{a.ref} · {a.reason} · {fmtAgo(a.ago)}</>, href: `/sessions/${a.session}`, action: "Open" };
    case "check": return { icon: "failed", title: "Check failing on main", line: a.what, action: "See config" };
    case "claim": return { icon: "waiting", title: <>Claim held by a station away for {Math.round(a.away / 3_600_000)}h</>, line: <>{a.station} · {a.ref}</>, action: "Release" };
    case "unwatched": return { icon: "waiting", title: <>{a.issues.length} queued issues, no online station watching</>, line: a.issues.map((n) => `#${n}`).join(", "), action: "Stations" };
    case "drift": return { icon: "waiting", title: "Station config drifted", line: <>{a.station} · {a.what}</>, action: "Compare" };
  }
}

function NeedsAttention() {
  return (
    <Section title="Needs attention" count={ATTENTION.length}>
      <Card className="divide-y divide-line overflow-hidden">
        {ATTENTION.map((a, i) => {
          const r = attentionRow(a);
          return <Row key={i} icon={r.icon} title={r.title} lines={[r.line]} where={a.factory} when={<span className="text-accent">{r.action} →</span>} href={r.href} />;
        })}
      </Card>
    </Section>
  );
}

function Running() {
  const running = SESSIONS.filter((s) => s.status === "running");
  return (
    <Section title="Running" count={running.length}>
      <Card className="divide-y divide-line overflow-hidden">
        {running.map((s) => {
          const { chapter, phase } = whereNow(s);
          return (
            <Row
              key={s.id}
              icon="running"
              title={s.title}
              lines={[
                <span key="g" className="flex flex-wrap items-center gap-x-3 gap-y-1"><MiniGraph chapter={chapter} /><span className="truncate">{phase?.owner} {phase?.kind === "code" ? "runs" : "is on"} {phase?.name}</span></span>,
              ]}
              where={<>{s.factory} · {s.ref}{s.chapters.length > 1 ? ` · ch. ${chapter.n}` : ""}</>}
              when={<>{fmtCost(cost(sessionPhases(s)))} · {fmtDur(elapsed(s))}</>}
              href={`/sessions/${s.id}`}
            />
          );
        })}
      </Card>
    </Section>
  );
}

function WaitingOnOthers() {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group mb-3 flex w-full items-baseline gap-2 text-left cursor-pointer">
        <h2 className="text-lg font-semibold tracking-tight">Waiting on others</h2>
        <span className="text-sm text-faint tabular-nums">{OTHERS.length}</span>
        <span className="grow" />
        <span className="flex items-center gap-1 text-sm text-muted group-hover:text-fg">
          <span className="group-data-panel-open:hidden">Show</span><span className="hidden group-data-panel-open:inline">Hide</span>
          <Chevron className="group-data-panel-open:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <Card className="divide-y divide-line overflow-hidden">
          {OTHERS.map((g) => (
            <Row
              key={g.id}
              icon="waiting"
              title={g.title}
              lines={[<>{g.question} {g.gate} gate · round {g.round} · asked of {g.askedOf}</>]}
              where={<>{g.factory} · {g.ref}</>}
              when={waited(g.since)}
              whenTone={late(g.since)}
              href={`/sessions/${g.session}`}
            />
          ))}
        </Card>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function NowPage() {
  const { answered } = useProto();
  const mine = GATES.filter((g) => !answered[g.id]).length;
  const running = SESSIONS.filter((s) => s.status === "running").length;
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Now</h1>
        <p className="mt-1 text-muted">
          {mine ? <><b className="font-medium text-wait">{mine} gate{mine > 1 ? "s" : ""}</b> wait on you</> : "Nothing waits on you"} · {ATTENTION.length} things need attention · {running} sessions running across 3 factories
        </p>
      </div>
      <Inbox />
      <NeedsAttention />
      <Running />
      <WaitingOnOthers />
    </div>
  );
}

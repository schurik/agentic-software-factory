"use client";
// PROTOTYPE, throwaway. Now (/): Inbox → Needs attention → Running → Waiting on others.
// Answers "what needs me, and what's moving" on the first screen.
import { Collapsible } from "@base-ui/react/collapsible";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ATTENTION, GATES, NOW, OTHERS, SESSIONS, type Attention } from "@/lib/data";
import { cost, elapsed, fmtAgo, fmtCost, fmtDur, sessionPhases, whereNow } from "@/lib/model";
import { MiniGraph } from "./Graph";
import { PLink, useProto } from "./state";
import { Card, Chevron, Kbd, SectionTitle, StatusIcon, cx } from "./ui";

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
    <section>
      <SectionTitle count={gates.length} right={
        <span className="hidden items-center gap-1 text-xs text-faint md:flex">
          <Kbd>j</Kbd><Kbd>k</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
        </span>
      }>Inbox</SectionTitle>
      {gates.length === 0 ? (
        <Card className="px-5 py-6 text-center text-muted">Nothing is waiting on you.</Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {gates.map((g, i) => {
            const active = openGate?.type === "gate" ? openGate.gateId === g.id : i === sel;
            return (
              <button
                key={g.id}
                onClick={() => { setSel(i); open({ type: "gate", gateId: g.id }); }}
                className={cx("relative flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2 cursor-pointer md:px-5", active && "bg-surface-2")}
              >
                {active ? <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
                <StatusIcon status="waiting" size={16} className="mt-0.5" />
                <span className="min-w-0 grow">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">{g.question.replace("?", "")}</span>
                    <span className="text-sm text-muted">{g.gate} gate · round {g.round}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-base">{g.title}</span>
                  <span className="mt-0.5 block truncate text-sm text-muted">{g.subject}</span>
                  <span className="mt-1 block text-sm text-muted sm:hidden">{g.factory} · {g.ref} · <span className={NOW - g.since > 30 * 60_000 ? "text-wait" : ""}>waiting {fmtAgo(NOW - g.since).replace(" ago", "")}</span></span>
                </span>
                <span className="hidden shrink-0 flex-col items-end gap-0.5 text-sm sm:flex">
                  <span className="text-muted">{g.factory} · {g.ref}</span>
                  <span className={cx("tabular-nums", NOW - g.since > 30 * 60_000 ? "text-wait" : "text-faint")}>waiting {fmtAgo(NOW - g.since).replace(" ago", "")}</span>
                </span>
              </button>
            );
          })}
        </Card>
      )}
    </section>
  );
}

const attentionIcon = (a: Attention): "failed" | "waiting" =>
  a.kind === "failed" || a.kind === "check" ? "failed" : "waiting";

function attentionText(a: Attention): { head: ReactNode; sub: ReactNode; href?: string; action: string } {
  switch (a.kind) {
    case "failed": return { head: <>Session failed: {a.title}</>, sub: <>{a.ref} · {a.reason} · {fmtAgo(a.ago)}</>, href: `/sessions/${a.session}`, action: "Open" };
    case "check": return { head: <>Check failing on main</>, sub: a.what, action: "See config" };
    case "claim": return { head: <>Claim held by a station away for {Math.round(a.away / 3_600_000)}h</>, sub: <>{a.station} · {a.ref}</>, action: "Release" };
    case "unwatched": return { head: <>{a.issues.length} queued issues, no online station watching</>, sub: a.issues.map((n) => `#${n}`).join(", "), action: "Stations" };
    case "drift": return { head: <>Station config drifted</>, sub: <>{a.station} · {a.what}</>, action: "Compare" };
  }
}

function NeedsAttention() {
  const byFactory = ATTENTION.reduce<Record<string, Attention[]>>((m, a) => ((m[a.factory] ??= []).push(a), m), {});
  return (
    <section>
      <SectionTitle count={ATTENTION.length}>Needs attention</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        {Object.entries(byFactory).map(([factory, items]) => (
          <div key={factory} className="flex flex-col gap-0 py-1 md:flex-row">
            <div className="shrink-0 px-4 pt-2 text-sm font-medium text-muted md:w-40 md:px-5 md:py-2.5">{factory}</div>
            <div className="min-w-0 grow">
              {items.map((a, i) => {
                const t = attentionText(a);
                const body = (
                  <>
                    <StatusIcon status={attentionIcon(a)} size={14} className="mt-1" />
                    <span className="min-w-0 grow">
                      <span className="block">{t.head}</span>
                      <span className="block truncate text-sm text-muted">{t.sub}</span>
                    </span>
                    <span className="shrink-0 text-sm text-accent">{t.action} →</span>
                  </>
                );
                const cls = "flex items-start gap-3 px-4 py-2 hover:bg-surface-2 md:pr-5 md:pl-0";
                return t.href ? <PLink key={i} href={t.href} className={cls}>{body}</PLink> : <div key={i} className={cls}>{body}</div>;
              })}
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

function Running() {
  const router = useRouter();
  const running = SESSIONS.filter((s) => s.status === "running");
  return (
    <section>
      <SectionTitle count={running.length}>Running</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        {running.map((s) => {
          const { chapter, stage, phase } = whereNow(s);
          return (
            <PLink key={s.id} href={`/sessions/${s.id}`} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-surface-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_6rem_5rem] md:px-5" onMouseEnter={() => router.prefetch(`/sessions/${s.id}`)}>
              <span className="min-w-0">
                <span className="block truncate font-semibold">{s.title}</span>
                <span className="block truncate text-sm text-muted">{s.factory} · {s.ref} · <span className="font-mono">{s.id}</span>{s.chapters.length > 1 ? ` · chapter ${chapter.n}` : ""}</span>
              </span>
              <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
                <MiniGraph chapter={chapter} />
                <span className="mt-1 block truncate text-xs text-muted">{chapter.workflow} · {stage?.name} · {phase?.owner} {phase?.kind === "code" ? "runs" : "is on"} {phase?.name}</span>
              </span>
              <span className="text-right text-sm tabular-nums">{fmtCost(cost(sessionPhases(s)))}<span className="block text-xs text-faint">spent</span></span>
              <span className="hidden text-right text-sm tabular-nums md:block">{fmtDur(elapsed(s))}<span className="block text-xs text-faint">elapsed</span></span>
            </PLink>
          );
        })}
      </Card>
    </section>
  );
}

function WaitingOnOthers() {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex w-full items-center gap-2 text-left cursor-pointer">
        <Chevron className="text-faint group-data-panel-open:rotate-90" />
        <h2 className="text-lg font-semibold tracking-tight">Waiting on others</h2>
        <span className="text-sm text-faint">{OTHERS.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-3">
        <Card className="divide-y divide-line">
          {OTHERS.map((g) => (
            <PLink key={g.id} href={`/sessions/${g.session}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 md:px-5">
              <StatusIcon status="waiting" size={14} />
              <span className="min-w-0 grow truncate">{g.title} <span className="text-muted">· {g.gate} gate · round {g.round}</span></span>
              <span className="shrink-0 text-sm text-muted">on {g.askedOf} · {fmtAgo(NOW - g.since)}</span>
            </PLink>
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

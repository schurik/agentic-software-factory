"use client";
// PROTOTYPE, throwaway. Factories (/factories) and one factory (/factories/<owner>/<repo>):
// Overview · Workflows · Stations · Config, and Sessions as a link to the sessions list filtered
// to it. What used to be top-level Stations and Cost lives here now, per factory.
//
// The list is drawn with Now's rows. The Overview is about the factory itself — what it costs,
// how its workflows do over a period — and shows nothing Now, Sessions or a session page shows.
// The Workflows tab draws each workflow with the session page's stage graph.
import { Collapsible } from "@base-ui/react/collapsible";
import { Tabs } from "@base-ui/react/tabs";
import { CircleDot, ExternalLink, GitPullRequest, Play, SquareTerminal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Fragment, useState, type ReactNode } from "react";
import { ATTENTION, FORGE, GATES, MODE, NOW, SESSIONS, VIEWER } from "@/lib/data";
import { FACTORY_DETAILS, factoryByName, type FactoryDetail, type Period, type Station, type Workflow } from "@/lib/factories";
import { fmtAgo, fmtCost, fmtDur, fmtInt, who } from "@/lib/model";
import { WorkflowGraph } from "./Graph";
import { DiffView } from "./Diff";
import { CommitRef, StageIcon } from "./icons";
import { Row, Section } from "./Now";
import { PLink, useProto, useToast } from "./state";
import { Button, Card, Chevron, Pill, StatusIcon, cx } from "./ui";

// ── shared facts per factory ───────────────────────────────────────────────

function factsOf(f: FactoryDetail) {
  const running = SESSIONS.filter((s) => s.factory === f.name && s.status === "running");
  const gates = GATES.filter((g) => g.factory === f.name);
  const attention = ATTENTION.filter((a) => a.factory === f.name);
  const online = f.stations.filter((s) => s.state === "online").length;
  return { running, gates, attention, online };
}

function CheckPill({ f }: { f: FactoryDetail }) {
  if (f.check.state === "failing") return <Pill status="failed">check failing</Pill>;
  if (f.check.state === "passing") return <Pill status="ok">check passing</Pill>;
  return <Pill status="pending">unchecked</Pill>;
}

// ── /factories ─────────────────────────────────────────────────────────────

const more = (n: number) => (n ? <span key="a" className="text-wait">{n} more {n > 1 ? "need" : "needs"} attention</span> : null);

/** Every factory this cockpit knows, what needs attention first, then the most recently active. */
export function FactoriesList() {
  const rows = FACTORY_DETAILS.map((f) => ({ f, ...factsOf(f) }))
    .sort((a, b) => (b.attention.length + b.gates.length > 0 ? 1 : 0) - (a.attention.length + a.gates.length > 0 ? 1 : 0) || b.f.lastActivity - a.f.lastActivity);
  return (
    <div className="flex max-w-[960px] flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight">Factories</h1>
      <Card className="divide-y divide-line overflow-hidden">
        {rows.map(({ f, running, gates, attention, online }) => {
          const needs = [
            gates.length ? <span key="g" className="text-wait">{gates.length} gate{gates.length > 1 ? "s" : ""} on you</span> : null,
            f.check.state === "failing" ? <span key="c" className="text-bad">check failing</span> : null,
            more(attention.filter((a) => a.kind !== "check").length),
          ].filter(Boolean);
          return (
            <Row
              key={f.name}
              icon={f.check.state === "failing" || attention.some((a) => a.kind === "failed") ? "failed" : needs.length ? "waiting" : "running"}
              glyph={!needs.length ? <StatusIcon status="ok" size={16} className="mt-0.5" /> : undefined}
              title={f.name}
              lines={[
                needs.length ? <span className="flex flex-wrap gap-x-1.5">{needs.flatMap((n, i) => (i ? [<span key={`s${i}`}>·</span>, n] : [n]))}</span> : <span>Nothing needs attention</span>,
                <span key="facts">{running.length} running · {online}/{f.stations.length} stations online · {f.workflows.filter((w) => !w.broken).length} workflows</span>,
              ]}
              where={<>{fmtCost(f.spend.last30.total)} in 30 days</>}
              when={<>active {fmtAgo(NOW - f.lastActivity)}</>}
              href={`/factories/${f.name}`}
            />
          );
        })}
      </Card>
    </div>
  );
}

// ── /factories/<owner>/<repo> ──────────────────────────────────────────────

const TABS = ["overview", "workflows", "stations", "config"] as const;
type Tab = (typeof TABS)[number];

export function FactoryPage({ name }: { name: string }) {
  const f = factoryByName(name);
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  if (!f) return <p className="text-muted">No factory called {name} reaches this cockpit.</p>;
  const raw = params.get("tab");
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "overview";
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params.toString());
    if (t === "overview") next.delete("tab"); else next.set("tab", t);
    const q = next.toString();
    router.replace(q ? `${path}?${q}` : path, { scroll: false });
  };
  const { online } = factsOf(f);
  const drifted = f.stations.filter((s) => s.drift === "drifted").length;
  const broken = f.workflows.filter((w) => w.broken).length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-sm text-muted"><PLink href="/factories" className="hover:text-fg">Factories</PLink> /</div>
        <div className="mt-1.5 flex flex-col gap-3 md:flex-row md:items-start">
          <div className="min-w-0 grow">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              {f.name}
              <a href={`${FORGE}/${f.name}`} target="_blank" rel="noreferrer" className="text-faint hover:text-fg" aria-label="On the forge"><ExternalLink size={16} /></a>
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <CheckPill f={f} />
              <span><span className="font-mono">{f.defaultBranch}</span> at <span className="font-mono">{f.sha}</span></span>
              <span>{online}/{f.stations.length} stations online</span>
              <span className="tabular-nums">{fmtCost(f.budget)} · {fmtInt(f.tokensCap)} tokens per session</span>
            </div>
          </div>
        </div>
      </div>

      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <Tabs.List className="relative flex items-center gap-4 overflow-x-auto border-b border-line no-scrollbar">
          {TABS.map((t) => (
            <Tabs.Tab key={t} value={t} className="flex h-10 shrink-0 items-center gap-1.5 text-base font-medium whitespace-nowrap text-muted capitalize outline-none hover:text-fg data-active:text-fg cursor-pointer">
              {t}
              {t === "workflows" && broken ? <span className="size-1.5 rounded-full bg-bad" aria-label={`${broken} broken`} /> : null}
              {t === "stations" && drifted ? <span className="size-1.5 rounded-full bg-wait" aria-label={`${drifted} drifted`} /> : null}
              {t === "config" && f.check.state === "failing" ? <span className="size-1.5 rounded-full bg-bad" aria-label="check failing" /> : null}
            </Tabs.Tab>
          ))}
          <Tabs.Indicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-accent transition-[translate,width] duration-150" />
          <span className="grow" />
          <PLink href={`/sessions?factory=${f.name}`} className="shrink-0 text-sm whitespace-nowrap text-muted hover:text-fg">All sessions →</PLink>
        </Tabs.List>
        <Tabs.Panel value="overview" className="pt-6 outline-none"><Overview f={f} /></Tabs.Panel>
        <Tabs.Panel value="workflows" className="pt-6 outline-none"><Workflows f={f} /></Tabs.Panel>
        <Tabs.Panel value="stations" className="pt-6 outline-none"><Stations f={f} /></Tabs.Panel>
        <Tabs.Panel value="config" className="pt-6 outline-none"><Config f={f} onTab={setTab} /></Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

// ── Overview: the factory itself, over a period ────────────────────────────
//
// Not what is happening now (that is Now) nor any one session (Sessions): what the factory costs
// and how its workflows do, so the people who own it can tune budgets, gates and workflows.

const PERIODS: [Period, string][] = [["last7", "Last 7 days"], ["last30", "Last 30 days"]];
const DAY = 24 * 3600_000;
const fmtDay = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Overview({ f }: { f: FactoryDetail }) {
  const [period, setPeriod] = useState<Period>("last30");
  const days = period === "last7" ? 7 : 30;
  const daily = f.daily.slice(-days);
  const total = daily.reduce((a, b) => a + b, 0);
  const share = total / f.daily.reduce((a, b) => a + b, 0);
  const o = f.outcomes[period];
  const scale = (rows: [string, number][]) => rows.map(([k, v]) => [k, v * share] as [string, number]);
  return (
    <div className="flex max-w-[960px] flex-col gap-8">
      {/* One filter row above everything it filters. */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted">{fmtDay(NOW - (days - 1) * DAY)} – {fmtDay(NOW)}</span>
        <span className="grow" />
        <div className="flex rounded-md border border-line p-0.5 text-xs" role="radiogroup" aria-label="Period">
          {PERIODS.map(([k, l]) => (
            <button key={k} role="radio" aria-checked={period === k} onClick={() => setPeriod(k)} className={cx("h-6 rounded px-2 cursor-pointer", period === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>{l}</button>
          ))}
        </div>
      </div>

      <Section title="Spend">
        <Card className="p-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-semibold tracking-tight">{fmtCost(total)}</span>
            <span className="text-sm text-muted tabular-nums">{fmtInt(Math.round((f.spend.last30.tokens * share) / 100) * 100)} tokens · list-price equivalent</span>
            <span className="grow" />
            <span className="text-sm text-muted tabular-nums">{fmtCost(total / days)} a day · {fmtCost(o.sessions ? total / o.sessions : 0)} a session</span>
          </div>
          <SpendChart daily={daily} />
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Breakdown title="By station — whose key paid" rows={scale(f.spend.last30.byStation)} total={total} mono />
            <Breakdown title="By person — who started it" rows={scale(f.spend.last30.byPerson).map(([p, v]) => [who(p), v])} total={total} />
          </div>
        </Card>
      </Section>

      <Section title="Outcomes">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Sessions" value={fmtInt(o.sessions)} sub={<>{o.done} done · <span className={o.failed ? "text-bad" : undefined}>{o.failed} failed</span> · {o.open} open</>} />
          <Stat label="Finished well" value={o.done + o.failed ? `${Math.round((o.done / (o.done + o.failed)) * 100)}%` : "—"} sub="of the sessions that finished" />
          <Stat label="Time to finish" value={o.medianSecs ? fmtDur(o.medianSecs) : "—"} sub="median, start to last phase" />
          <Stat label="Wait at gates" value={o.gateRounds ? fmtDur(o.medianGateWait) : "—"} sub={o.gateRounds ? <>median · {o.gateRounds} rounds, {o.rejectedRounds} rejected</> : "no gate asked a person"} />
        </div>
      </Section>

      <Section title="By workflow">
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium md:px-5">Workflow</th>
                <th className="px-2 py-2 text-right font-medium">Sessions</th>
                <th className="px-2 py-2 font-medium">Finished</th>
                <th className="px-2 py-2 text-right font-medium">Median time</th>
                <th className="w-44 px-2 py-2 font-medium">Spend</th>
                <th className="px-4 py-2 text-right font-medium md:px-5">Last run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {o.byWorkflow.map((w) => (
                <tr key={w.workflow}>
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap md:px-5">{w.workflow}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{w.sessions}</td>
                  <td className="px-2 py-2.5 tabular-nums">{w.done} done{w.failed ? <span className="text-bad"> · {w.failed} failed</span> : null}{w.sessions - w.done - w.failed ? <span className="text-muted"> · {w.sessions - w.done - w.failed} open</span> : null}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{w.medianSecs ? fmtDur(w.medianSecs) : "—"}</td>
                  <td className="px-2 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 grow overflow-hidden rounded-full bg-accent-soft"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(...o.byWorkflow.map((x) => x.spend)) ? (w.spend / Math.max(...o.byWorkflow.map((x) => x.spend))) * 100 : 0}%` }} /></span>
                      <span className="w-12 text-right tabular-nums">{fmtCost(w.spend)}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted tabular-nums md:px-5">{fmtAgo(NOW - w.lastRun)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </Card>
  );
}

/**
 * Spend per day: one series, so no legend (the section names it). Columns capped at 24px with a
 * 2px gap, square at the baseline and 4px round at the top; hairline gridlines at clean values;
 * a tooltip on each day, whose hit target is the whole column, not just the bar.
 */
function SpendChart({ daily }: { daily: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...daily, 0.01);
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1].find((s) => max / s <= 4) ?? 1;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const first = NOW - (daily.length - 1) * DAY;
  return (
    <div className="mt-8">
      <div className="flex gap-2">
        <div className="relative h-36 w-10 shrink-0 text-right text-[11px] text-muted tabular-nums">
          {ticks.map((t) => <span key={t} className="absolute right-0 -translate-y-1/2" style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)" }}>{fmtCost(t)}</span>)}
        </div>
        <div className="relative h-36 grow" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => <span key={t} aria-hidden className="absolute inset-x-0 h-px bg-line" style={{ bottom: `${(t / top) * 100}%` }} />)}
          <div className="absolute inset-0 flex items-end gap-0.5" role="img" aria-label={`Spend per day, ${daily.length} days`}>
            {daily.map((v, i) => (
              <div key={i} className="relative flex h-full min-w-0 flex-1 items-end justify-center" onMouseEnter={() => setHover(i)}>
                <span className={cx("block w-full max-w-6 rounded-t-[4px] transition-opacity", hover !== null && hover !== i ? "bg-accent opacity-40" : "bg-accent")} style={{ height: v ? `${Math.max(2, (v / top) * 100)}%` : 0 }} />
                {hover === i ? (
                  <span className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-md border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-pop" style={{ bottom: `${(v / top) * 100}%` }}>
                    <span className="text-muted">{fmtDay(first + i * DAY)}</span> <b className="font-semibold tabular-nums">{fmtCost(v)}</b>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-1.5 ml-12 flex justify-between text-[11px] text-muted">
        <span>{fmtDay(first)}</span>
        <span>{fmtDay(first + Math.floor(daily.length / 2) * DAY)}</span>
        <span>{fmtDay(NOW)}</span>
      </div>
    </div>
  );
}

function Breakdown({ title, rows, total, mono }: { title: string; rows: [string, number][]; total: number; mono?: boolean }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted">{title}</div>
      <div className="flex flex-col gap-2">
        {[...rows].sort((a, b) => b[1] - a[1]).map(([label, v]) => (
          <div key={label} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className={cx("min-w-0 grow truncate", mono && "font-mono text-[13px]")}>{label}</span>
              <span className="tabular-nums">{fmtCost(v)}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-accent-soft"><div className="h-full rounded-full bg-accent" style={{ width: `${total ? (v / total) * 100 : 0}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Workflows: each one's shape, and how it has done ───────────────────────
//
// The self-description gives the shape (stages, agents, gates, triggers); the events of every run
// give the record. On the graph, per stage, over the last 30 days: median time and cost, the
// slowest stage, where runs failed, and what people did at its gate.

const INPUT_ICON: Record<Workflow["input"], ReactNode> = {
  issue: <CircleDot size={13} />, pr: <GitPullRequest size={13} />, prompt: <SquareTerminal size={13} />,
};
const INPUT_WORD: Record<Workflow["input"], string> = { issue: "issue", pr: "pull request", prompt: "prompt" };
const HARNESS: Record<string, string> = { claude_code: "Claude Code", pi: "pi" };
const WATCHER_OF: Record<Workflow["input"], "issues" | "pull_requests" | null> = { issue: "issues", pr: "pull_requests", prompt: null };

function Workflows({ f }: { f: FactoryDetail }) {
  const broken = f.workflows.filter((w) => w.broken);
  const fine = f.workflows.filter((w) => !w.broken);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        As <span className="font-mono">asf check --json</span> describes them on <span className="font-mono">{f.defaultBranch}</span> at <span className="font-mono">{f.sha}</span>. Figures on a stage are medians over the last 30 days.
      </p>
      {broken.map((w) => (
        <Card key={w.name} className="border-l-[3px] border-l-bad px-5 py-4">
          <div className="flex items-center gap-2"><StatusIcon status="failed" /><span className="font-semibold">{w.name}</span><span className="text-sm text-muted">does not load, so a run of it is refused</span></div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{w.broken}</pre>
        </Card>
      ))}
      {fine.map((w) => <WorkflowCard key={w.name} f={f} w={w} />)}
    </div>
  );
}

/** Opens the header's Run-a-prompt dialog with this factory and workflow chosen: one dialog, two ways in. */
function RunWorkflow({ factory, workflow }: { factory: string; workflow: string }) {
  const { openRun } = useProto();
  return <Button variant="secondary" size="sm" onClick={() => openRun({ factory, workflow })} aria-label={`Run ${workflow}`}><Play size={12} fill="currentColor" />Run</Button>;
}

function WorkflowCard({ f, w }: { f: FactoryDetail; w: Workflow }) {
  const used = [...new Set(w.stages.flatMap((s) => s.agents))];
  const agents = f.agents.filter((a) => used.includes(a.name));
  const record = f.outcomes.last30.byWorkflow.find((x) => x.workflow === w.name);
  const watcher = WATCHER_OF[w.input];
  const watching = watcher ? f.stations.filter((s) => s.watchers.includes(watcher) && s.state === "online").length : 0;
  return (
    <Card className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-lg font-semibold">{w.name}</span>
        <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{INPUT_ICON[w.input]}{INPUT_WORD[w.input]}</span>
        {w.trigger.labels.map((l) => <span key={l} className="rounded-md border border-line px-1.5 py-0.5 font-mono text-xs text-muted">{l}</span>)}
        {w.trigger.watched ? (
          watching
            ? <span className="text-xs text-muted">watched by {watching} online station{watching > 1 ? "s" : ""}</span>
            : <span className="text-xs font-medium text-wait">no online station watches for it</span>
        ) : <span className="text-xs text-muted">prompt only</span>}
        <span className="grow" />
        {w.input === "prompt" ? <RunWorkflow factory={f.name} workflow={w.name} /> : null}
      </div>
      <p className="mt-1">{w.about}</p>
      <p className="mt-0.5 text-sm text-muted">Started by {w.startedBy}.</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {record ? (
          <>
            <span className="text-muted">Last 30 days</span>
            <span className="tabular-nums">{record.sessions} session{record.sessions > 1 ? "s" : ""} · {record.done} done{record.failed ? <span className="text-bad"> · {record.failed} failed</span> : null} · median {record.medianSecs ? fmtDur(record.medianSecs) : "—"} · {fmtCost(record.spend)}</span>
            <PLink href={`/sessions?factory=${f.name}`} className="text-accent hover:underline">Sessions →</PLink>
          </>
        ) : <span className="text-muted">No runs in the last 30 days.</span>}
      </div>
      {w.warnings?.map((x) => (
        <div key={x} className="mt-3 flex items-start gap-2 rounded-lg bg-wait-soft px-3 py-2 text-sm"><StatusIcon status="waiting" className="mt-0.5" /><span><b className="font-medium">asf check warns:</b> {x}</span></div>
      ))}
      <div className="mt-4"><WorkflowGraph workflow={w} /></div>
      {agents.length ? (
        <Collapsible.Root className="mt-2 border-t border-line pt-3">
          <Collapsible.Trigger className="group flex items-center gap-1.5 text-sm text-muted hover:text-fg cursor-pointer">
            <Chevron className="transition-transform duration-200 group-data-panel-open:rotate-90" />
            {agents.length} agent{agents.length > 1 ? "s" : ""}: {agents.map((a) => a.name).join(", ")}
          </Collapsible.Trigger>
          <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr><th className="py-1.5 pr-3 font-medium">Agent</th><th className="py-1.5 pr-3 font-medium">Runs on</th><th className="py-1.5 pr-3 font-medium">Tools</th><th className="py-1.5 font-medium">May write — the boundary</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {agents.map((a) => (
                    <tr key={a.name} className="align-top">
                      <td className="py-2 pr-3"><span className="font-medium">{a.name}</span><span className="block text-xs text-muted">{a.purpose}</span></td>
                      <td className="py-2 pr-3 whitespace-nowrap">{HARNESS[a.harness]}<span className="block text-xs text-muted">{a.model} · thinking {a.effort}</span></td>
                      <td className="py-2 pr-3 text-muted">{a.tools.join(", ")}</td>
                      <td className="py-2">
                        {a.writes === "read-only"
                          ? <span className="text-muted">nothing — read-only</span>
                          : <span className="flex flex-wrap gap-1">{a.writes.split(", ").map((x) => <code key={x} className="rounded border border-line bg-surface-2 px-1 font-mono text-xs">{x}</code>)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">The factory diffs the repository after every agent call and rolls back any change outside what it may write.</p>
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : null}
    </Card>
  );
}

// ── Stations: who runs it, what each one does, and how loaded it is ────────
//
// What a station tells the cockpit: its own report on every poll (watchers, the commands it
// obeys, its checkout's commit and config hash), when it last polled, the release it runs (from
// the sessions it starts), its claims, and what is queued for it. Nothing about the machine.

const stateTone: Record<Station["state"], string> = { online: "bg-ok", away: "bg-wait", never: "bg-faint" };
const WATCHES: Record<string, string> = { issues: "issues", pull_requests: "pull-request reviews" };

function whose(s: Station): string {
  if (s.kind === "ci") return "CI";
  if (!s.owner) return "a machine";
  return who(s.owner) === "you" ? "your machine" : `${s.owner}'s machine`;
}

function Stations({ f }: { f: FactoryDetail }) {
  const { openToast } = useToast();
  return (
    <div className="flex flex-col gap-4">
      {f.registrations.map((r) => (
        <Card key={r.code} className="flex flex-col gap-3 border-l-[3px] border-l-accent px-5 py-4 md:flex-row md:items-center">
          <div className="min-w-0 grow">
            <div><span className="font-mono">{r.name}</span> asks to become a station of {f.name}</div>
            <div className="mt-0.5 text-sm text-muted">Approve only if its terminal shows <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">{r.code}</span> · asked {fmtAgo(NOW - r.at)} · the code expires in {Math.round((r.expiresAt - NOW) / 60_000)}m</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => openToast(`Declined ${r.name}. Prototype: nothing was sent.`)}>Decline</Button>
            <Button variant="primary" size="sm" onClick={() => openToast(`Approved ${r.name} — it gets its command token on its next poll. Prototype: nothing was sent.`)}>Approve</Button>
          </div>
        </Card>
      ))}
      <div className="grid gap-4 lg:grid-cols-2">
        {f.stations.map((s) => <StationCard key={s.name} f={f} s={s} />)}
      </div>
      <p className="text-xs text-muted">A machine station is online while its loop asks for commands, and belongs to the person who approved it. A CI station lives for one job and takes no commands.</p>
    </div>
  );
}

function StationCard({ f, s }: { f: FactoryDetail; s: Station }) {
  const { openToast } = useToast();
  const behind = s.release !== f.check.skill && s.release < f.check.skill;
  return (
    <Card className="flex flex-col px-5 py-4">
      <div className="flex items-start gap-3">
        <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", stateTone[s.state])} aria-hidden />
        <div className="min-w-0 grow">
          <div className="truncate font-mono font-medium">{s.name}</div>
          <div className="text-sm text-muted">{whose(s)} · {s.state === "online" ? <span className="text-ok">online</span> : s.state === "away" ? <span className="text-wait">away {fmtAgo(NOW - (s.lastSeen ?? NOW)).replace(" ago", "")}</span> : "never polled"}{s.state === "online" && s.lastSeen && NOW - s.lastSeen > 60_000 ? ` · seen ${fmtAgo(NOW - s.lastSeen)}` : ""}</div>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[8.5rem_1fr] gap-y-2 text-sm">
        <dt className="text-muted">Watches</dt>
        <dd>{s.watchers.length ? s.watchers.map((x) => WATCHES[x]).join(" · ") : <span className="text-muted">{s.kind === "ci" ? "nothing — runs what its job says" : "nothing — runs what it is told"}</span>}</dd>
        <dt className="text-muted">Takes commands</dt>
        <dd>{s.verbs.length ? s.verbs.join(", ") : <span className="text-muted">none</span>}</dd>
        <dt className="text-muted">Runs</dt>
        <dd className="flex flex-wrap items-center gap-x-2">
          <span>release {s.release}</span>
          {behind ? <span className="text-xs font-medium text-wait">behind main&apos;s {f.check.skill}</span> : null}
          {s.commit ? <CommitRef factory={f.name} sha={s.commit} /> : null}
          {s.drift === "in sync" ? <span className="text-xs text-ok">config same as {f.defaultBranch}</span> : s.drift === "drifted" ? <span className="text-xs font-medium text-wait">config drifted</span> : <span className="text-xs text-muted">no report yet</span>}
          {s.driftWhat ? <span className="basis-full text-xs text-muted">{s.driftWhat}</span> : null}
        </dd>
        <dt className="text-muted">Now</dt>
        <dd className="tabular-nums">{s.running} running · {s.claims ? `${s.claims} claim${s.claims > 1 ? "s" : ""} held` : "no claims"}</dd>
        <dt className="text-muted">Last 30 days</dt>
        <dd className="tabular-nums">{s.last30.sessions} session{s.last30.sessions === 1 ? "" : "s"}{s.last30.failed ? <span className="text-bad"> · {s.last30.failed} failed</span> : null} · {fmtCost(s.last30.spend)} on its key</dd>
      </dl>
      {s.pending.length ? (
        <div className="mt-3 rounded-lg bg-wait-soft px-3 py-2 text-sm">
          {s.pending.map((c) => (
            <div key={c.session + c.verb}><b className="font-medium">{c.verb}</b> <span className="font-mono">{c.session}</span> waits for it · queued by {who(c.by)} {fmtAgo(NOW - c.issuedAt)} · expires in {Math.round((c.expiresAt - NOW) / 60_000)}m</div>
          ))}
        </div>
      ) : null}
      {s.kind === "machine" ? (
        <div className="mt-auto flex justify-end pt-3">
          <Button variant="ghost" size="sm" className="text-bad hover:bg-bad-soft" onClick={() => openToast(`Revoked ${s.name}: it takes no more commands. Prototype: nothing was sent.`)}>Revoke</Button>
        </div>
      ) : null}
    </Card>
  );
}

// ── Config: what main says, grouped by what it decides; edited as a pull request ──
//
// The repository is the source of truth: a person who may write edits the files under asf/
// here, and the cockpit proposes the change as a pull request in their name; the cockpit checks
// YAML syntax, the repository's CI checks the rest, branch protection decides the merge.

function Config({ f, onTab }: { f: FactoryDetail; onTab: (t: Tab) => void }) {
  const c = f.config;
  const [editing, setEditing] = useState(false);
  const drifted = f.stations.filter((s) => s.drift === "drifted");
  const prompts = f.workflows.filter((w) => w.input === "prompt" && !w.broken).map((w) => w.name);
  const yes = (b: boolean) => (b ? "yes" : "no");
  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
        <div className="min-w-0 grow text-sm">
          <div>The factory&apos;s configuration is <span className="font-mono">asf/</span> on <span className="font-mono">{f.defaultBranch}</span> at <CommitRef factory={f.name} sha={f.sha} />. A change to it is a pull request.</div>
          {c.proposals.length ? (
            <div className="mt-1 text-muted">Open proposal{c.proposals.length > 1 ? "s" : ""}: {c.proposals.map((p) => (
              <a key={p.n} href={`${FORGE}/${f.name}/pull/${p.n}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">#{p.n} {p.title}</a>
            ))} · by {who(c.proposals[0].by)} {fmtAgo(NOW - c.proposals[0].at)}</div>
          ) : null}
        </div>
        <Button variant="primary" size="sm" className="shrink-0 self-start md:self-auto" onClick={() => setEditing(true)}>Edit config</Button>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <ConfigCard title="Check" right={<CheckPill f={f} />}>
          <p className="text-sm text-muted">On <span className="font-mono">{f.defaultBranch}</span> at <CommitRef factory={f.name} sha={f.sha} />, pushed by <span className="font-mono">{f.check.pushedBy}</span> {fmtAgo(NOW - f.check.at)} · skill {f.check.skill}</p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {f.workflows.map((w) => (
              <li key={w.name} className="flex items-start gap-2">
                <StatusIcon status={w.broken ? "failed" : w.warnings?.length ? "waiting" : "ok"} className="mt-0.5" />
                <span className="min-w-0"><span className="font-medium">{w.name}</span>
                  {w.broken ? <span className="block text-bad">{w.broken.split("\n")[1]?.replace(/^- /, "")}</span> : w.warnings?.length ? <span className="block text-muted">{w.warnings.length} warning</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <button onClick={() => onTab("workflows")} className="mt-3 text-sm text-accent hover:underline cursor-pointer">See the workflows →</button>
        </ConfigCard>

        <ConfigCard title="Forge and tracker">
          <Facts rows={[
            ["Forge", <>{c.forge.name} · <span className="font-mono">{c.forge.host}</span></>],
            ["This cockpit reaches it", MODE === "local" ? "through your own gh token (local)" : "through the team's GitHub App"],
            ["Issues", c.issues.enabled ? <>GitHub Issues of <span className="font-mono">{c.issues.project}</span>, through <span className="font-mono">{c.issues.via}</span></> : "off"],
            ["Pull requests", c.pullRequests.enabled ? <>GitHub pull requests; reviews are answered by <b className="font-medium">{c.pullRequests.workflow}</b></> : "off"],
          ]} />
        </ConfigCard>

        <ConfigCard title="Where work comes from">
          <h4 className="text-xs font-medium text-muted">Issues, by label</h4>
          <div className="mt-1.5 flex flex-col gap-1 text-sm">
            {c.issues.routes.map(([label, wf]) => (
              <div key={label} className="flex items-center gap-2"><code className="rounded border border-line bg-surface-2 px-1.5 font-mono text-xs">{label}</code><span className="text-faint">→</span><span>{wf}</span></div>
            ))}
          </div>
          <Facts className="mt-3" rows={[
            ["Queued as", <code key="q" className="font-mono text-xs">{c.issues.states.queued}</code>],
            ["Trusted authors", c.issues.trustedAuthors.length ? c.issues.trustedAuthors.map(who).join(", ") : "anyone who can label"],
            ["At once", `${c.issues.maxConcurrent} issues`],
            ["Reviews", <>{c.pullRequests.replyToThreads ? "replies in the thread" : "no replies"}{c.pullRequests.resolveThreads ? ", resolves what it addressed" : ""}; up to {c.pullRequests.maxThreads} threads</>],
            ["Trusted reviewers", c.pullRequests.trustedReviewers.map(who).join(", ")],
            ["Ignored", c.pullRequests.ignoreAuthors.join(", ") || "nobody"],
            ["Prompts", prompts.join(", ")],
          ]} />
        </ConfigCard>

        <ConfigCard title="People at gates">
          <div className="flex flex-col gap-1 text-sm">
            {Object.keys(c.hitl.gates).length ? Object.entries(c.hitl.gates).map(([g, on]) => (
              <div key={g} className="flex items-center gap-2"><StageIcon name={g} size={14} className="text-muted" /><span className="font-medium">{g}</span><span className={on === "on" ? "text-wait" : "text-muted"}>{on === "on" ? "asks a person" : "passes by policy"}</span></div>
            )) : <span className="text-muted">No gate names a person.</span>}
            <div className="text-muted">Every other gate {c.hitl.default === "on" ? "asks a person" : "passes by policy"}.</div>
          </div>
          <Facts className="mt-3" rows={[
            ["Attended", `asks in place for ${Math.round(c.hitl.waitSeconds / 60)}m, then suspends`],
            ["Unattended", c.hitl.whenUnattended === "suspend" ? "suspends and asks on the issue" : "passes automatically"],
            ["Rounds", c.hitl.maxRounds ? `at most ${c.hitl.maxRounds}` : "until approved or aborted"],
            ["Notifies", c.hitl.notify || "nobody — the issue comment is the notice"],
          ]} />
        </ConfigCard>

        <ConfigCard title="How work lands">
          <Facts rows={[
            ["As", c.integration.mode === "pr" ? (c.integration.openPr ? "a pull request, opened by the factory" : "a pushed branch; a person opens the PR") : "a merge into the base branch"],
            ["Branches", <><code className="font-mono text-xs">{c.integration.branchPrefix}&lt;session&gt;</code> on <span className="font-mono">{c.integration.remote}</span></>],
            ["Based on", c.integration.baseRef || "what the main checkout has out"],
            ["Worktrees", c.integration.keepOnSuccess ? "kept after success" : "removed after success, kept on failure for resume"],
          ]} />
        </ConfigCard>

        <ConfigCard title="Limits and data">
          <Facts rows={[
            ["Per session", <span key="b" className="tabular-nums">{fmtCost(f.budget)} · {fmtInt(f.tokensCap)} tokens</span>],
            ["Transcripts", f.transcripts ? `kept, ${f.retentionDays} days after a session finishes` : "off — no prompt or tool argument leaves the machine"],
            ["The cockpit may", c.cockpitCommands.join(", ")],
            ["Drift", drifted.length ? <button key="d" onClick={() => onTab("stations")} className="text-left font-medium text-wait hover:underline cursor-pointer">{drifted.length} station{drifted.length > 1 ? "s" : ""} on another config →</button> : `every station runs ${f.defaultBranch}'s config`],
            ["Purged", f.purged.length ? f.purged.map((p) => `${p.session} by ${who(p.by)} ${fmtAgo(NOW - p.at)}`).join("; ") : "nothing"],
          ]} />
        </ConfigCard>
      </div>
      <ConfigEditor f={f} open={editing} onOpenChange={setEditing} />
    </div>
  );
}

function ConfigCard({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-3"><h2 className="text-lg font-semibold">{title}</h2><span className="grow" />{right}</div>
      {children}
    </Card>
  );
}

function Facts({ rows, className }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-[9.5rem_1fr] gap-y-1.5 text-sm", className)}>
      {rows.map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="min-w-0">{v}</dd></Fragment>)}
    </dl>
  );
}

/** factory.yaml as the editor shows it — the real file's text, comments and all, in the real build. */
function yamlOf(f: FactoryDetail): string {
  const c = f.config;
  return `budget:
  max_cost_usd: ${f.budget}
  max_tokens: ${f.tokensCap}
hitl:
  default: ${c.hitl.default}                     # off | on — for gates no workflow names
  gates: {${Object.entries(c.hitl.gates).map(([g, v]) => `${g}: ${v}`).join(", ")}}
  wait_seconds: ${c.hitl.waitSeconds}                # attended: prompt this long, then suspend
  max_rounds: ${c.hitl.maxRounds}                    # 0 = until you approve or abort
  when_unattended: ${c.hitl.whenUnattended}
cockpit:
  transcripts: ${f.transcripts}
  commands: [${c.cockpitCommands.join(", ")}]
worktree:
  branch_prefix: "${c.integration.branchPrefix}"
  integration:
    mode: ${c.integration.mode}                       # merge | pr
    open_pr: ${c.integration.openPr}
issues:
  enabled: ${c.issues.enabled}
  project: "${c.issues.project}"
  route:
${c.issues.routes.map(([l, w]) => `    "${l}": ${w}`).join("\n")}
  trusted_authors: [${c.issues.trustedAuthors.join(", ")}]
  max_concurrent: ${c.issues.maxConcurrent}
pull_requests:
  enabled: ${c.pullRequests.enabled}
  workflow: ${c.pullRequests.workflow}
  ignore_authors: [${c.pullRequests.ignoreAuthors.map((a) => `"${a}"`).join(", ")}]
  max_threads: ${c.pullRequests.maxThreads}
`;
}

/** Edit the files under asf/ as text and propose the change as a pull request, in your name. */
function ConfigEditor({ f, open, onOpenChange }: { f: FactoryDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { openToast } = useToast();
  const original = yamlOf(f);
  const [file, setFile] = useState(f.config.files[0]);
  const [text, setText] = useState(original);
  const [title, setTitle] = useState("");
  const changed = text !== original;
  const slug = (title || "config").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setText(original); setTitle(""); } }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/60" />
        <Dialog.Popup className="fixed top-[5vh] left-1/2 z-50 flex max-h-[90vh] w-[min(1040px,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-line bg-surface shadow-pop transition-all data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="grow">
              <Dialog.Title className="text-lg font-semibold">Edit config</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-muted">Files under <span className="font-mono">asf/</span> on {f.defaultBranch} at <span className="font-mono">{f.sha}</span>. Your change becomes a pull request in your name; the repository&apos;s CI checks it.</Dialog.Description>
            </div>
            <Dialog.Close className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Close">×</Dialog.Close>
          </div>
          <div className="flex min-h-0 grow flex-col md:flex-row">
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-60 md:flex-col md:border-r md:border-b-0">
              {f.config.files.map((x) => (
                <button key={x} onClick={() => setFile(x)} className={cx("rounded-md px-2.5 py-1.5 text-left font-mono text-xs whitespace-nowrap cursor-pointer", file === x ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>{x.replace(/^asf\//, "")}</button>
              ))}
            </nav>
            <div className="flex min-h-0 min-w-0 grow flex-col gap-3 overflow-y-auto p-4">
              {file === "asf/factory.yaml" ? (
                <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={18} className="w-full resize-y rounded-lg border border-line-strong bg-surface-2 px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-accent focus:ring-4 focus:ring-accent-soft" />
              ) : <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">Prototype: only factory.yaml is editable here. The real editor reads every file from the forge at {f.sha}.</p>}
              {changed ? <DiffView files={[{ path: "asf/factory.yaml", before: original, after: text }]} title="Your change" /> : null}
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-line px-5 py-4 md:flex-row md:items-center">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What the pull request is called" className="h-9 min-w-0 grow rounded-md border border-line-strong bg-surface px-3 outline-none placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent-soft" />
            <span className="shrink-0 text-xs text-muted">on <span className="font-mono">cockpit/{VIEWER}/{slug}</span> → {f.defaultBranch}</span>
            <Button variant="primary" disabled={!changed || !title.trim()} onClick={() => { onOpenChange(false); setText(original); setTitle(""); openToast(`Would open a pull request “${title}” on ${f.name} as you. Prototype: nothing was sent.`); }}>Propose pull request</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

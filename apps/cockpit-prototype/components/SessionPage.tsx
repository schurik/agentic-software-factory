"use client";
// PROTOTYPE, throwaway. The session page, top to bottom: header (title, status, the one
// applicable action, a ⋯ menu) → the graph, one row per chapter → the Now card →
// Details · Timeline · Journal (· Changes). On a phone the Now card comes first, under the header:
// it is where an answer starts. A gate is answered from the Now card, and only from there.
import { Menu } from "@base-ui/react/menu";
import { Copy, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { BRANCH_DIFF, GATES, OTHERS, type Session } from "@/lib/data";
import { RECORDED_JOURNAL } from "@/lib/journals";
import {
  allPhases, cost, elapsed, fmtClock, fmtCost, fmtDur, fmtInt, phaseTitle, sessionPhases, tokens, whereNow, who,
} from "@/lib/model";
import { SessionGraph } from "./Graph";
import { DiffView } from "./Diff";
import { BranchRef, CommitRef, ExternalLink, IssueRef, PrRef, prUrl } from "./icons";
import { Md } from "./Md";
import { PLink, useProto } from "./state";
import { Tabbed } from "./Tabs";
import { Button, Card, KindIcon, Pill, StatusIcon, cx, menuItem, menuPopup } from "./ui";

const statusWord = { done: "done", running: "running", waiting: "waiting", failed: "failed" } as const;

/** The one action the header offers. Answering a gate is not one: that starts in the Now card. */
function Action({ s }: { s: Session }) {
  const [queued, setQueued] = useState(false);
  if (s.status === "done" && s.pr) {
    return (
      <a href={prUrl(s.factory, s.pr.n)} target="_blank" rel="noreferrer">
        <Button variant="primary">Pull request #{s.pr.n} <ExternalLink size={14} /></Button>
      </a>
    );
  }
  if (s.status === "waiting" && !GATES.some((g) => g.session === s.id)) {
    return <span className="text-sm text-muted">Waiting on {OTHERS.find((g) => g.session === s.id)?.askedOf ?? "someone"}</span>;
  }
  if (s.status === "running") return <Button variant="danger">Kill</Button>;
  if (s.status === "failed") {
    // A command reaches a station only while it is online; an away one gets it when it is back.
    if (s.stationOnline) return <Button variant="primary">Resume</Button>;
    return <Button variant="primary" disabled={queued} onClick={() => setQueued(true)}>{queued ? "Resume queued" : "Queue resume"}</Button>;
  }
  return null;
}

/** What is rarely needed and never first: copying the id, purging. */
function MoreMenu({ s }: { s: Session }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="grid size-9 place-items-center rounded-md border border-line-strong bg-surface text-muted shadow-card hover:bg-surface-2 hover:text-fg data-popup-open:bg-surface-2 cursor-pointer" aria-label="More">
        <MoreHorizontal size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup className={menuPopup}>
            <Menu.Item className={menuItem} onClick={() => navigator.clipboard?.writeText(s.id)}>
              <Copy size={14} className="text-muted" /> Copy session id <span className="ml-auto font-mono text-xs text-faint">{s.id}</span>
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className={cx(menuItem, "text-bad data-highlighted:bg-bad-soft")}>
              <Trash2 size={14} /> Purge session…
            </Menu.Item>
            <div className="max-w-60 px-2.5 pb-1.5 pl-[2.1rem] text-xs text-muted">Removes this cockpit’s copy; the factory keeps its own.</div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Spend against the per-session ceiling: the accent, amber from 80%, red at the ceiling. */
function CostGauge({ spent, budget }: { spent: number; budget: number }) {
  const share = spent / budget;
  const tone = share >= 1 ? "bg-bad" : share >= 0.8 ? "bg-wait" : "bg-accent";
  return (
    <div className="w-28">
      <div className={cx("text-lg font-semibold", share >= 0.8 && "text-wait")}>{fmtCost(spent)}</div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent} aria-label="Spend against the session ceiling">
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      <div className="mt-1 text-xs text-faint">{Math.round(share * 100)}% of {fmtCost(budget)}</div>
    </div>
  );
}

const ANSWER: Record<string, string> = { plan: "Review the plan and answer", integrate: "Review the changes and answer" };

function NowCard({ s, className }: { s: Session; className?: string }) {
  const { open, answered } = useProto();
  const gate = GATES.find((g) => g.session === s.id && !answered[g.id]);
  const { phase } = whereNow(s);
  const spent = cost(sessionPhases(s));
  const tone = s.status === "failed" ? "border-l-bad" : s.status === "waiting" ? "border-l-wait" : s.status === "running" ? "border-l-accent" : "border-l-ok";
  return (
    <Card className={cx("flex flex-col gap-4 border-l-[3px] px-5 py-4 md:flex-row md:items-center", tone, className)}>
      <div className="min-w-0 grow">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">Now</div>
        <p className="mt-0.5 text-lg">{s.now}</p>
        {gate ? (
          <Button variant="primary" className="mt-3" onClick={() => open({ type: "gate", gateId: gate.id })}>{ANSWER[gate.kind] ?? "Answer"}</Button>
        ) : phase && s.status === "failed" ? (
          <button onClick={() => open({ type: "phase", session: s.id, phaseId: phase.id })} className="mt-1 text-sm text-accent hover:underline cursor-pointer">
            See {phaseTitle(phase)}&apos;s output →
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-6 text-right tabular-nums">
        <CostGauge spent={spent} budget={s.budget} />
        <div><div className="text-lg font-semibold">{fmtDur(elapsed(s))}</div><div className="text-xs text-faint">{s.status === "done" || s.status === "failed" ? "took" : "elapsed"}</div></div>
      </div>
    </Card>
  );
}

function Timeline({ s }: { s: Session }) {
  const { open } = useProto();
  return (
    <div className="flex flex-col gap-6">
      {s.chapters.map((c) => (
        <div key={c.n}>
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Chapter {c.n} · {c.workflow} · {c.ref}</div>
          <ol className="relative flex flex-col">
            {allPhases(c).map((p) => (
              <li key={p.id}>
                <button onClick={() => open({ type: "phase", session: s.id, phaseId: p.id })} className="grid w-full grid-cols-[3rem_1rem_1fr_auto] items-start gap-x-3 rounded-md px-2 py-2 text-left hover:bg-surface-2 cursor-pointer md:grid-cols-[3.5rem_1rem_10rem_1fr_auto]">
                  <span className="pt-px text-sm tabular-nums text-faint">{fmtClock(p.at)}</span>
                  <StatusIcon status={p.status} className="mt-1" />
                  <span className="flex items-center gap-1.5 font-medium"><span className="truncate">{phaseTitle(p)}</span><KindIcon kind={p.kind} /></span>
                  <span className="col-start-3 min-w-0 text-sm text-muted md:col-start-auto">
                    <span className="block truncate">{who(p.owner)}{p.summary && !p.commit ? ` — ${p.summary}` : p.commit ? ` — ${p.commit.message}` : ""}</span>
                    {p.remark?.text ? <span className="mt-0.5 block text-fg">✎ {who(p.remark.by)}: “{p.remark.text}”</span> : null}
                    {p.notes?.map((n) => <span key={n.what} className="mt-0.5 block">⚑ {n.kind}: {n.what}</span>)}
                    {p.commit?.sha ? <span className="mt-0.5 block"><CommitRef factory={s.factory} sha={p.commit.sha} className="text-accent" /></span> : null}
                  </span>
                  <span className="row-start-1 col-start-4 text-right text-sm tabular-nums text-faint md:col-start-5">{p.secs ? fmtDur(p.secs) : ""}{p.cost ? <span className="block text-xs">{fmtCost(p.cost)}</span> : null}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/**
 * The journal: engine/journal.py's markdown, rendered. The recorded session shows its real
 * journal.md verbatim; the others are written here in the same form.
 */
function journalOf(s: Session): string {
  if (s.id === "a9f259f0") return RECORDED_JOURNAL;
  const seen = new Set<number>();
  const lines = sessionPhases(s)
    .filter((p) => p.status !== "waiting" && p.status !== "running")
    .filter((p) => (seen.has(p.seq) ? false : (seen.add(p.seq), true)))
    .map((p) => {
      const out = [`${p.seq}. ${p.name} · ${p.owner} · ${p.status === "failed" ? "failure" : "success"}${p.summary ? ` — ${p.summary}` : ""}`];
      for (const n of p.notes ?? []) {
        out.push(`   ⚑ ${n.kind} (${n.by}, in ${p.name}): ${n.what}`);
        if (n.insteadOf) out.push(`     instead of: ${n.insteadOf}`);
        out.push(`     because: ${n.because}`);
      }
      if (p.remark?.text) out.push(`   ✎ ${p.remark.by} said, ${p.remark.verdict} at the ${p.gate?.name} gate (round ${p.gate?.round}): ${p.remark.text}`);
      return out.join("\n");
    });
  return `## This run so far

The factory wrote this as the run went. Each numbered line is a phase that closed;
the marked lines under one are what came out of it.

${lines.join("\n")}
`;
}

/**
 * journal.py numbers each line by the phase's seq, and the numbers skip (7, 10, 12…). A stock
 * markdown renderer renumbers an ordered list from its first number, so the numbered entries
 * are split out here and drawn with their own numbers; markdown renders inside each one.
 */
function splitJournal(text: string): { head: string; items: { n: number; body: string }[] } {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^\d+\. /.test(l));
  if (first < 0) return { head: text, items: [] };
  const items: { n: number; body: string }[] = [];
  for (const l of lines.slice(first)) {
    const m = /^(\d+)\. (.*)$/.exec(l);
    if (m) items.push({ n: Number(m[1]), body: m[2] });
    else if (l.trim() && items.length) items[items.length - 1].body += "\n" + l.trim();
  }
  return { head: lines.slice(0, first).join("\n"), items };
}

function Journal({ s }: { s: Session }) {
  const { head, items } = splitJournal(journalOf(s));
  return (
    <div className="flex max-w-[80ch] flex-col gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-surface-2 px-4 py-2.5 text-sm">
        <span><b>⚑</b> a note an agent filed — a report, judged like any claim</span>
        <span><b>✎</b> what a person typed at a gate — an instruction, it wins</span>
      </div>
      <Md text={head} />
      <ol className="flex flex-col gap-2">
        {items.map((it) => (
          <li key={it.n} className="grid grid-cols-[2rem_1fr] gap-x-2">
            <span className="pt-px text-right text-sm text-faint tabular-nums">{it.n}.</span>
            <Md text={it.body} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What the page shows nowhere else. Issue, pull request and branch are under the title; spend is
 * in the Now card; purge is in the ⋯ menu.
 */
function Details({ s }: { s: Session }) {
  const tok = tokens(sessionPhases(s));
  const [baseRef, , sha] = s.base.split(" ");
  const meter = (v: number) => (
    <span className="mt-1 block h-1 w-48 overflow-hidden rounded-full bg-surface-3"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, v * 100)}%` }} /></span>
  );
  return (
    <div className="grid gap-x-8 gap-y-2.5 md:grid-cols-2">
      <dl className="grid grid-cols-[7.5rem_1fr] gap-y-2.5 text-sm">
        <dt className="text-muted">Station</dt>
        <dd><span className="font-mono">{s.station}</span><span className="block text-muted">{s.owner !== "—" ? `owned by ${who(s.owner)} · ` : "a CI station · "}{s.stationOnline ? <span className="text-ok">online</span> : <span className="text-wait">away 26h</span>}</span></dd>
        <dt className="text-muted">Triggered by</dt><dd>{s.triggeredBy}</dd>
        <dt className="text-muted">Started</dt><dd className="tabular-nums">{fmtClock(s.startedAt)}</dd>
        <dt className="text-muted">Tokens</dt><dd className="tabular-nums">{fmtInt(tok)} of 2,000,000{meter(tok / 2_000_000)}</dd>
      </dl>
      <dl className="grid grid-cols-[7.5rem_1fr] gap-y-2.5 text-sm">
        <dt className="text-muted">Base</dt><dd><span className="font-mono">{baseRef}</span> at <span className="font-mono">{sha}</span></dd>
        <dt className="text-muted">Claim</dt><dd>{s.status === "done" ? "released when it finished" : <>held by <span className="font-mono">{s.station}</span></>}</dd>
        <dt className="text-muted">Transcripts</dt><dd>{s.transcripts ? "on — prompts and harness output are kept" : "off — no prompt or tool argument leaves the machine"}</dd>
      </dl>
    </div>
  );
}

export function SessionPage({ s }: { s: Session }) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-sm text-muted">
          <PLink href="/factories" className="hover:text-fg">{s.factory}</PLink> / <PLink href="/sessions" className="hover:text-fg">sessions</PLink> / <span className="font-mono">{s.id}</span>
        </div>
        <div className="mt-1.5 flex flex-col gap-3 md:flex-row md:items-start">
          <div className="min-w-0 grow">
            <h1 className="text-2xl font-semibold tracking-tight">{s.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {s.issue ? <IssueRef factory={s.factory} n={s.issue.n} state={s.issue.state} /> : <span>from a prompt</span>}
              {s.pr ? <PrRef factory={s.factory} n={s.pr.n} state={s.pr.state} /> : null}
              <span className="flex min-w-0 items-center gap-1"><BranchRef factory={s.factory} branch={s.branch} /><span className="text-faint">→ {s.base.split(" ")[0]}</span></span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-1 md:items-end">
            <div className="flex items-center gap-3">
              <Pill status={s.status}>{statusWord[s.status]}</Pill>
              <Action s={s} />
              <MoreMenu s={s} />
            </div>
            {s.status === "failed" && !s.stationOnline ? (
              <span className="text-xs text-muted"><span className="font-mono">{s.station}</span> is away — resume runs when it is back</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="max-md:order-2"><SessionGraph session={s} /></div>
      <NowCard s={s} className="max-md:order-1" />
      <Card className="px-5 pb-5 max-md:order-3 md:px-6">
        <Tabbed tabs={[
          { value: "details", label: "Details", body: <Details s={s} /> },
          { value: "timeline", label: "Timeline", body: <Timeline s={s} /> },
          { value: "journal", label: "Journal", body: <Journal s={s} /> },
          ...(BRANCH_DIFF[s.id] ? [{ value: "changes", label: "Changes", body: <DiffView files={BRANCH_DIFF[s.id]} title={<>{s.branch} against {s.base.split(" ")[0]}</>} /> }] : []),
        ]} />
      </Card>
    </div>
  );
}

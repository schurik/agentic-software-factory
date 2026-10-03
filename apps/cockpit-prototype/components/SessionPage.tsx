"use client";
// PROTOTYPE, throwaway. The session page, top to bottom: header (title, status, the one
// applicable action) → the graph, one row per chapter → the Now card → Details · Timeline · Journal.
import { BRANCH_DIFF, GATES, OTHERS, type Phase, type Session } from "@/lib/data";
import { RECORDED_JOURNAL } from "@/lib/journals";
import {
  allPhases, cost, elapsed, fmtClock, fmtCost, fmtDur, fmtInt, sessionPhases, tokens, whereNow,
} from "@/lib/model";
import { SessionGraph } from "./Graph";
import { DiffView } from "./Diff";
import { BranchRef, CommitRef, ExternalLink, IssueRef, PrRef, prUrl } from "./icons";
import { Md } from "./Md";
import { PLink, useProto } from "./state";
import { Tabbed } from "./Tabs";
import { Button, Card, KindIcon, Pill, StatusIcon, cx } from "./ui";

const statusWord = { done: "done", running: "running", waiting: "waiting", failed: "failed" } as const;

function Action({ s }: { s: Session }) {
  const { open, answered } = useProto();
  const gate = GATES.find((g) => g.session === s.id && !answered[g.id]);
  if (s.status === "done" && s.pr) {
    return (
      <a href={prUrl(s.factory, s.pr.n)} target="_blank" rel="noreferrer">
        <Button variant="primary">Pull request #{s.pr.n} <ExternalLink size={14} /></Button>
      </a>
    );
  }
  if (gate) return <Button variant="primary" onClick={() => open({ type: "gate", gateId: gate.id })}>Answer the {gate.gate} gate</Button>;
  if (s.status === "waiting") return <span className="text-sm text-muted">Waiting on {OTHERS.find((g) => g.session === s.id)?.askedOf ?? "someone"}</span>;
  if (s.status === "running") return <Button variant="danger">Kill</Button>;
  if (s.status === "failed") return <Button variant="primary">Resume</Button>;
  return null;
}

function NowCard({ s }: { s: Session }) {
  const { open, answered } = useProto();
  const gate = GATES.find((g) => g.session === s.id && !answered[g.id]);
  const { phase } = whereNow(s);
  const spent = cost(sessionPhases(s));
  const tone = s.status === "failed" ? "border-l-bad" : s.status === "waiting" ? "border-l-wait" : s.status === "running" ? "border-l-accent" : "border-l-ok";
  return (
    <Card className={cx("flex flex-col gap-4 border-l-[3px] px-5 py-4 md:flex-row md:items-center", tone)}>
      <div className="min-w-0 grow">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">Now</div>
        <p className="mt-0.5 text-lg">{s.now}</p>
        {phase && (s.status === "failed" || gate) ? (
          <button onClick={() => (gate ? open({ type: "gate", gateId: gate.id }) : open({ type: "phase", session: s.id, phaseId: phase.id }))} className="mt-1 text-sm text-accent hover:underline cursor-pointer">
            {gate ? "Open the plan and answer →" : `See ${phase.name}'s output →`}
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-6 text-right tabular-nums">
        <div><div className="text-lg font-semibold">{fmtCost(spent)}</div><div className="text-xs text-faint">of {fmtCost(s.budget)}</div></div>
        <div><div className="text-lg font-semibold">{fmtDur(elapsed(s))}</div><div className="text-xs text-faint">{s.status === "done" || s.status === "failed" ? "took" : "elapsed"}</div></div>
        <div><div className="text-lg font-semibold">{s.chapters.length}</div><div className="text-xs text-faint">chapter{s.chapters.length > 1 ? "s" : ""}</div></div>
      </div>
    </Card>
  );
}

const label = (p: Phase) => (p.gate ? `${p.gate.name} gate · round ${p.gate.round}` : p.name);

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
                  <span className="flex items-center gap-1.5 font-medium"><span className="truncate">{label(p)}</span><KindIcon kind={p.kind} /></span>
                  <span className="col-start-3 min-w-0 text-sm text-muted md:col-start-auto">
                    <span className="block truncate">{p.owner}{p.summary && !p.commit ? ` — ${p.summary}` : p.commit ? ` — ${p.commit.message}` : ""}</span>
                    {p.remark?.text ? <span className="mt-0.5 block text-fg">✎ {p.remark.by}: “{p.remark.text}”</span> : null}
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

function Details({ s }: { s: Session }) {
  const spent = cost(sessionPhases(s));
  const tok = tokens(sessionPhases(s));
  const meter = (v: number) => (
    <span className="mt-1 block h-1 w-48 overflow-hidden rounded-full bg-surface-3"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, v * 100)}%` }} /></span>
  );
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <dl className="grid grid-cols-[7.5rem_1fr] gap-y-2.5 text-sm">
        <dt className="text-muted">Station</dt>
        <dd><span className="font-mono">{s.station}</span><span className="block text-muted">{s.owner !== "—" ? `owned by ${s.owner} · ` : "a CI station · "}{s.stationOnline ? <span className="text-ok">online</span> : <span className="text-wait">away 26h</span>}</span></dd>
        <dt className="text-muted">Triggered by</dt><dd>{s.triggeredBy}</dd>
        <dt className="text-muted">Started</dt><dd className="tabular-nums">{fmtClock(s.startedAt)} · {fmtDur(elapsed(s))}</dd>
        <dt className="text-muted">Cost</dt><dd className="tabular-nums">{fmtCost(spent)} of {fmtCost(s.budget)} per-session ceiling · {Math.round((spent / s.budget) * 100)}%{meter(spent / s.budget)}</dd>
        <dt className="text-muted">Tokens</dt><dd className="tabular-nums">{fmtInt(tok)} of 2,000,000{meter(tok / 2_000_000)}</dd>
      </dl>
      <dl className="grid grid-cols-[7.5rem_1fr] gap-y-2.5 text-sm">
        <dt className="text-muted">Branch</dt><dd><BranchRef factory={s.factory} branch={s.branch} className="text-accent" /></dd>
        <dt className="text-muted">Base</dt><dd className="font-mono">{s.base}</dd>
        <dt className="text-muted">Issue</dt><dd>{s.issue ? <span className="flex items-center gap-2"><IssueRef factory={s.factory} n={s.issue.n} state={s.issue.state} className="text-accent" /><span className="text-muted">{s.issue.state}</span></span> : <span className="text-muted">none — started from a prompt</span>}</dd>
        <dt className="text-muted">Pull request</dt><dd>{s.pr ? <span className="flex items-center gap-2"><PrRef factory={s.factory} n={s.pr.n} state={s.pr.state} className="text-accent" /><span className="text-muted">{s.pr.state}</span></span> : <span className="text-muted">not opened yet</span>}</dd>
        <dt className="text-muted">Claim</dt><dd>{s.status === "done" ? "released when it finished" : `held by ${s.station}`}</dd>
        <dt className="text-muted">Transcripts</dt><dd>{s.transcripts ? "on — prompts and harness output are kept" : "off — no prompt or tool argument leaves the machine"}</dd>
      </dl>
      <div className="flex items-center gap-4 rounded-lg border border-line px-4 py-3 md:col-span-2">
        <div className="grow text-sm"><b className="font-medium">Purge this session</b><div className="text-muted">Deletes its events from this cockpit. The factory&apos;s own record is untouched.</div></div>
        <Button variant="danger" size="sm">Purge…</Button>
      </div>
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
          <div className="flex shrink-0 items-center gap-3">
            <Pill status={s.status}>{statusWord[s.status]}</Pill>
            <Action s={s} />
          </div>
        </div>
      </div>
      <SessionGraph session={s} />
      <NowCard s={s} />
      <Card className="px-5 pb-5 md:px-6">
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

"use client";
// PROTOTYPE, throwaway. The session page, top to bottom: header (title, status, the one
// applicable action) → the graph, one row per chapter → the Now card → Timeline · Journal · Details.
import { GATES, OTHERS, type Phase, type Session } from "@/lib/data";
import {
  allPhases, cost, elapsed, fmtClock, fmtCost, fmtDur, fmtInt, sessionPhases, tokens, whereNow,
} from "@/lib/model";
import { SessionGraph } from "./Graph";
import { inline } from "./Md";
import { PLink, useProto } from "./state";
import { Tabbed } from "./Tabs";
import { Button, Card, KindIcon, Pill, StatusIcon, cx } from "./ui";

const statusWord = { done: "done", running: "running", waiting: "waiting", failed: "failed" } as const;

function Action({ s }: { s: Session }) {
  const { open, answered } = useProto();
  const gate = GATES.find((g) => g.session === s.id && !answered[g.id]);
  if (s.status === "done" && s.prUrl) return <Button variant="primary">Open pull request ↗</Button>;
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
                    <span className="block truncate">{p.owner}{p.summary ? ` — ${p.summary}` : ""}</span>
                    {p.remark?.text ? <span className="mt-0.5 block text-fg">✎ {p.remark.by}: “{p.remark.text}”</span> : null}
                    {p.notes?.map((n) => <span key={n.what} className="mt-0.5 block">⚑ {n.kind}: {n.what}</span>)}
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

/** The journal, rendered — engine/journal.py's text, read as a page instead of monospace. */
function Journal({ s }: { s: Session }) {
  const phases = sessionPhases(s).filter((p) => p.status !== "waiting" && p.status !== "running");
  // One line per phase that closed, as journal.py numbers them (replays and repeats collapse).
  const seen = new Set<number>();
  const lines = phases.filter((p) => (seen.has(p.seq) ? false : (seen.add(p.seq), true)));
  return (
    <article className="prose-journal max-w-[72ch]">
      <h3 className="text-lg font-semibold">This run so far</h3>
      <p className="mt-1 text-muted">The factory wrote this as the run went. Each numbered line is a phase that closed; the marked lines under one are what came out of it.</p>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-surface-2 px-4 py-2.5 text-sm">
        <span><b>⚑</b> a note an agent filed — a report, judged like any claim</span>
        <span><b>✎</b> what a person typed at a gate — an instruction, it wins</span>
      </div>
      <ol className="mt-4">
        {lines.map((p) => (
          <li key={p.id} value={p.seq}>
            <span className="font-medium">{p.name}</span> <span className="text-muted">· {p.owner} · {p.status === "rejected" ? "success" : p.status === "ok" ? "success" : p.status}</span>
            {p.summary ? <> — {inline(p.summary)}</> : null}
            {p.notes?.map((n) => (
              <div key={n.what} className="mt-1 ml-1 border-l-2 border-line pl-3 text-sm">
                ⚑ <b className="font-medium">{n.kind}</b> ({n.by}): {n.what}
                {n.insteadOf ? <div className="text-muted">instead of: {n.insteadOf}</div> : null}
                <div className="text-muted">because: {n.because}</div>
              </div>
            ))}
            {p.remark?.text ? (
              <div className="mt-1 ml-1 border-l-2 border-wait pl-3 text-sm">
                ✎ {p.remark.by} said, {p.remark.verdict} at the {p.gate?.name} gate (round {p.gate?.round}): <b className="font-medium">{p.remark.text}</b>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </article>
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
        <dt className="text-muted">Branch</dt><dd className="font-mono">{s.branch}</dd>
        <dt className="text-muted">Base</dt><dd className="font-mono">{s.base}</dd>
        <dt className="text-muted">Links</dt><dd className="flex gap-3">{s.issueUrl ? <a className="text-accent hover:underline" href="#">issue {s.ref}</a> : null}{s.prUrl ? <a className="text-accent hover:underline" href="#">pull request</a> : null}</dd>
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
          <h1 className="min-w-0 grow text-2xl font-semibold tracking-tight">
            {s.ref !== "prompt" ? <span className="text-faint">{s.ref} </span> : null}{s.title}
          </h1>
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
          { value: "timeline", label: "Timeline", body: <Timeline s={s} /> },
          { value: "journal", label: "Journal", body: <Journal s={s} /> },
          { value: "details", label: "Details", body: <Details s={s} /> },
        ]} />
      </Card>
    </div>
  );
}

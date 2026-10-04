"use client";

import { useEffect, useState } from "react";
import type { Read } from "@/convex/artifacts";
import { type Artifact, type PhaseDetail, READ_BYTES } from "@/convex/model/phase";
import { prunedWord } from "@/convex/model/retention";
import { formatBytes, formatClock, formatCost, formatDuration, formatPruned, formatTime, formatTokenCount, formatTokens, pretty } from "../format";
import { Facts, num, Pre, Table, Tabs } from "../ui";

/** Which session a phase is of, and the forge's web origin its links go to ("" when unknown). */
export interface Where {
  factory: string;
  session: string;
  forge: string;
}

/** Read a repo artifact from the forge, by the seq of its `artifact_written` (`artifacts.read`). */
export type ReadArtifact = (seq: number) => Promise<Read>;

const TABS = {
  artifacts: "Artifacts", overview: "Overview", checks: "Checks", tools: "Tools",
  transcript: "Transcript", cost: "Cost", events: "Events",
} as const;

type Tab = keyof typeof TABS;

/**
 * The tabs a phase opens into. An agent has all of them; a code step ran no
 * agent, so it has no tools, transcript or cost to show — and a phase that
 * wrote nothing has no Artifacts tab rather than an empty one.
 */
export function tabsFor(detail: PhaseDetail): Tab[] {
  const tabs = Object.keys(TABS) as Tab[];
  return tabs.filter((tab) => {
    if (tab === "artifacts") return detail.artifacts.length > 0;
    if (tab === "tools" || tab === "transcript" || tab === "cost") return detail.kind === "agent";
    return true;
  });
}

/**
 * A phase opened into its tabs. Pure but for which tab is showing: everything
 * comes from `detail` (the `sessions.phase` query), and a repo file is read
 * through `read` (the `artifacts.read` action) when its tab is shown.
 */
export function PhaseTabs({ detail, where, initial, read }: {
  detail: PhaseDetail;
  where: Where;
  initial?: string;
  read?: ReadArtifact;
}) {
  const tabs = tabsFor(detail);
  const [tab, setTab] = useState<Tab>(tabs.includes(initial as Tab) ? initial as Tab : tabs[0]);
  const shown = tabs.includes(tab) ? tab : tabs[0];
  return (
    <div>
      <Tabs label="Phase" selected={shown} onSelect={setTab} tabs={tabs.map((each) => ({
        id: each,
        label: <>{TABS[each]}{each === "transcript" && !detail.transcript.on ? <span className="font-normal text-muted"> · off</span>
          : each === "transcript" && detail.transcript.pruned ? <span className="font-normal text-muted"> · {prunedWord(detail.transcript.pruned.reason)}</span> : null}</>,
      }))} />
      <div className="grid gap-2 pt-3 text-sm" role="tabpanel">
        {shown === "artifacts" ? <Artifacts detail={detail} where={where} read={read} /> : null}
        {shown === "overview" ? <Overview detail={detail} /> : null}
        {shown === "checks" ? <Checks detail={detail} /> : null}
        {shown === "tools" ? <Tools detail={detail} /> : null}
        {shown === "transcript" ? <Transcript detail={detail} /> : null}
        {shown === "cost" ? <Cost detail={detail} /> : null}
        {shown === "events" ? <Events detail={detail} /> : null}
      </div>
    </div>
  );
}

// ── Artifacts ────────────────────────────────────────────────────────────────

function Artifacts({ detail, where, read }: { detail: PhaseDetail; where: Where; read?: ReadArtifact }) {
  return <>{detail.artifacts.map((artifact) => <ArtifactCard key={artifact.seq} artifact={artifact} where={where} read={read} />)}</>;
}

function ArtifactCard({ artifact, where, read }: { artifact: Artifact; where: Where; read?: ReadArtifact }) {
  const repo = artifact.location === "repo";
  const { committed, changedLater, rewritten } = artifact;
  const whereNow = !repo ? "shipped with the session"
    : committed ? <>committed by {committed.phase || "a later phase"} at <code>{committed.sha.slice(0, 7)}</code></>
    : rewritten ? "never committed" : "not committed yet";
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line bg-surface-2 px-3 py-1.5">
        <code>{artifact.path}</code>
        <span className="text-muted">{repo ? "in the repository" : artifact.role === "request" ? "handoff · the request" : "handoff"}</span>
        <span className="text-muted">· {formatBytes(artifact.size)} · {whereNow}</span>
        {repo && committed && where.forge ? (
          <a className="ml-auto" href={`${where.forge}/${where.factory}/blob/${committed.sha}/${artifact.path}`}>on the forge ↗</a>
        ) : null}
      </div>
      {changedLater ? (
        <div className={note}>
          Changed later in <code>{changedLater.sha.slice(0, 7)}</code>{changedLater.phase ? ` by ${changedLater.phase}` : ""}
          {" · "}
          {where.forge && committed
            ? <a href={`${where.forge}/${where.factory}/compare/${committed.sha}...${changedLater.sha}`}>compare</a>
            : "compare"}
        </div>
      ) : null}
      {!repo ? <HandoffFile artifact={artifact} />
        : rewritten ? (
          <p className={quiet}>
            {rewritten.phase || "A later phase"} wrote it again before anything committed it: this version never reached the forge.
          </p>
        ) : committed ? <RepoArtifact artifact={artifact} read={read} />
        : <p className={quiet}>A repository file is read from the forge at the commit after it, and none has been made yet.</p>}
    </div>
  );
}

function HandoffFile({ artifact }: { artifact: Artifact }) {
  if (artifact.pruned) {
    return <p className={quiet}>Not shown: its {formatPruned("content", artifact.pruned)} ({formatBytes(artifact.size)}).</p>;
  }
  if (artifact.truncated && artifact.content === "") {
    return <p className={quiet}>Not text: the factory did not send it ({formatBytes(artifact.size)}).</p>;
  }
  return (
    <>
      {artifact.truncated ? (
        <div className={note}>Cut at the factory&apos;s cap: the file was {formatBytes(artifact.size)}, and this is its start.</div>
      ) : null}
      <pre className={body}>{artifact.content}</pre>
    </>
  );
}

/** A repo file, read from the forge as its tab is shown, and never kept. */
function RepoArtifact({ artifact, read }: { artifact: Artifact; read?: ReadArtifact }) {
  const [got, setGot] = useState<Read | null>(null);
  useEffect(() => {
    let current = true;
    read?.(artifact.seq).then(
      (answer) => { if (current) setGot(answer); },
      (error: unknown) => { if (current) setGot({ ok: false, because: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [read, artifact.seq]);
  return <RepoFile artifact={artifact} got={got} />;
}

/** What reading a repo file from the forge gave, or null while it is being read. */
export function RepoFile({ artifact, got }: { artifact: Artifact; got: Read | null }) {
  const sha = artifact.committed?.sha.slice(0, 7) ?? "";
  if (got === null) return <p className={quiet}>Reading it from the forge at <code>{sha}</code>…</p>;
  if (!got.ok) return <p className={quiet}>Not read: {got.because}.</p>;
  return (
    <>
      {!got.matches ? (
        <div className={note}>Not byte for byte what this phase wrote: it was changed again before this commit.</div>
      ) : null}
      {got.truncated ? (
        <div className={note}>Cut at {formatBytes(READ_BYTES)}: the file is {formatBytes(artifact.size)}, and this is its start.</div>
      ) : null}
      {got.binary ? <p className={quiet}>Not text: nothing to show.</p> : <pre className={body}>{got.content}</pre>}
    </>
  );
}

// An artifact's body, a remark about it, and a line saying why there is none.
const body = "max-h-[32rem] overflow-auto px-3 py-2 text-xs leading-relaxed";
const note = "border-b border-line px-3 py-1.5 text-wait";
const quiet = "px-3 py-2 text-muted";

// ── Overview ─────────────────────────────────────────────────────────────────

function Overview({ detail }: { detail: PhaseDetail }) {
  const { envelope } = detail;
  return (
    <>
      <Facts>
        <dt>For</dt><dd>{detail.description || "—"}</dd>
        <dt>Run by</dt><dd>{detail.kind}{detail.owner ? ` · ${detail.owner}` : ""}</dd>
        <dt>Outcome</dt><dd>{detail.status || "—"}{detail.error ? <span className="text-bad"> — {detail.error}</span> : null}</dd>
        {detail.task ? <><dt>Instructions</dt><dd><code>{detail.task}</code>, and the journal as of this phase</dd></> : null}
        {detail.promptDigest ? <><dt>Prompt digest</dt><dd><code>{detail.promptDigest.slice(0, 16)}</code></dd></> : null}
      </Facts>
      {detail.commits.length ? (
        <>
          <h4 className="mt-2">Commits</h4>
          <ul className="grid gap-0.5">
            {detail.commits.map((commit) => (
              <li key={commit.sha}>
                <code>{commit.sha.slice(0, 7)}</code> {commit.message}
                <span className="text-muted"> · {commit.filesTotal} file{commit.filesTotal === 1 ? "" : "s"}: {commit.files.join(", ")}
                  {commit.filesTotal > commit.files.length ? ", …" : ""}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {detail.kind === "agent" ? (
        <>
          <h4 className="mt-2">Envelope · {envelope ? envelope.outputType : "none accepted"}</h4>
          {envelope ? (
            <>
              {envelope.attempt === 0 ? <p className="text-muted">Answered from the record on a resume: no agent ran.</p> : null}
              <Pre>{envelope.json}</Pre>
            </>
          ) : <p className="text-muted">The agent has not reported yet, or no report was accepted.</p>}
        </>
      ) : null}
    </>
  );
}

// ── Checks ───────────────────────────────────────────────────────────────────

function Checks({ detail }: { detail: PhaseDetail }) {
  const { checks, rejections, commands } = detail;
  if (!checks.length && !rejections.length && !commands.length) return <p className="text-muted">Nothing was checked here.</p>;
  // One timeline: what was refused, what the gates said, what ran — in the order it happened.
  const lines = [
    ...checks.map((check) => ({ seq: check.seq, node: (
      <div key={`g${check.seq}`}>
        <span className={check.passed ? "text-ok" : "text-bad"}>{check.passed ? "✓" : "✕"}</span> <b className="font-semibold">{check.gate}</b>{" "}
        <span className="text-muted">{check.replayed ? "on resume, checked against the record" : `attempt ${check.attempt}`}
          {" · "}{formatClock(check.at)}</span>
        {check.checks.length ? (
          <ul className="mt-0.5 grid gap-0.5 pl-5">
            {check.checks.map((each, index) => (
              <li key={index} className={each.ok ? undefined : "text-bad"}>{each.item}{each.note ? `: ${each.note}` : ""}</li>
            ))}
          </ul>
        ) : null}
        {check.violations.length && !check.passed ? <div className="text-bad">{check.violations.join("; ")}</div> : null}
      </div>
    ) })),
    ...rejections.map((rejection) => ({ seq: rejection.seq, node: (
      <div key={`r${rejection.seq}`}>
        <span className="text-bad">✕</span> <b className="font-semibold">{rejection.outputType}</b> refused, attempt {rejection.attempt}: {rejection.error}
        <span className="text-muted"> → re-prompted in the same session</span>
        {rejection.raw ? <details><summary className="text-muted">what the agent answered</summary><Pre className="mt-1">{rejection.raw}</Pre></details> : null}
      </div>
    ) })),
    ...commands.map((command) => ({ seq: command.seq, node: (
      <div key={`c${command.seq}`}>
        <span className={command.exitCode ? "text-bad" : "text-ok"}>{command.exitCode ? "✕" : "✓"}</span> <b className="font-semibold">{command.name}</b>{" "}
        <code>{command.argv.join(" ")}</code>
        <span className="text-muted"> · exit {command.exitCode} · {formatDuration(command.durationSeconds)}</span>
        {command.pruned ? <p className="text-muted">Its {formatPruned("output", command.pruned)}.</p>
          : command.outputTail ? <Pre className="mt-1">{command.outputTail}</Pre> : null}
      </div>
    ) })),
  ].sort((a, b) => a.seq - b.seq);
  return <>{lines.map((line) => line.node)}</>;
}

// ── Tools ────────────────────────────────────────────────────────────────────

function Tools({ detail }: { detail: PhaseDetail }) {
  const { tools } = detail;
  const failed = tools.filter((call) => !call.ok).length;
  const spent = tools.reduce((total, call) => total + call.durationMs, 0);
  return (
    <>
      {tools.length ? (
        <>
          <p>{tools.length} call{tools.length === 1 ? "" : "s"}{failed ? `, ${failed} failed` : ""}
            <span className="text-muted"> · {formatMs(spent)} in tools</span></p>
          <Table>
            <thead><tr><th>at</th><th>tool</th><th>outcome</th><th className={num}>took</th></tr></thead>
            <tbody>
              {tools.map((call) => (
                <tr key={call.seq}>
                  <td>{formatClock(call.at)}</td>
                  <td><code>{call.tool}</code></td>
                  <td className={call.ok ? undefined : "text-bad"}>{call.ok ? "✓ ok" : "✕ failed"}</td>
                  <td className={num}>{formatMs(call.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : <p className="text-muted">No tool calls.</p>}
      <p className={off}>
        A tool call travels as its name, whether it worked and how long it took. What a call was given and returned is
        transcript material{detail.transcript.on ? ", on the Transcript tab" : ", and this factory has not opted in"}.
      </p>
    </>
  );
}

const formatMs = (ms: number) => (ms < 1000 ? `${ms}ms` : formatDuration(ms / 1000));

// What a tab says of what it does not show, and why.
const off = "rounded-lg border border-dashed border-line-strong px-3 py-2 text-muted";

// ── Transcript ───────────────────────────────────────────────────────────────

function Transcript({ detail }: { detail: PhaseDetail }) {
  const { transcript } = detail;
  if (!transcript.on) {
    return (
      <>
        {detail.task ? (
          <p>The instructions were <code>{detail.task}</code> and the journal as of this phase
            {detail.promptDigest ? <>; the prompt&apos;s digest is <code>{detail.promptDigest.slice(0, 16)}</code></> : null}.</p>
        ) : null}
        <p className={off}>
          Transcripts are off for this factory: the session shipped no prompt and no harness output.{" "}
          <code>cockpit: {"{transcripts: true}"}</code> in <code>asf/factory.yaml</code> turns them on.
        </p>
      </>
    );
  }
  if (transcript.pruned) {
    return (
      <>
        <p className={off}>This {formatPruned("transcript", transcript.pruned)}: the prompts this phase sent and its
          harness&apos;s output are no longer kept.{transcript.pruned.reason === "aged_out"
            ? " A finished session's transcript is kept for as long as the cockpit's retention allows." : ""}</p>
        {detail.promptDigest ? <p className="text-muted">The prompt&apos;s digest was <code>{detail.promptDigest.slice(0, 16)}</code>.</p> : null}
      </>
    );
  }
  if (!transcript.runs.length) {
    return <p className="text-muted">Nothing was sent to this agent: a phase answered from the record sends no prompt.</p>;
  }
  return (
    <>
      {transcript.runs.map((run, index) => (
        <div key={index} className="grid gap-2">
          {transcript.runs.length > 1 ? <h4 className="mt-2">Run {index + 1} · {formatTime(run.at)}</h4> : null}
          {run.sends.map((send) => (
            <div key={send.seq} className="grid gap-1">
              <h4 className="mt-2">Prompt {send.send}{send.send > 1 ? " · a correction" : ""}
                {send.truncated ? <span className="normal-case"> · cut at the cap</span> : null}</h4>
              {send.system ? <details><summary className="text-muted">the agent&apos;s identity</summary><Pre className="mt-1">{send.system}</Pre></details> : null}
              <Pre>{send.prompt}</Pre>
            </div>
          ))}
          <h4 className="mt-2">Harness output</h4>
          {run.output ? <Pre>{run.output}</Pre> : <p className="text-muted">None yet.</p>}
        </div>
      ))}
    </>
  );
}

// ── Cost ─────────────────────────────────────────────────────────────────────

function Cost({ detail }: { detail: PhaseDetail }) {
  const { usage } = detail;
  if (!usage.length) return <p className="text-muted">No spend: no agent ran here, or none reported yet.</p>;
  const total = usage.reduce((sum, turn) => sum + turn.cost, 0);
  const tokens = usage.reduce((sum, turn) => sum + turn.tokens, 0);
  const last = [...usage].reverse().find((turn) => turn.contextWindow > 0);
  return (
    <>
      <p><b className="font-semibold">{formatCost(total)}</b> <span className="text-muted">· {formatTokens(tokens)} · list-price equivalent</span></p>
      <Table>
        <thead>
          <tr>
            <th>model</th><th className={num}>tokens</th><th className={num}>cost</th><th className={num}>input</th>
            <th className={num}>output</th><th className={num}>cache read</th><th className={num}>cache write</th>
            <th className={num}>reasoning</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((turn) => (
            <tr key={turn.seq}>
              <td>{turn.model || "—"}</td>
              <td className={num}>{formatTokenCount(turn.tokens)}</td>
              <td className={num}>{formatCost(turn.cost)}</td>
              <td className={num}>{formatTokenCount(turn.breakdown.inputTokens)}</td>
              <td className={num}>{formatTokenCount(turn.breakdown.outputTokens)}</td>
              <td className={num}>{formatTokenCount(turn.breakdown.cacheReadTokens)}</td>
              <td className={num}>{formatTokenCount(turn.breakdown.cacheWriteTokens)}</td>
              <td className={num}>{formatTokenCount(turn.breakdown.reasoningTokens)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <h4 className="mt-2">Context window</h4>
      {last ? (
        <div className="relative h-6 overflow-hidden rounded-md border border-line">
          <i className="absolute inset-y-0 left-0 bg-accent-soft" style={{ width: `${Math.min(100, (last.contextTokens / last.contextWindow) * 100)}%` }} />
          <span className="relative px-2 leading-6">{formatTokenCount(last.contextTokens)} of {formatTokens(last.contextWindow)} ·{" "}
            {Math.round((last.contextTokens / last.contextWindow) * 100)}%</span>
        </div>
      ) : <p className="text-muted">The harness did not say how full it was.</p>}
    </>
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

function Events({ detail }: { detail: PhaseDetail }) {
  return (
    <Table>
      <thead><tr><th className={num}>seq</th><th>kind</th><th>what happened</th><th>at</th></tr></thead>
      <tbody>
        {detail.events.map((row) => (
          <tr key={row.seq} className={row.unreadBecause ? "text-muted" : undefined}>
            <td className={num}>{row.seq}</td>
            <td><code>{row.kind}</code>{row.v > 1 || row.unreadBecause ? <span className="text-muted"> v{row.v}</span> : null}</td>
            <td>
              <details>
                <summary>{row.unreadBecause ? `${row.unreadBecause} — shown as sent` : row.detail}</summary>
                <Pre className="mt-1">{pretty(row.raw)}</Pre>
              </details>
            </td>
            <td>{formatClock(row.ts)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

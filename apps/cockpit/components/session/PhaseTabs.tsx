"use client";

import { useEffect, useState } from "react";
import type { Read } from "@/convex/artifacts";
import { type Artifact, type PhaseDetail, READ_BYTES } from "@/convex/model/phase";
import { prunedWord } from "@/convex/model/retention";
import { formatBytes, formatClock, formatCost, formatDuration, formatPruned, formatTime, pretty } from "../format";

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
    <div className="phase-tabs">
      <div className="tabs" role="tablist">
        {tabs.map((each) => (
          <button key={each} role="tab" aria-selected={each === shown} onClick={() => setTab(each)}>
            {TABS[each]}{each === "transcript" && !detail.transcript.on ? <span className="off"> · off</span>
              : each === "transcript" && detail.transcript.pruned ? <span className="off"> · {prunedWord(detail.transcript.pruned.reason)}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel" role="tabpanel">
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
    <div className="art">
      <div className="art-h">
        <code>{artifact.path}</code>
        <span className="muted">{repo ? "in the repository" : artifact.role === "request" ? "handoff · the request" : "handoff"}</span>
        <span className="muted">· {formatBytes(artifact.size)} · {whereNow}</span>
        <span className="grow" />
        {repo && committed && where.forge ? (
          <a href={`${where.forge}/${where.factory}/blob/${committed.sha}/${artifact.path}`}>on the forge ↗</a>
        ) : null}
      </div>
      {changedLater ? (
        <div className="art-n">
          Changed later in <code>{changedLater.sha.slice(0, 7)}</code>{changedLater.phase ? ` by ${changedLater.phase}` : ""}
          {" · "}
          {where.forge && committed
            ? <a href={`${where.forge}/${where.factory}/compare/${committed.sha}...${changedLater.sha}`}>compare</a>
            : "compare"}
        </div>
      ) : null}
      {!repo ? <HandoffFile artifact={artifact} />
        : rewritten ? (
          <p className="art-b muted">
            {rewritten.phase || "A later phase"} wrote it again before anything committed it: this version never reached the forge.
          </p>
        ) : committed ? <RepoArtifact artifact={artifact} read={read} />
        : <p className="art-b muted">A repository file is read from the forge at the commit after it, and none has been made yet.</p>}
    </div>
  );
}

function HandoffFile({ artifact }: { artifact: Artifact }) {
  if (artifact.pruned) {
    return <p className="art-b muted">Not shown: its {formatPruned("content", artifact.pruned)} ({formatBytes(artifact.size)}).</p>;
  }
  if (artifact.truncated && artifact.content === "") {
    return <p className="art-b muted">Not text: the factory did not send it ({formatBytes(artifact.size)}).</p>;
  }
  return (
    <>
      {artifact.truncated ? (
        <div className="art-n">Cut at the factory&apos;s cap: the file was {formatBytes(artifact.size)}, and this is its start.</div>
      ) : null}
      <pre className="art-b">{artifact.content}</pre>
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
  if (got === null) return <p className="art-b muted">Reading it from the forge at <code>{sha}</code>…</p>;
  if (!got.ok) return <p className="art-b muted">Not read: {got.because}.</p>;
  return (
    <>
      {!got.matches ? (
        <div className="art-n">Not byte for byte what this phase wrote: it was changed again before this commit.</div>
      ) : null}
      {got.truncated ? (
        <div className="art-n">Cut at {formatBytes(READ_BYTES)}: the file is {formatBytes(artifact.size)}, and this is its start.</div>
      ) : null}
      {got.binary ? <p className="art-b muted">Not text: nothing to show.</p> : <pre className="art-b">{got.content}</pre>}
    </>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────

function Overview({ detail }: { detail: PhaseDetail }) {
  const { envelope } = detail;
  return (
    <>
      <dl className="kv">
        <dt>For</dt><dd>{detail.description || "—"}</dd>
        <dt>Run by</dt><dd>{detail.kind}{detail.owner ? ` · ${detail.owner}` : ""}</dd>
        <dt>Outcome</dt><dd>{detail.status || "—"}{detail.error ? <span className="error"> — {detail.error}</span> : null}</dd>
        {detail.task ? <><dt>Instructions</dt><dd><code>{detail.task}</code>, and the journal as of this phase</dd></> : null}
        {detail.promptDigest ? <><dt>Prompt digest</dt><dd><code>{detail.promptDigest.slice(0, 16)}</code></dd></> : null}
      </dl>
      {detail.commits.length ? (
        <>
          <h4>Commits</h4>
          <ul className="plain">
            {detail.commits.map((commit) => (
              <li key={commit.sha}>
                <code>{commit.sha.slice(0, 7)}</code> {commit.message}
                <span className="muted"> · {commit.filesTotal} file{commit.filesTotal === 1 ? "" : "s"}: {commit.files.join(", ")}
                  {commit.filesTotal > commit.files.length ? ", …" : ""}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {detail.kind === "agent" ? (
        <>
          <h4>Envelope · {envelope ? envelope.outputType : "none accepted"}</h4>
          {envelope ? (
            <>
              {envelope.attempt === 0 ? <p className="muted small">Answered from the record on a resume: no agent ran.</p> : null}
              <pre>{envelope.json}</pre>
            </>
          ) : <p className="muted">The agent has not reported yet, or no report was accepted.</p>}
        </>
      ) : null}
    </>
  );
}

// ── Checks ───────────────────────────────────────────────────────────────────

function Checks({ detail }: { detail: PhaseDetail }) {
  const { checks, rejections, commands } = detail;
  if (!checks.length && !rejections.length && !commands.length) return <p className="muted">Nothing was checked here.</p>;
  // One timeline: what was refused, what the gates said, what ran — in the order it happened.
  const lines = [
    ...checks.map((check) => ({ seq: check.seq, node: (
      <div className="check" key={`g${check.seq}`}>
        <span className={check.passed ? "ok" : "error"}>{check.passed ? "✓" : "✕"}</span> <b>{check.gate}</b>{" "}
        <span className="muted">{check.replayed ? "on resume, checked against the record" : `attempt ${check.attempt}`}</span>
        {check.checks.length ? (
          <ul className="plain">
            {check.checks.map((each, index) => (
              <li key={index} className={each.ok ? undefined : "error"}>{each.item}{each.note ? `: ${each.note}` : ""}</li>
            ))}
          </ul>
        ) : null}
        {check.violations.length && !check.passed ? <div className="error small">{check.violations.join("; ")}</div> : null}
      </div>
    ) })),
    ...rejections.map((rejection) => ({ seq: rejection.seq, node: (
      <div className="check" key={`r${rejection.seq}`}>
        <span className="error">✕</span> <b>{rejection.outputType}</b> refused, attempt {rejection.attempt}: {rejection.error}
        <span className="muted"> → re-prompted in the same session</span>
        {rejection.raw ? <details><summary className="muted small">what the agent answered</summary><pre>{rejection.raw}</pre></details> : null}
      </div>
    ) })),
    ...commands.map((command) => ({ seq: command.seq, node: (
      <div className="check" key={`c${command.seq}`}>
        <span className={command.exitCode ? "error" : "ok"}>{command.exitCode ? "✕" : "✓"}</span> <b>{command.name}</b>{" "}
        <code>{command.argv.join(" ")}</code>
        <span className="muted"> · exit {command.exitCode} · {formatDuration(command.durationSeconds)}</span>
        {command.pruned ? <p className="muted small">Its {formatPruned("output", command.pruned)}.</p>
          : command.outputTail ? <pre>{command.outputTail}</pre> : null}
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
            <span className="muted"> · {formatMs(spent)} in tools</span></p>
          <table className="table compact">
            <thead><tr><th>at</th><th>tool</th><th>outcome</th><th className="num">took</th></tr></thead>
            <tbody>
              {tools.map((call) => (
                <tr key={call.seq}>
                  <td>{formatClock(call.at)}</td>
                  <td><code>{call.tool}</code></td>
                  <td className={call.ok ? undefined : "error"}>{call.ok ? "✓ ok" : "✕ failed"}</td>
                  <td className="num">{formatMs(call.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : <p className="muted">No tool calls.</p>}
      <p className="off-box">
        A tool call travels as its name, whether it worked and how long it took. What a call was given and returned is
        transcript material{detail.transcript.on ? ", on the Transcript tab" : ", and this factory has not opted in"}.
      </p>
    </>
  );
}

const formatMs = (ms: number) => (ms < 1000 ? `${ms}ms` : formatDuration(ms / 1000));

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
        <p className="off-box">
          Transcripts are off for this factory: the session shipped no prompt and no harness output.{" "}
          <code>cockpit: {"{transcripts: true}"}</code> in <code>asf/factory.yaml</code> turns them on.
        </p>
      </>
    );
  }
  if (transcript.pruned) {
    return (
      <>
        <p className="off-box">This {formatPruned("transcript", transcript.pruned)}: the prompts this phase sent and its
          harness&apos;s output are no longer kept.{transcript.pruned.reason === "aged_out"
            ? " A finished session's transcript is kept for as long as the cockpit's retention allows." : ""}</p>
        {detail.promptDigest ? <p className="muted small">The prompt&apos;s digest was <code>{detail.promptDigest.slice(0, 16)}</code>.</p> : null}
      </>
    );
  }
  if (!transcript.runs.length) {
    return <p className="muted">Nothing was sent to this agent: a phase answered from the record sends no prompt.</p>;
  }
  return (
    <>
      {transcript.runs.map((run, index) => (
        <div key={index} className="run">
          {transcript.runs.length > 1 ? <h4>Run {index + 1} · {formatTime(run.at)}</h4> : null}
          {run.sends.map((send) => (
            <div key={send.seq}>
              <h4>Prompt {send.send}{send.send > 1 ? " · a correction" : ""}
                {send.truncated ? <span className="muted"> · cut at the cap</span> : null}</h4>
              {send.system ? <details><summary className="muted small">the agent&apos;s identity</summary><pre>{send.system}</pre></details> : null}
              <pre>{send.prompt}</pre>
            </div>
          ))}
          <h4>Harness output</h4>
          {run.output ? <pre>{run.output}</pre> : <p className="muted">None yet.</p>}
        </div>
      ))}
    </>
  );
}

// ── Cost ─────────────────────────────────────────────────────────────────────

function Cost({ detail }: { detail: PhaseDetail }) {
  const { usage } = detail;
  if (!usage.length) return <p className="muted">No spend: no agent ran here, or none reported yet.</p>;
  const total = usage.reduce((sum, turn) => sum + turn.cost, 0);
  const tokens = usage.reduce((sum, turn) => sum + turn.tokens, 0);
  const last = [...usage].reverse().find((turn) => turn.contextWindow > 0);
  return (
    <>
      <p><b>{formatCost(total)}</b> <span className="muted">· {tokens.toLocaleString()} tokens · list-price equivalent</span></p>
      <table className="table compact">
        <thead>
          <tr>
            <th>model</th><th className="num">tokens</th><th className="num">cost</th><th className="num">input</th>
            <th className="num">output</th><th className="num">cache read</th><th className="num">cache write</th>
            <th className="num">reasoning</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((turn) => (
            <tr key={turn.seq}>
              <td>{turn.model || "—"}</td>
              <td className="num">{turn.tokens.toLocaleString()}</td>
              <td className="num">{formatCost(turn.cost)}</td>
              <td className="num">{turn.breakdown.inputTokens.toLocaleString()}</td>
              <td className="num">{turn.breakdown.outputTokens.toLocaleString()}</td>
              <td className="num">{turn.breakdown.cacheReadTokens.toLocaleString()}</td>
              <td className="num">{turn.breakdown.cacheWriteTokens.toLocaleString()}</td>
              <td className="num">{turn.breakdown.reasoningTokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Context window</h4>
      {last ? (
        <div className="meter">
          <i style={{ width: `${Math.min(100, (last.contextTokens / last.contextWindow) * 100)}%` }} />
          <span>{last.contextTokens.toLocaleString()} of {last.contextWindow.toLocaleString()} tokens ·{" "}
            {Math.round((last.contextTokens / last.contextWindow) * 100)}%</span>
        </div>
      ) : <p className="muted">The harness did not say how full it was.</p>}
    </>
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

function Events({ detail }: { detail: PhaseDetail }) {
  return (
    <table className="table events compact">
      <thead><tr><th className="num">seq</th><th>kind</th><th>what happened</th><th>at</th></tr></thead>
      <tbody>
        {detail.events.map((row) => (
          <tr key={row.seq} className={row.unreadBecause ? "generic" : undefined}>
            <td className="num">{row.seq}</td>
            <td><code>{row.kind}</code>{row.v > 1 || row.unreadBecause ? <span className="muted"> v{row.v}</span> : null}</td>
            <td>
              <details>
                <summary>{row.unreadBecause ? `${row.unreadBecause} — shown as sent` : row.detail}</summary>
                <pre>{pretty(row.raw)}</pre>
              </details>
            </td>
            <td>{formatClock(row.ts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

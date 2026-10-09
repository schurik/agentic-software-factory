"use client";

import { useEffect, useState } from "react";
import type { Read } from "@/convex/artifacts";
import { type Artifact, type PhaseDetail, READ_BYTES } from "@/convex/model/phase";
import { type Pruned, prunedWord } from "@/convex/model/retention";
import type { Phase } from "@/convex/model/graph";
import type { GateItem } from "@/convex/model/story";
import { ForgeDiff, type ReadDiff } from "../diff/DiffView";
import { isMarkdown, Markdown } from "../Markdown";
import { formatBytes, formatClock, formatDuration, formatPruned, formatTime, formatTokenCount, formatTokens, plural, pretty } from "../format";
import { cx, Facts, num, Pre, Table, TabPanel, Tabs } from "../ui";
import { useWho } from "../viewer";
import { channelWords } from "./words";

/** Which session a phase is of, and the forge's web origin its links go to ("" when unknown). */
export interface Where {
  factory: string;
  session: string;
  forge: string;
}

/** Read a repo artifact from the forge, by the seq of its `artifact_written` (`artifacts.read`). */
export type ReadArtifact = (seq: number) => Promise<Read>;

const TABS = {
  overview: "Overview", diff: "Diff", artifacts: "Artifacts", checks: "Checks", tools: "Tools", transcript: "Transcript", events: "Events",
} as const;

type Tab = keyof typeof TABS;

/**
 * The tabs a phase opens into, each only where it has something to show
 * (#110): an agent's tool calls and transcript, what was checked, what it
 * wrote, what it committed (#112). The Transcript tab stays on an agent whose factory keeps none, to
 * say so and why. What it cost is the drawer's header line, not a tab.
 */
export function tabsFor(detail: PhaseDetail): Tab[] {
  const tabs = Object.keys(TABS) as Tab[];
  return tabs.filter((tab) => {
    if (tab === "diff") return detail.commits.length > 0;
    if (tab === "artifacts") return detail.artifacts.length > 0;
    if (tab === "checks") return detail.checks.length + detail.rejections.length + detail.commands.length > 0;
    if (tab === "tools") return detail.kind === "agent" && detail.tools.length > 0;
    if (tab === "transcript") return detail.kind === "agent";
    return true;
  });
}

/**
 * A phase opened into its tabs, on Overview unless the address says another.
 * Pure: everything comes from `item` (the phase as the session's story tells
 * it), `detail` (the `sessions.phase` query) and `tab`; a repo file is read
 * through `read` (the `artifacts.read` action), and a commit's diff through
 * `readDiff` (`diffs.commit`), when its tab is shown.
 */
export function PhaseTabs({ item, detail, where, tab, onTab, read, readDiff }: {
  item: Phase;
  detail: PhaseDetail;
  where: Where;
  tab: string | null;
  onTab?: (tab: string) => void;
  read?: ReadArtifact;
  readDiff?: ReadDiff;
}) {
  const tabs = tabsFor(detail);
  const shown = tabs.includes(tab as Tab) ? tab as Tab : "overview";
  return (
    <Tabs label="Phase" selected={shown} onSelect={(next) => onTab?.(next)} tabs={tabs.map((each) => ({
      id: each,
      label: <>{TABS[each]}{each === "transcript" && !detail.transcript.on ? <span className="font-normal text-muted"> · off</span>
        : each === "transcript" && detail.transcript.pruned ? <span className="font-normal text-muted"> · {prunedWord(detail.transcript.pruned.reason)}</span> : null}</>,
    }))}>
      <TabPanel key={shown} value={shown} className="grid gap-2 pt-4 text-sm">
        {shown === "overview" ? <Overview item={item} detail={detail} where={where} /> : null}
        {shown === "diff" ? <CommitDiffs detail={detail} readDiff={readDiff} /> : null}
        {shown === "artifacts" ? <Artifacts detail={detail} where={where} read={read} /> : null}
        {shown === "checks" ? <Checks detail={detail} /> : null}
        {shown === "tools" ? <Tools detail={detail} /> : null}
        {shown === "transcript" ? <Transcript detail={detail} /> : null}
        {shown === "events" ? <Events detail={detail} /> : null}
      </TabPanel>
    </Tabs>
  );
}

// ── Diff ─────────────────────────────────────────────────────────────────────

/** What each commit the phase made changed, read from the forge at its sha: no diff travels in an event. */
function CommitDiffs({ detail, readDiff }: { detail: PhaseDetail; readDiff?: ReadDiff }) {
  return (
    <div className="flex flex-col gap-6">
      {detail.commits.map((commit) => (
        <ForgeDiff key={commit.sha} subject={commit.sha} read={readDiff}
                   title={<><code>{commit.sha.slice(0, 7)}</code> {commit.message}</>} />
      ))}
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
    return <p className={quiet}>Not shown: its <PrunedWords what={"content"} pruned={artifact.pruned} /> ({formatBytes(artifact.size)}).</p>;
  }
  if (artifact.truncated && artifact.content === "") {
    return <p className={quiet}>Not text: the factory did not send it ({formatBytes(artifact.size)}).</p>;
  }
  return (
    <>
      {artifact.truncated ? (
        <div className={note}>Cut at the factory&apos;s cap: the file was {formatBytes(artifact.size)}, and this is its start.</div>
      ) : null}
      <FileBody path={artifact.path} content={artifact.content} />
    </>
  );
}

/** A file's text: rendered when it is markdown, exactly as written otherwise. */
function FileBody({ path, content }: { path: string; content: string }) {
  return isMarkdown(path) ? <Markdown text={content} className="max-h-[32rem] overflow-auto px-4 py-3" /> : <pre className={body}>{content}</pre>;
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
      {got.binary ? <p className={quiet}>Not text: nothing to show.</p> : <FileBody path={artifact.path} content={got.content} />}
    </>
  );
}

/** What became of a pruned body, in words, with the viewer who purged it as "you". */
export function PrunedWords({ what, pruned }: { what: string; pruned: Pruned }) {
  const who = useWho();
  return <>{formatPruned(what, pruned, who)}</>;
}

// An artifact's body, a remark about it, and a line saying why there is none.
const body = "max-h-[32rem] overflow-auto px-3 py-2 text-xs leading-relaxed";
const note = "border-b border-line px-3 py-1.5 text-wait";
const quiet = "px-3 py-2 text-muted";

// ── Overview ─────────────────────────────────────────────────────────────────

/**
 * What the phase was for and what came of it: the summary it reported, the
 * error it ended on, what a person said at its gate, the flags an agent filed,
 * the command it ran with the end of its output, and the commit it made.
 */
function Overview({ item, detail, where }: { item: Phase; detail: PhaseDetail; where: Where }) {
  const { envelope } = detail;
  const error = (item.type === "gate" ? "" : item.error) || detail.error;
  return (
    <div className="flex flex-col gap-4">
      {detail.description ? <p className="text-muted">{detail.description}</p> : null}
      {item.type === "agent" && (item.summary || envelope) ? (
        <div>
          <div className="mb-1 font-mono text-xs text-faint">{item.outputType || envelope?.outputType}</div>
          {item.summary ? <p className="text-lg">{item.summary}</p> : null}
          {envelope ? (
            <details className="mt-1">
              <summary className="text-muted">the envelope as reported{envelope.attempt === 0 ? ", answered from the record on a resume" : ""}</summary>
              <Pre className="mt-1">{envelope.json}</Pre>
            </details>
          ) : null}
        </div>
      ) : detail.status === "running" ? <p className="text-lg text-muted">Still running.</p> : null}
      {error ? <div className="rounded-lg border border-bad/40 bg-bad-soft px-3 py-2 text-bad">{error}</div> : null}
      {item.type === "gate" ? <GateRemark gate={item} /> : null}
      {item.type === "agent" ? item.notes.map((note) => (
        <div key={`${note.kind}:${note.what}`} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <div className="mb-0.5 text-xs font-semibold tracking-wider text-muted uppercase">⚑ {note.kind}</div>
          <div><b className="font-medium">{note.what}</b>{note.insteadOf ? <span className="text-muted"> — instead of {note.insteadOf}</span> : null}</div>
          {note.because ? <div className="text-muted">because {note.because}</div> : null}
        </div>
      )) : null}
      {detail.commands.map((command) => (
        <div key={command.seq} className="overflow-hidden rounded-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-xs">
            <span className="text-faint">$</span><span className="min-w-0 truncate">{command.argv.join(" ")}</span><span className="grow" />
            <span className={command.exitCode ? "text-bad" : "text-ok"}>exit {command.exitCode}</span>
          </div>
          {command.pruned ? <p className={quiet}>Its <PrunedWords what={"output"} pruned={command.pruned} />.</p>
            : command.outputTail ? <pre className={body}>{command.outputTail}</pre> : null}
        </div>
      ))}
      {detail.task || detail.kind === "agent" ? (
        <Facts>
          {detail.task ? <><dt>Instructions</dt><dd><code>{detail.task}</code>, and the journal as of this phase</dd></> : null}
          {detail.kind === "agent" ? <><dt>Context window</dt><dd><ContextWindow usage={detail.usage} /></dd></> : null}
        </Facts>
      ) : null}
      {detail.commits.map((commit) => (
        <div key={commit.sha}>
          {where.forge ? <a href={`${where.forge}/${where.factory}/commit/${commit.sha}`}><code>{commit.sha.slice(0, 7)}</code></a>
            : <code>{commit.sha.slice(0, 7)}</code>} {commit.message}
          <div className="text-muted">{plural(commit.filesTotal, "file")}: {commit.files.join(", ")}{commit.filesTotal > commit.files.length ? ", …" : ""}</div>
        </div>
      ))}
    </div>
  );
}

/** How full the agent's context window got, as its harness last said: the one thing the header line's tokens do not tell. */
function ContextWindow({ usage }: { usage: PhaseDetail["usage"] }) {
  const last = [...usage].reverse().find((turn) => turn.contextWindow > 0);
  if (!last) return <span className="text-muted">the harness did not say how full it was</span>;
  const share = last.contextTokens / last.contextWindow;
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
      {formatTokenCount(last.contextTokens)} of {formatTokens(last.contextWindow)} · {Math.round(share * 100)}%
    </span>
  );
}

/** What a person said at a gate: the verdict, where, and the note the next agent reads as an instruction. */
function GateRemark({ gate }: { gate: GateItem }) {
  const who = useWho();
  const { decision } = gate;
  if (!decision) {
    return (
      <p className="text-muted">
        {gate.status === "waiting" || gate.status === "open" ? "Waiting for an answer" : `Passed: ${gate.status}`} on{" "}
        {channelWords(gate.channel, gate.issueNumber)}.
      </p>
    );
  }
  const rejected = gate.status === "rejected" || gate.status === "aborted";
  return (
    <div className={cx("rounded-lg border px-3 py-2.5", rejected ? "border-bad/40 bg-bad-soft" : "border-ok/30 bg-ok-soft")}>
      <div><b className="font-semibold">{gate.status[0].toUpperCase() + gate.status.slice(1)}</b> by {who(decision.by)} · via{" "}
        {channelWords(decision.channel, gate.issueNumber)}</div>
      {decision.notes ? (
        <>
          <div className="mt-1 text-base">✎ “{decision.notes}”</div>
          <div className="mt-1 text-xs text-muted">An instruction: the next agent reads it, and it wins over what an agent reported.</div>
        </>
      ) : null}
    </div>
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
        <p className={off}>This <PrunedWords what={"transcript"} pruned={transcript.pruned} />: the prompts this phase sent and its
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

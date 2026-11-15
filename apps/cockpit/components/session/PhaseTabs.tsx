"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { Read } from "@/convex/artifacts";
import {
  type Artifact, joined, type Output, type PhaseDetail, type Prompts, READ_BYTES, runsOf, type ToolCall,
} from "@/convex/model/phase";
import type { Pruned } from "@/convex/model/retention";
import type { Phase } from "@/convex/model/graph";
import type { Row } from "@/convex/model/session";
import type { GateItem } from "@/convex/model/story";
import { ForgeDiff, type ReadDiff } from "../diff/DiffView";
import { isMarkdown, Markdown } from "../Markdown";
import { formatBytes, formatClock, formatDuration, formatPruned, formatTime, formatTokenCount, formatTokens, plural, pretty } from "../format";
import { cx, Facts, num, Pre, Table, TabPanel, Tabs } from "../ui";
import { useWho } from "../viewer";
import { channelWords, earlierWords, stoppedMark, stoppedWords } from "./words";

/** Which session a phase is of, and the forge's web origin its links go to ("" when unknown). */
export interface Where {
  factory: string;
  session: string;
  forge: string;
}

/** Read a repo artifact from the forge, by the seq of its `artifact_written` (`artifacts.read`). */
export type ReadArtifact = (seq: number) => Promise<Read>;

export const TABS = {
  overview: "Overview", diff: "Diff", artifacts: "Artifacts", checks: "Checks", tools: "Tools",
  prompt: "Agent prompt", output: "Harness output", events: "Events",
} as const;

export type Tab = keyof typeof TABS;

/**
 * The tabs a phase opens into, each only where it has something to show
 * (#110): an agent's tool calls, the prompts it was sent and its harness's
 * output, what was checked, what it wrote, what it committed (#112). An
 * agent's transcript tabs stay on when its factory keeps none, to say so and
 * why. What it cost is the drawer's header line, not a tab.
 */
export function tabsFor(detail: PhaseDetail): Tab[] {
  const tabs = Object.keys(TABS) as Tab[];
  return tabs.filter((tab) => {
    if (tab === "diff") return detail.commits.length > 0;
    if (tab === "artifacts") return detail.artifacts.length > 0;
    if (tab === "checks") return detail.checks.length + detail.rejections.length + detail.commands.length > 0;
    if (tab === "tools") return detail.kind === "agent" && detail.toolCalls > 0;
    if (tab === "prompt" || tab === "output") return detail.kind === "agent";
    return true;
  });
}

/** The tab an address asks for: a link from before the transcript had two tabs opens on its prompts. */
export function askedTab(tab: string | null): string | null {
  return tab === "transcript" ? "prompt" : tab;
}

/**
 * What the tabs that read on their own were given (#275): each is its own
 * query, asked for only while its tab is shown (`PhaseDetails`), and undefined
 * until it answers.
 */
export interface Loaded {
  tools?: ToolCall[];
  events?: Row[];
  prompt?: Prompts;
  output?: Output;
}

/**
 * A phase opened into its tabs, on Overview unless the address says another.
 * Pure: everything comes from `item` (the phase as the session's story tells
 * it), `detail` (the `sessions.phase` query), `loaded` (the shown tab's own
 * query, for the tabs that have one) and `tab`; a repo file is read through
 * `read` (the `artifacts.read` action), and a commit's diff through `readDiff`
 * (`diffs.commit`), when its tab is shown.
 */
export function PhaseTabs({ item, detail, loaded = {}, where, tab, onTab, read, readDiff }: {
  item: Phase;
  detail: PhaseDetail;
  loaded?: Loaded;
  where: Where;
  tab: string | null;
  onTab?: (tab: string) => void;
  read?: ReadArtifact;
  readDiff?: ReadDiff;
}) {
  const tabs = tabsFor(detail);
  const asked = askedTab(tab);
  const shown = tabs.includes(asked as Tab) ? asked as Tab : "overview";
  return (
    <Tabs label="Phase" selected={shown} onSelect={(next) => onTab?.(next)} tabs={tabs.map((each) => ({
      id: each,
      label: <>{TABS[each]}{(each === "prompt" || each === "output") && !detail.transcripts
        ? <span className="font-normal text-muted"> · off</span> : null}</>,
    }))}>
      <TabPanel key={shown} value={shown} className="grid gap-2 pt-4 text-sm">
        {shown === "overview" ? <Overview item={item} detail={detail} where={where} /> : null}
        {shown === "diff" ? <CommitDiffs detail={detail} readDiff={readDiff} /> : null}
        {shown === "artifacts" ? <Artifacts detail={detail} where={where} read={read} /> : null}
        {shown === "checks" ? <Checks detail={detail} /> : null}
        {shown === "tools" ? <Loading of={loaded.tools}>{(tools) => <Tools tools={tools} detail={detail} />}</Loading> : null}
        {shown === "prompt" ? (
          !detail.transcripts ? <TranscriptOff detail={detail} />
            : <Loading of={loaded.prompt}>{(prompts) => <AgentPrompt detail={detail} prompts={prompts} />}</Loading>
        ) : null}
        {shown === "output" ? (
          !detail.transcripts ? <TranscriptOff detail={detail} />
            : <Loading of={loaded.output}>{(output) => <HarnessOutput detail={detail} output={output} />}</Loading>
        ) : null}
        {shown === "events" ? <Loading of={loaded.events}>{(rows) => <Events rows={rows} />}</Loading> : null}
      </TabPanel>
    </Tabs>
  );
}

/** A tab whose query has not answered yet says so; once it has, it shows what came. */
function Loading<T>({ of, children }: { of: T | undefined; children: (got: T) => ReactNode }) {
  return of === undefined ? <p className="text-muted">Loading…</p> : <>{children(of)}</>;
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
  // A limit or a rollback is told as the fact it is; the error's prose stays one click away.
  const stopped = item.type === "agent" ? stoppedWords(item) : "";
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
      {stopped && item.type === "agent" ? (
        <div className="rounded-lg border border-bad/40 bg-bad-soft px-3 py-2 text-bad">
          {stoppedMark(item)} {stopped}
          {error ? (
            <details className="mt-1 text-sm">
              <summary>the phase&apos;s error</summary>
              <Pre className="mt-1">{error}</Pre>
            </details>
          ) : null}
        </div>
      ) : error ? <div className="rounded-lg border border-bad/40 bg-bad-soft px-3 py-2 text-bad">{error}</div> : null}
      {item.type === "agent" && item.earlier.length ? (
        <ul className="text-muted">
          {item.earlier.map((stop) => <li key={stop.seq}>{stoppedMark(stop)} {earlierWords(stop)}</li>)}
        </ul>
      ) : null}
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

function Tools({ tools, detail }: { tools: ToolCall[]; detail: PhaseDetail }) {
  const rows = toolRows(tools);
  const failed = tools.filter((call) => !call.ok).length;
  const bySubagents = tools.filter((call) => call.parentCallId).length;
  // The agent's own calls only: a subagent's time is already inside the call that ran it.
  const spent = tools.filter((call) => !call.parentCallId).reduce((total, call) => total + call.durationMs, 0);
  return (
    <>
      {tools.length ? (
        <>
          <p>{tools.length} call{tools.length === 1 ? "" : "s"}{failed ? `, ${failed} failed` : ""}
            {bySubagents ? `, ${bySubagents} by subagents` : ""}
            <span className="text-muted"> · {formatMs(spent)} in tools</span></p>
          <Table>
            <thead><tr><th>at</th><th>tool</th><th>outcome</th><th className={num}>took</th></tr></thead>
            <tbody>
              {rows.map(({ call, depth, made }) => (
                <tr key={call.seq}>
                  <td>{formatClock(call.at)}</td>
                  <td>
                    {depth ? <span className="text-muted" style={{ marginLeft: `${depth - 1}em` }}>↳ </span> : null}
                    <code>{call.tool}</code>
                    {made ? <span className="text-muted"> · its subagent made {plural(made, "call")}</span> : null}
                  </td>
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
        transcript material{detail.transcripts ? ", on the Harness output tab" : ", and this factory has not opted in"}.
      </p>
    </>
  );
}

/**
 * The calls as the tab lists them: the agent's own in order, each followed by its subagent's, one step in. A
 * subagent's calls come first on the wire — a call is sent when it returns, and the one that spawned them returns
 * last — so they are moved under it. One whose spawning call never returned stays where it came, marked as a
 * subagent's.
 */
export function toolRows(tools: ToolCall[]): { call: ToolCall; depth: number; made: number }[] {
  const ids = new Set(tools.map((call) => call.callId).filter(Boolean));
  const under = new Map<string, ToolCall[]>();
  for (const call of tools) {
    if (call.parentCallId && ids.has(call.parentCallId)) {
      under.set(call.parentCallId, [...(under.get(call.parentCallId) ?? []), call]);
    }
  }
  const rows: { call: ToolCall; depth: number; made: number }[] = [];
  const place = (call: ToolCall, depth: number) => {
    const made = call.callId ? under.get(call.callId) ?? [] : [];
    rows.push({ call, depth, made: made.length });
    for (const child of made) place(child, depth + 1);
  };
  for (const call of tools) {
    if (call.parentCallId && ids.has(call.parentCallId)) continue;
    place(call, call.parentCallId ? 1 : 0);
  }
  return rows;
}

const formatMs = (ms: number) => (ms < 1000 ? `${ms}ms` : formatDuration(ms / 1000));

// What a tab says of what it does not show, and why.
const off = "rounded-lg border border-dashed border-line-strong px-3 py-2 text-muted";

// ── Agent prompt · Harness output ───────────────────────────────────────────

/** Either transcript tab, for a factory that keeps none: what is known of the prompt without one, and how to turn them on. */
function TranscriptOff({ detail }: { detail: PhaseDetail }) {
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

/** Either transcript tab, once its part was pruned: the events are still here, and their bodies are not. */
function TranscriptPruned({ detail, pruned }: { detail: PhaseDetail; pruned: Pruned }) {
  return (
    <>
      <p className={off}>This <PrunedWords what={"transcript"} pruned={pruned} />: the prompts this phase sent and its
        harness&apos;s output are no longer kept.{pruned.reason === "aged_out"
          ? " A finished session's transcript is kept for as long as the cockpit's retention allows." : ""}</p>
      {detail.promptDigest ? <p className="text-muted">The prompt&apos;s digest was <code>{detail.promptDigest.slice(0, 16)}</code>.</p> : null}
    </>
  );
}

/** What the phase sent its agent, walk by walk: the task first, then each correction, with the agent's identity on the first. */
function AgentPrompt({ detail, prompts }: { detail: PhaseDetail; prompts: Prompts }) {
  if (prompts.pruned) return <TranscriptPruned detail={detail} pruned={prompts.pruned} />;
  const runs = runsOf(detail.walks, prompts.items);
  if (!runs.length) {
    return <p className="text-muted">Nothing was sent to this agent: a phase answered from the record sends no prompt.</p>;
  }
  return (
    <>
      {runs.map((run, index) => (
        <div key={index} className="grid gap-2">
          {runs.length > 1 ? <h4 className="mt-2">Run {index + 1} · {formatTime(run.at)}</h4> : null}
          {run.items.map((send) => (
            <div key={send.seq} className="grid gap-1">
              <h4 className="mt-2">Prompt {send.send}{send.send > 1 ? " · a correction" : ""}
                {send.truncated ? <span className="normal-case"> · cut at the cap</span> : null}</h4>
              {send.system ? <details><summary className="text-muted">the agent&apos;s identity</summary><Pre className="mt-1">{send.system}</Pre></details> : null}
              <Pre>{send.prompt}</Pre>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** The harness's raw stream, walk by walk, as the factory cut it into chunks and the cockpit joins them again. */
function HarnessOutput({ detail, output }: { detail: PhaseDetail; output: Output }) {
  if (output.pruned) return <TranscriptPruned detail={detail} pruned={output.pruned} />;
  const runs = runsOf(detail.walks, output.items);
  if (!runs.length) {
    return <p className="text-muted">{detail.status === "running" ? "None yet."
      : "No harness output: a phase answered from the record runs no harness."}</p>;
  }
  return (
    <>
      {runs.map((run, index) => (
        <div key={index} className="grid gap-2">
          {runs.length > 1 ? <h4 className="mt-2">Run {index + 1} · {formatTime(run.at)}</h4> : null}
          <Pre>{joined(run.items)}</Pre>
        </div>
      ))}
    </>
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

/** This phase's share of the session's events, read and unread alike. Its transcript is on the two tabs before. */
function Events({ rows }: { rows: Row[] }) {
  return (
    <Table>
      <thead><tr><th className={num}>seq</th><th>kind</th><th>what happened</th><th>at</th></tr></thead>
      <tbody>
        {rows.map((row) => (
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

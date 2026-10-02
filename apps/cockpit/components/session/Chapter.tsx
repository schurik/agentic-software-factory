import { useState } from "react";
import type {
  AgentItem, Asked, AutomaticItem, Chapter as ChapterData, CodeItem, GateItem, Item, ResumedItem,
} from "@/convex/model/story";
import { Status } from "../Status";
import { formatClock, formatCost, formatDuration, formatPruned } from "../format";
import { PhaseDetails } from "./PhaseDetails";
import type { Where } from "./PhaseTabs";
import { channelWords, pillOf, toneOf } from "./words";

export const phaseAnchor = (phaseId: string) => `phase-${phaseId}`;
export const chapterAnchor = (number: number) => `chapter-${number}`;

/** One chapter: what it was asked, then what happened, in order. */
export function Chapter({ chapter, where }: { chapter: ChapterData; where: Where }) {
  const { answering } = chapter;
  return (
    <section className="chapter" id={chapterAnchor(chapter.number)}>
      <header className="ch-head">
        <span className="ch-no">{chapter.number ? `Chapter ${chapter.number}` : "Chapter"}</span>
        <h2>{chapter.title}</h2>
        <span className="muted small">
          {answering ? <>answering <a href={answering.url}>{answering.kind === "issue" ? "issue" : "pull request"} #{answering.number}</a> · </> : null}
          {formatClock(chapter.startedAt)}
        </span>
        <span className="grow" />
        <Status status={chapter.status} />
        <span className="small">{formatCost(chapter.cost)}</span>
      </header>
      {chapter.reason ? <p className="error small">{chapter.reason}</p> : null}
      {chapter.asked ? <AskedCard asked={chapter.asked} /> : null}
      <ol className="timeline">
        {chapter.items.map((item) => <TimelineItem key={`${item.type}-${item.seq}`} item={item} where={where} />)}
      </ol>
    </section>
  );
}

function AskedCard({ asked }: { asked: Asked }) {
  return (
    <details className="asked">
      <summary>
        <span className="label">Asked</span> <code className="muted">{asked.path.split("/").pop()}</code>
        <span className="first">{firstLine(asked.content)}</span>
      </summary>
      {asked.pruned ? <p className="muted small">Its {formatPruned("content", asked.pruned)}.</p> : <pre>{asked.content}</pre>}
      {asked.truncated && !asked.pruned ? <p className="muted small">Cut at the factory&apos;s cap: the file was {asked.size} bytes.</p> : null}
    </details>
  );
}

/**
 * The one line that says what was asked: the last thing a reviewer wrote, or
 * the reporter's own first paragraph — never a heading or the factory's
 * framing comments around them.
 */
export function firstLine(content: string): string {
  const lines = content.split("\n").map((line) => line.trim());
  const quoted = lines.filter((line) => line.startsWith("> "));
  if (quoted.length) return quoted.at(-1)!.slice(2);
  const prose = (line: string) => line !== "" && !line.startsWith("#") && !line.startsWith("<!--");
  const start = lines.findIndex(prose);
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && !prose(line));
  return lines.slice(start, end === -1 ? undefined : end).join(" ");
}

function TimelineItem({ item, where }: { item: Item; where: Where }) {
  switch (item.type) {
    case "agent": return <AgentCard phase={item} where={where} />;
    case "code": return <CodeRow phase={item} where={where} />;
    case "gate": return <GateCard gate={item} />;
    case "automatic": return <AutomaticRow row={item} />;
    case "resumed": return <ResumedRow row={item} />;
  }
}

/**
 * Whether a phase is opened into its tabs, and on which: closed until asked,
 * so a page of thirty phases asks the backend for none of their detail.
 */
function useOpened(): [string | null, (tab: string | null) => void, React.ReactNode] {
  const [opened, open] = useState<string | null>(null);
  const toggle = (
    <button className="link small" aria-expanded={opened !== null} onClick={() => open(opened === null ? "" : null)}>
      {opened === null ? "details" : "hide"}
    </button>
  );
  return [opened, open, toggle];
}

function AgentCard({ phase, where }: { phase: AgentItem; where: Where }) {
  const [opened, open, toggle] = useOpened();
  return (
    <li className={`item agent tone-${toneOf(phase.status)}`} id={phaseAnchor(phase.phaseId)}>
      <span className="when">{formatClock(phase.at)}</span>
      <div className="box">
        <div className="head">
          <strong>{phase.name}</strong>
          <span className="muted small">{phase.owner}{phase.task ? <> · <code>{phase.task}</code></> : null}</span>
          {phase.replayed ? <span className="tag">replayed on resume</span> : null}
          <span className="grow" />
          <span className="meta">
            <span>{phase.toolCalls} tool call{phase.toolCalls === 1 ? "" : "s"}
              {phase.toolFailures ? `, ${phase.toolFailures} failed` : ""}</span>
            <span>{formatDuration(phase.duration)}</span>
            <span>{formatCost(phase.cost)}</span>
          </span>
          {toggle}
        </div>
        <div className="summary">
          {phase.outputType ? <><b>{phase.outputType}</b>{phase.summary ? ` · ${phase.summary}` : ""}</>
            : phase.status === "running" ? <span className="muted">working…</span> : <span className="muted">no envelope accepted</span>}
          {phase.corrections ? <> <span className="tag">{phase.corrections} correction{phase.corrections === 1 ? "" : "s"}</span></> : null}
        </div>
        {phase.changedFiles.length ? (
          <div className="files">{phase.changedFiles.length} file{phase.changedFiles.length === 1 ? "" : "s"} · {phase.changedFiles.join(" · ")}</div>
        ) : null}
        {phase.artifacts.length ? (
          <div className="chips">
            {phase.artifacts.map((chip) => (
              <button className="chip" key={chip.path} onClick={() => open("artifacts")}>
                <code>{chip.path.split("/").pop()}</code> <span className="muted">{chip.location === "repo" ? "repo" : "handoff"}</span>
              </button>
            ))}
          </div>
        ) : null}
        {phase.notes.map((note) => (
          <div className="note" key={`${note.kind}:${note.what}`}>
            <span className="label">⚑ {note.kind}</span>
            <span>
              {note.what}
              {note.insteadOf ? <span className="muted"> — instead of {note.insteadOf}</span> : null}
              {note.because ? <span className="muted"> — because {note.because}</span> : null}
            </span>
          </div>
        ))}
        {phase.error ? <div className="error small">{phase.error}</div> : null}
        {opened !== null ? (
          <div className="detail"><PhaseDetails phaseId={phase.phaseId} where={where} initial={opened || undefined} /></div>
        ) : null}
      </div>
    </li>
  );
}

function CodeRow({ phase, where }: { phase: CodeItem; where: Where }) {
  const [opened, , toggle] = useOpened();
  const failed = phase.commands.filter((command) => command.exitCode !== 0).at(-1);
  return (
    <li className={`item code tone-${toneOf(phase.status)}`} id={phaseAnchor(phase.phaseId)}>
      <span className="when">{formatClock(phase.at)}</span>
      <div className="row">
        <div className="step">
          <span className="name">{phase.name}</span>
          <span className="what">
            {phase.commits.map((commit) => (
              <span key={commit.sha}><code>{commit.sha.slice(0, 7)}</code> {commit.message}</span>
            ))}
            {phase.commands.map((command, index) => (
              <span key={index} className={command.exitCode ? "error" : undefined}>
                {command.exitCode ? "✕" : "✓"} <code>{command.name}</code>
              </span>
            ))}
            {!phase.commits.length && !phase.commands.length ? <span className="muted">{phase.description}</span> : null}
          </span>
          <span className="grow" />
          <span className="muted small">{formatDuration(phase.duration)}</span>
          {toggle}
        </div>
        {failed?.pruned ? <p className="muted small">Its {formatPruned("output", failed.pruned)}.</p>
          : failed?.outputTail ? <pre className="tail">{failed.outputTail}</pre> : null}
        {phase.error ? <div className="error small">{phase.error}</div> : null}
        {opened !== null ? (
          <div className="detail boxed"><PhaseDetails phaseId={phase.phaseId} where={where} /></div>
        ) : null}
      </div>
    </li>
  );
}

function GateCard({ gate }: { gate: GateItem }) {
  const { decision } = gate;
  const waited = decision ? (Date.parse(decision.decidedAt) - Date.parse(gate.at)) / 1000 : NaN;
  return (
    <li className={`item gate tone-${toneOf(gate.status)}`} id={phaseAnchor(gate.phaseId)}>
      <span className="when">{formatClock(gate.at)}</span>
      <div className="box">
        <div className="head">
          <strong>◐ {gate.gate || gate.name} {gate.kind === "questions" ? "questions" : "gate"} · round {gate.round || 1}</strong>
          <span className={`status status-${pillOf(gate.status)}`}>
            {decision ? `${gate.status} by ${decision.by}` : gate.status}
          </span>
        </div>
        <div className="small">
          {gate.channel ? <>Asked on {channelWords(gate.channel, gate.issueNumber)}</> : <>Asked</>}
          {gate.headSha ? <> · subject at <code>{gate.headSha.slice(0, 7)}</code></> : null}
          {gate.summary ? <span className="muted"> · {gate.summary}</span> : null}
        </div>
        {decision ? (
          <div className="small muted">
            Answered {formatClock(decision.decidedAt)} via {channelWords(decision.channel)}
            {Number.isFinite(waited) ? ` · waited ${formatDuration(Math.max(0, waited))}` : ""}
          </div>
        ) : null}
        {/* A person's words at a gate amend the request: they read as an instruction. */}
        {decision?.notes ? (
          <div className="remark"><span className="label">✎ instruction</span> {decision.notes}</div>
        ) : null}
        {gate.status === "waiting" ? (
          <div className="small muted">Answering happens in the inbox, not here.</div>
        ) : null}
      </div>
    </li>
  );
}

function AutomaticRow({ row }: { row: AutomaticItem }) {
  return (
    <li className="item automatic">
      <span className="when">{formatClock(row.at)}</span>
      <div className="step">
        <span className="tag">⚙ {row.gate} gate passed by policy · automatic, nobody was asked</span>
      </div>
    </li>
  );
}

function ResumedRow({ row }: { row: ResumedItem }) {
  const replayed = row.replayed.length === 0 ? "nothing replayed"
    : `${row.replayed.join(", ")} replayed from the record, not run again`;
  return (
    <li className="item resumed">
      <span className="when">{formatClock(row.at)}</span>
      <div className="step muted">▶ <b>Resumed</b> · {replayed}</div>
    </li>
  );
}

import { useState } from "react";
import type {
  AgentItem, Asked, AutomaticItem, Chapter as ChapterData, CodeItem, GateItem, Item, ResumedItem,
} from "@/convex/model/story";
import { formatClock, formatCost, formatDuration } from "../format";
import { Card, cx, LinkButton, Pre, StatusPill, Tag } from "../ui";
import { useWho } from "../viewer";
import { PhaseDetails } from "./PhaseDetails";
import { PrunedWords, type Where } from "./PhaseTabs";
import { channelWords, glyphOf, toneOf } from "./words";

export const phaseAnchor = (phaseId: string) => `phase-${phaseId}`;
export const chapterAnchor = (number: number) => `chapter-${number}`;

/** One chapter: what it was asked, then what happened, in order. */
export function Chapter({ chapter, where }: { chapter: ChapterData; where: Where }) {
  const { answering } = chapter;
  return (
    <section className="mt-8 scroll-mt-20" id={chapterAnchor(chapter.number)}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-medium tracking-wider text-muted uppercase">{chapter.number ? `Chapter ${chapter.number}` : "Chapter"}</span>
        <h2>{chapter.title}</h2>
        <span className="text-sm text-muted">
          {answering ? <>answering <a href={answering.url}>{answering.kind === "issue" ? "issue" : "pull request"} #{answering.number}</a> · </> : null}
          {formatClock(chapter.startedAt)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <StatusPill status={chapter.status} />
          <span className="text-sm tabular-nums">{formatCost(chapter.cost)}</span>
        </span>
      </header>
      {chapter.reason ? <p className="mt-1 text-sm text-bad">{chapter.reason}</p> : null}
      {chapter.asked ? <AskedCard asked={chapter.asked} reader={chapter.reader} where={where} /> : null}
      <ol className="mt-3 grid gap-2">
        {chapter.items.map((item) => <TimelineItem key={`${item.type}-${item.seq}`} item={item} where={where} />)}
      </ol>
    </section>
  );
}

/** What the chapter was asked, and the code phase that read it, which opens like any code row. */
function AskedCard({ asked, reader, where }: { asked: Asked; reader: CodeItem | null; where: Where }) {
  const [opened, , toggle] = useOpened();
  return (
    <Card className="mt-3 scroll-mt-20 border-l-[3px] border-l-accent px-3.5 py-2.5" id={reader ? phaseAnchor(reader.phaseId) : undefined}>
      <details>
        <summary>
          <span className="text-xs font-medium tracking-wider text-accent uppercase">Asked</span> <code className="text-muted">{asked.path.split("/").pop()}</code>
          <span className="mt-0.5 block">{firstLine(asked.content)}</span>
        </summary>
        {asked.pruned ? <p className="mt-2 text-sm text-muted">Its <PrunedWords what={"content"} pruned={asked.pruned} />.</p> : <Pre className="mt-2">{asked.content}</Pre>}
        {asked.truncated && !asked.pruned ? <p className="mt-1 text-sm text-muted">Cut at the factory&apos;s cap: the file was {asked.size} bytes.</p> : null}
      </details>
      {reader ? (
        <div className="mt-1.5 text-sm text-muted">
          {glyphOf(reader.status)} read by <b className="font-medium">{reader.name}</b>
          {" · "}{formatClock(reader.at)} · {formatDuration(reader.duration)} {toggle}
        </div>
      ) : null}
      {reader && opened !== null ? (
        <div className="mt-3 border-t border-line pt-3"><PhaseDetails phaseId={reader.phaseId} where={where} /></div>
      ) : null}
    </Card>
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
    <LinkButton className="text-sm" aria-expanded={opened !== null} onClick={() => open(opened === null ? "" : null)}>
      {opened === null ? "details" : "hide"}
    </LinkButton>
  );
  return [opened, open, toggle];
}

/** A phase's place on the timeline: its clock time in a gutter, then what happened. */
function Row({ at, id, children }: { at: string; id?: string; children: React.ReactNode }) {
  return (
    <li className="grid scroll-mt-20 grid-cols-[3rem_minmax(0,1fr)] gap-2 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3" id={id}>
      <span className="pt-2.5 text-right text-xs whitespace-nowrap text-muted tabular-nums">{formatClock(at)}</span>
      {children}
    </li>
  );
}

const EDGE: Record<string, string> = { ok: "border-l-ok", bad: "border-l-bad", wait: "border-l-wait", run: "border-l-accent" };

/** A phase's card, its left edge in the colour of how it went. */
function Box({ status, fallback = "border-l-line-strong", children }: { status: string; fallback?: string; children: React.ReactNode }) {
  return <Card className={cx("min-w-0 border-l-[3px] px-3.5 py-2.5", EDGE[toneOf(status)] ?? fallback)}>{children}</Card>;
}

function AgentCard({ phase, where }: { phase: AgentItem; where: Where }) {
  const [opened, open, toggle] = useOpened();
  return (
    <Row at={phase.at} id={phaseAnchor(phase.phaseId)}>
      <Box status={phase.status}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <strong className="font-semibold">{phase.name}</strong>
          <span className="text-sm text-muted">{phase.owner}{phase.task ? <> · <code>{phase.task}</code></> : null}</span>
          {phase.replayed ? <Tag>replayed on resume</Tag> : null}
          <span className="ml-auto hidden gap-3.5 text-sm whitespace-nowrap text-muted tabular-nums md:flex">
            <span>{phase.toolCalls} tool call{phase.toolCalls === 1 ? "" : "s"}
              {phase.toolFailures ? `, ${phase.toolFailures} failed` : ""}</span>
            <span>{formatDuration(phase.duration)}</span>
            <span>{formatCost(phase.cost)}</span>
          </span>
          {toggle}
        </div>
        <div className="mt-1">
          {phase.outputType ? <><b className="font-medium">{phase.outputType}</b>{phase.summary ? ` · ${phase.summary}` : ""}</>
            : phase.status === "running" ? <span className="text-muted">working…</span> : <span className="text-muted">no envelope accepted</span>}
          {phase.corrections ? <> <Tag tone="wait">{phase.corrections} correction{phase.corrections === 1 ? "" : "s"}</Tag></> : null}
        </div>
        {phase.changedFiles.length ? (
          <div className="mt-1 font-mono text-xs text-muted">{phase.changedFiles.length} file{phase.changedFiles.length === 1 ? "" : "s"} · {phase.changedFiles.join(" · ")}</div>
        ) : null}
        {phase.artifacts.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {phase.artifacts.map((chip) => (
              <button type="button" className="rounded-md border border-line px-1.5 text-sm hover:border-accent" key={chip.path} onClick={() => open("artifacts")}>
                <code>{chip.path.split("/").pop()}</code> <span className="text-muted">{chip.location === "repo" ? "repo" : "handoff"}</span>
              </button>
            ))}
          </div>
        ) : null}
        {phase.notes.map((note) => (
          <div className="mt-2 flex gap-2 rounded-md border border-dashed border-line-strong px-2 py-1 text-sm" key={`${note.kind}:${note.what}`}>
            <span className="pt-px text-xs font-semibold tracking-wide whitespace-nowrap uppercase">⚑ {note.kind}</span>
            <span>
              {note.what}
              {note.insteadOf ? <span className="text-muted"> — instead of {note.insteadOf}</span> : null}
              {note.because ? <span className="text-muted"> — because {note.because}</span> : null}
            </span>
          </div>
        ))}
        {phase.error ? <div className="mt-1 text-sm text-bad">{phase.error}</div> : null}
        {opened !== null ? (
          <div className="mt-3 border-t border-line pt-3"><PhaseDetails phaseId={phase.phaseId} where={where} initial={opened || undefined} /></div>
        ) : null}
      </Box>
    </Row>
  );
}

function CodeRow({ phase, where }: { phase: CodeItem; where: Where }) {
  const [opened, , toggle] = useOpened();
  const failed = phase.commands.filter((command) => command.exitCode !== 0).at(-1);
  return (
    <Row at={phase.at} id={phaseAnchor(phase.phaseId)}>
      <div className="min-w-0 px-1 pt-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-sm">
          <span className={cx("font-semibold", toneOf(phase.status) === "bad" && "text-bad")}>{phase.name}</span>
          <span className="flex min-w-0 flex-wrap gap-x-3">
            {phase.commits.map((commit) => (
              <span key={commit.sha}><code>{commit.sha.slice(0, 7)}</code> {commit.message}</span>
            ))}
            {phase.commands.map((command, index) => (
              <span key={index} className={command.exitCode ? "text-bad" : undefined}>
                {command.exitCode ? "✕" : "✓"} <code>{command.name}</code>
              </span>
            ))}
            {!phase.commits.length && !phase.commands.length ? <span className="text-muted">{phase.description}</span> : null}
          </span>
          <span className="ml-auto text-muted tabular-nums">{formatDuration(phase.duration)}</span>
          {toggle}
        </div>
        {failed?.pruned ? <p className="mt-1 text-sm text-muted">Its <PrunedWords what={"output"} pruned={failed.pruned} />.</p>
          : failed?.outputTail ? <Pre className="mt-1">{failed.outputTail}</Pre> : null}
        {phase.error ? <div className="mt-1 text-sm text-bad">{phase.error}</div> : null}
        {opened !== null ? (
          <Card className="mt-2 p-3.5"><PhaseDetails phaseId={phase.phaseId} where={where} /></Card>
        ) : null}
      </div>
    </Row>
  );
}

function GateCard({ gate }: { gate: GateItem }) {
  const who = useWho();
  const { decision } = gate;
  const waited = decision ? (Date.parse(decision.decidedAt) - Date.parse(gate.at)) / 1000 : NaN;
  return (
    <Row at={gate.at} id={phaseAnchor(gate.phaseId)}>
      <Box status={gate.status} fallback="border-l-wait">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <strong className="font-semibold">◐ {gate.gate || gate.name} {gate.kind === "questions" ? "questions" : "gate"} · round {gate.round || 1}</strong>
          <StatusPill status={gate.status}>{decision ? `${gate.status} by ${who(decision.by)}` : gate.status}</StatusPill>
        </div>
        <div className="mt-1 text-sm">
          {gate.channel ? <>Asked on {channelWords(gate.channel, gate.issueNumber)}</> : <>Asked</>}
          {gate.headSha ? <> · subject at <code>{gate.headSha.slice(0, 7)}</code></> : null}
          {gate.summary ? <span className="text-muted"> · {gate.summary}</span> : null}
        </div>
        {decision ? (
          <div className="text-sm text-muted">
            Answered {formatClock(decision.decidedAt)} via {channelWords(decision.channel)}
            {Number.isFinite(waited) ? ` · waited ${formatDuration(Math.max(0, waited))}` : ""}
          </div>
        ) : null}
        {/* A person's words at a gate amend the request: they read as an instruction. */}
        {decision?.notes ? (
          <div className="mt-2 flex gap-2 rounded-md border border-wait px-2 py-1 text-sm">
            <span className="pt-px text-xs font-semibold tracking-wide whitespace-nowrap text-wait uppercase">✎ instruction</span> {decision.notes}
          </div>
        ) : null}
        {gate.status === "waiting" ? (
          <div className="text-sm text-muted">Answering happens in the inbox, not here.</div>
        ) : null}
      </Box>
    </Row>
  );
}

function AutomaticRow({ row }: { row: AutomaticItem }) {
  return (
    <Row at={row.at}>
      <div className="px-1 pt-2 text-sm text-muted">⚙ <b className="font-semibold">{row.gate} gate</b> passed by policy · automatic, nobody was asked</div>
    </Row>
  );
}

function ResumedRow({ row }: { row: ResumedItem }) {
  const replayed = row.replayed.length === 0 ? "nothing replayed"
    : `${row.replayed.join(", ")} replayed from the record, not run again`;
  return (
    <Row at={row.at}>
      <div className="px-1 pt-2 text-sm text-muted">▶ <b className="font-semibold">Resumed</b> · {replayed}</div>
    </Row>
  );
}

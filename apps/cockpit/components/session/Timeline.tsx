"use client";

import type { ReactNode } from "react";
import { markOf, type Phase } from "@/convex/model/graph";
import type { Chapter, Item } from "@/convex/model/story";
import { formatClock, formatCost, formatDuration } from "../format";
import { KindIcon, StatusIcon } from "../icons";
import { cx, followInPlace } from "../ui";
import { useWho } from "../viewer";
import type { OpenPhase } from "../graph/StageGraph";
import { answeringWords, notAccepted, phaseName, stoppedMark, stoppedWords } from "./words";

/**
 * The session in order: every phase of every chapter, a row each — when, its
 * name for people, who ran it and what came of it (a summary, a commit, a
 * verdict), the remarks a person typed and the flags an agent filed, and how
 * long it took and what it cost. A row opens its phase in the drawer, and the
 * row of the phase the drawer has open is marked.
 */
export function Timeline({ chapters, opened, openPhase }: {
  chapters: Chapter[];
  /** The phase the drawer has open, if any. */
  opened: string | null;
  /** Following a row: it opens its phase. */
  openPhase: OpenPhase;
}) {
  return (
    <div className="grid gap-6">
      {chapters.map((chapter) => (
        <section key={chapter.number}>
          <h4 className="mb-2">
            {chapter.number ? `Chapter ${chapter.number} · ` : ""}{chapter.title}
            {chapter.answering ? ` · ${answeringWords(chapter.answering)}` : ""}
            {chapter.accepted === false ? <span className="text-bad"> · {notAccepted(chapter)}</span> : null}
          </h4>
          <ol className="grid">
            {[...(chapter.reader ? [chapter.reader] : []), ...chapter.items].map((item) => (
              <li key={`${item.type}-${item.seq}`}>
                <Line item={item} chapter={chapter} opened={opened} openPhase={openPhase} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

const ROW = "grid w-full grid-cols-[3rem_1rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-2 text-left md:grid-cols-[3.5rem_1rem_12rem_minmax(0,1fr)_auto]";

function Line({ item, chapter, opened, openPhase }: { item: Item; chapter: Chapter; opened: string | null; openPhase: OpenPhase }) {
  const who = useWho();
  if (item.type === "automatic") {
    return <Quiet at={item.at}>⚙ <b className="font-semibold">{item.gate} gate</b> passed by policy · automatic, nobody was asked</Quiet>;
  }
  if (item.type === "resumed") {
    const replayed = item.replayed.length === 0 ? "nothing replayed" : `${item.replayed.join(", ")} replayed from the record, not run again`;
    return <Quiet at={item.at}>▶ <b className="font-semibold">Resumed</b> · {replayed}</Quiet>;
  }
  const { href, onClick } = openPhase(item.phaseId);
  const open = item.phaseId === opened;
  const stopped = item.type === "agent" ? stoppedWords(item) : "";
  return (
    <a href={href} aria-current={open || undefined}
       onClick={followInPlace(onClick)}
       className={cx(ROW, "text-fg no-underline hover:bg-surface-2 hover:no-underline", open && "bg-surface-2")}>
      <span className="pt-px text-sm text-faint tabular-nums">{formatClock(item.at)}</span>
      <StatusIcon status={markOf(item)} className="mt-1" />
      <span className="flex min-w-0 items-center gap-1.5 font-medium"><span className="truncate">{phaseName(item)}</span><KindIcon type={item.type} /></span>
      <span className="col-start-3 min-w-0 text-sm text-muted md:col-start-auto">
        <span className="block">{said(item, chapter, who)}</span>
        {item.type === "gate" && item.decision?.notes ? (
          <span className="mt-0.5 block text-fg">✎ {who(item.decision.by)}: {item.decision.notes}</span>
        ) : null}
        {item.type === "agent" ? item.notes.map((note) => (
          <span key={`${note.kind}:${note.what}`} className="mt-0.5 block">⚑ {note.kind}: {note.what}</span>
        )) : null}
        {item.type === "agent" && stopped ? (
          <span className="mt-0.5 block text-bad">{stoppedMark(item)} {stopped}</span>
        ) : item.type !== "gate" && item.error ? <span className="mt-0.5 block text-bad">{item.error}</span> : null}
      </span>
      <span className="col-start-4 row-start-1 text-right text-sm text-faint tabular-nums md:col-start-5">
        {item.type === "gate" ? "" : formatDuration(item.duration)}
        {item.type === "agent" && item.cost ? <span className="block text-xs">{formatCost(item.cost)}</span> : null}
      </span>
    </a>
  );
}

/** Who ran a phase, and what came of it, in one line. */
export function said(phase: Phase, chapter: Chapter, who: (login: string) => string): string {
  if (phase.type === "gate") {
    return [phase.decision ? who(phase.decision.by) : "", phase.status].filter(Boolean).join(" — ");
  }
  const what = phase.type === "agent" ? phase.summary || phase.outputType
    : phase === chapter.reader && chapter.asked ? firstLine(chapter.asked.content)
    : phase.commits[0]?.message ?? (phase.commands.map((command) => `${command.exitCode ? "✕" : "✓"} ${command.name}`).join(" ") || phase.description);
  return [who(phase.owner), what].filter(Boolean).join(" — ");
}

function Quiet({ at, children }: { at: string; children: ReactNode }) {
  return (
    <div className={cx(ROW, "text-sm text-muted")}>
      <span className="pt-px text-faint tabular-nums">{formatClock(at)}</span>
      <span />
      <span className="col-span-2 md:col-span-3">{children}</span>
    </div>
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

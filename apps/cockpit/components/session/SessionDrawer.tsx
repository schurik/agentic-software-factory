"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { markOf, type Phase, type Stage } from "@/convex/model/graph";
import type { Chapter, Story } from "@/convex/model/story";
import { Drawer, DrawerFrame, type Go } from "../Drawer";
import { formatClock, formatCost, formatDuration, formatTokens, plural, secondsBetween } from "../format";
import { followInPlace } from "../graph/StageGraph";
import { KindIcon, StageIcon, StatusIcon } from "../icons";
import { StatusPill, Tag } from "../ui";
import { useWho } from "../viewer";
import type { Page } from "./SessionView";
import { back, closed, pushPhase, type Shown, writeShown } from "./shown";
import { said } from "./Timeline";
import { phaseName, stagePurpose } from "./words";

/**
 * The session page's drawer (#110): a stage's view — its phases, each one
 * click from its own view — and a phase's. Which one is open is the
 * address's (`Shown`), so a link opens exactly that drawer, and a phase
 * opened from a stage's view keeps the stage under it, for Back.
 */
export function SessionDrawer(props: DrawerProps) {
  const { page, shown, onShow } = props;
  // What the address opens, named: no name, nothing open — a link to a phase this session never had included.
  const label = labelOf(page.story, shown);
  return (
    <Drawer open={label !== ""} label={label} onClose={() => onShow?.(closed(shown))}>
      <DrawerView {...props} />
    </Drawer>
  );
}

export interface DrawerProps {
  page: Page;
  now: number;
  shown: Shown;
  /** Go to what the page shows next: the address a click sets. */
  onShow?: (shown: Shown) => void;
  /** A phase's tabs, as the page asks for them: its detail is a query of its own. */
  phase?: PhaseTabsOf;
}

/** A phase's tabs, `tab` showing; `onTab` goes to another. */
export type PhaseTabsOf = (item: Phase, tab: string | null, onTab: (tab: string) => void) => ReactNode;

/** What the drawer holds for the address, or null when nothing is open in it. Pure: a test renders it as is. */
export function DrawerView({ page, shown, onShow, phase }: DrawerProps): ReactNode {
  const go = (to: Shown): Go => ({ href: writeShown(to) || "?", onClick: () => onShow?.(to) });
  const stage = stageAt(page.story, shown.stage);
  const found = phaseAt(page.story, shown.phase);
  if (found) {
    return (
      <DrawerFrame icon={<KindIcon type={found.phase.type} className="size-4" />} title={phaseName(found.phase)}
                   what="phase" back={stage ? go(back(shown)) : null} close={go(closed(shown))}>
        <PhaseView page={page} found={found}>
          {phase?.(found.phase, shown.phaseTab, (tab) => onShow?.({ ...shown, phaseTab: tab }))}
        </PhaseView>
      </DrawerFrame>
    );
  }
  if (stage) {
    return (
      <DrawerFrame icon={<StageIcon name={stage.stage.name} size={16} className="text-muted" />} title={stage.stage.name}
                   what="stage" back={null} close={go(closed(shown))}>
        <StageView page={page} chapter={stage.chapter} stage={stage.stage} open={(phaseId) => go(pushPhase(shown, phaseId))} />
      </DrawerFrame>
    );
  }
  return null;
}

interface Found {
  chapter: Chapter;
  phase: Phase;
  /** The stage it is a phase of; null for the work item read, the report, or a chapter drawn without stages. */
  stage: Stage | null;
}

/** The phase the address names, in the chapter it is a phase of. */
function phaseAt(story: Story, phaseId: string | null): Found | null {
  if (!phaseId) return null;
  for (const chapter of story.chapters) {
    const phase = [...(chapter.reader ? [chapter.reader] : []), ...chapter.items]
      .find((item): item is Phase => "phaseId" in item && item.phaseId === phaseId);
    if (!phase) continue;
    const stage = chapter.graph.kind === "stages"
      ? chapter.graph.stages.find((each) => each.phases.includes(phase)) ?? null : null;
    return { chapter, phase, stage };
  }
  return null;
}

/** The stage the address names, as "chapter.stage", in the chapter it is a stage of. */
function stageAt(story: Story, key: string | null): { chapter: Chapter; stage: Stage } | null {
  if (!key) return null;
  const [number, index] = key.split(".").map(Number);
  const chapter = story.chapters.find((each) => each.number === number);
  const stage = chapter?.graph.kind === "stages" ? chapter.graph.stages[index] : undefined;
  return chapter && stage ? { chapter, stage } : null;
}

function labelOf(story: Story, shown: Shown): string {
  const found = phaseAt(story, shown.phase);
  const stage = stageAt(story, shown.stage);
  return found ? `${phaseName(found.phase)} phase` : stage ? `${stage.stage.name} stage` : "";
}

/**
 * Where a phase sits, and in one line who ran it, when, for how long, and —
 * for an agent — its tokens, cost and corrections, and whether a resume
 * answered it from the record. Then its tabs.
 */
function PhaseView({ page, found, children }: { page: Page; found: Found; children: ReactNode }) {
  const who = useWho();
  const { chapter, phase, stage } = found;
  const where = stage ? `${stage.name} stage` : phase === chapter.reader ? "the work item" : "the report";
  const mark = markOf(phase);
  const facts: ReactNode[] = [];
  if (phase.type === "agent") facts.push(["agent", phase.owner, phase.model].filter(Boolean).join(" · "));
  else if (phase.type === "gate") facts.push(phase.decision ? `person · ${who(phase.decision.by)}` : "person");
  else facts.push(["code", phase.owner].filter(Boolean).join(" · "));
  facts.push(formatClock(phase.at));
  if (phase.type !== "gate") {
    if (phase.duration !== null) facts.push(formatDuration(phase.duration));
  } else if (phase.decision) {
    const waited = secondsBetween(phase.at, Date.parse(phase.decision.decidedAt));
    if (waited !== null) facts.push(`waited ${formatDuration(waited)}`);
  }
  if (phase.type === "agent") {
    if (phase.tokens) facts.push(formatTokens(phase.tokens));
    if (phase.cost) facts.push(formatCost(phase.cost));
    if (phase.corrections) facts.push(plural(phase.corrections, "correction"));
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm text-muted">
          {page.factory} · <code>{page.session}</code> · chapter {chapter.number} · {where}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted tabular-nums">
          <StatusPill status={mark}>{mark}</StatusPill>
          {facts.filter(Boolean).map((fact, index) => <span key={index}>{fact}</span>)}
          {phase.type === "agent" && phase.replayed ? <Tag>replayed on resume</Tag> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

const STAGE_WORDS: Record<Stage["status"], string> = {
  done: "done", running: "running", waiting: "waiting", failed: "failed", pending: "not yet",
};

/** Where a stage sits, what it is for, and the phases it produced — each one click from its own view. */
function StageView({ page, chapter, stage, open }: {
  page: Page; chapter: Chapter; stage: Stage; open: (phaseId: string) => Go;
}) {
  const who = useWho();
  const stages = chapter.stages.length;
  const took = stage.phases.reduce((total, phase) => total + (phase.type === "gate" ? 0 : phase.duration ?? 0), 0);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm text-muted">
          {page.factory} · <code>{page.session}</code> · chapter {chapter.number} · {chapter.workflow} · stage {stage.index + 1} of {stages}
        </div>
        <div className="mt-2"><StatusPill status={stage.status}>{STAGE_WORDS[stage.status]}</StatusPill></div>
        {stagePurpose(stage.name) ? <p className="mt-2 text-sm text-muted">{stagePurpose(stage.name)}</p> : null}
      </div>
      {stage.phases.length ? (
        <div>
          <div className="mb-2 flex items-baseline gap-2 text-xs font-medium tracking-wider text-faint uppercase">
            {plural(stage.phases.length, "phase")}<span className="grow" />
            <span className="tracking-normal normal-case tabular-nums">{formatDuration(took)}</span>
          </div>
          <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {stage.phases.map((phase) => {
              const { href, onClick } = open(phase.phaseId);
              return (
                <li key={phase.phaseId}>
                  <a href={href} onClick={followInPlace(onClick)}
                     className="flex items-start gap-3 px-3 py-2.5 text-fg no-underline hover:bg-surface-2 hover:no-underline">
                    <StatusIcon status={markOf(phase)} className="mt-1" />
                    <span className="min-w-0 grow">
                      <span className="flex items-center gap-1.5 font-medium">{phaseName(phase)}<KindIcon type={phase.type} /></span>
                      <span className="block text-sm text-muted">{remarkOrSummary(phase, chapter, who)}</span>
                    </span>
                    <span className="shrink-0 text-sm text-faint tabular-nums">{phase.type === "gate" ? "" : formatDuration(phase.duration)}</span>
                    <ChevronRight size={14} aria-hidden="true" className="mt-1 shrink-0 text-faint" />
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
          Not reached yet in this chapter.
        </p>
      )}
    </div>
  );
}

/** A phase in one line: the remark a person typed at its gate, or else what came of it. */
function remarkOrSummary(phase: Phase, chapter: Chapter, who: (login: string) => string): string {
  if (phase.type === "gate" && phase.decision?.notes) return `✎ ${who(phase.decision.by)}: ${phase.decision.notes}`;
  return said(phase, chapter, who);
}

"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type Graph, lookOf, markOf, type Mini, type Phase, type Stage, type StageStatus } from "@/convex/model/graph";
import { formatDuration, plural } from "../format";
import { KindIcon, StageIcon, StatusIcon } from "../icons";
import { phaseName } from "../session/words";
import { cx, followInPlace, type Go } from "../ui";
import { useWho } from "../viewer";

/**
 * The stage graph (#104, the prototype's Cards look, round 9): a chapter as a
 * chain — a start pill, its stages as cards joined by connectors coloured by
 * progress, an end pill — and the phases each stage produced inside its card.
 * One component, for every page that draws a workflow: the session page's
 * chapters here, as `MiniGraph` one row of a list, and as `WorkflowGraph` a
 * workflow with no session behind it, on a factory's Workflows tab.
 *
 * Hand-built, with no graph library: a chapter is a straight chain, because
 * the stage vocabulary has no `if:` and no `loop:`. It never wraps: wider than
 * its box, it scrolls sideways, with arrows and faded edges, and keeps the
 * current stage in view. On a phone it is drawn top to bottom instead.
 *
 * A stage shows its phases when it is where the session is, failed, or had a
 * round rejected — where the detail matters — and folds to "N phases ›"
 * otherwise, one click (`onToggle`) from them. A stage's name opens its
 * drawer (`openStage`), and a phase opens its own (`openPhase`).
 */

/** Where opening a phase goes. */
export type OpenPhase = (phaseId: string) => Go;

/** Where opening a stage goes, by its index. */
export type OpenStage = (index: number) => Go;

export interface StageGraphProps {
  graph: Graph;
  /** The stages opened by hand, by index. */
  opened: number[];
  onToggle?: (index: number) => void;
  openPhase?: OpenPhase;
  openStage?: OpenStage;
}

/** Whether a stage shows its phases without being asked: the session is there, it failed there, or a round was rejected. */
export function opensItself(graph: Graph, stage: Stage): boolean {
  return graph.current === stage.index || stage.status === "failed" || stage.rejected > 0;
}

export function StageGraph({ graph, opened, onToggle, openPhase, openStage }: StageGraphProps) {
  const links: ReactNode[] = [];
  if (graph.kind === "phases") {
    graph.phases.forEach((phase, index) => {
      if (index) links.push(<Connector key={`c${index}`} done={markOf(phase) !== "pending"} />);
      links.push(<PhaseCard key={phase.phaseId} phase={phase} current={index === graph.current} openPhase={openPhase} />);
    });
    return <Chain focus={graph.current === null ? null : `[data-phase="${graph.phases[graph.current].phaseId}"]`}>{links}</Chain>;
  }
  links.push(<End key="start" phase={graph.start} label={graph.start ? phaseName(graph.start) : "prompt"} openPhase={openPhase} />);
  for (const stage of graph.stages) {
    links.push(<Connector key={`c${stage.index}`} done={stage.phases.length > 0} />);
    links.push(
      <StageCard key={stage.index} stage={stage} current={graph.current === stage.index} itself={opensItself(graph, stage)}
                 opened={opened.includes(stage.index)} onToggle={onToggle} openPhase={openPhase} openStage={openStage} />,
    );
  }
  links.push(<Connector key="cend" done={graph.end !== null} />);
  links.push(<End key="end" phase={graph.end} label="report" openPhase={openPhase} />);
  return <Chain focus={graph.current === null ? null : `[data-stage="${graph.current}"]`}>{links}</Chain>;
}

// ── the look ─────────────────────────────────────────────────────────────────
// White cards with a stronger border and a 3px status-coloured top edge, a
// light status wash over each card, the current one ringed; pending ones
// dashed and quiet. Written out whole: Tailwind only generates what it reads.

const EDGE: Record<StageStatus, string> = {
  done: "border-t-ok", running: "border-t-accent", waiting: "border-t-wait", failed: "border-t-bad", pending: "",
};
const WASH: Record<StageStatus, string> = {
  done: "bg-[color-mix(in_oklab,var(--ok)_5%,var(--surface))] dark:bg-[color-mix(in_oklab,var(--ok)_9%,var(--surface))]",
  running: "bg-[color-mix(in_oklab,var(--accent)_5%,var(--surface))] dark:bg-[color-mix(in_oklab,var(--accent)_10%,var(--surface))]",
  waiting: "bg-[color-mix(in_oklab,var(--wait)_7%,var(--surface))] dark:bg-[color-mix(in_oklab,var(--wait)_10%,var(--surface))]",
  failed: "bg-[color-mix(in_oklab,var(--bad)_5%,var(--surface))] dark:bg-[color-mix(in_oklab,var(--bad)_10%,var(--surface))]",
  pending: "",
};
const RING: Record<StageStatus, string> = {
  done: "", running: "ring-4 ring-accent-soft", waiting: "ring-4 ring-wait-soft", failed: "ring-4 ring-bad-soft", pending: "",
};
const NOW_TAB: Record<StageStatus, string> = {
  done: "bg-accent-strong text-accent-fg", running: "bg-accent-strong text-accent-fg", pending: "bg-accent-strong text-accent-fg",
  waiting: "bg-wait text-bg", failed: "bg-bad text-bg",
};
const PENDING = "border border-dashed border-line-strong border-t-[3px] bg-transparent";

function card(status: StageStatus, current: boolean): string {
  if (status === "pending") return PENDING;
  return cx("border border-line-strong border-t-[3px] shadow-card", WASH[status], EDGE[status], current && RING[status]);
}

function NowTab({ status }: { status: StageStatus }) {
  return (
    <span className={cx("absolute -top-2.5 left-2.5 z-10 rounded px-1.5 text-[10px] font-semibold tracking-wider uppercase", NOW_TAB[status])}>
      now
    </span>
  );
}

function StageCard({ stage, current, itself, opened, onToggle, openPhase, openStage }: {
  stage: Stage; current: boolean; itself: boolean; opened: boolean;
  onToggle?: (index: number) => void; openPhase?: OpenPhase; openStage?: OpenStage;
}) {
  const open = (itself || opened) && stage.phases.length > 0;
  const heading = cx("flex items-center gap-1.5 px-2.5 pt-2.5 pb-1", openStage && "group/stage rounded-t-lg text-fg no-underline hover:no-underline");
  const go = openStage?.(stage.index);
  return (
    <div data-stage={stage.index}
         className={cx("relative flex w-full shrink-0 flex-col rounded-lg", card(stage.status, current), open ? "md:w-56" : "md:w-auto")}>
      {current ? <NowTab status={stage.status} /> : null}
      <Heading go={go} className={heading}>
        <StatusIcon status={stage.status} />
        <StageIcon name={stage.name} className="text-faint" />
        <span className={cx("text-base font-semibold whitespace-nowrap group-hover/stage:underline", stage.status === "pending" && "font-medium text-faint")}>{stage.name}</span>
        {stage.rejected ? (
          <span title={`${plural(stage.rejected, "round")} rejected`} className="rounded bg-bad-soft px-1 text-[10px] font-semibold whitespace-nowrap text-bad">
            ↺ {stage.rejected}
          </span>
        ) : null}
      </Heading>
      {!stage.phases.length ? <span className="pb-1.5" />
        : open ? (
          <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
            {stage.phases.map((phase) => <PhaseRow key={phase.phaseId} phase={phase} openPhase={openPhase} />)}
            {!itself && onToggle ? (
              <button type="button" onClick={() => onToggle(stage.index)} className="px-2 py-1 text-left text-xs text-faint hover:text-fg">collapse</button>
            ) : null}
          </div>
        ) : (
          <button type="button" disabled={!onToggle} onClick={() => onToggle?.(stage.index)}
                  className="flex items-center gap-1 px-2.5 pb-2.5 text-xs whitespace-nowrap text-muted hover:text-fg">
            {plural(stage.phases.length, "phase")} ›
          </button>
        )}
    </div>
  );
}

/** A stage card's name line: the link to its drawer, where there is one. */
function Heading({ go, className, children }: { go?: Go; className: string; children: ReactNode }) {
  if (!go) return <div className={className}>{children}</div>;
  return <a href={go.href} onClick={followInPlace(go.onClick)} className={className}>{children}</a>;
}

/** What a phase's row says after its name: who decided a gate, that it waits or runs, or how long it took. */
function usePhaseMeta(): (phase: Phase) => string {
  const who = useWho();
  return (phase) => {
    const mark = markOf(phase);
    if (phase.type === "gate" && phase.decision) return `${phase.status} by ${who(phase.decision.by)}`;
    if (mark === "waiting" || mark === "running" || mark === "failed" || mark === "pending") return mark;
    return phase.type === "gate" ? phase.status : formatDuration(phase.duration);
  };
}

/** A link that opens a phase: an address a person can share, followed in place. */
function PhaseLink({ phaseId, openPhase, className, children }: {
  phaseId: string; openPhase?: OpenPhase; className: string; children: ReactNode;
}) {
  if (!openPhase) return <span className={className}>{children}</span>;
  const { href, onClick } = openPhase(phaseId);
  return <a href={href} onClick={followInPlace(onClick)} className={cx(className, "text-fg no-underline hover:no-underline")}>{children}</a>;
}

function PhaseRow({ phase, openPhase }: { phase: Phase; openPhase?: OpenPhase }) {
  const meta = usePhaseMeta();
  const mark = markOf(phase);
  return (
    <PhaseLink phaseId={phase.phaseId} openPhase={openPhase}
               className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2",
                             mark === "rejected" && "bg-bad-soft hover:bg-bad-soft", mark === "waiting" && "bg-wait-soft hover:bg-wait-soft")}>
      <StatusIcon status={mark} size={13} />
      <span className="min-w-0 grow">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{phaseName(phase)}</span>
          <KindIcon type={phase.type} />
        </span>
        <span className="block truncate text-xs text-muted">{meta(phase)}</span>
      </span>
    </PhaseLink>
  );
}

/** A phase as a card of its own: the chain of a chapter recorded before stages. */
function PhaseCard({ phase, current, openPhase }: { phase: Phase; current: boolean; openPhase?: OpenPhase }) {
  const mark = markOf(phase);
  const status = lookOf(mark);
  return (
    <div data-phase={phase.phaseId} className={cx("relative w-full shrink-0 rounded-lg md:w-auto", card(status, current))}>
      {current ? <NowTab status={status} /> : null}
      <PhaseLink phaseId={phase.phaseId} openPhase={openPhase} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 whitespace-nowrap">
        <StatusIcon status={mark} size={13} />
        <span className="text-sm font-medium">{phaseName(phase)}</span>
        <KindIcon type={phase.type} />
      </PhaseLink>
    </div>
  );
}

/** The chain's two ends: the work item read, and the report. Dashed until it happened. */
function End({ phase, label, openPhase }: { phase: Phase | null; label: string; openPhase?: OpenPhase }) {
  const shape = cx("flex w-fit shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap",
                   phase ? "border-ok/40 bg-[color-mix(in_oklab,var(--ok)_5%,var(--surface))] shadow-card dark:bg-[color-mix(in_oklab,var(--ok)_9%,var(--surface))]"
                     : "border-dashed border-line-strong text-faint");
  const body = <><StatusIcon status={phase ? markOf(phase) : "pending"} size={13} /><span className="font-medium">{label}</span></>;
  return phase ? <PhaseLink phaseId={phase.phaseId} openPhase={openPhase} className={shape}>{body}</PhaseLink> : <span className={shape}>{body}</span>;
}

/**
 * Between two links of the chain: green up to where the session got, dashed
 * beyond, with an arrowhead across; a short stem down a phone. A workflow's
 * chain has no progress to colour: its connectors are `neutral` ink.
 */
function Connector({ done, neutral = false }: { done: boolean; neutral?: boolean }) {
  const line = neutral ? "border-fg/35 dark:border-fg/45" : "border-ok/60";
  return (
    <span aria-hidden="true" className="relative ml-5 h-3 w-0 shrink-0 md:mt-[1.1rem] md:ml-0 md:h-0 md:w-4">
      <span className={cx("absolute inset-0", done ? cx("border-l-2 md:border-t-2 md:border-l-0", line) : "border-l border-dashed border-line-strong md:border-t md:border-l-0")} />
      {done ? (
        <span className={cx("absolute -top-[3px] right-0 hidden size-0 border-y-4 border-l-[5px] border-y-transparent md:block",
                            neutral ? "border-l-fg/35 dark:border-l-fg/45" : "border-l-ok/60")} />
      ) : null}
    </span>
  );
}

/**
 * One chain on one line, scrolled sideways when it does not fit: only then
 * does it get a gutter for its arrows (so an arrow never sits on a card), and
 * its inner edges fade where stages are hidden. No scrollbar — the arrows, a
 * trackpad and the fades say it scrolls. `focus` is scrolled into view.
 */
function Chain({ focus, children }: { focus: string | null; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ overflow: false, left: false, right: false });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEdge({ overflow: el.scrollWidth > el.clientWidth + 2, left: el.scrollLeft > 2,
              right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => {
    const el = row.current;
    const target = focus && el?.querySelector<HTMLElement>(focus);
    if (!el || !target || !edge.overflow) return;
    if (target.offsetLeft + target.offsetWidth > el.scrollLeft + el.clientWidth || target.offsetLeft < el.scrollLeft) {
      el.scrollLeft = target.offsetLeft - el.clientWidth / 2 + target.offsetWidth / 2;
    }
    measure();
  }, [focus, edge.overflow, measure]);
  const mask = `linear-gradient(to right, ${edge.left ? "transparent, black 2.5rem" : "black"}, ${edge.right ? "black calc(100% - 2.5rem), transparent" : "black"})`;
  const arrow = (direction: -1 | 1, enabled: boolean) => (
    <button type="button" disabled={!enabled} aria-label={direction < 0 ? "Scroll left" : "Scroll right"}
            onClick={() => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.6, behavior: "smooth" })}
            className={cx("absolute top-[1.9rem] hidden size-7 place-items-center rounded-full border border-line bg-surface text-muted shadow-card transition-opacity hover:text-fg disabled:opacity-0 md:grid",
                          direction < 0 ? "left-0" : "right-0")}>
      {direction < 0 ? <ChevronLeft size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
  );
  return (
    <div className={cx("relative", edge.overflow && "md:px-9")}>
      <div ref={row} onScroll={measure} style={{ maskImage: mask, WebkitMaskImage: mask }}
           className="flex flex-col items-stretch pt-3 pb-1 [scrollbar-width:none] md:flex-row md:items-start md:overflow-x-auto md:px-1 md:pb-3 [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      {edge.overflow ? <>{arrow(-1, edge.left)}{arrow(1, edge.right)}</> : null}
    </div>
  );
}

// ── a workflow's graph ───────────────────────────────────────────────────────
// A workflow's stages have no status, so its cards get a neutral tint instead
// of a status wash: a little of the text colour mixed into the surface — more
// in dark, where the surfaces sit close together — and a border that stays
// visible on a dark card. Its ends are neutral too.

const NEUTRAL_TINT = "bg-[color-mix(in_oklab,var(--fg)_3%,var(--surface))] dark:bg-[color-mix(in_oklab,var(--fg)_8%,var(--surface))]";
const NEUTRAL_CARD = cx("border border-line-strong border-t-[3px] border-t-fg/40 shadow-card dark:border-fg/25 dark:border-t-fg/55", NEUTRAL_TINT);
const NEUTRAL_END = cx("border border-line-strong text-muted shadow-card dark:border-fg/25", NEUTRAL_TINT);

/** A stage of a workflow, as its card shows it: its name in the vocabulary, and what the page writes under it. */
export interface WorkflowStage {
  name: string;
  children: ReactNode;
}

/**
 * A workflow drawn with no session behind it (#120): what it will do, stage
 * by stage, from what starts it to its report — the same chain, cards,
 * connectors and sideways scroll as a session's chapter, so a workflow and a
 * run of it read alike. The Workflows tab writes on each card.
 */
export function WorkflowGraph({ start, stages }: { start: string; stages: WorkflowStage[] }) {
  const pill = cx("flex w-fit shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm whitespace-nowrap", NEUTRAL_END);
  const links: ReactNode[] = [<span key="start" className={pill}>{start}</span>];
  stages.forEach((stage, index) => {
    links.push(<Connector key={`c${index}`} done neutral />);
    links.push(
      <div key={index} data-stage={index} className={cx("flex w-full shrink-0 flex-col gap-1 rounded-lg px-2.5 py-2 md:w-auto", NEUTRAL_CARD)}>
        <span className="flex items-center gap-1.5 text-base font-semibold whitespace-nowrap">
          <StageIcon name={stage.name} className="text-muted" />{stage.name}
        </span>
        {stage.children}
      </div>,
    );
  });
  links.push(<Connector key="cend" done neutral />);
  links.push(<span key="end" className={pill}>report</span>);
  return <Chain focus={null}>{links}</Chain>;
}

// ── the mini graph ───────────────────────────────────────────────────────────

const CHIP: Record<StageStatus, string> = {
  done: "border-ok text-ok", running: "border-accent text-accent", waiting: "border-wait text-wait",
  failed: "border-bad text-bad", pending: "border-line-strong text-muted",
};

/**
 * A chapter in one row: the current stage as a chip with its name, every
 * other one as a small block — filled where the session has been, dashed
 * where it has not. For a list's row, and a folded chapter's line.
 */
export function MiniGraph({ mini }: { mini: Mini }) {
  const blocks = mini.blocks.map(({ key, status, stage, phase }) => ({ key, status, name: stage ?? (phase ? phaseName(phase) : "") }));
  return (
    <span className="flex flex-wrap items-center gap-1">
      {blocks.map((block, index) => index === mini.current ? (
        <span key={block.key} className={cx("flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", CHIP[block.status])}>
          <StatusIcon status={block.status} size={11} />{block.name}
        </span>
      ) : (
        <span key={block.key} title={block.name}
              className={cx("h-4 w-3 shrink-0 rounded-sm border",
                            block.status === "pending" ? "border-dashed border-line-strong"
                              : block.status === "failed" ? "border-transparent bg-bad/60" : "border-transparent bg-ok/45")} />
      ))}
    </span>
  );
}

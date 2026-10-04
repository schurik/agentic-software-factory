"use client";
// PROTOTYPE, throwaway. The stage graph: stages as cards on a chain, phases as sub-nodes inside
// the card (the Cards graph, chosen over Rail and Ribbon — both in the branch history). Its
// contrast against the page is what ?variant=A|B|C|D compares now (see Skins below). A full form
// (session page, Workflows tab) and a mini form (a row on Now). Horizontal on desktop, vertical on
// a phone. Hand-built: flex + borders, no graph library.
import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Chapter, Phase, Session, Stage } from "@/lib/data";
import type { StageStat, Workflow } from "@/lib/factories";
import { StageIcon } from "./icons";
import {
  chapterSecs, chapterStatus, cost, allPhases, currentStageIndex, expandedByDefault, fmtCost, fmtDur,
  hadRejection, phaseTitle, stageSecs, stageStatus, who, type StageStatus,
} from "@/lib/model";
import { useProto, type Variant } from "./state";
import { Chevron, KindIcon, StatusIcon, cx } from "./ui";

interface GraphProps {
  session: Session;
  chapter: Chapter;
}

function useGraph({ session, chapter }: GraphProps) {
  const { open } = useProto();
  const current = currentStageIndex(chapter);
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const isOpen = (i: number) => toggled[i] ?? expandedByDefault(chapter, i);
  return {
    current,
    isOpen,
    isDefault: (i: number) => expandedByDefault(chapter, i),
    toggle: (i: number) => setToggled((t) => ({ ...t, [i]: !isOpen(i) })),
    openPhase: (p: Phase) => open({ type: "phase", session: session.id, phaseId: p.id }),
    openStage: (i: number) => open({ type: "stage", session: session.id, chapter: chapter.n, stage: i }),
  };
}

const phaseLabel = phaseTitle;
const phaseMeta = (p: Phase) =>
  p.status === "rejected" ? `rejected by ${who(p.remark?.by ?? "")}` :
  p.status === "waiting" ? `waiting on ${who(p.owner)}` :
  p.status === "running" ? "running" :
  p.remark?.verdict === "approve" && p.kind === "gate" ? `approved by ${who(p.remark.by)}` :
  p.secs ? fmtDur(p.secs) : "";

// ═════════════════════════════════════════════════════════════════════════════
// Skins (?variant=A|B|C|D): one Cards graph, four ways to give it contrast
//   A Well — the chain sits on a tinted canvas; white cards with a real border and a shadow
//   B Tint — each card filled with its status' tint; connectors coloured by progress
//   C Edge — white cards, a stronger border and a status-coloured top edge; arrowed connectors
//   D Ink  — finished stages in ink outline; the current one with a solid status header
// ═════════════════════════════════════════════════════════════════════════════

type Tone = "ok" | "accent" | "wait" | "bad" | "none";
const toneOf: Record<StageStatus, Tone> = { ok: "ok", running: "accent", waiting: "wait", failed: "bad", pending: "none" };
const ringSoft: Record<Tone, string> = { ok: "", accent: "ring-4 ring-accent-soft", wait: "ring-4 ring-wait-soft", bad: "ring-4 ring-bad-soft", none: "" };
const border: Record<Tone, string> = { ok: "border-ok", accent: "border-accent", wait: "border-wait", bad: "border-bad", none: "border-line-strong" };
const solid: Record<Tone, string> = { ok: "bg-ok text-bg", accent: "bg-accent-strong text-accent-fg", wait: "bg-wait text-bg", bad: "bg-bad text-bg", none: "" };

interface Skin {
  /** Around the whole chain. */
  canvas: string;
  card: (st: StageStatus, current: boolean) => string;
  /** The card's title row; D fills it on the current stage. */
  head: (st: StageStatus, current: boolean) => string;
  /** A workflow's stage card, which has no status. */
  shape: string;
  connector: (done: boolean) => string;
  arrow?: boolean;
  end: (done: boolean) => string;
  mini: string;
}

const PENDING = "border border-dashed border-line-strong bg-transparent";

const SKINS: Record<Variant, Skin> = {
  A: {
    canvas: "rounded-xl bg-surface-2 p-2 md:px-3 dark:bg-bg",
    card: (st, cur) => st === "pending" ? PENDING : cx("border bg-surface shadow-card", cur ? cx(border[toneOf[st]], ringSoft[toneOf[st]]) : "border-line-strong"),
    head: () => "",
    shape: "border border-line-strong bg-surface shadow-card",
    connector: (done) => (done ? "bg-line-strong" : "dashed"),
    end: (done) => (done ? "border-line-strong bg-surface shadow-card" : "border-dashed border-line-strong text-faint"),
    mini: "bg-fg/20",
  },
  B: {
    canvas: "",
    card: (st, cur) => {
      const tint = { ok: "bg-ok-soft border-ok/40", running: "bg-accent-soft border-accent/60", waiting: "bg-wait-soft border-wait/60", failed: "bg-bad-soft border-bad/60", pending: "" }[st];
      return st === "pending" ? PENDING : cx("border", tint, cur && ringSoft[toneOf[st]]);
    },
    head: () => "",
    shape: "border border-line-strong bg-surface-2",
    connector: (done) => (done ? "bg-ok/50" : "dashed"),
    end: (done) => (done ? "border-ok/40 bg-ok-soft" : "border-dashed border-line-strong text-faint"),
    mini: "bg-ok/45",
  },
  C: {
    canvas: "",
    card: (st, cur) => st === "pending" ? cx(PENDING, "border-t-[3px]") : cx(
      "border border-line-strong border-t-[3px] bg-surface shadow-card",
      { ok: "border-t-ok", running: "border-t-accent", waiting: "border-t-wait", failed: "border-t-bad", pending: "" }[st],
      cur && ringSoft[toneOf[st]],
    ),
    head: () => "",
    shape: "border border-line-strong border-t-[3px] border-t-fg/40 bg-surface shadow-card",
    connector: (done) => (done ? "bg-fg/35" : "dashed"),
    arrow: true,
    end: (done) => (done ? "border-line-strong bg-surface shadow-card" : "border-dashed border-line-strong text-faint"),
    mini: "bg-fg/30",
  },
  D: {
    canvas: "",
    card: (st, cur) => st === "pending" ? PENDING : cx("border-[1.5px] bg-surface", cur ? border[toneOf[st]] : "border-fg/55"),
    // The header fills to the card's rounded top without clipping the NOW badge above it.
    // The icon takes the header's text colour: white on blue; on amber and red, white in light
    // and dark in dark (where those fills are light).
    head: (st, cur) => (cur && st !== "ok" ? cx(solid[toneOf[st]], "rounded-t-[6px] pt-3 [&_svg]:[filter:brightness(0)_invert(1)]", toneOf[st] !== "accent" && "dark:[&_svg]:[filter:brightness(0)]") : ""),
    shape: "border-[1.5px] border-fg/55 bg-surface",
    connector: (done) => (done ? "bg-fg/60" : "dashed"),
    end: (done) => (done ? "border-[1.5px] border-fg/55 bg-surface" : "border-dashed border-line-strong text-faint"),
    mini: "bg-fg/55",
  },
};

function useSkin(): Skin {
  return SKINS[useProto().variant];
}

// ═════════════════════════════════════════════════════════════════════════════
// The Cards graph
// ═════════════════════════════════════════════════════════════════════════════

function EndNode({ phase, label, onClick }: { phase?: Phase; label: string; onClick?: () => void }) {
  const skin = useSkin();
  return (
    <button
      onClick={onClick}
      disabled={!phase}
      className={cx(
        "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap",
        skin.end(!!phase), phase && "hover:brightness-[0.98] cursor-pointer",
      )}
    >
      <StatusIcon status={phase?.status ?? "pending"} size={13} />
      <span className="font-medium">{label}</span>
    </button>
  );
}

function PhaseRow({ p, onClick, dense }: { p: Phase; onClick: () => void; dense?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cx(
        "group flex w-full items-center gap-2 rounded-md px-2 text-left hover:bg-surface-2 cursor-pointer",
        dense ? "py-1" : "py-1.5",
        p.status === "rejected" && "bg-bad-soft hover:bg-bad-soft",
        p.status === "waiting" && "bg-wait-soft hover:bg-wait-soft",
      )}
    >
      <StatusIcon status={p.status} size={13} />
      <span className="min-w-0 grow">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{phaseLabel(p)}</span>
          <KindIcon kind={p.kind} />
        </span>
        <span className="block truncate text-xs text-muted">{phaseMeta(p)}</span>
      </span>
    </button>
  );
}

function StageCard({ stage, i, g }: { stage: Stage; i: number; g: ReturnType<typeof useGraph> }) {
  const skin = useSkin();
  const st = stageStatus(stage);
  const open = g.isOpen(i) && stage.phases.length > 0;
  const current = i === g.current;
  return (
    <div
      data-stage={i}
      className={cx(
        "relative flex shrink-0 flex-col rounded-lg transition-[width]",
        skin.card(st, current),
        open ? "w-full md:w-52" : "w-full md:w-auto",
      )}
    >
      {current ? (
        <span className={cx("absolute -top-2.5 left-2.5 z-10 rounded px-1.5 text-[10px] font-semibold uppercase tracking-wider", st === "failed" ? "bg-bad text-bg" : st === "waiting" ? "bg-wait text-bg" : "bg-accent-strong text-accent-fg")}>
          now
        </span>
      ) : null}
      <button onClick={() => g.openStage(i)} className={cx("flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-left cursor-pointer", skin.head(st, current), skin.head(st, current) && "pb-2")}>
        <StatusIcon status={st} size={14} />
        <span className={cx("text-base font-semibold", st === "pending" && "text-faint font-medium")}>{stage.name}</span>
        {hadRejection(stage) ? <span className={cx("rounded px-1 text-[10px] font-semibold text-bad", skin.head(st, current) ? "bg-surface" : "bg-bad-soft")}>↺ {stage.phases.filter((p) => p.status === "rejected").length}</span> : null}
      </button>
      {stage.phases.length === 0 ? (
        <span className="pb-1.5" />
      ) : open ? (
        <div className={cx("flex flex-col gap-0.5 px-1.5 pb-1.5", skin.head(st, current) && "pt-1.5")}>
          {stage.phases.map((p) => <PhaseRow key={p.id} p={p} onClick={() => g.openPhase(p)} />)}
          {!g.isDefault(i) ? (
            <button onClick={() => g.toggle(i)} className="px-2 py-1 text-left text-xs text-faint hover:text-fg cursor-pointer">collapse</button>
          ) : null}
        </div>
      ) : (
        <button onClick={() => g.toggle(i)} className="flex items-center gap-1 px-2.5 pb-2.5 text-xs text-muted hover:text-fg cursor-pointer whitespace-nowrap">
          {stage.phases.length > 1 ? `${stage.phases.length} phases` : fmtDur(stageSecs(stage))}
          <Chevron className="size-2.5" />
        </button>
      )}
    </div>
  );
}

function Connector({ done }: { done: boolean }) {
  const skin = useSkin();
  const tone = skin.connector(done);
  const dashed = tone === "dashed";
  return (
    <>
      <span aria-hidden className="relative mt-[1.1rem] hidden w-4 shrink-0 md:block">
        <span className={cx("block", dashed ? "border-t border-dashed border-line-strong" : cx("h-0.5", tone))} />
        {skin.arrow && !dashed ? <span className="absolute -top-[3px] right-0 size-0 border-y-4 border-l-[5px] border-y-transparent border-l-fg/35" /> : null}
      </span>
      <span aria-hidden className={cx("ml-5 h-3 md:hidden", dashed ? "border-l border-dashed border-line-strong" : cx("w-0.5", tone))} />
    </>
  );
}

function CardsFull(props: GraphProps) {
  const g = useGraph(props);
  const { chapter } = props;
  const nodes: React.ReactNode[] = [];
  nodes.push(<EndNode key="start" phase={chapter.start} label={chapter.start ? chapter.start.name === "issue" ? `issue ${chapter.ref}` : `pr ${chapter.ref.replace("PR ", "")}` : "prompt"} onClick={chapter.start ? () => g.openPhase(chapter.start!) : undefined} />);
  chapter.stages.forEach((s, i) => {
    nodes.push(<Connector key={`c${i}`} done={s.phases.length > 0} />);
    nodes.push(<StageCard key={i} stage={s} i={i} g={g} />);
  });
  nodes.push(<Connector key="cend" done={!!chapter.end} />);
  nodes.push(<EndNode key="end" phase={chapter.end} label="report" onClick={chapter.end ? () => g.openPhase(chapter.end!) : undefined} />);
  return (
    <Canvas>
      <div className="flex flex-col items-stretch pt-3 md:hidden">{nodes}</div>
      <ScrollRow focus={g.current}>{nodes}</ScrollRow>
    </Canvas>
  );
}

function Canvas({ children }: { children: ReactNode }) {
  return <div className={useSkin().canvas}>{children}</div>;
}

/**
 * One chain on one line, scrolled sideways when it does not fit. Only then does it get a gutter
 * on each side for its arrows — so an arrow never sits on a card — and the inner edges fade where
 * stages are hidden. No scrollbar: the arrows, a trackpad and the fades say it scrolls. The
 * current stage is scrolled into view when the chapter opens.
 */
function ScrollRow({ children, focus }: { children: ReactNode; focus: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ overflow: false, left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    setEdge({
      overflow: el.scrollWidth > el.clientWidth + 2,
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !edge.overflow) return;
    const card = el.querySelector<HTMLElement>(`[data-stage="${focus}"]`);
    if (card && card.offsetLeft + card.offsetWidth > el.clientWidth) {
      el.scrollLeft = card.offsetLeft - el.clientWidth / 2 + card.offsetWidth / 2;
    }
    measure();
  }, [focus, edge.overflow]);
  const mask = `linear-gradient(to right, ${edge.left ? "transparent, black 2.5rem" : "black"}, ${edge.right ? "black calc(100% - 2.5rem), transparent" : "black"})`;
  const arrow = (dir: -1 | 1, enabled: boolean) => (
    <button
      onClick={() => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.6, behavior: "smooth" })}
      disabled={!enabled}
      className={cx("absolute top-[1.9rem] grid size-7 place-items-center rounded-full border border-line bg-surface text-muted shadow-card hover:text-fg disabled:opacity-0 cursor-pointer transition-opacity", dir < 0 ? "left-0" : "right-0")}
      aria-label={dir < 0 ? "Scroll left" : "Scroll right"}
    >
      <Chevron className={dir < 0 ? "rotate-180" : undefined} />
    </button>
  );
  return (
    <div className={cx("relative hidden md:block", edge.overflow && "px-9")}>
      <div
        ref={ref}
        onScroll={measure}
        className="no-scrollbar flex flex-row items-start overflow-x-auto px-1 pt-3 pb-3"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {children}
      </div>
      {edge.overflow ? <>{arrow(-1, edge.left)}{arrow(1, edge.right)}</> : null}
    </div>
  );
}

function CardsMini({ chapter }: { chapter: Chapter }) {
  const skin = useSkin();
  const cur = currentStageIndex(chapter);
  return (
    <div className="flex items-center gap-1">
      {chapter.stages.map((s, i) => {
        const st = stageStatus(s);
        if (i === cur) {
          return (
            <span key={i} className={cx("flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium", st === "waiting" ? "border-wait text-wait" : st === "failed" ? "border-bad text-bad" : "border-accent text-accent")}>
              <StatusIcon status={st} size={11} /> {s.name}
            </span>
          );
        }
        return (
          <span key={i} title={s.name} className={cx("h-4 w-3 rounded-sm border",
            st === "ok" ? cx("border-transparent", skin.mini) : "border-dashed border-line-strong")} />
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Switching, and the chapters around a graph
// ═════════════════════════════════════════════════════════════════════════════

export function ChapterGraph({ session, chapter }: GraphProps) {
  return <CardsFull session={session} chapter={chapter} />;
}

export function MiniGraph({ chapter }: { chapter: Chapter }) {
  return <CardsMini chapter={chapter} />;
}

/**
 * Every chapter, one row each: earlier ones fold to a line, the last one is open. A Base UI
 * Collapsible: the header never changes size, the panel grows to the graph's height and fades
 * in, and the small graph in the header fades out as the big one arrives (and back).
 */
export function SessionGraph({ session }: { session: Session }) {
  const last = session.chapters.length - 1;
  return (
    <div className="flex flex-col gap-2">
      {session.chapters.map((c, i) => {
        const st = chapterStatus(c);
        return (
          <Collapsible.Root key={c.n} defaultOpen={i === last} render={<section className="rounded-xl border border-line bg-surface" />}>
            <Collapsible.Trigger className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left md:px-5 cursor-pointer">
              <Chevron className="text-faint transition-transform duration-200 group-data-panel-open:rotate-90" />
              <span className="text-xs font-medium uppercase tracking-wider text-faint">Chapter {c.n}</span>
              <span className="font-semibold">{c.workflow}</span>
              <span className="text-sm text-muted">{c.input === "prompt" ? "from a prompt" : `answering ${c.ref}`}</span>
              <span aria-hidden className="hidden transition-opacity duration-200 group-data-panel-open:pointer-events-none group-data-panel-open:opacity-0 sm:block">
                <MiniGraph chapter={c} />
              </span>
              <span className="grow" />
              <span className="flex items-center gap-3 text-sm text-muted tabular-nums">
                <span>{fmtDur(chapterSecs(c))}</span>
                <span>{fmtCost(cost(allPhases(c)))}</span>
                {i === last && session.status !== "done" ? null : <StatusIcon status={st} />}
              </span>
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
              <div className="px-4 pb-4 md:px-5 md:pb-5">
                <ChapterGraph session={session} chapter={c} />
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// A workflow's shape (factory page): the same chain, read from the self-description
// ═════════════════════════════════════════════════════════════════════════════

const INPUT_LABEL: Record<Workflow["input"], string> = { issue: "an issue", pr: "a pull request", prompt: "a prompt" };

/**
 * The stage graph with no session behind it: what a workflow WILL do, stage by stage, with the
 * agents bound to each and whether its gate asks a person. Same chain, cards, connectors and
 * sideways scroll as a session's chapter, so a workflow and a run of it read alike.
 */
export function WorkflowGraph({ workflow }: { workflow: Workflow }) {
  const skin = useSkin();
  const stats = workflow.stats;
  // The slowest stage by median time, among the stages that do work (not the 2s commits).
  const slowest = stats ? stats.reduce((m, x, i) => (x.medianSecs > stats[m].medianSecs ? i : m), 0) : -1;
  const nodes: ReactNode[] = [];
  const start = (
    <span key="start" className={cx("flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap text-muted", skin.end(true))}>
      {INPUT_LABEL[workflow.input]}
    </span>
  );
  nodes.push(start);
  workflow.stages.forEach((s, i) => {
    nodes.push(<Connector key={`c${i}`} done />);
    nodes.push(
      <div key={i} data-stage={i} className={cx("flex w-full shrink-0 flex-col gap-1 rounded-lg px-2.5 py-2 md:w-auto", skin.shape)}>
        <span className="flex items-center gap-1.5 text-base font-semibold whitespace-nowrap">
          <StageIcon name={s.name} size={14} className="text-muted" />{s.name}
        </span>
        <span className="text-xs whitespace-nowrap text-muted">{s.agents.length ? s.agents.join(", ") : "code"}</span>
        {stats?.[i] ? <StageRecord stat={stats[i]} slowest={i === slowest} /> : null}
        {s.gate ? (
          <span className={cx("w-fit rounded px-1.5 py-px text-[11px] font-medium whitespace-nowrap", s.gate.on ? "bg-wait-soft text-wait" : "bg-surface-2 text-muted")}>
            {s.gate.name} gate · {s.gate.on ? "asks a person" : "passes by policy"}
          </span>
        ) : null}
        {s.gate?.on && stats?.[i]?.gate ? (
          <span className="text-[11px] whitespace-nowrap text-muted">
            {stats[i].gate!.rejected} of {stats[i].gate!.rounds} rejected · wait {fmtDur(stats[i].gate!.medianWait)}
          </span>
        ) : null}
      </div>,
    );
  });
  nodes.push(<Connector key="cend" done />);
  nodes.push(
    <span key="end" className={cx("flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap text-muted", skin.end(true))}>report</span>,
  );
  return (
    <Canvas>
      <div className="flex flex-col items-stretch md:hidden">{nodes}</div>
      <ScrollRow focus={-1}>{nodes}</ScrollRow>
    </Canvas>
  );
}

/** A stage's last 30 days on its card: median time and cost; failures and the slowest said in colour, with words. */
function StageRecord({ stat, slowest }: { stat: StageStat; slowest: boolean }) {
  return (
    <span className="flex flex-col gap-0.5 border-t border-line pt-1 text-[11px] whitespace-nowrap tabular-nums text-muted">
      <span>{fmtDur(stat.medianSecs)}{stat.medianCost ? ` · ${fmtCost(stat.medianCost)}` : ""} <span className="text-faint">median</span></span>
      {slowest ? <span className="font-medium text-wait">slowest stage</span> : null}
      {stat.failures ? <span className="font-medium text-bad">{stat.failures} failure{stat.failures > 1 ? "s" : ""}</span> : null}
    </span>
  );
}

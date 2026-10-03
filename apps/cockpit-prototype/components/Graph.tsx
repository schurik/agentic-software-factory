"use client";
// PROTOTYPE, throwaway. The stage graph, three ways (?variant=A|B|C):
//   A Cards  — stages as cards on a chain, phases as sub-nodes stacked inside the card
//   B Rail   — a metro line: stages are stations on one line, phases hang below as beads
//   C Ribbon — one bar, each stage a segment sized by its time, phases as slices inside
// Each has a full form (session page) and a mini form (a row on Now). Horizontal on desktop,
// vertical on a phone. Hand-built: flex/grid + borders, no graph library.
import { useState } from "react";
import type { Chapter, Phase, Session, Stage } from "@/lib/data";
import {
  chapterSecs, chapterStatus, cost, allPhases, currentStageIndex, expandedByDefault, fmtCost, fmtDur,
  hadRejection, stageSecs, stageStatus, type StageStatus,
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

const phaseLabel = (p: Phase) => (p.gate ? `${p.gate.name} gate · round ${p.gate.round}` : p.name);
const phaseMeta = (p: Phase) =>
  p.status === "rejected" ? `rejected by ${p.remark?.by}` :
  p.status === "waiting" ? `waiting on ${p.owner}` :
  p.status === "running" ? "running" :
  p.remark?.verdict === "approve" && p.kind === "gate" ? `approved by ${p.remark.by}` :
  p.secs ? fmtDur(p.secs) : "";

const ringTone: Record<StageStatus, string> = {
  ok: "border-line", pending: "border-dashed border-line-strong", running: "border-accent ring-4 ring-accent-soft",
  waiting: "border-wait ring-4 ring-wait-soft", failed: "border-bad ring-4 ring-bad-soft",
};

// ═════════════════════════════════════════════════════════════════════════════
// A · Cards
// ═════════════════════════════════════════════════════════════════════════════

function EndNode({ phase, label, onClick }: { phase?: Phase; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={!phase}
      className={cx(
        "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap",
        phase ? "border-line bg-surface hover:bg-surface-2 cursor-pointer" : "border-dashed border-line-strong text-faint",
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
  const st = stageStatus(stage);
  const open = g.isOpen(i) && stage.phases.length > 0;
  const current = i === g.current;
  return (
    <div
      className={cx(
        "relative flex shrink-0 flex-col rounded-lg border bg-surface transition-[width]",
        ringTone[st],
        open ? "w-full md:w-52" : "w-full md:w-auto",
        st === "pending" && "bg-transparent",
      )}
    >
      {current ? (
        <span className={cx("absolute -top-2.5 left-2.5 rounded px-1.5 text-[10px] font-semibold uppercase tracking-wider", st === "failed" ? "bg-bad text-white" : st === "waiting" ? "bg-wait text-white" : "bg-accent text-accent-fg")}>
          now
        </span>
      ) : null}
      <button onClick={() => g.openStage(i)} className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-left cursor-pointer">
        <StatusIcon status={st} size={14} />
        <span className={cx("text-base font-semibold", st === "pending" && "text-faint font-medium")}>{stage.name}</span>
        {hadRejection(stage) ? <span className="rounded bg-bad-soft px-1 text-[10px] font-semibold text-bad">↺ {stage.phases.filter((p) => p.status === "rejected").length}</span> : null}
      </button>
      {stage.phases.length === 0 ? (
        <span className="pb-1.5" />
      ) : open ? (
        <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
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
  return (
    <>
      <span aria-hidden className={cx("hidden md:block mt-[1.15rem] h-px w-3 shrink-0", done ? "bg-line-strong" : "border-t border-dashed border-line-strong")} />
      <span aria-hidden className={cx("md:hidden ml-5 h-3 w-px", done ? "bg-line-strong" : "border-l border-dashed border-line-strong")} />
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
  return <div className="flex flex-col items-stretch pt-3 md:flex-row md:flex-wrap md:items-start md:gap-y-4 md:pb-2">{nodes}</div>;
}

function CardsMini({ chapter }: { chapter: Chapter }) {
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
            st === "ok" ? "border-transparent bg-surface-3" : "border-dashed border-line-strong")} />
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// B · Rail
// ═════════════════════════════════════════════════════════════════════════════

const dotTone: Record<StageStatus, string> = {
  ok: "bg-fg border-fg", pending: "bg-bg border-line-strong", running: "bg-accent border-accent pulse",
  waiting: "bg-wait border-wait", failed: "bg-bad border-bad",
};

function Bead({ p, onClick }: { p: Phase; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group relative flex w-full items-start gap-2 py-1 text-left cursor-pointer">
      <span className={cx("relative z-10 mt-1 size-2.5 shrink-0 rounded-full border-2 bg-bg",
        p.status === "ok" ? "border-muted" : p.status === "rejected" || p.status === "failed" ? "border-bad bg-bad" : p.status === "waiting" ? "border-wait bg-wait" : p.status === "running" ? "border-accent bg-accent" : "border-line-strong")} />
      <span className="min-w-0">
        <span className="flex items-center gap-1 whitespace-nowrap text-sm font-medium group-hover:text-accent">
          <span>{phaseLabel(p)}</span><KindIcon kind={p.kind} />
        </span>
        <span className={cx("block whitespace-nowrap text-xs", p.status === "rejected" ? "text-bad" : p.status === "waiting" ? "text-wait" : "text-muted")}>{phaseMeta(p)}</span>
      </span>
    </button>
  );
}

function RailFull(props: GraphProps) {
  const g = useGraph(props);
  const { chapter } = props;
  const n = chapter.stages.length;
  const doneUpTo = chapter.stages.findLastIndex((s) => s.phases.length > 0);
  const pct = n ? ((doneUpTo + 0.5) / n) * 100 : 0;
  return (
    <>
      {/* desktop: horizontal line */}
      <div className="hidden md:block">
        <div className="mb-3 flex items-center gap-3 text-sm">
          <button disabled={!chapter.start} onClick={() => chapter.start && g.openPhase(chapter.start)} className="flex items-center gap-1.5 text-muted hover:text-fg cursor-pointer">
            <StatusIcon status={chapter.start?.status ?? "ok"} size={12} />
            {chapter.start ? `${chapter.start.name} ${chapter.ref.replace("PR ", "")}` : "prompt"}
          </button>
          <span className="h-px grow bg-line" />
          <button disabled={!chapter.end} onClick={() => chapter.end && g.openPhase(chapter.end)} className={cx("flex items-center gap-1.5", chapter.end ? "text-muted hover:text-fg cursor-pointer" : "text-faint")}>
            <StatusIcon status={chapter.end?.status ?? "pending"} size={12} /> report
          </button>
        </div>
        <div className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          <span aria-hidden className="absolute top-[7px] h-0.5 bg-line" style={{ left: `${50 / n}%`, right: `${50 / n}%` }} />
          <span aria-hidden className="absolute top-[7px] h-0.5 bg-fg" style={{ left: `${50 / n}%`, width: `calc(${Math.max(0, pct - 50 / n)}%)` }} />
          {chapter.stages.map((s, i) => {
            const st = stageStatus(s);
            const open = g.isOpen(i) && s.phases.length > 0;
            return (
              <div key={i} className="relative flex min-w-0 flex-col items-center px-1">
                <button onClick={() => g.openStage(i)} className={cx("relative z-10 size-4 rounded-full border-2 cursor-pointer", dotTone[st], i === g.current && "size-4 ring-4", i === g.current && (st === "waiting" ? "ring-wait-soft" : st === "failed" ? "ring-bad-soft" : "ring-accent-soft"))} aria-label={s.name} />
                <button onClick={() => g.openStage(i)} className={cx("mt-2 text-sm font-semibold cursor-pointer hover:text-accent", st === "pending" && "font-normal text-faint", i === g.current && (st === "waiting" ? "text-wait" : st === "failed" ? "text-bad" : "text-accent"))}>
                  {s.name}
                </button>
                {hadRejection(s) ? <span className="text-[10px] font-semibold text-bad">↺ rejected once</span> : null}
                {s.phases.length === 0 ? null : open ? (
                  <div className="relative mt-2 w-full">
                    <div className="ml-[calc(50%-1px)] flex w-max max-w-[14rem] flex-col border-l border-line [&>button]:-ml-[5px]">
                      {s.phases.map((p) => <Bead key={p.id} p={p} onClick={() => g.openPhase(p)} />)}
                    </div>
                  </div>
                ) : (
                  <button onClick={() => g.toggle(i)} className="mt-0.5 text-xs text-faint hover:text-fg cursor-pointer">
                    {s.phases.length > 1 ? `${s.phases.length} phases` : fmtDur(stageSecs(s))}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* phone: vertical line */}
      <div className="md:hidden relative pl-1">
        <span aria-hidden className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-line" />
        {chapter.start ? (
          <button onClick={() => g.openPhase(chapter.start!)} className="relative mb-2 flex items-center gap-3 text-sm text-muted">
            <span className="z-10 grid size-4 place-items-center rounded-sm border-2 border-muted bg-bg" />
            {chapter.start.name} {chapter.ref.replace("PR ", "")}
          </button>
        ) : null}
        {chapter.stages.map((s, i) => {
          const st = stageStatus(s);
          const open = g.isOpen(i) && s.phases.length > 0;
          return (
            <div key={i} className="relative py-1.5">
              <div className="flex items-center gap-3">
                <button onClick={() => g.openStage(i)} className={cx("relative z-10 size-4 shrink-0 rounded-full border-2", dotTone[st], i === g.current && "ring-4 ring-accent-soft")} aria-label={s.name} />
                <button onClick={() => g.openStage(i)} className={cx("text-base font-semibold", st === "pending" && "font-normal text-faint", i === g.current && "text-accent")}>{s.name}</button>
                {s.phases.length > 1 && !open ? <button onClick={() => g.toggle(i)} className="text-xs text-faint">{s.phases.length} phases</button> : null}
                <span className="grow" />
                {s.phases.length ? <span className="text-xs text-faint tabular-nums">{fmtDur(stageSecs(s))}</span> : null}
              </div>
              {open ? (
                <div className="ml-7 mt-1 flex flex-col border-l border-line pl-0">
                  <div className="-ml-[5px]">{s.phases.map((p) => <Bead key={p.id} p={p} onClick={() => g.openPhase(p)} />)}</div>
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="relative mt-1 flex items-center gap-3 text-sm text-muted">
          <span className={cx("z-10 size-4 rounded-sm border-2 bg-bg", chapter.end ? "border-muted" : "border-dashed border-line-strong")} />
          report
        </div>
      </div>
    </>
  );
}

function RailMini({ chapter }: { chapter: Chapter }) {
  const cur = currentStageIndex(chapter);
  return (
    <div className="flex items-center">
      {chapter.stages.map((s, i) => {
        const st = stageStatus(s);
        return (
          <span key={i} className="flex items-center">
            {i > 0 ? <span className={cx("h-0.5 w-2.5", s.phases.length ? "bg-fg/70" : "bg-line")} /> : null}
            <span title={s.name} className={cx("rounded-full border-2", dotTone[st], i === cur ? "size-3 ring-2 ring-accent-soft" : "size-2")} />
            {i === cur ? <span className={cx("ml-1.5 mr-1 text-xs font-medium", st === "waiting" ? "text-wait" : st === "failed" ? "text-bad" : "text-accent")}>{s.name}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// C · Ribbon
// ═════════════════════════════════════════════════════════════════════════════

const segTone: Record<StageStatus, string> = {
  ok: "bg-surface-3 text-fg", pending: "bg-transparent border border-dashed border-line-strong text-faint",
  running: "bg-accent text-accent-fg moving", waiting: "bg-wait text-white", failed: "bg-bad text-white",
};
const sliceTone = (p: Phase) =>
  p.status === "rejected" ? "bg-bad/80" : p.status === "failed" ? "bg-bad" : p.status === "waiting" ? "bg-wait" : p.status === "running" ? "bg-accent moving" : p.kind === "gate" ? "bg-ok/60" : "bg-fg/15";

function weight(s: Stage) {
  return s.phases.length ? Math.min(16, Math.max(4, Math.sqrt(stageSecs(s)))) : 5;
}

function RibbonFull(props: GraphProps) {
  const g = useGraph(props);
  const { chapter } = props;
  const focus = chapter.stages.map((s, i) => ({ s, i })).filter(({ i, s }) => g.isOpen(i) && s.phases.length > 0);
  return (
    <div>
      {/* desktop */}
      <div className="hidden md:block">
        <div className="flex items-end gap-0.5">
          {chapter.stages.map((s, i) => {
            const st = stageStatus(s);
            return (
              <div key={i} className="min-w-0" style={{ flex: `${weight(s)} 1 0` }}>
                <button onClick={() => g.openStage(i)} className={cx("mb-1 flex w-full items-center gap-1 truncate text-left text-xs cursor-pointer hover:text-fg", i === g.current ? "font-semibold text-fg" : st === "pending" ? "text-faint" : "text-muted")}>
                  <span className="truncate">{s.name}</span>
                  {hadRejection(s) ? <span className="text-bad">↺</span> : null}
                </button>
                <button
                  onClick={() => g.toggle(i)}
                  className={cx("relative flex h-7 w-full overflow-hidden rounded-[5px] cursor-pointer", segTone[st], i === g.current && "ring-2 ring-offset-2 ring-offset-bg", i === g.current && (st === "waiting" ? "ring-wait" : st === "failed" ? "ring-bad" : "ring-accent"))}
                  aria-label={`${s.name}: ${s.phases.length} phases`}
                >
                  {s.phases.length > 1 ? s.phases.map((p) => (
                    <span key={p.id} className={cx("h-full border-r border-bg/60 last:border-r-0", sliceTone(p))} style={{ flex: `${Math.max(1, Math.sqrt(p.secs || 20))} 1 0` }} />
                  )) : null}
                </button>
                <div className="mt-1 truncate text-[11px] tabular-nums text-faint">{s.phases.length ? fmtDur(stageSecs(s)) : ""}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-faint">
          <button onClick={() => chapter.start && g.openPhase(chapter.start)} className="hover:text-fg cursor-pointer">← {chapter.start ? `${chapter.start.name} ${chapter.ref.replace("PR ", "")}` : "prompt"}</button>
          <button onClick={() => chapter.end && g.openPhase(chapter.end)} className={cx(chapter.end ? "hover:text-fg cursor-pointer" : "")}>{chapter.end ? "report ✓" : "report"} →</button>
        </div>
        {focus.length ? (
          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(focus.length, 3)}, minmax(0, 1fr))` }}>
            {focus.map(({ s, i }) => (
              <div key={i} className="rounded-lg border border-line bg-surface p-1.5">
                <div className="flex items-center gap-2 px-2 pt-1 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                  {s.name}<span className="grow" /><button onClick={() => g.toggle(i)} className="font-normal normal-case tracking-normal text-faint hover:text-fg cursor-pointer">hide</button>
                </div>
                <div className="flex flex-col gap-0.5">{s.phases.map((p) => <PhaseRow key={p.id} p={p} dense onClick={() => g.openPhase(p)} />)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {/* phone: a Gantt — one row per stage */}
      <div className="md:hidden flex flex-col gap-1">
        {chapter.stages.map((s, i) => {
          const st = stageStatus(s);
          const total = Math.max(...chapter.stages.map(weight));
          const open = g.isOpen(i) && s.phases.length > 0;
          return (
            <div key={i}>
              <button onClick={() => (s.phases.length ? g.toggle(i) : g.openStage(i))} className="flex w-full items-center gap-2 py-0.5 text-left">
                <span className={cx("w-20 shrink-0 truncate text-sm", i === g.current ? "font-semibold" : st === "pending" ? "text-faint" : "text-muted")}>{s.name}</span>
                <span className="h-4 grow">
                  <span className={cx("block h-full rounded-[4px]", segTone[st])} style={{ width: `${(weight(s) / total) * 100}%` }} />
                </span>
                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-faint">{s.phases.length ? fmtDur(stageSecs(s)) : ""}</span>
              </button>
              {open ? <div className="ml-20 flex flex-col">{s.phases.map((p) => <PhaseRow key={p.id} p={p} dense onClick={() => g.openPhase(p)} />)}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RibbonMini({ chapter }: { chapter: Chapter }) {
  const cur = currentStageIndex(chapter);
  const st = cur >= 0 ? stageStatus(chapter.stages[cur]) : "ok";
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-1.5 w-40 gap-px overflow-hidden rounded-full">
        {chapter.stages.map((s, i) => (
          <span key={i} title={s.name} className={cx("h-full", segTone[stageStatus(s)], stageStatus(s) === "pending" && "border-0 bg-line")} style={{ flex: `${weight(s)} 1 0` }} />
        ))}
      </div>
      {cur >= 0 ? <span className={cx("text-xs font-medium", st === "waiting" ? "text-wait" : st === "failed" ? "text-bad" : "text-accent")}>{chapter.stages[cur].name}</span> : null}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Switching, and the chapters around a graph
// ═════════════════════════════════════════════════════════════════════════════

export function ChapterGraph({ session, chapter, variant }: GraphProps & { variant: Variant }) {
  if (variant === "B") return <RailFull session={session} chapter={chapter} />;
  if (variant === "C") return <RibbonFull session={session} chapter={chapter} />;
  return <CardsFull session={session} chapter={chapter} />;
}

export function MiniGraph({ chapter }: { chapter: Chapter }) {
  const { variant } = useProto();
  if (variant === "B") return <RailMini chapter={chapter} />;
  if (variant === "C") return <RibbonMini chapter={chapter} />;
  return <CardsMini chapter={chapter} />;
}

/** Every chapter, one row each: earlier ones collapse to a line, the last one is open. */
export function SessionGraph({ session }: { session: Session }) {
  const { variant } = useProto();
  const last = session.chapters.length - 1;
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <div className="flex flex-col gap-2">
      {session.chapters.map((c, i) => {
        const isOpen = open[i] ?? i === last;
        const st = chapterStatus(c);
        return (
          <section key={c.n} className={cx("rounded-xl border border-line bg-surface", isOpen ? "p-4 md:p-5" : "px-4 py-2.5")}>
            <button onClick={() => setOpen((o) => ({ ...o, [i]: !isOpen }))} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left cursor-pointer">
              <Chevron open={isOpen} className="text-faint" />
              <span className="text-xs font-medium uppercase tracking-wider text-faint">Chapter {c.n}</span>
              <span className="font-semibold">{c.workflow}</span>
              <span className="text-sm text-muted">{c.input === "prompt" ? "from a prompt" : `answering ${c.ref}`}</span>
              {!isOpen ? <span className="hidden sm:block"><MiniGraph chapter={c} /></span> : null}
              <span className="grow" />
              <span className="flex items-center gap-3 text-sm text-muted tabular-nums">
                <span>{fmtDur(chapterSecs(c))}</span>
                <span>{fmtCost(cost(allPhases(c)))}</span>
                <StatusIcon status={st} />
              </span>
            </button>
            {isOpen ? <div className="mt-4"><ChapterGraph session={session} chapter={c} variant={variant} /></div> : null}
          </section>
        );
      })}
    </div>
  );
}

import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { ItemState } from "@/convex/forge/forge";
import { type Attention, expensive, type Facts, needsAttention, stuck, waitedLong } from "@/convex/model/attention";
import { stationWords, type Row as Wait } from "@/convex/model/inbox";
import type { Other } from "@/convex/inbox";
import type { Running } from "@/convex/now";
import { tabHref } from "../factory/view";
import { formatAgoAt, formatDollars, formatDuration, formatSpan, issueNumber, plural, prNumber, secondsBetween, sessionHref, type WorkItemKind } from "../format";
import { asks, verbsOf } from "../gate/answer";
import { MiniGraph } from "../graph/StageGraph";
import { ForgeRef, KindIcon, StageIcon, StatusIcon } from "../icons";
import { keyOf, whyYours } from "../inbox/waits";
import { phaseName } from "../session/words";
import { Card, cx, followInPlace, type Go, Tag } from "../ui";
import { useWho } from "../viewer";

/**
 * Now's rows (#115): every list on the page is drawn
 * with one row, so the four line up on one grid — an icon, the title and its
 * detail lines, and on the right where it is above when it is. On a phone the
 * right column folds into one "where · when" line under the detail.
 *
 * The icon says what the row is about: a gate's stage in amber (the Inbox,
 * Waiting on others), the stage a session is in, in blue (Running), and a
 * status mark for what needs attention. Pure: the rows and the clock come in.
 */

/** Where a running session is, from its own events (`sessions.progress`). */
export type Progress = NonNullable<FunctionReturnType<typeof api.sessions.progress>>;

/** An icon on a tinted square: amber when it waits on a person, blue while it runs. */
function Glyph({ title, tone, children }: { title: string; tone: "wait" | "run"; children: ReactNode }) {
  return (
    <span title={title} className={cx("grid size-6 place-items-center rounded-md",
                                      tone === "wait" ? "bg-wait-soft text-wait" : "bg-accent-soft text-accent")}>
      {children}
    </span>
  );
}

/** A stage's icon on its square. */
function StageGlyph({ name, tone }: { name: string; tone: "wait" | "run" }) {
  return <Glyph title={name} tone={tone}><StageIcon name={name} size={14} /></Glyph>;
}

/**
 * Where a running session is, as the glyph its row leads with: the stage's
 * icon, or in a chapter drawn without stages the phase's — a gate, code, an
 * agent — and an empty square of the same size while its progress loads or
 * between phases. Never a spinner: the mini graph beside it says it runs.
 * The phase is named by its name alone: progress knows no gate or round.
 */
function RunningGlyph({ progress }: { progress: Progress | null | undefined }) {
  if (progress?.stage) return <StageGlyph name={progress.stage} tone="run" />;
  const phase = progress?.phase;
  if (phase) return <Glyph title={phaseName({ name: phase.name })} tone="run"><KindIcon type={phase.type} size={14} className="text-current" /></Glyph>;
  return <span aria-hidden="true" className="block size-6 rounded-md bg-surface-2" />;
}

/** One row of a list drawn as Now's are; the Factories list's too. */
export function Row({ glyph, title, lines, where, when, go, href, active }: {
  glyph: ReactNode;
  title: ReactNode;
  lines: ReactNode[];
  where: ReactNode;
  when: ReactNode;
  /** Opened in place, at an address of its own: a gate's drawer. */
  go?: Go;
  /** Or a page of its own. */
  href?: string;
  active?: boolean;
}) {
  const body = (
    <>
      <span className="-mt-0.5 -ml-1">{glyph}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5 font-semibold">{title}</span>
        {lines.map((line, at) => <span key={at} className="mt-0.5 block min-w-0 truncate text-sm text-muted">{line}</span>)}
        <span className="mt-1 flex min-w-0 items-center gap-1 truncate text-sm text-muted sm:hidden">{where} · {when}</span>
      </span>
      <span className="hidden w-48 flex-col items-end gap-0.5 text-right text-sm sm:flex">
        <span className="max-w-full truncate text-muted">{where}</span>
        <span className="max-w-full truncate tabular-nums">{when}</span>
      </span>
    </>
  );
  const look = cx("relative grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 text-left text-fg no-underline hover:bg-surface-2 hover:no-underline sm:grid-cols-[16px_minmax(0,1fr)_auto] md:px-5",
                  active && "bg-surface-2 shadow-[inset_3px_0_var(--accent)]");
  if (go) return <a href={go.href} onClick={followInPlace(go.onClick)} aria-current={active || undefined} className={look}>{body}</a>;
  return <Link href={href ?? ""} className={look}>{body}</Link>;
}

/** Rows in one card, a line between each. */
export function Rows({ label, children }: { label: string; children: ReactNode }) {
  return <Card><ul aria-label={label} className="divide-y divide-line overflow-hidden rounded-xl">{children}</ul></Card>;
}

/** What a list says when it has nothing in it. */
export function Empty({ children }: { children: ReactNode }) {
  return <Card className="px-5 py-6 text-center text-muted">{children}</Card>;
}

/**
 * A section of Now whose list folds away behind Show/Hide — the Inbox is the
 * one that never folds. Its title row keeps one size either way.
 */
export function FoldSection({ title, count, open, children }: { title: string; count: number; open: boolean; children: ReactNode }) {
  return (
    <Collapsible.Root defaultOpen={open} render={<section className="mt-8" />}>
      <Collapsible.Trigger className="group flex w-full items-baseline gap-2 text-left">
        <h2>{title}</h2>
        <span className="text-sm text-faint tabular-nums">{count}</span>
        <span className="grow" />
        <span className="flex items-center gap-1 text-sm text-muted group-hover:text-fg">
          <span className="group-data-panel-open:hidden">Show</span><span className="hidden group-data-panel-open:inline">Hide</span>
          <ChevronRight size={14} aria-hidden="true" className="transition-transform duration-200 group-data-panel-open:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="overflow-hidden">
        {/* The gap under the title is inside the panel, so it folds away with the list. */}
        <div className="pt-3">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** A session's title: what it was asked, without the `#42` its work item already says on the right. */
export function titleOf(request: string, issueNumber: number): string {
  return issueNumber ? request.replace(new RegExp(`^#${issueNumber}(\\s+|$)`), "") : request;
}

/** How long a gate has waited, amber once that is long. */
function Waited({ since, now }: { since: string; now: number }) {
  return <span className={waitedLong(since, now) ? "font-medium text-wait" : "text-faint"}>waiting {formatSpan(now - Date.parse(since))}</span>;
}

/** What a wait asks: "Approve the plan? plan gate · round 2", or for a question round "3 questions before the plan · round 1". */
function question(wait: Wait): ReactNode {
  const { question: asked } = verbsOf(wait);
  return wait.kind === "questions"
    ? <><span className="font-medium text-fg">{asked}</span> · round {wait.round}</>
    : <><span className="font-medium text-fg">{asked}</span> {asks(wait)} · round {wait.round}</>;
}

/** An issue or a pull request, by number, and where it stands on the forge when that is known. */
interface Item {
  kind: WorkItemKind;
  number: number;
  state: ItemState | null;
}

/**
 * A work item named in a row, with its kind's icon in its state. The row is
 * itself a link, and a link inside a link is no HTML a browser keeps, so it
 * is not one.
 */
function WorkItem({ kind, number, state }: Item) {
  return <ForgeRef kind={kind} href="" state={state}>#{number}</ForgeRef>;
}

/** A label and the work item it is about: a long label is cut short, never the number. */
function Labelled({ label, item }: { label: string; item: Item }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      <span className="truncate">{label}</span><span className="shrink-0"><WorkItem {...item} /></span>
    </span>
  );
}

/** Where a row is: its factory, and its work item — an issue, a pull request — or that it was a prompt, with none. */
function whereOf(factory: string, item: Item | null): ReactNode {
  return item === null ? `${factory} · prompt` : <Labelled label={factory} item={item} />;
}

/** Where a wait is: its factory, and the work item it is asked on. */
const waitsAt = ({ factory, issueNumber: number, issueState: state }: Pick<Wait, "factory" | "issueNumber" | "issueState">) =>
  whereOf(factory, number ? { kind: "issue", number, state } : null);

/** The gates waiting on the viewer, each opening in the drawer over Now; `selected` is the one the keys are on. */
export function InboxRows({ rows, selected, now, open }: { rows: Wait[]; selected: string | null; now: number; open: (key: string) => Go }) {
  return (
    <Rows label="Waiting on you">
      {rows.map((row) => {
        const key = keyOf(row);
        return (
          <li key={key}>
            <Row glyph={<StageGlyph name={row.gate} tone="wait" />} go={open(key)} active={key === selected}
                 title={<>
                   <span className={cx("truncate", row.blocked && "text-muted")}>{titleOf(row.workItem, row.issueNumber) || row.session}</span>
                   {row.forYou.length ? <Tag tone="mine" title={whyYours(row.forYou)}>for you</Tag> : null}
                 </>}
                 lines={[
                   question(row),
                   ...(row.summary ? [row.summary] : []),
                   ...(row.blocked ? [<i key="blocked">{row.blocked}{row.queued ? `: ${stationWords(row, now)}` : ""}</i>] : []),
                 ]}
                 where={waitsAt(row)} when={<Waited since={row.since} now={now} />} />
          </li>
        );
      })}
    </Rows>
  );
}

/** The gates waiting on someone else, and on whom; each opens in the drawer, which says why it is not the viewer's. */
export function OtherRows({ rows, now, open }: { rows: Other[]; now: number; open: (key: string) => Go }) {
  const who = useWho();
  return (
    <Rows label="Waiting on others">
      {rows.map((row) => (
        <li key={keyOf(row)}>
          <Row glyph={<StageGlyph name={row.gate} tone="wait" />} go={open(keyOf(row))}
               title={<span className="truncate">{titleOf(row.workItem, row.issueNumber) || row.session}</span>}
               lines={[<>{question(row)} · asked of {row.waitsOn.map(who).join(", ") || "someone else"}</>]}
               where={waitsAt(row)} when={<Waited since={row.since} now={now} />} />
        </li>
      ))}
    </Rows>
  );
}

/** One thing that needs attention, as a row: what it is, a line on it, and the next step, where it goes. */
interface Needed {
  key: string;
  failed: boolean;
  title: ReactNode;
  line: ReactNode;
  factory: string;
  step: string;
  href: string;
}

/**
 * What needs attention across `attention`'s factories at `now`, a row each:
 * every failed session on its own, each claim, and the rest one row a factory.
 * The gates waiting on the viewer are the Inbox's, and are not said again.
 * A claim is released from its session's page; the other steps go to the
 * factory's tab that answers them.
 */
export function neededAt(attention: { factory: string; facts: Facts }[], now: number): Needed[] {
  return attention.flatMap(({ factory, facts }) => needsAttention(facts, now).flatMap((item: Attention): Needed[] => {
    switch (item.kind) {
      case "gates":
        return [];
      case "failed":
        return item.sessions.map((failed) => ({
          key: `${factory}/failed/${failed.session}`, failed: true, factory,
          title: <>Session failed: {failed.title || failed.session}</>,
          line: `${failed.workflow} on ${failed.station || "its station"} · ${formatAgoAt(failed.endedAt, now)}`,
          step: "Open", href: sessionHref(factory, failed.session),
        }));
      case "claim":
        return [{
          key: `${factory}/claim/${item.claim.id}`, failed: false, factory,
          title: <>Claim held by a station away for {formatSpan(item.away)}</>,
          line: <Labelled label={`${item.claim.stationName} ·`} item={item.claim} />,
          step: "Release", href: sessionHref(factory, item.claim.session),
        }];
      case "drift":
        return [{
          key: `${factory}/drift`, failed: false, factory, title: "Station config drifted from the default branch",
          line: item.stations.map((station) => `${station.name}${station.badges.length ? ` (${station.badges.join(", ")})` : ""}`).join(", "),
          step: "Compare", href: tabHref(factory, "stations"),
        }];
      case "check":
        return [{
          key: `${factory}/check`, failed: true, factory, title: <><code>asf check</code> failing on the default branch</>,
          line: "the factory refuses what the check refuses", step: "See config", href: tabHref(factory, "config"),
        }];
      case "unwatched":
        return [{
          key: `${factory}/unwatched`, failed: false, factory,
          title: <>{plural(item.issues.length, "queued issue")}, no online station watching</>,
          line: <span className="inline-flex items-center gap-2">{item.issues.map((number) => <WorkItem key={number} kind="issue" number={number} state="open" />)}</span>,
          step: "Stations", href: tabHref(factory, "stations"),
        }];
    }
  }));
}

export function AttentionRows({ rows }: { rows: Needed[] }) {
  return (
    <Rows label="Needs attention">
      {rows.map((row) => (
        <li key={row.key}>
          <Row glyph={<StatusIcon status={row.failed ? "failed" : "waiting"} size={16} className="mt-1 ml-1" />} href={row.href}
               title={<span className="truncate">{row.title}</span>} lines={[row.line]} where={row.factory}
               when={<span className="text-accent">{row.step} →</span>} />
        </li>
      ))}
    </Rows>
  );
}

/**
 * A session running now: the stage it is in, its mini graph, how long it has
 * been in the phase when that is long enough to call it stuck, what it spent
 * — against its ceiling once that is close, in red once it is over — and how
 * long it has been going.
 * `progress` is its own query, undefined until it answers.
 */
export function RunningRow({ row, progress, now }: { row: Running; progress: Progress | null | undefined; now: number }) {
  const [issue, pr] = [issueNumber(row.issueUrl), prNumber(row.prUrl)];
  const phase = progress?.phase ?? null;
  const where = progress?.stage ?? (phase ? phaseName({ name: phase.name }) : "");
  const elapsed = secondsBetween(row.startedAt, now);
  return (
    <Row href={sessionHref(row.factory, row.session)}
         glyph={<RunningGlyph progress={progress} />}
         title={<span className="truncate">{titleOf(row.title, Number(issue)) || row.session}</span>}
         lines={[
           <span key="graph" className="flex flex-wrap items-center gap-x-3 gap-y-1">
             {progress ? <MiniGraph mini={progress.mini} /> : <span>{row.workflow}</span>}
             {phase && stuck(phase.since, now)
               ? <span className="font-medium text-wait">{formatDuration(secondsBetween(phase.since, now))} in {where}</span> : null}
           </span>,
         ]}
         where={whereOf(row.factory, pr ? { kind: "pr", number: Number(pr), state: row.states.pr }
           : issue ? { kind: "issue", number: Number(issue), state: row.states.issue } : null)}
         when={<>
           {expensive(row.cost, row.ceiling)
             ? <span className={cx("font-medium", row.cost >= row.ceiling ? "text-bad" : "text-wait")}>{formatDollars(row.cost)} of {formatDollars(row.ceiling)}</span>
             : <span className="text-faint">{formatDollars(row.cost)}</span>}
           <span className="text-faint"> · {formatDuration(elapsed)}</span>
         </>} />
  );
}

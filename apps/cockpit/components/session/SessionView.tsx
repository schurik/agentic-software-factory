"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { ChevronRight, Copy, Ellipsis, Trash2, X } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import type { ClaimView } from "@/convex/model/claim";
import type { SteeringView } from "@/convex/model/command";
import type { Budget } from "@/convex/model/description";
import { isLive, type SessionView as View, until } from "@/convex/model/session";
import { markOfStatus, miniOf } from "@/convex/model/graph";
import type { Chapter } from "@/convex/model/story";
import type { Purged } from "@/convex/retention";
import { formatCost, formatDuration, issueNumber, plural, pretty, prNumber, secondsBetween } from "../format";
import { ForgeDiff, type ReadDiff } from "../diff/DiffView";
import { MiniGraph, type OpenPhase, StageGraph } from "../graph/StageGraph";
import { ExternalLink, ForgeRef, StatusIcon } from "../icons";
import { PurgeForm } from "../Purge";
import { Button, buttonClass, Card, cx, menuItem, menuPopup, Notice, num, Pre, StatusPill, Table, Tabs } from "../ui";
import { useWho, ViewerLogin } from "../viewer";
import { type Action, actionFor, type Command } from "./action";
import { Details } from "./Details";
import { Journal } from "./Journal";
import { NowCard } from "./NowCard";
import { type GateOf, type PhaseTabsOf, SessionDrawer, waitingGate } from "./SessionDrawer";
import {
  chapterOpen, goTo, type SessionTab, type Shown, SHOWN, stageKey, withChapter, withGate, withPhase, withStage,
} from "./shown";
import { Timeline } from "./Timeline";
import { answeringWords } from "./words";

export type Page = View & {
  factory: string; session: string; acked: number; forge: string;
  /** The ceiling its spend is shown against; null when no `asf check` reached the cockpit. */
  budget: Budget | null;
  /** Whether the viewer may purge its bodies: an admin of its repository. */
  mayPurge?: boolean;
};

/** What the ⋯ menu holds for this viewer: copying the id always, purging for an admin of the repository. */
export function sessionMenu(page: Page): ("copy" | "purge")[] {
  return page.mayPurge ? ["copy", "purge"] : ["copy"];
}

/**
 * The session page (#104): a header with the one action that applies now,
 * the session's chapters each drawn as its stage graph, a Now card saying
 * where it is, and tabs for what the page shows nowhere else (Details), every
 * phase in order (Timeline), the journal the next agent reads and — once it
 * committed — what the session changed (Changes, #112). A stage, a phase
 * or the gate waiting opens in the drawer over it (SessionDrawer.tsx).
 *
 * Pure: everything it shows comes from `page`, the clock `now` and `shown` —
 * what the address says is open — so a test renders it from a golden session
 * with no backend (tests/sessionview.test.tsx), and a click is `onShow` with
 * the address it sets.
 */
export function SessionView({ page, now, shown = SHOWN, onShow, steering, onCommand, claims, onRelease, onPurge, phase, gate, readChanges }: {
  page: Page;
  now: number;
  shown?: Shown;
  /** Go to what the page shows next: the address a click sets. */
  onShow?: (shown: Shown) => void;
  /** The station's side of it (commands.steering): undefined while it is asked for. */
  steering?: SteeringView | null;
  /** Queue the command the header's button names. */
  onCommand?: (command: Command) => void;
  /** The claims the session took (claims.ofSession). */
  claims?: ClaimView[];
  /** Release one, confirmed. */
  onRelease?: (claim: ClaimView) => void;
  /** Purge the session's bodies, for why. Offered only where the page says the viewer may. */
  onPurge?: (reason: string) => Promise<Purged>;
  /** One phase's tabs, as the page asks for them: the phase the drawer has open. */
  phase?: PhaseTabsOf;
  /** The gate waiting, in the drawer, as the page asks for it. */
  gate?: GateOf;
  /** Read the session's changes from the forge (`diffs.changes`), when its tab is shown. */
  readChanges?: ReadDiff;
}) {
  const { summary, story, session } = page;
  const viewer = useContext(ViewerLogin);
  const who = useWho();
  const go = (to: Shown) => goTo(to, onShow);
  // The gate waiting opens as its gate, for whoever it waits on: what matters of it now is the answer.
  const waiting = waitingGate(story);
  const openPhase: OpenPhase = (phaseId) => go(waiting?.phaseId === phaseId ? withGate(shown, phaseId) : withPhase(shown, phaseId));
  const latest = story.chapters.at(-1)?.number ?? 0;
  // Where a chapter that never said it finished stops counting: now, or where the session stopped.
  const stops = until(summary, now);
  // The branch has a diff once the session committed something on top of the commit it started from.
  const changed = story.baseCommit !== "" && story.headCommit !== "";
  const tabs: { id: SessionTab; label: string }[] = [
    { id: "details", label: "Details" }, { id: "timeline", label: "Timeline" }, { id: "journal", label: "Journal" },
    ...(changed ? [{ id: "changes" as const, label: "Changes" }] : []),
  ];
  const tab = tabs.some((each) => each.id === shown.tab) ? shown.tab : SHOWN.tab;

  return (
    <div className="flex flex-col gap-5">
      <Header page={page} action={actionFor(session, summary, story, steering, now, { viewer, who })}
              onCommand={onCommand} onPurge={onPurge} />
      {summary.unread > 0 ? <Unread page={page} /> : null}
      <div className="flex flex-col gap-2 max-md:order-2">
        {story.chapters.map((chapter) => {
          const open = chapterOpen(shown, chapter.number, latest);
          const opened = shown.stages.flatMap((key) => {
            const [of, index] = key.split(".").map(Number);
            return of === chapter.number ? [index] : [];
          });
          const toggleStage = (index: number) => {
            const key = stageKey(chapter.number, index);
            onShow?.({ ...shown, stages: shown.stages.includes(key) ? shown.stages.filter((each) => each !== key) : [...shown.stages, key] });
          };
          const toggleChapter = (to: boolean) => onShow?.(withChapter(shown, chapter.number, to));
          return (
            <ChapterRow key={chapter.number} chapter={chapter} open={open} onOpen={toggleChapter} until={stops} latest={chapter.number === latest}
                        sessionDone={!isLive(summary)}>
              <StageGraph graph={chapter.graph} opened={opened} onToggle={toggleStage} openPhase={openPhase}
                          openStage={(index) => go(withStage(shown, chapter.number, index))} />
            </ChapterRow>
          );
        })}
        {summary.status === "running" ? <p className="px-1 text-sm text-muted">● live · updating as events arrive</p> : null}
      </div>
      <NowCard summary={summary} story={story} budget={page.budget} now={now} viewer={viewer} openPhase={openPhase}
               openGate={waiting && go(withGate(shown, waiting.phaseId))} className="max-md:order-1" />
      <Card className="px-5 pb-5 max-md:order-3 md:px-6">
        <Tabs label="Session" selected={tab} onSelect={(next: SessionTab) => onShow?.({ ...shown, tab: next })} tabs={tabs} />
        <div className="pt-4" role="tabpanel">
          {tab === "details" ? (
            <Details page={page} now={now} steering={steering ?? null} claims={claims ?? []} onRelease={onRelease} />
          ) : tab === "timeline" ? (
            <Timeline chapters={story.chapters} opened={shown.phase} openPhase={openPhase} />
          ) : tab === "journal" ? (
            <Journal entries={story.journalEntries} />
          ) : (
            <ForgeDiff subject={`${story.baseCommit}...${story.headCommit}`} read={readChanges}
                       title={`${summary.branch} against ${summary.baseRef || story.baseCommit.slice(0, 7)}`} />
          )}
        </div>
      </Card>
      <SessionDrawer page={page} shown={shown} onShow={onShow} phase={phase} gate={gate} />
    </div>
  );
}

function Header({ page, action, onCommand, onPurge }: {
  page: Page; action: Action | null; onCommand?: (command: Command) => void; onPurge?: (reason: string) => Promise<Purged>;
}) {
  const { summary, story, session, factory, forge } = page;
  const issue = issueNumber(summary.issueUrl);
  const pr = prNumber(summary.prUrl);
  return (
    <header>
      <div className="text-sm text-muted">{factory} / sessions / <code>{session}</code></div>
      <div className="mt-1.5 flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 grow">
          <h1>{story.title || `Session ${session}`}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            {issue ? <ForgeRef kind="issue" href={summary.issueUrl}>#{issue}</ForgeRef> : summary.trigger === "prompt" ? <span>from a prompt</span> : null}
            {pr ? <ForgeRef kind="pr" href={summary.prUrl}>#{pr}</ForgeRef> : null}
            {summary.branch ? (
              <span className="flex min-w-0 items-center gap-1">
                <ForgeRef kind="branch" href={forge ? `${forge}/${factory}/tree/${summary.branch}` : ""}>{summary.branch}</ForgeRef>
                {summary.baseRef ? <span className="text-faint">→ {summary.baseRef}</span> : null}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1 md:items-end">
          <div className="flex items-center gap-3">
            <StatusPill status={summary.status} />
            <ActionControl action={action} onCommand={onCommand} />
            <More page={page} onPurge={onPurge} />
          </div>
          {action?.kind === "command" && (action.disabledBecause || action.note) ? (
            <span className="max-w-sm text-xs text-muted md:text-right">{action.disabledBecause || action.note}</span>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function ActionControl({ action, onCommand }: { action: Action | null; onCommand?: (command: Command) => void }) {
  if (action === null) return null;
  if (action.kind === "link") {
    return <a className={buttonClass("primary")} href={action.href}>{action.label} <ExternalLink size={14} aria-hidden="true" /></a>;
  }
  if (action.kind === "words") return <span className="text-sm text-muted">{action.label}</span>;
  return (
    <Button variant={action.command === "kill" ? "danger" : "primary"} disabled={action.disabledBecause !== "" || !onCommand}
            onClick={() => onCommand?.(action.command)}>{action.label}</Button>
  );
}

/** What is rarely needed and never first: copying the id, and purging the session's bodies. */
function More({ page, onPurge }: { page: Page; onPurge?: (reason: string) => Promise<Purged> }) {
  const [purging, setPurging] = useState(false);
  const items = sessionMenu(page).filter((item) => item !== "purge" || onPurge);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger aria-label="More" className={cx(buttonClass("secondary", "icon"), "text-muted hover:text-fg data-popup-open:bg-surface-2")}>
          <Ellipsis size={16} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50">
            <Menu.Popup className={menuPopup}>
              <Menu.Item className={menuItem} onClick={() => void navigator.clipboard?.writeText(page.session)}>
                <Copy size={14} aria-hidden="true" className="text-muted" /> Copy session id
                <code className="ml-auto text-xs text-faint">{page.session}</code>
              </Menu.Item>
              {items.includes("purge") ? (
                <>
                  <Menu.Separator className="my-1 h-px bg-line" />
                  <Menu.Item className={cx(menuItem, "text-bad data-highlighted:bg-bad-soft")} onClick={() => setPurging(true)}>
                    <Trash2 size={14} aria-hidden="true" /> Purge session…
                  </Menu.Item>
                  <div className="max-w-64 px-2.5 pb-1.5 pl-[2.1rem] text-xs text-muted">Removes the bodies this cockpit keeps; the events stay.</div>
                </>
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {onPurge ? (
        <Dialog.Root open={purging} onOpenChange={setPurging}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 dark:bg-black/60" />
            <Dialog.Popup className="fixed top-[12dvh] left-1/2 z-50 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-surface p-5 shadow-pop">
              <div className="mb-3 flex items-start gap-3">
                <Dialog.Title className="grow text-lg font-semibold">Purge session {page.session}</Dialog.Title>
                <Dialog.Close aria-label="Close" className={buttonClass("ghost", "sm")}><X size={14} aria-hidden="true" /></Dialog.Close>
              </div>
              <PurgeForm label="Purge bodies" onPurge={onPurge}
                         explains="Removes every artifact's content, every command's output and the transcript from this cockpit. The events stay — phases, gates, decisions, cost — and so does a line saying who purged them, when and why." />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}

/**
 * One chapter, one row: open, its stage graph; folded, one line with a mini
 * graph, how long it took and what it cost. The row's header keeps one size
 * either way, so nothing below it jumps.
 */
function ChapterRow({ chapter, open, onOpen, until, latest, sessionDone, children }: {
  chapter: Chapter; open: boolean; onOpen: (open: boolean) => void; until: number; latest: boolean; sessionDone: boolean;
  children: ReactNode;
}) {
  const took = secondsBetween(chapter.startedAt, chapter.endedAt ? Date.parse(chapter.endedAt) : until);
  return (
    <Collapsible.Root open={open} onOpenChange={onOpen}
                      render={<section data-chapter={chapter.number} data-open={open} className="rounded-xl border border-line bg-surface shadow-card" />}>
      <Collapsible.Trigger className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left md:px-5">
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-faint transition-transform duration-200 group-data-panel-open:rotate-90" />
        <span className="text-xs font-medium tracking-wider text-faint uppercase">{chapter.number ? `Chapter ${chapter.number}` : "Chapter"}</span>
        <span className="font-semibold">{chapter.title}</span>
        <span className="text-sm text-muted">
          {chapter.answering ? answeringWords(chapter.answering) : chapter.input === "prompt" ? "from a prompt" : ""}
        </span>
        {open ? null : <MiniGraph mini={miniOf(chapter.graph)} />}
        <span className="grow" />
        <span className="flex items-center gap-3 text-sm text-muted tabular-nums">
          <span>{formatDuration(took)}</span>
          <span>{formatCost(chapter.cost)}</span>
          {/* The chapter in progress says its status once, in the header's pill. */}
          {latest && !sessionDone ? null : <StatusIcon status={markOfStatus(chapter.status)} />}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="overflow-hidden">
        <div className="px-4 pb-4 md:px-5 md:pb-5">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}


/** The events this cockpit cannot read, listed as they were sent: nothing is hidden, and the page says to upgrade. */
function Unread({ page }: { page: Page }) {
  const unread = page.events.filter((row) => row.unreadBecause);
  return (
    <Notice>
      <details open>
        <summary>{plural(unread.length, "event")} of this session came from a newer factory than
          this cockpit reads: upgrade the cockpit to read them.</summary>
        <Table className="mt-3 text-sm">
          <thead><tr><th className={num}>seq</th><th>kind</th><th>why it is shown as sent</th></tr></thead>
          <tbody>
            {unread.map((row) => (
              <tr key={row.seq}>
                <td className={num}>{row.seq}</td>
                <td><code>{row.kind}</code> <span className="text-muted">v{row.v}</span></td>
                <td>{row.unreadBecause}<Pre className="mt-1">{pretty(row.raw)}</Pre></td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </Notice>
  );
}

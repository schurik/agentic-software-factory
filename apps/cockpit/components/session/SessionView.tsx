"use client";

import { type ReactNode, useState } from "react";
import type { ClaimView } from "@/convex/model/claim";
import type { Budget } from "@/convex/model/description";
import { liveness, type SteeringView } from "@/convex/model/command";
import type { SessionView as View } from "@/convex/model/session";
import type { Item, Story } from "@/convex/model/story";
import type { Purged } from "@/convex/retention";
import { ClaimRow } from "../ClaimRow";
import { Purge } from "../Purge";
import { formatAgo, formatCost, formatDollars, formatDuration, formatNumber, formatTime, formatTokenCount, formatTokens, pretty } from "../format";
import { Button, buttonClass, Card, cx, Facts, Notice, num, Pre, StatusPill, Table, Tabs } from "../ui";
import { useWho } from "../viewer";
import { actionFor, type Command } from "./action";
import { Chapter, chapterAnchor, phaseAnchor } from "./Chapter";
import { channelWords, glyphOf, toneOf } from "./words";

export type Page = View & {
  factory: string; session: string; acked: number; forge: string;
  /** The ceiling its spend is shown against; null when no `asf check` reached the cockpit. */
  budget: Budget | null;
  /** Whether the viewer may purge its bodies: an admin of its repository. */
  mayPurge?: boolean;
};

/**
 * The session page: a top bar with the one action that applies now, a sidebar
 * with the run's facts and its outline or journal, and the story in chapters.
 * It reads gates and never answers them — answering has one place, the inbox.
 *
 * Pure: everything it shows comes from `page` and the clock `now`, so a test
 * renders it from a golden session with no backend (tests/sessionview.test.tsx).
 */
export function SessionView({ page, now, steering, onCommand, claims, onRelease, onPurge }: {
  page: Page;
  now: number;
  /** The station's side of it (commands.steering): undefined while it is asked for. */
  steering?: SteeringView | null;
  /** Queue the command the top bar's button names. */
  onCommand?: (command: Command) => void;
  /** The claims the session took (claims.ofSession). */
  claims?: ClaimView[];
  /** Release one, confirmed. */
  onRelease?: (claim: ClaimView) => void;
  /** Purge the session's bodies, for why. Offered only where the page says the viewer may. */
  onPurge?: (reason: string) => Promise<Purged>;
}) {
  const { summary, story, session, factory } = page;
  const who = useWho();
  const action = actionFor(factory, session, summary, story, steering, now, who);
  const command = action?.command ?? null;
  return (
    <div>
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-line pb-4">
        <div className="min-w-0 grow">
          <div className="text-sm text-muted">{factory} / sessions / <code>{session}</code></div>
          <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0">{story.title || `Session ${session}`}</span>
            <StatusPill status={summary.status} />
          </h1>
        </div>
        {action ? (
          <div className="flex flex-wrap items-center gap-3">
            {action.disabledBecause || action.note ? (
              <span className="max-w-sm text-sm text-muted sm:text-right">{action.disabledBecause || action.note}</span>
            ) : null}
            {action.href ? <a className={buttonClass("primary")} href={action.href}>{action.label}{action.href.startsWith("/") ? "" : " ↗"}</a>
              : <Button variant={command === "kill" ? "danger" : "primary"}
                        disabled={action.disabledBecause !== "" || command === null || !onCommand}
                        onClick={() => command && onCommand?.(command)}>{action.label}</Button>}
          </div>
        ) : null}
      </header>

      {summary.unread > 0 ? (
        <Notice>
          {summary.unread} event{summary.unread === 1 ? "" : "s"} of this session came from a newer factory
          than this cockpit reads. They are stored and listed under every event below; upgrade the cockpit to read them.
        </Notice>
      ) : null}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <Sidebar page={page} now={now} steering={steering ?? null} claims={claims ?? []} onRelease={onRelease} onPurge={onPurge} />
        <div className="min-w-0">
          <NowCard story={story} status={summary.status} cost={summary.totalCost} />
          {story.chapters.map((chapter) => (
            <Chapter key={chapter.number} chapter={chapter} where={{ factory, session, forge: page.forge }} />
          ))}
          {summary.status === "running" ? <p className="mt-2 text-sm text-muted sm:ml-20">● live · updating as events arrive</p> : null}
          <Events page={page} now={now} />
        </div>
      </div>
    </div>
  );
}

function Sidebar({ page, now, steering, claims, onRelease, onPurge }: {
  page: Page; now: number; steering: SteeringView | null; claims: ClaimView[]; onRelease?: (claim: ClaimView) => void;
  onPurge?: (reason: string) => Promise<Purged>;
}) {
  const [tab, setTab] = useState<"outline" | "journal">("outline");
  const who = useWho();
  const { summary, story } = page;
  const ran = summary.startedAt
    ? ((summary.endedAt ? Date.parse(summary.endedAt) : now) - Date.parse(summary.startedAt)) / 1000 : null;
  return (
    <aside className="grid gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-auto">
      <Card className="p-4">
        <Facts className="text-sm">
          <dt>Chapter</dt><dd><b className="font-medium">{story.now.chapter || "—"}</b></dd>
          <dt>Station</dt>
          <dd>
            {story.station.name ? <code>{story.station.name}</code> : "—"}
            {story.station.runBy ? <div className="text-muted">run by {who(story.station.runBy)}</div> : null}
            <Liveness steering={steering} now={now} />
            <div className="text-muted">last heard from {formatAgo(summary.lastEventAt, now)}</div>
          </dd>
          <dt>Triggered by</dt><dd>{who(summary.triggeredBy) || "—"}</dd>
          <dt>Started</dt><dd>{formatTime(summary.startedAt, now)}{ran !== null && ran >= 0 ? <span className="text-muted"> · {formatDuration(ran)}</span> : null}</dd>
          <dt>Cost</dt><dd><Spent cost={summary.totalCost} tokens={summary.totalTokens} budget={page.budget} /></dd>
          <dt>Branch</dt><dd>{summary.branch ? <code>{summary.branch}</code> : "—"}</dd>
          <dt>Base</dt>
          <dd>{summary.baseRef ? <code>{summary.baseRef}</code> : "—"}{story.baseCommit ? <> at <code>{story.baseCommit.slice(0, 7)}</code></> : null}</dd>
          <dt>Links</dt>
          <dd>
            {summary.issueUrl ? <a href={summary.issueUrl}>issue</a> : null}
            {summary.issueUrl && summary.prUrl ? " · " : null}
            {summary.prUrl ? <a href={summary.prUrl}>pull request</a> : null}
            {!summary.issueUrl && !summary.prUrl ? "—" : null}
          </dd>
          {claims.length ? (
            <>
              <dt>Claim</dt>
              <dd>{claims.map((claim) => <ClaimRow key={claim.id} claim={claim} now={now} onRelease={onRelease} />)}</dd>
            </>
          ) : null}
        </Facts>
      </Card>
      <Card className="p-3">
        <Tabs label="Session" selected={tab} onSelect={setTab}
              tabs={[{ id: "outline", label: "Outline" }, { id: "journal", label: "Journal" }]} />
        <div className="pt-3">
          {tab === "outline" ? <Outline story={story} /> : (
            <div>
              <pre className="text-xs">{story.journal || "Nothing has closed yet: the next agent would be told nothing."}</pre>
              <p className="mt-2 text-sm text-muted">
                Exactly what the next agent reads. ⚑ is a report an agent filed; ✎ is an instruction a person gave.
              </p>
            </div>
          )}
        </div>
      </Card>
      {page.mayPurge && onPurge ? (
        <Purge label="Purge bodies" onPurge={onPurge}
               explains="Removes every artifact's content, every command's output and the transcript from this cockpit. The events stay — phases, gates, decisions, cost — and so does a line saying who purged them, when and why." />
      ) : null}
    </aside>
  );
}

/**
 * What the session spent, against the per-session ceiling the factory
 * enforces — in money and in tokens, each only where factory.yaml sets one —
 * and never against anything else: no budget per period exists to show.
 */
function Spent({ cost, tokens, budget }: { cost: number; tokens: number; budget: Budget | null }) {
  const money = formatDollars(cost);
  const counted = formatTokens(tokens);
  const note = <div className="text-muted">list-price equivalent</div>;
  if (budget === null || (!budget.maxCostUsd && !budget.maxTokens)) {
    return (
      <>
        <b className="font-medium">{money}</b> <span className="text-muted">· {counted}</span>
        <div className="text-muted">
          {budget === null ? "ceiling unknown: no asf check has reached the cockpit" : "no per-session budget"}
        </div>
        {note}
      </>
    );
  }
  return (
    <>
      <Against spent={cost} ceiling={budget.maxCostUsd}
               words={budget.maxCostUsd ? <><b className="font-medium">{money}</b> of {formatDollars(budget.maxCostUsd)} per-session ceiling</>
                 : <><b className="font-medium">{money}</b> · no cost ceiling</>} />
      <Against spent={tokens} ceiling={budget.maxTokens}
               words={budget.maxTokens ? <>{formatTokenCount(tokens)} of {formatTokens(budget.maxTokens)}</>
                 : <>{counted} · no token ceiling</>} />
      {note}
    </>
  );
}

function Against({ spent, ceiling, words }: { spent: number; ceiling: number; words: ReactNode }) {
  const share = ceiling ? spent / ceiling : null;
  return (
    <div className="mb-1.5">
      {words}
      {share === null ? null : (
        <>
          <span className="text-muted"> · {Math.round(share * 100)}%</span>
          <Gauge share={share} />
        </>
      )}
    </div>
  );
}

/**
 * Whether anything of the station is polling for this session's commands,
 * and when it last did: read off the polls it makes anyway, never a heartbeat.
 */
function Liveness({ steering, now }: { steering: SteeringView | null; now: number }) {
  const who = useWho();
  const station = steering?.station ?? null;
  if (station === null) return <div className="text-muted">○ takes no commands from here</div>;
  const live = liveness(station.seenAt, steering!.attendedAt, now);
  const seen = live.lastSeen === null ? "never polled for commands"
    : `last seen ${formatAgo(new Date(live.lastSeen).toISOString(), now)}`;
  const state = !station.registered ? "○ takes no commands: its token was revoked"
    : live.attended ? "● attended" : live.online ? "● online" : "○ offline";
  return (
    <>
      {station.owner ? <div className="text-muted">owned by {who(station.owner)}</div> : null}
      <div className={live.attended || live.online ? "text-ok" : "text-muted"}>{state} · {seen}</div>
    </>
  );
}

function Outline({ story }: { story: Story }) {
  return (
    <nav aria-label="Outline" className="grid text-sm">
      {story.chapters.map((chapter) => (
        <div key={chapter.number} className="grid">
          <a className="mt-3 px-1.5 text-xs font-medium tracking-wider text-muted uppercase first:mt-0" href={`#${chapterAnchor(chapter.number)}`}>
            {chapter.number ? `${chapter.number} · ` : ""}{chapter.title}
          </a>
          {chapter.reader ? <OutlineEntry item={chapter.reader} /> : null}
          {chapter.items.map((item) => <OutlineEntry key={`${item.type}-${item.seq}`} item={item} />)}
        </div>
      ))}
    </nav>
  );
}

function OutlineEntry({ item }: { item: Item }) {
  if (item.type === "automatic" || item.type === "resumed") return null;
  const label = item.type === "gate" ? `${item.gate || item.name} gate · round ${item.round || 1}` : item.name;
  return (
    <a href={`#${phaseAnchor(item.phaseId)}`}
       className={cx("flex gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:no-underline", item.type === "code" ? "text-muted" : "text-fg")}>
      <span className="w-4 shrink-0 text-center">{glyphOf(item.status)}</span><span className="min-w-0">{label}</span>
      {item.type !== "gate" ? <span className="ml-auto text-muted tabular-nums">{formatDuration(item.duration)}</span> : null}
    </a>
  );
}

/** What is happening now, in one sentence, and what it has cost so far. */
function NowCard({ story, status, cost }: { story: Story; status: string; cost: number }) {
  const { now } = story;
  let said: React.ReactNode;
  if (status === "running") {
    said = now.phase ? <><b className="font-semibold">{now.phase.owner || now.phase.name}</b> is working on <b className="font-semibold">{now.phase.name}</b> in {now.chapter}</>
      : <>Running {now.chapter}</>;
  } else if (status === "waiting" && now.waiting) {
    const where = `on ${channelWords(now.waiting.channel, now.waiting.issueNumber)}`;
    said = <>Waiting on a person: the <b className="font-semibold">{now.waiting.gate} {now.waiting.kind === "questions" ? "questions" : "gate"}</b>, round {now.waiting.round}, asked {where}</>;
  } else if (status === "fail") {
    said = now.failed ? <>Failed in <b className="font-semibold">{now.failed.name}</b>{now.failed.error ? `: ${now.failed.error}` : ""}</> : <>Failed</>;
  } else if (status === "success") {
    const over = `over ${now.chapters} chapter${now.chapters === 1 ? "" : "s"}`;
    said = now.prUrl ? <>All work landed in <a href={now.prUrl}>pull request #{now.prUrl.split("/").pop()}</a> {over}</>
      : <>Finished {over}</>;
  } else {
    said = <>Nothing has started yet</>;
  }
  return (
    <Card className={cx("flex flex-wrap items-center gap-x-6 gap-y-3 border-t-[3px] px-4 py-3.5", EDGE[toneOf(status)] ?? "border-t-line-strong")}>
      <div className="min-w-0 grow basis-64">
        <div className="text-xs font-medium tracking-wider text-muted uppercase">Now</div>
        <div className="mt-0.5 text-lg">{said}</div>
      </div>
      <div className="flex gap-5 text-right">
        <div className="grid"><b className="font-semibold tabular-nums">{formatCost(cost)}</b><span className="text-xs text-muted">cost</span></div>
        <div className="grid"><b className="font-semibold tabular-nums">{formatNumber(story.agentPhases)}</b><span className="text-xs text-muted">agent phases</span></div>
        <div className="grid"><b className="font-semibold tabular-nums">{formatNumber(story.toolCalls)}</b><span className="text-xs text-muted">tool calls</span></div>
      </div>
    </Card>
  );
}

/** Every stored event, the ones this cockpit cannot read among them: nothing is hidden. */
function Events({ page, now }: { page: Page; now: number }) {
  const { events } = page;
  return (
    <details className="mt-10" open={page.summary.unread > 0}>
      <summary className="text-muted">Every event ({formatNumber(events.length)}, received up to seq {page.acked})</summary>
      <Table className="mt-3 text-sm">
        <thead>
          <tr><th className={num}>seq</th><th>kind</th><th>what happened</th><th>at</th></tr>
        </thead>
        <tbody>
          {events.map((row) => (
            <tr key={row.seq} className={row.unreadBecause ? "text-muted" : undefined}>
              <td className={num}>{row.seq}</td>
              <td><code>{row.kind}</code>{row.v > 1 || row.unreadBecause ? <span className="text-muted"> v{row.v}</span> : null}</td>
              <td>
                {row.unreadBecause ? (
                  <details>
                    <summary>{row.unreadBecause} — shown as sent</summary>
                    <Pre className="mt-1">{pretty(row.raw)}</Pre>
                  </details>
                ) : row.detail}
              </td>
              <td className="whitespace-nowrap">{formatTime(row.ts, now)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </details>
  );
}

/** How much of a ceiling is spent: the accent, amber from 80%, red at the ceiling. */
function Gauge({ share }: { share: number }) {
  const tone = share >= 1 ? "bg-bad" : share >= 0.8 ? "bg-wait" : "bg-accent";
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(share, 1) * 100)}
          className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-3">
      <span className={cx("block h-full rounded-full", tone)} style={{ width: `${Math.min(share, 1) * 100}%` }} />
    </span>
  );
}

const EDGE: Record<string, string> = { ok: "border-t-ok", bad: "border-t-bad", wait: "border-t-wait", run: "border-t-accent" };

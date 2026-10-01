"use client";

import { useState } from "react";
import type { ClaimView } from "@/convex/model/claim";
import { liveness, type SteeringView } from "@/convex/model/command";
import type { SessionView as View } from "@/convex/model/session";
import type { Item, Story } from "@/convex/model/story";
import { Status } from "../Status";
import { formatAgo, formatCost, formatDuration, formatSpan, formatTime, pretty } from "../format";
import { actionFor, type Command } from "./action";
import { Chapter, chapterAnchor, phaseAnchor } from "./Chapter";
import { channelWords, glyphOf, toneOf } from "./words";

export type Page = View & { factory: string; session: string; acked: number; forge: string };

/**
 * The session page: a top bar with the one action that applies now, a sidebar
 * with the run's facts and its outline or journal, and the story in chapters.
 * It reads gates and never answers them — answering has one place, the inbox.
 *
 * Pure: everything it shows comes from `page` and the clock `now`, so a test
 * renders it from a golden session with no backend (tests/sessionview.test.tsx).
 */
export function SessionView({ page, now, steering, onCommand, claims, onRelease }: {
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
}) {
  const { summary, story, session, factory } = page;
  const action = actionFor(factory, session, summary, story, steering, now);
  const command = action?.command ?? null;
  return (
    <div className="session">
      <header className="topbar">
        <div className="grow">
          <div className="muted small">{factory} / sessions / <code>{session}</code></div>
          <h1>{story.title || `Session ${session}`}</h1>
        </div>
        <Status status={summary.status} />
        {action ? (
          <div className="action">
            {action.disabledBecause || action.note ? (
              <span className="why small muted">{action.disabledBecause || action.note}</span>
            ) : null}
            {action.href ? <a className="button" href={action.href}>{action.label}{action.href.startsWith("/") ? "" : " ↗"}</a>
              : <button className="button" disabled={action.disabledBecause !== "" || command === null || !onCommand}
                        onClick={() => command && onCommand?.(command)}>{action.label}</button>}
          </div>
        ) : null}
      </header>

      {summary.unread > 0 ? (
        <p className="notice">
          {summary.unread} event{summary.unread === 1 ? "" : "s"} of this session came from a newer factory
          than this cockpit reads. They are stored and listed under every event below; upgrade the cockpit to read them.
        </p>
      ) : null}

      <div className="layout">
        <Sidebar page={page} now={now} steering={steering ?? null} claims={claims ?? []} onRelease={onRelease} />
        <div className="story">
          <NowCard story={story} status={summary.status} cost={summary.totalCost} />
          {story.chapters.map((chapter) => (
            <Chapter key={chapter.number} chapter={chapter} where={{ factory, session, forge: page.forge }} />
          ))}
          {summary.status === "running" ? <p className="live muted small">● live · updating as events arrive</p> : null}
          <Events page={page} />
        </div>
      </div>
    </div>
  );
}

function Sidebar({ page, now, steering, claims, onRelease }: {
  page: Page; now: number; steering: SteeringView | null; claims: ClaimView[]; onRelease?: (claim: ClaimView) => void;
}) {
  const [tab, setTab] = useState<"outline" | "journal">("outline");
  const { summary, story } = page;
  const ran = summary.startedAt
    ? ((summary.endedAt ? Date.parse(summary.endedAt) : now) - Date.parse(summary.startedAt)) / 1000 : null;
  return (
    <aside className="sidebar">
      <dl className="facts">
        <dt>Chapter</dt><dd><b>{story.now.chapter || "—"}</b></dd>
        <dt>Station</dt>
        <dd>
          {story.station.name ? <code>{story.station.name}</code> : "—"}
          {story.station.runBy ? <div className="muted small">run by {story.station.runBy}</div> : null}
          <Liveness steering={steering} now={now} />
          <div className="muted small">last heard from {formatAgo(summary.lastEventAt, now)}</div>
        </dd>
        <dt>Triggered by</dt><dd>{summary.triggeredBy || "—"}</dd>
        <dt>Started</dt><dd>{formatTime(summary.startedAt)}{ran !== null && ran >= 0 ? <span className="muted"> · {formatDuration(ran)}</span> : null}</dd>
        <dt>Cost</dt><dd><b>{formatCost(summary.totalCost)}</b> <span className="muted">· {summary.totalTokens.toLocaleString()} tokens</span></dd>
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
            <dd>{claims.map((claim) => <Claim key={claim.id} claim={claim} now={now} onRelease={onRelease} />)}</dd>
          </>
        ) : null}
      </dl>
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === "outline"} onClick={() => setTab("outline")}>Outline</button>
        <button role="tab" aria-selected={tab === "journal"} onClick={() => setTab("journal")}>Journal</button>
      </div>
      {tab === "outline" ? <Outline story={story} /> : (
        <div className="journal">
          <pre>{story.journal || "Nothing has closed yet: the next agent would be told nothing."}</pre>
          <p className="muted small">
            Exactly what the next agent reads. ⚑ is a report an agent filed; ✎ is an instruction a person gave.
          </p>
        </div>
      )}
    </aside>
  );
}

/**
 * Whether anything of the station is polling for this session's commands,
 * and when it last did: read off the polls it makes anyway, never a heartbeat.
 */
function Liveness({ steering, now }: { steering: SteeringView | null; now: number }) {
  const station = steering?.station ?? null;
  if (station === null) return <div className="muted small">○ takes no commands from here</div>;
  const live = liveness(station.seenAt, steering!.attendedAt, now);
  const seen = live.lastSeen === null ? "never polled for commands"
    : `last seen ${formatAgo(new Date(live.lastSeen).toISOString(), now)}`;
  const state = !station.registered ? "○ takes no commands: its token was revoked"
    : live.attended ? "● attended" : live.online ? "● online" : "○ offline";
  return (
    <>
      {station.owner ? <div className="muted small">owned by {station.owner}</div> : null}
      <div className={`small liveness ${live.attended || live.online ? "on" : "off"}`}>{state} · {seen}</div>
    </>
  );
}

const RELEASED_WHY: Record<string, string> = {
  finished: "freed: the run finished", aborted: "freed: the run was aborted", "never started": "given back: the run never started",
};

/**
 * A work item the session claimed (ADR 0003): which station holds it and how
 * long that station has been away — away, never "orphaned": a laptop asleep
 * over a weekend is not a dead one, and nothing releases a claim by the clock.
 * A writer may release it, in two steps, the second saying what that does.
 */
function Claim({ claim, now, onRelease }: { claim: ClaimView; now: number; onRelease?: (claim: ClaimView) => void }) {
  const [asking, setAsking] = useState(false);
  const item = `${claim.kind === "pr" ? "pull request" : "issue"} #${claim.number}`;
  const consequence = claim.consequence.charAt(0).toUpperCase() + claim.consequence.slice(1);
  if (claim.released !== null) {
    const { by, why } = claim.released;
    return <div className="small muted">{item} {why === "released" ? `released by ${by || "someone"}: session abandoned` : RELEASED_WHY[why] ?? why}</div>;
  }
  const away = claim.seenAt === 0 ? "its station loop never polled"
    : liveness(claim.seenAt, null, now).online ? "online" : `offline ${formatSpan(now - claim.seenAt)}`;
  return (
    <div className="claim">
      <div className="small">{item} held by <code>{claim.stationName}</code>, {away}</div>
      {claim.refused !== null ? <div className="muted small">{claim.refused}</div>
        : asking ? (
          <div className="confirm small">
            {consequence}.{" "}
            <button className="button small danger" onClick={() => { setAsking(false); onRelease?.(claim); }}>Release</button>{" "}
            <button className="link small" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        ) : (
          <button className="button small" title={consequence} disabled={!onRelease} onClick={() => setAsking(true)}>Release claim</button>
        )}
    </div>
  );
}

function Outline({ story }: { story: Story }) {
  return (
    <nav className="outline">
      {story.chapters.map((chapter) => (
        <div key={chapter.number}>
          <a className="oc" href={`#${chapterAnchor(chapter.number)}`}>
            {chapter.number ? `${chapter.number} · ` : ""}{chapter.title}
          </a>
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
    <a href={`#${phaseAnchor(item.phaseId)}`} className={item.type === "code" ? "sub" : undefined}>
      <span className="glyph">{glyphOf(item.status)}</span>{label}
      {item.type !== "gate" ? <span className="d">{formatDuration(item.duration)}</span> : null}
    </a>
  );
}

/** What is happening now, in one sentence, and what it has cost so far. */
function NowCard({ story, status, cost }: { story: Story; status: string; cost: number }) {
  const { now } = story;
  let said: React.ReactNode;
  if (status === "running") {
    said = now.phase ? <><b>{now.phase.owner || now.phase.name}</b> is working on <b>{now.phase.name}</b> in {now.chapter}</>
      : <>Running {now.chapter}</>;
  } else if (status === "waiting" && now.waiting) {
    const where = `on ${channelWords(now.waiting.channel, now.waiting.issueNumber)}`;
    said = <>Waiting on a person: the <b>{now.waiting.gate} {now.waiting.kind === "questions" ? "questions" : "gate"}</b>, round {now.waiting.round}, asked {where}</>;
  } else if (status === "fail") {
    said = now.failed ? <>Failed in <b>{now.failed.name}</b>{now.failed.error ? `: ${now.failed.error}` : ""}</> : <>Failed</>;
  } else if (status === "success") {
    const over = `over ${now.chapters} chapter${now.chapters === 1 ? "" : "s"}`;
    said = now.prUrl ? <>All work landed in <a href={now.prUrl}>pull request #{now.prUrl.split("/").pop()}</a> {over}</>
      : <>Finished {over}</>;
  } else {
    said = <>Nothing has started yet</>;
  }
  return (
    <div className={`now tone-${toneOf(status)}`}>
      <div className="grow">
        <div className="label">Now</div>
        <div className="big">{said}</div>
      </div>
      <div className="stats">
        <div><b>{formatCost(cost)}</b><span>cost</span></div>
        <div><b>{story.agentPhases}</b><span>agent phases</span></div>
        <div><b>{story.toolCalls}</b><span>tool calls</span></div>
      </div>
    </div>
  );
}

/** Every stored event, the ones this cockpit cannot read among them: nothing is hidden. */
function Events({ page }: { page: Page }) {
  const { events } = page;
  return (
    <details className="all-events" open={page.summary.unread > 0}>
      <summary>Every event ({events.length}, received up to seq {page.acked})</summary>
      <table className="table events">
        <thead>
          <tr><th className="num">seq</th><th>kind</th><th>what happened</th><th>at</th></tr>
        </thead>
        <tbody>
          {events.map((row) => (
            <tr key={row.seq} className={row.unreadBecause ? "generic" : undefined}>
              <td className="num">{row.seq}</td>
              <td><code>{row.kind}</code>{row.v > 1 || row.unreadBecause ? <span className="muted"> v{row.v}</span> : null}</td>
              <td>
                {row.unreadBecause ? (
                  <details>
                    <summary>{row.unreadBecause} — shown as sent</summary>
                    <pre>{pretty(row.raw)}</pre>
                  </details>
                ) : row.detail}
              </td>
              <td>{formatTime(row.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

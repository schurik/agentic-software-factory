import type { ClaimView } from "@/convex/model/claim";
import { liveness, type SteeringView } from "@/convex/model/command";
import type { Budget } from "@/convex/model/description";
import { ClaimRow } from "../ClaimRow";
import { formatAgo, formatTime, formatTokenCount, formatTokens, plural } from "../format";
import { Facts } from "../ui";
import { useWho } from "../viewer";
import type { Page } from "./SessionView";

/**
 * What the page shows nowhere else (#104): the station and whether it is
 * there, what started the session and when, its tokens against their limit,
 * the commit it branched from, the claim it holds, and whether its transcript
 * is kept. The work item, pull request and branch are under the title; the
 * spend is on the Now card; purging is in the ⋯ menu.
 */
export function Details({ page, now, steering, claims, onRelease }: {
  page: Page; now: number; steering: SteeringView | null; claims: ClaimView[]; onRelease?: (claim: ClaimView) => void;
}) {
  const who = useWho();
  const { summary, story } = page;
  return (
    <Facts className="text-sm md:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
      <dt>Station</dt>
      <dd>
        {story.station.name ? <code>{story.station.name}</code> : "—"}
        {story.station.runBy ? <span className="text-muted"> run by {who(story.station.runBy)}</span> : null}
        <Liveness steering={steering} now={now} />
        <div className="text-muted">last heard from {formatAgo(summary.lastEventAt, now)}</div>
      </dd>
      <dt>Triggered by</dt>
      <dd>{who(summary.triggeredBy) || "—"}{summary.trigger ? <span className="text-muted"> · {summary.trigger}</span> : null}</dd>
      <dt>Started</dt><dd className="tabular-nums">{formatTime(summary.startedAt, now)}</dd>
      <dt>Tokens</dt><dd><Tokens spent={summary.totalTokens} budget={page.budget} /></dd>
      <dt>Base commit</dt>
      <dd>{story.baseCommit ? <code>{story.baseCommit.slice(0, 7)}</code> : "—"}</dd>
      <dt>Claim</dt>
      <dd>{claims.length ? claims.map((claim) => <ClaimRow key={claim.id} claim={claim} now={now} onRelease={onRelease} />)
        : <span className="text-muted">none held</span>}</dd>
      <dt>Transcripts</dt>
      <dd>
        {page.transcripts
          ? <>on: the prompts and the harness&apos;s output are kept{summary.transcriptDays ? `, for ${plural(summary.transcriptDays, "day")} after it finishes` : ""}</>
          : <>none kept: the session shipped no prompt and no tool call&apos;s arguments.{" "}
            <code>cockpit: {"{transcripts: true}"}</code> in <code>asf/factory.yaml</code> sends them</>}
      </dd>
    </Facts>
  );
}

/** Tokens spent, against the per-session limit factory.yaml sets, where it sets one. */
function Tokens({ spent, budget }: { spent: number; budget: Budget | null }) {
  if (!budget?.maxTokens) {
    return <>{formatTokens(spent)}<span className="text-muted"> · {budget === null ? "limit unknown: no asf check has reached the cockpit" : "no limit"}</span></>;
  }
  const share = Math.min(spent / budget.maxTokens, 1);
  return (
    <>
      {formatTokenCount(spent)} of {formatTokens(budget.maxTokens)}
      <span role="meter" aria-label="Tokens against the session's limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}
            className="mt-1 block h-1 w-48 max-w-full overflow-hidden rounded-full bg-surface-3">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
      </span>
    </>
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
    : live.attended ? "● attended" : live.online ? "● online" : "○ away";
  return (
    <>
      {station.owner ? <div className="text-muted">owned by {who(station.owner)}</div> : null}
      <div className={live.attended || live.online ? "text-ok" : "text-muted"}>{state} · {seen}</div>
    </>
  );
}

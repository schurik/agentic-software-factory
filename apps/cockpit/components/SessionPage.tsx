"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Status } from "./Status";
import { formatCost, formatTime, formatWaitingFor } from "./format";

export function SessionPage({ factory, session }: { factory: string; session: string }) {
  const page = useQuery(api.sessions.get, { factory, session });
  if (page === undefined) return <p className="muted">Loading…</p>;
  if (page === null) return <p className="notice">No station has shipped session <code>{session}</code> of {factory}.</p>;
  const { summary, phases, events } = page;

  return (
    <>
      <h1>
        <code>{session}</code> <Status status={summary.status} />
      </h1>
      <p className="muted">
        {factory} · {summary.workflows.join(" → ") || "workflow not yet known"}
        {summary.request ? <> · {summary.request}</> : null}
      </p>

      {summary.unread > 0 ? (
        <p className="notice">
          {summary.unread} event{summary.unread === 1 ? "" : "s"} of this session came from a newer factory
          than this cockpit reads. They are stored and shown raw below; upgrade the cockpit to read them.
        </p>
      ) : null}

      <dl className="facts">
        <dt>Waiting for</dt>
        <dd>{formatWaitingFor(summary.waitingFor)}{summary.waitingFor ? ` · on the ${summary.waitingFor.channel}` : null}</dd>
        <dt>Station</dt><dd>{summary.stationName || "—"}{summary.skillVersion ? ` · stamped at ${summary.skillVersion}` : null}</dd>
        <dt>Branch</dt><dd>{summary.branch ? <code>{summary.branch}</code> : "—"}{summary.baseRef ? <> from <code>{summary.baseRef}</code></> : null}</dd>
        <dt>Triggered</dt><dd>{summary.trigger || "—"}{summary.triggeredBy ? ` by ${summary.triggeredBy}` : ""}</dd>
        <dt>Links</dt>
        <dd>
          {summary.issueUrl ? <a href={summary.issueUrl}>issue</a> : null}
          {summary.issueUrl && summary.prUrl ? " · " : null}
          {summary.prUrl ? <a href={summary.prUrl}>pull request</a> : null}
          {!summary.issueUrl && !summary.prUrl ? "—" : null}
        </dd>
        <dt>Started</dt><dd>{formatTime(summary.startedAt)}</dd>
        <dt>Ended</dt><dd>{formatTime(summary.endedAt)}</dd>
        <dt>Spend</dt><dd>{formatCost(summary.totalCost)} · {summary.totalTokens.toLocaleString()} tokens</dd>
        <dt>Received</dt><dd>up to seq {page.acked}</dd>
      </dl>

      <h2>Phases</h2>
      {phases.length === 0 ? <p className="muted">No phase has started.</p> : (
        <ol className="phases">
          {phases.map((phase) => (
            <li key={phase.phaseId}>
              <Status status={phase.status || "unknown"} /> <strong>{phase.name}</strong>
              {phase.kind ? <span className="muted"> · {phase.kind}{phase.owner ? ` ${phase.owner}` : ""}</span> : null}
              {phase.gate ? <span className="muted"> · at {phase.gate} round {phase.round}</span> : null}
              {phase.description ? <div className="muted">{phase.description}</div> : null}
              {phase.error ? <div className="error">{phase.error}</div> : null}
            </li>
          ))}
        </ol>
      )}

      <h2>Events</h2>
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
    </>
  );
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

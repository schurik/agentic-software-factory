import Link from "next/link";
import type { SessionRow } from "@/convex/activity";
import type { Attention } from "@/convex/model/attention";
import type { ClaimView } from "@/convex/model/claim";
import { ClaimRow } from "../ClaimRow";
import { Status } from "../Status";
import { formatAgoAt as ago, formatCost, plural, sessionHref } from "../format";

/** What runs now, by workflow, and what finished last (activity.page). */
export interface Happening {
  running: { workflow: string; sessions: SessionRow[] }[];
  recent: SessionRow[];
}

/** The inbox, showing only the gates waiting at `factory`. */
export function inboxOf(factory: string): string {
  return `/?factory=${encodeURIComponent(factory)}`;
}


/**
 * One factory's Activity (spec #40): what needs attention — each with where
 * to act on it — what runs now, by workflow and naming each station, and what
 * finished last. Pure: `attention` is `needsAttention` read at `now`.
 */
export function ActivityTab({ factory, forge, now, attention, page, onRelease }: {
  factory: string;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  now: number;
  attention: Attention[] | undefined;
  page: Happening | null | undefined;
  onRelease?: (claim: ClaimView) => void;
}) {
  return (
    <div className="activity">
      <section>
        <h2>Needs attention</h2>
        {attention === undefined ? <p className="muted">Loading…</p>
          : attention.length === 0 ? <p className="muted">Nothing needs attention.</p>
          : <ul className="attention">{attention.map((item, at) => (
              <li key={`${item.kind}-${at}`}><Needs item={item} factory={factory} forge={forge} now={now} onRelease={onRelease} /></li>
            ))}</ul>}
      </section>
      <section>
        <h2>Running now</h2>
        {page === undefined ? <p className="muted">Loading…</p>
          : !page?.running.length ? <p className="muted">Nothing is running.</p>
          : page.running.map((group) => (
              <div key={group.workflow}>
                <h3>{group.workflow || "—"}</h3>
                <Sessions factory={factory} rows={group.sessions} now={now} />
              </div>
            ))}
      </section>
      <section>
        <h2>Recent</h2>
        {!page?.recent.length ? <p className="muted">No session has finished yet.</p>
          : <Sessions factory={factory} rows={page.recent} now={now} workflow />}
      </section>
    </div>
  );
}

function Needs({ item, factory, forge, now, onRelease }: {
  item: Attention; factory: string; forge: string; now: number; onRelease?: (claim: ClaimView) => void;
}) {
  switch (item.kind) {
    case "gates":
      return (
        <>
          <strong>{plural(item.mine, "gate")} waiting on you</strong>{item.total > item.mine ? ` (${item.total} in all)` : ""}.{" "}
          <Link href={inboxOf(factory)}>Answer in the inbox</Link>
        </>
      );
    case "failed":
      return (
        <>
          <strong>{plural(item.sessions.length, "session")} failed</strong> in the last day:{" "}
          {item.sessions.map((failed, at) => (
            <span key={failed.session}>
              {at ? ", " : ""}<Link href={sessionHref(factory, failed.session)}><code>{failed.session}</code></Link>{" "}
              <span className="muted small">{failed.workflow} on {failed.station || "its station"}, {ago(failed.endedAt, now)}</span>
            </span>
          ))}
        </>
      );
    case "claim":
      return <ClaimRow claim={item.claim} now={now} onRelease={onRelease} />;
    case "drift":
      return (
        <>
          <strong>Config drifted</strong> from the default branch on{" "}
          {item.stations.map((station, at) => (
            <span key={station.station}>
              {at ? ", " : ""}<code>{station.name}</code>{station.badges.length ? <span className="muted small"> ({station.badges.join(", ")})</span> : null}
            </span>
          ))}
        </>
      );
    case "check":
      return <><strong><code>asf check</code> is failing</strong> on the default branch: the Config tab says why.</>;
    case "unwatched":
      return (
        <>
          <strong>Nobody watching</strong>:{" "}
          {item.issues.map((number, at) => (
            <span key={number}>{at ? ", " : ""}<a href={`${forge}/${factory}/issues/${number}`}>#{number}</a></span>
          ))}{" "}
          {item.issues.length === 1 ? "is" : "are"} queued for a route, and no station online runs an issues watcher —{" "}
          <code>asf up</code> on one starts it.
        </>
      );
  }
}

/** Sessions as a table; `workflow` and `station` say whether those columns are worth a column where it is shown. */
export function Sessions({ factory, rows, now, workflow = false, station = true }: {
  factory: string; rows: SessionRow[]; now: number; workflow?: boolean; station?: boolean;
}) {
  return (
    <table className="table small">
      <thead>
        <tr><th>session</th>{workflow ? <th>workflow</th> : null}<th>status</th>{station ? <th>station</th> : null}<th className="num">cost</th><th>last</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.session}>
            <td><Link href={sessionHref(factory, row.session)}><code>{row.session}</code></Link></td>
            {workflow ? <td>{row.workflow || "—"}</td> : null}
            <td><Status status={row.status} />{row.gate ? <span className="muted"> at {row.gate}</span> : null}</td>
            {station ? <td>{row.station || "—"}</td> : null}
            <td className="num">{formatCost(row.cost)}</td>
            <td>{ago(row.endedAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

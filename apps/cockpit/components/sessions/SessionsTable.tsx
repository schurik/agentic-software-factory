import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { factoryHref } from "../factory/view";
import { formatCost, formatTime, formatWaitingFor, sessionHref } from "../format";
import { Status } from "../Status";

/** A session as the sessions list returns it. */
export type Listed = NonNullable<FunctionReturnType<typeof api.sessions.list>>["sessions"][number];

/**
 * The sessions the filters kept (spec #40). `across` is the page across
 * factories, which names each row's factory; a factory's own Sessions tab
 * leaves the column out. Pure: the rows are what the query returned.
 */
export function SessionsTable({ rows, across }: { rows: Listed[]; across: boolean }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Session</th>
          {across ? <th>Factory</th> : null}
          <th>Workflow</th>
          <th>Status</th>
          <th>Waiting for</th>
          <th>Triggered by</th>
          <th>Station</th>
          <th className="num" title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">Cost</th>
          <th>Started</th>
          <th>Last event</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ factory, session, summary }) => (
          <tr key={`${factory}/${session}`}>
            <td><Link href={sessionHref(factory, session)}><code>{session}</code></Link></td>
            {across ? <td><Link href={factoryHref(factory)}>{factory}</Link></td> : null}
            <td>{summary.workflows.join(" → ") || "—"}</td>
            <td><Status status={summary.status} /></td>
            <td>{formatWaitingFor(summary.waitingFor)}</td>
            <td>{summary.triggeredBy || "—"}</td>
            <td>
              {summary.stationName || "—"}
              {summary.stationKind === "ci" ? <> <span className="tag">CI</span></> : null}
            </td>
            <td className="num">{formatCost(summary.totalCost)}</td>
            <td>{formatTime(summary.startedAt)}</td>
            <td>{formatTime(summary.lastEventAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

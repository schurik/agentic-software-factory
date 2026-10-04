import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { factoryHref } from "../factory/view";
import { formatCost, formatTime, formatWaitingFor, sessionHref } from "../format";
import { num, StatusPill, Table, Tag } from "../ui";
import { useWho } from "../viewer";

/** A session as the sessions list returns it. */
export type Listed = NonNullable<FunctionReturnType<typeof api.sessions.list>>["sessions"][number];

/**
 * The sessions the filters kept (spec #40). `across` is the page across
 * factories, which names each row's factory; a factory's own Sessions tab
 * leaves the column out. Pure: the rows are what the query returned.
 */
export function SessionsTable({ rows, across, now }: { rows: Listed[]; across: boolean; now: number }) {
  const who = useWho();
  return (
    <Table>
      <thead>
        <tr>
          <th>Session</th>
          {across ? <th>Factory</th> : null}
          <th>Workflow</th>
          <th>Status</th>
          <th>Waiting for</th>
          <th>Triggered by</th>
          <th>Station</th>
          <th className={num} title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">Cost</th>
          <th>Started</th>
          <th>Last event</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ factory, session, summary }) => (
          <tr key={`${factory}/${session}`} className="hover:bg-surface-2">
            <td><Link href={sessionHref(factory, session)}><code>{session}</code></Link></td>
            {across ? <td><Link href={factoryHref(factory)}>{factory}</Link></td> : null}
            <td>{summary.workflows.join(" → ") || "—"}</td>
            <td><StatusPill status={summary.status} /></td>
            <td>{formatWaitingFor(summary.waitingFor)}</td>
            <td>{who(summary.triggeredBy) || "—"}</td>
            <td>
              {summary.stationName || "—"}
              {summary.stationKind === "ci" ? <> <Tag>CI</Tag></> : null}
            </td>
            <td className={num}>{formatCost(summary.totalCost)}</td>
            <td className="whitespace-nowrap">{formatTime(summary.startedAt, now)}</td>
            <td className="whitespace-nowrap">{formatTime(summary.lastEventAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

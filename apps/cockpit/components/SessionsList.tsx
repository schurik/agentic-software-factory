"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Status } from "./Status";
import { formatCost, formatTime, formatWaitingFor, sessionHref } from "./format";
import { useSignIn } from "./signIn";

export function SessionsList() {
  const sessions = useQuery(api.sessions.list, { signIn: useSignIn() });
  if (sessions === undefined) return <p className="muted">Loading…</p>;
  if (sessions.length === 0) {
    return (
      <p className="notice">
        No station has shipped a session yet. A station sends its events to <code>POST /ingest</code>{" "}
        on this deployment&apos;s site URL with a factory&apos;s ingest token.
      </p>
    );
  }
  return (
    <>
      <h1>Sessions</h1>
      <table className="table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Factory</th>
            <th>Workflow</th>
            <th>Status</th>
            <th>Waiting for</th>
            <th>Station</th>
            <th className="num">Cost</th>
            <th>Last event</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(({ factory, session, summary }) => (
            <tr key={`${factory}/${session}`}>
              <td><Link href={sessionHref(factory, session)}><code>{session}</code></Link></td>
              <td>{factory}</td>
              <td>{summary.workflows.join(" → ") || "—"}</td>
              <td><Status status={summary.status} /></td>
              <td>{formatWaitingFor(summary.waitingFor)}</td>
              <td>{summary.stationName || "—"}</td>
              <td className="num">{formatCost(summary.totalCost)}</td>
              <td>{formatTime(summary.lastEventAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

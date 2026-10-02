"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { SessionFilter } from "@/convex/model/filter";
import { periodOf } from "@/convex/model/period";
import { useClock, viewersTimeZone } from "./clock";
import { plural } from "./format";
import { ANY, type Choice, SessionFilters } from "./sessions/SessionFilters";
import { SessionsTable } from "./sessions/SessionsTable";
import { useCockpit } from "./Shell";
import { useSignIn } from "./signIn";

/**
 * Every session the viewer can read, as a table they narrow by workflow,
 * person — who triggered the run — station, status and period (spec #40).
 * Given a `factory`, it is that factory's Sessions tab; without one, the
 * Sessions page across every factory they can read.
 */
export function SessionsList({ factory }: { factory?: string }) {
  const signIn = useSignIn();
  const { viewer } = useCockpit();
  const now = useClock();
  const [choice, setChoice] = useState<Choice>(ANY);
  const asked = useQuery(api.sessions.list, { signIn, factory, filter: filterOf(choice, now) });
  // A new filter is a new query, unanswered at first: the last answer stays up until it is.
  const [last, setLast] = useState(asked);
  if (asked !== undefined && asked !== last) setLast(asked);
  const list = asked ?? last;
  const across = factory === undefined;
  const heading = across ? <h1>Sessions</h1> : null;
  if (list === undefined) return <>{heading}<p className="muted">Loading…</p></>;
  if (list === null) return null;       // signed out, or a factory the page already said cannot be read
  if (list.looked === 0) {
    return (
      <>
        {heading}
        <p className="notice">
          No station has shipped a session{across ? "" : " of this factory"} yet. A station sends its events to{" "}
          <code>POST /ingest</code> on this deployment&apos;s site URL with a factory&apos;s ingest token.
        </p>
      </>
    );
  }
  return (
    <>
      {heading}
      <SessionFilters choice={choice} facets={list.facets} me={viewer?.login ?? ""} onChange={setChoice} />
      <p className="muted small">
        {list.sessions.length} of {plural(list.looked, "session")} looked at, most recently active first
        {list.cut ? "; older ones were not looked at, and may match too" : ""}.
      </p>
      {list.sessions.length ? <SessionsTable rows={list.sessions} across={across} /> : <p className="muted">No session matches.</p>}
    </>
  );
}

/**
 * What the query narrows by. The period's bounds stay put between its
 * midnights, so the clock ticking asks the query again only when it moves on.
 */
function filterOf({ workflow, person, station, status, period }: Choice, now: number): SessionFilter {
  return {
    ...(workflow ? { workflow } : {}), ...(person ? { person } : {}), ...(station ? { station } : {}), ...(status ? { status } : {}),
    ...(period ? { period: periodOf(period, now, viewersTimeZone()) } : {}),
  };
}

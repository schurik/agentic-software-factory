"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { workflowOf } from "@/convex/model/session";
import { useClock } from "./clock";
import { type Listed, SessionsView, Where } from "./sessions/SessionsTable";
import { useSignIn } from "./signIn";
import { Loading, Notice, PageHeader } from "./ui";

/** How long the search waits for typing to pause before it asks again. */
const SETTLE_MS = 250;

/**
 * Every session the viewer can read (#116), narrowed to one factory — as the
 * address's `?factory=` names it — and by one search box over title, issue or
 * pull request and id. The search
 * is the query's, so it finds sessions past the newest the page shows.
 */
export function SessionsList({ factory }: { factory?: string }) {
  const signIn = useSignIn();
  const now = useClock();
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const settled = setTimeout(() => setSearch(typed.trim()), SETTLE_MS);
    return () => clearTimeout(settled);
  }, [typed]);
  const asked = useQuery(api.sessions.list, { signIn, factory, filter: search ? { search } : {} });
  // A new search is a new query, unanswered at first: the last answer stays up until it is.
  const [last, setLast] = useState(asked);
  if (asked !== undefined && asked !== last) setLast(asked);
  const list = asked ?? last;
  if (list === undefined) return <div className="flex flex-col gap-5"><PageHeader title="Sessions" /><Loading /></div>;
  // Signed out — the shell says so — or a factory the viewer cannot read.
  if (list === null) {
    return !factory ? null : (
      <div className="flex flex-col gap-5">
        <PageHeader title="Sessions" />
        <Notice>{factory} is not a factory you can read. <Link href="/sessions">All sessions</Link></Notice>
      </div>
    );
  }
  return (
    <SessionsView list={list} factory={factory} search={typed} onSearch={setTyped} now={now}
                  live={(row) => <LiveWhere row={row} signIn={signIn} />} />
  );
}

/** Where a live session is in its workflow: its own query, so one long record weighs on its row alone. */
function LiveWhere({ row, signIn }: { row: Listed; signIn: string | undefined }) {
  const progress = useQuery(api.sessions.progress, { factory: row.factory, session: row.session, signIn });
  return <Where workflow={workflowOf(row.summary)} progress={progress} />;
}

"use client";

import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useClock } from "./clock";
import { type Listed, SessionsView, Where } from "./sessions/SessionsTable";
import { useSignIn } from "./signIn";
import { Loading, PageHeader } from "./ui";

/** How long the search waits for typing to pause before it asks again. */
const SETTLE_MS = 250;

/**
 * Every session the viewer can read (#116), narrowed to one factory — as the
 * address's `?factory=` names it — and by one search box over title, issue or
 * pull request and id. `tab` is that factory's own Sessions tab. The search
 * is the query's, so it finds sessions past the newest the page shows.
 */
export function SessionsList({ factory, tab = false }: { factory?: string; tab?: boolean }) {
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
  if (list === undefined) return <>{tab ? null : <PageHeader title="Sessions" />}<Loading /></>;
  if (list === null) return null;       // signed out, or a factory the page already said cannot be read
  return (
    <SessionsView list={list} factory={factory} tab={tab} search={typed} onSearch={setTyped} now={now}
                  live={(row) => <LiveWhere row={row} signIn={signIn} />} />
  );
}

/** Where a live session is in its workflow: its own query, so one long record weighs on its row alone. */
function LiveWhere({ row, signIn }: { row: Listed; signIn: string | undefined }) {
  const progress = useQuery(api.sessions.progress, { factory: row.factory, session: row.session, signIn });
  return <Where workflow={row.summary.workflow || (row.summary.workflows.at(-1) ?? "")} progress={progress} />;
}

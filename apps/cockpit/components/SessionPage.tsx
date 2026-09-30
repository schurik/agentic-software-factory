"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SessionView } from "./session/SessionView";
import { useSignIn } from "./signIn";

/**
 * One session, live. `useQuery` is a subscription: every event a station ships
 * re-runs the query and the page moves on in place, with nothing to reload.
 * The clock ticks on its own so "last heard from" keeps counting between events.
 */
export function SessionPage({ factory, session }: { factory: string; session: string }) {
  const page = useQuery(api.sessions.get, { factory, session, signIn: useSignIn() });
  const now = useClock();
  if (page === undefined) return <p className="muted">Loading…</p>;
  if (page === null) {
    return (
      <p className="notice">
        No station has shipped session <code>{session}</code> of {factory}, or it is in a repository you cannot read.
      </p>
    );
  }
  return <SessionView page={page} now={now} />;
}

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

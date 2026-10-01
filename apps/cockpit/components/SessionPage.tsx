"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useClock } from "./clock";
import { said } from "./Shell";
import type { Command } from "./session/action";
import { SessionView } from "./session/SessionView";
import { useSignIn } from "./signIn";

/**
 * One session, live. `useQuery` is a subscription: every event a station ships
 * re-runs the query and the page moves on in place, with nothing to reload.
 * The clock ticks on its own so "last heard from" keeps counting between events.
 */
export function SessionPage({ factory, session }: { factory: string; session: string }) {
  const signIn = useSignIn();
  const page = useQuery(api.sessions.get, { factory, session, signIn });
  // Apart from the page: the station polls every few seconds, and that must
  // not re-tell the whole story each time.
  const steering = useQuery(api.commands.steering, { factory, session, signIn });
  const kill = useMutation(api.commands.kill);
  const resume = useMutation(api.commands.resume);
  const [problem, setProblem] = useState("");
  const now = useClock();
  if (page === undefined) return <p className="muted">Loading…</p>;
  if (page === null) {
    return (
      <p className="notice">
        No station has shipped session <code>{session}</code> of {factory}, or it is in a repository you cannot read.
      </p>
    );
  }
  const onCommand = (command: Command) => {
    setProblem("");
    void (command === "kill" ? kill : resume)({ factory, session, signIn })
      .then((queued) => { if (!queued.ok) setProblem(queued.because); })
      .catch((error: unknown) => setProblem(said(error)));
  };
  return (
    <>
      {problem ? <p className="notice">Not queued: {problem}</p> : null}
      <SessionView page={page} now={now} steering={steering} onCommand={onCommand} />
    </>
  );
}

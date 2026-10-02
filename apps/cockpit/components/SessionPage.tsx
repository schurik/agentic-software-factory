"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useClock } from "./clock";
import { said } from "./Shell";
import type { ClaimView } from "@/convex/model/claim";
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
  const claims = useQuery(api.claims.ofSession, { factory, session, signIn });
  const release = useAction(api.claims.release);
  const purge = useMutation(api.retention.purgeSession);
  const [problem, setProblem] = useState("");
  const [released, setReleased] = useState("");
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
      .then((queued) => { if (!queued.ok) setProblem(`Not queued: ${queued.because}`); })
      .catch((error: unknown) => setProblem(`Not queued: ${said(error)}`));
  };
  const onRelease = (claim: ClaimView) => {
    setProblem("");
    setReleased("");
    void release({ claim: claim.id, signIn })
      .then((done) => {
        if (!done.ok) setProblem(`Not released: ${done.because}`);
        else if (!done.relabelled) setReleased(`Released — ${done.because}.`);
      })
      .catch((error: unknown) => setProblem(`Not released: ${said(error)}`));
  };
  return (
    <>
      {problem ? <p className="notice">{problem}</p> : null}
      {released ? <p className="notice">{released}</p> : null}
      <SessionView page={page} now={now} steering={steering} onCommand={onCommand} claims={claims} onRelease={onRelease}
                   onPurge={(reason) => purge({ factory, session, reason, signIn })} />
    </>
  );
}

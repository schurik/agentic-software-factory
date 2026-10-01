"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useClock } from "../clock";
import { said } from "../Shell";
import { useSignIn } from "../signIn";
import { RunForm } from "./RunForm";

/**
 * Run a prompt workflow, live: the factory chosen from those the viewer has a
 * station on, the form for it, and their runs there updating as the station
 * reports. The Factory header, its Workflows tab and a command palette will
 * open this same form for their factory.
 */
export function RunPrompt({ factory }: { factory: string }) {
  const signIn = useSignIn();
  const router = useRouter();
  const mine = useQuery(api.stations.mine, { signIn });
  const targets = useQuery(api.commands.runTargets, factory ? { factory, signIn } : "skip");
  const runs = useQuery(api.commands.runs, factory ? { factory, signIn } : "skip");
  const run = useMutation(api.commands.run);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const now = useClock();
  const factories = [...new Set((mine ?? []).map((row) => row.factory))].sort();

  return (
    <>
      <h1>Run a prompt</h1>
      <p className="muted">
        Starts a workflow that takes a prompt on one of your own stations, as you. A station runs it only if its{" "}
        <code>asf/factory.yaml</code> lists <code>run</code> under <code>cockpit.commands</code> — it is off unless it does.
      </p>
      <form className="form" onSubmit={(event) => event.preventDefault()}>
        <label>
          Factory
          <select value={factory} onChange={(event) => router.push(`/run?factory=${encodeURIComponent(event.target.value)}`)}>
            <option value="" disabled>{factories.length ? "pick a factory" : "no station of yours yet"}</option>
            {factories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </form>
      {!factory ? null : targets === undefined || runs === undefined ? <p className="muted">Loading…</p> : (
        <RunForm key={factory} factory={factory} targets={targets} runs={runs} now={now} busy={busy} problem={problem}
                 onRun={({ workflow, prompt, station }) => {
                   setBusy(true);
                   setProblem("");
                   void run({ factory, workflow, prompt, station, signIn })
                     .then((queued) => { if (!queued.ok) setProblem(queued.because); })
                     .catch((error: unknown) => setProblem(said(error)))
                     .finally(() => setBusy(false));
                 }} />
      )}
    </>
  );
}

"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { useClock } from "../clock";
import { said } from "../Shell";
import { useSignIn } from "../signIn";
import { control, Field, Loading, PageHeader } from "../ui";
import { RunForm } from "./RunForm";

/**
 * Run a prompt workflow, live: the factory chosen from those the viewer has a
 * station on, the form for it, and their runs there updating as the station
 * reports. The Factory header and its Workflows tab open the same form
 * (`RunPanel`) for their factory.
 */
export function RunPrompt({ factory }: { factory: string }) {
  const signIn = useSignIn();
  const router = useRouter();
  const mine = useQuery(api.stations.mine, { signIn });
  const factories = [...new Set((mine ?? []).map((row) => row.factory))].sort();

  return (
    <>
      <PageHeader title="Run a prompt" sub={
        <>
          Starts a workflow that takes a prompt on one of your own stations, as you. A station runs it only if its{" "}
          <code>asf/factory.yaml</code> lists <code>run</code> under <code>cockpit.commands</code> — it is off unless it does.
        </>
      } />
      <form className="mb-4 grid max-w-2xl" onSubmit={(event) => event.preventDefault()}>
        <Field label="Factory">
          <select value={factory} className={control} onChange={(event) => router.push(`/run?factory=${encodeURIComponent(event.target.value)}`)}>
            <option value="" disabled>{factories.length ? "pick a factory" : "no station of yours yet"}</option>
            {factories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
      </form>
      {factory ? <RunPanel key={factory} factory={factory} /> : null}
    </>
  );
}

/**
 * The run form for one factory, live: where the viewer may run, and their
 * latest runs there. `workflow` starts it on one; `workflows` are the prompt
 * workflows the factory's self-description names, offered as it is typed.
 */
export function RunPanel({ factory, workflow, workflows }: { factory: string; workflow?: string; workflows?: string[] }) {
  const signIn = useSignIn();
  const targets = useQuery(api.commands.runTargets, { factory, signIn });
  const runs = useQuery(api.commands.runs, { factory, signIn });
  const run = useMutation(api.commands.run);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const now = useClock();
  if (targets === undefined || runs === undefined) return <Loading />;
  return (
    <RunForm key={workflow ?? ""} factory={factory} targets={targets} runs={runs} now={now} busy={busy} problem={problem}
             workflow={workflow} workflows={workflows}
             onRun={(asked) => {
               setBusy(true);
               setProblem("");
               void run({ factory, ...asked, signIn })
                 .then((queued) => { if (!queued.ok) setProblem(queued.because); })
                 .catch((error: unknown) => setProblem(said(error)))
                 .finally(() => setBusy(false));
             }} />
  );
}

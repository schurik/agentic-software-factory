"use client";

import Link from "next/link";
import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { liveness, pending } from "@/convex/model/command";
import { formatAgo, formatClock, sessionHref } from "../format";

export type Targets = NonNullable<FunctionReturnType<typeof api.commands.runTargets>>;
export type RunRow = FunctionReturnType<typeof api.commands.runs>[number];

/** Whether a station's loop is polling by the page's clock: what a run sent to it waits on. */
function online(seenAt: number, now: number): boolean {
  return liveness(seenAt, null, now).online;
}

/** One of the viewer's stations as the list offers it: its name, whether it is listening, and the default. */
function choice(station: Targets["stations"][number], now: number): string {
  const seen = online(station.seenAt, now) ? "online"
    : station.seenAt ? `last seen ${formatAgo(new Date(station.seenAt).toISOString(), now)}` : "never polled";
  return `${station.name} · ${seen}${station.default ? " · default" : ""}`;
}

/** What became of a run, by the station's word and the page's clock — never "done" because it was sent. */
export function runWords(run: RunRow, now: number): string {
  // Past its TTL it is expired, whether or not the minute's sweep has said so yet.
  const state = (run.state === "queued" || run.state === "delivered") && !pending(run, now) ? "expired" : run.state;
  switch (state) {
    case "queued":
      return online(run.seenAt, now) ? `queued: ${run.station} takes it within seconds`
        : `queued, station offline: ${run.station} takes it when it is back, until ${formatClock(new Date(run.expiresAt).toISOString())}`;
    case "delivered":
      return `sent to ${run.station}: waiting for it to say it started`;
    case "done":
      return `started session ${run.started} on ${run.station}`;
    case "refused":
      return `refused by ${run.station}: ${run.detail}`;
    case "expired":
      return `expired: ${run.station} did not take it in time — pick another station`;
  }
}

/**
 * Run a prompt workflow on one of your own stations (spec #40): the workflow,
 * the prompt, and the station — your default for this factory, or another of
 * yours, each saying when it was last seen. Never anyone else's: a teammate
 * never starts an agent on your machine or budget, nor you on theirs. Below,
 * your latest runs here and what became of each.
 *
 * Pure: what it shows comes from its props, so a test renders it; `onRun` queues.
 */
export function RunForm({ factory, targets, runs, now, busy, problem, onRun, workflow: initial = "", workflows = [] }: {
  factory: string;
  targets: Targets | null;
  runs: RunRow[];
  now: number;
  busy: boolean;
  problem: string;
  onRun: (run: { workflow: string; prompt: string; station: string }) => void;
  /** The workflow it opens on: the one a Workflows tab's Run was pressed for. */
  workflow?: string;
  /** The prompt workflows the factory's self-description names, when it has one. */
  workflows?: string[];
}) {
  const fallback = targets?.stations.find((station) => station.default)?.station ?? "";
  const [picked, setPicked] = useState("");
  const [workflow, setWorkflow] = useState(initial);
  const [prompt, setPrompt] = useState("");
  const station = picked || fallback;
  const chosen = targets?.stations.find((each) => each.station === station) ?? null;
  const cannot = targets === null ? `${factory} is not a repository you can read`
    : targets.refused ?? (chosen === null ? `you have no station on ${factory}: run \`asf station register\` in a checkout of it`
      : chosen.refused);
  return (
    <form className="form run-form" onSubmit={(event) => {
      event.preventDefault();
      if (cannot === null && !busy) onRun({ workflow: workflow.trim(), prompt, station });
    }}>
      <label>
        Workflow
        <input value={workflow} placeholder={workflows[0] ?? "quick"} list={workflows.length ? `prompt-workflows-${factory}` : undefined}
               onChange={(event) => setWorkflow(event.target.value)} />
        {workflows.length ? (
          <datalist id={`prompt-workflows-${factory}`}>
            {workflows.map((name) => <option key={name} value={name} />)}
          </datalist>
        ) : null}
        <small>
          {workflows.length ? <>One that takes a prompt: {workflows.join(", ")}.</>
            : <>One that takes a prompt: `asf list` in the repository names them.</>}
        </small>
      </label>
      <label>
        Prompt
        <textarea value={prompt} rows={5} placeholder="what the run is for" onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <label>
        Station
        <select value={station} onChange={(event) => setPicked(event.target.value)} disabled={!targets?.stations.length}>
          {(targets?.stations ?? []).map((each) => (
            <option key={each.station} value={each.station}>{choice(each, now)}</option>
          ))}
        </select>
        <small>Only your own stations: a run starts an agent on that machine, on its owner&apos;s budget.</small>
      </label>
      {cannot ? <p className="notice small">{cannot}</p> : null}
      {problem ? <p className="error small">Not queued: {problem}.</p> : null}
      <button type="submit" className="button" disabled={cannot !== null || busy || !workflow.trim() || !prompt.trim()}>
        Run on {chosen?.name ?? "your station"}
      </button>
      {runs.length ? (
        <section>
          <h3>Your latest runs here</h3>
          <ul className="runs small">
            {runs.map((run) => (
              <li key={run.id}>
                <strong>{run.workflow}</strong> · {run.prompt.split("\n")[0]} — {runWords(run, now)}
                {run.state === "done" && run.started ? <> · <Link href={sessionHref(factory, run.started)}>open</Link></> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </form>
  );
}

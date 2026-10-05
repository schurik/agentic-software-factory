"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { liveness, pending } from "@/convex/model/command";
import { formatAgo, formatClock, sessionHref } from "../format";
import { Button, control, Field, Notice, Select } from "../ui";
import { type RunDialogAction, type RunDialogState, workflowOf } from "./dialog";

export type Targets = NonNullable<FunctionReturnType<typeof api.commands.runTargets>>;
export type RunRow = FunctionReturnType<typeof api.commands.runs>[number];
export type Offered = NonNullable<FunctionReturnType<typeof api.factory.promptWorkflows>>;

/** Whether a station's loop is polling by the page's clock: what a run sent to it waits on. */
function online(seenAt: number, now: number): boolean {
  return liveness(seenAt, null, now).online;
}

/** The station a run goes to, and whether it is listening. */
function where(station: Targets["stations"][number], now: number): string {
  const seen = online(station.seenAt, now) ? "online"
    : station.seenAt ? `last seen ${formatAgo(new Date(station.seenAt).toISOString(), now)}` : "never polled";
  return `${station.name} · ${seen}`;
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
      return `expired: ${run.station} did not take it in time`;
  }
}

/** What the dialog knows of the chosen factory: what `refusal` reads. */
interface Asked {
  factory: string;
  factories: string[];
  targets: Targets | null | undefined;
  offered: Offered | null | undefined;
  /** The station a run would go to. */
  station: Targets["stations"][number] | undefined;
}

/**
 * Why nothing can run on the chosen factory, in a sentence, or null when
 * something can. Undefined while what it depends on is still being asked.
 */
function refusal({ factory, factories, targets, offered, station }: Asked): string | null | undefined {
  if (!factory) return factories.length ? null : "you have no station yet: run `asf station register` in a checkout of a factory";
  if (targets === undefined || offered === undefined) return undefined;
  if (targets === null || offered === null) return `${factory} is not a repository you can read`;
  if (targets.refused) return targets.refused;
  if (station === undefined) return `you have no station on ${factory}: run \`asf station register\` in a checkout of it`;
  if (station.refused) return station.refused;
  if (!offered.described) {
    return `${factory} has not described itself yet, so there is no workflow to offer: its CI workflow pushes \`asf check --json\` from the default branch`;
  }
  if (!offered.workflows.length) return `${factory} has no workflow that takes a prompt`;
  return null;
}

/**
 * The Run a prompt dialog's body (#108): the factory and one of its prompt
 * workflows, the prompt, then Cancel and Run. A run goes to the viewer's own
 * default station on the factory — never anyone else's: a teammate never
 * starts an agent on your machine or budget, nor you on theirs. Below, the
 * viewer's latest runs there and what became of each.
 *
 * Pure: what it shows comes from its props, so a test renders it. `onChange`
 * is everything a person does to the form; `onRun` queues.
 */
export function RunForm({ factories, state, workflows, targets, runs, now, busy, problem, onChange, onRun, onCancel }: {
  /** The factories the viewer has a station on, and the one in view. */
  factories: string[];
  state: RunDialogState;
  /** The chosen factory's prompt workflows; undefined while asked. */
  workflows: Offered | null | undefined;
  /** Where the viewer may run on the chosen factory; undefined while asked. */
  targets: Targets | null | undefined;
  runs: RunRow[];
  now: number;
  busy: boolean;
  problem: string;
  onChange: (action: RunDialogAction) => void;
  onRun: (run: { workflow: string; prompt: string; station: string }) => void;
  onCancel: () => void;
}) {
  const offered = workflows?.workflows ?? [];
  const workflow = workflowOf(state.workflow, offered);
  // Their default, unless it would refuse a run and another of theirs would take it.
  const station = targets?.stations.find((each) => each.refused === null) ?? targets?.stations.find((each) => each.default);
  const cannot = refusal({ factory: state.factory, factories, targets, offered: workflows, station });
  const ready = cannot === null && state.factory !== "" && station !== undefined && workflow !== "" && state.prompt.trim() !== "" && !busy;
  return (
    <form className="grid gap-4" onSubmit={(event) => {
      event.preventDefault();
      if (ready) onRun({ workflow, prompt: state.prompt, station: station.station });
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Factory" items={factories} value={state.factory} placeholder="Pick a factory"
                onChange={(factory) => onChange({ type: "factory", factory })} />
        <Select label="Workflow" items={offered} value={workflow} placeholder="No prompt workflow"
                onChange={(chosen) => onChange({ type: "workflow", workflow: chosen })} />
      </div>
      <Field label="Prompt">
        <textarea value={state.prompt} rows={5} placeholder="What should change?" className={control}
                  onChange={(event) => onChange({ type: "prompt", prompt: event.target.value })} />
      </Field>
      {cannot ? <Notice className="my-0 text-sm">{cannot}</Notice>
        : station ? (
          <p className="text-sm text-muted">
            Runs on {where(station, now)} — only ever one of your own: a run starts an agent on that machine, on its owner&apos;s budget.
          </p>
        ) : null}
      {problem ? <p className="text-sm text-bad">Not queued: {problem}.</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>Run</Button>
      </div>
      {runs.length ? (
        <section className="border-t border-line pt-4">
          <h4 className="mb-2">Your latest runs on {state.factory}</h4>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {runs.map((run) => (
              <li key={run.id}>
                <strong>{run.workflow}</strong> · {run.prompt.split("\n")[0]} — {runWords(run, now)}
                {run.state === "done" && run.started ? <> · <Link href={sessionHref(state.factory, run.started)}>open</Link></> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </form>
  );
}

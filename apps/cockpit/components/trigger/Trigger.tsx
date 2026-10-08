"use client";

import { Form } from "@base-ui/react/form";
import { notAnIssue } from "@/convex/model/trigger";
import type { Offered, Triggered } from "@/convex/trigger";
import { ForgeRef } from "../icons";
import { Button, Control, Field, Notice, Select } from "../ui";
import { useWho } from "../viewer";

/** What the form is filled in with. */
export interface Asked {
  factory: string;
  issue: string;
  label: string;
}

/**
 * The Trigger a workflow dialog's body: the factory and one of its routes,
 * the issue, what pressing Trigger will do — before it is pressed, and once
 * it has been — then Cancel and Trigger. Whether the viewer may label the
 * factory's issues is the forge's word, which `routes` carries: the dialog
 * opens on any factory, and says there why nothing can be triggered on one.
 *
 * Pure: what it shows comes from its props, so a test renders it.
 */
export function TriggerFormView({ factories, routes, asked, busy, outcome, as, onChange, onSubmit, onCancel }: {
  /** The factories on the forge the viewer can read, and the one in view. */
  factories: string[];
  /** The chosen factory's routes; null while they are read. */
  routes: Offered | null;
  asked: Asked;
  busy: boolean;
  outcome: Triggered | null;
  /** Whose name the labels go on under: the viewer's login. */
  as: string;
  onChange: (asked: Asked) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const who = useWho();
  const { factory } = asked;
  const offered = routes?.ok ? routes.routes : [];
  const route = offered.find(({ label }) => label === asked.label) ?? offered[0];
  const by = as ? who(as) : "you";
  const ready = route !== undefined && asked.issue !== "" && !busy;
  return (
    <Form className="grid gap-4" onFormSubmit={() => { if (ready) onSubmit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Factory" items={factories} value={factory} placeholder="Pick a factory"
                onChange={(chosen) => onChange({ ...asked, factory: chosen, label: "" })} />
        <Select label="Workflow" name="label" value={route?.label ?? ""} placeholder="No route label"
                onChange={(label) => onChange({ ...asked, label })}
                items={offered.map(({ label, workflow }) => ({ value: label, label: `${workflow} (${label})` }))} />
      </div>
      <Field label="Issue" name="issue" validate={(value) => notAnIssue(String(value ?? ""))}>
        <Control inputMode="numeric" placeholder="42" value={asked.issue}
                 onValueChange={(typed) => onChange({ ...asked, issue: typed.replace(/^#/, "") })} />
      </Field>
      {!factory ? (factories.length ? null : <Notice className="text-sm">You can read no factory on the forge yet.</Notice>)
        : routes === null ? <p className="text-sm text-muted">Reading {factory}&apos;s route labels from the forge…</p>
        : !routes.ok ? <Notice className="text-sm">Nothing can be triggered on {factory} from here: {routes.because}.</Notice>
        : route ? (
          <p className="text-sm text-muted">
            Adds <code>{route.label}</code> and <code>{routes.queued}</code> to the issue as {by}. The
            factory&apos;s issues watcher starts {route.workflow} on its next poll, and records {by} as who
            triggered it.
          </p>
        ) : null}
      {outcome?.ok ? (
        <Notice tone="ok" className="text-sm">
          Labelled <ForgeRef kind="issue" href={outcome.url} state="open" newTab>#{asked.issue} {outcome.title}</ForgeRef>: {outcome.workflow} starts
          when the factory&apos;s issues watcher next polls.
        </Notice>
      ) : outcome ? <Notice tone="bad" className="text-sm">Not triggered: {outcome.because}.</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          {busy ? "Labelling…" : route ? `Trigger ${route.workflow}` : "Trigger"}
        </Button>
      </div>
    </Form>
  );
}

"use client";

import { Form } from "@base-ui/react/form";
import { notAnIssue } from "@/convex/model/trigger";
import type { Offered } from "@/convex/trigger";
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
 * the issue, what pressing Trigger will do, why the forge refused it if it
 * did — then Cancel and Trigger. Once it labels the issue the dialog closes. Whether the viewer may label the
 * factory's issues is the forge's word, which `routes` carries: the dialog
 * opens on any factory, and says there why nothing can be triggered on one.
 *
 * Pure: what it shows comes from its props, so a test renders it.
 */
export function TriggerFormView({ factories, routes, asked, busy, problem, as, onChange, onSubmit, onCancel }: {
  /** The factories on the forge the viewer can read, and the one in view. */
  factories: string[];
  /** The chosen factory's routes; null while they are read. */
  routes: Offered | null;
  asked: Asked;
  busy: boolean;
  /** Why the forge refused the last Trigger; empty when it has not. */
  problem: string;
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
    // One column no wider than the dialog: an auto one grows to fit an unbreakable line, and
    // pushes every field and the buttons past the dialog's edge.
    <Form className="grid grid-cols-1 gap-4" onFormSubmit={() => { if (ready) onSubmit(); }}>
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
      {problem ? <Notice tone="bad" className="text-sm">Not triggered: {problem}.</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          {busy ? "Labelling…" : route ? `Trigger ${route.workflow}` : "Trigger"}
        </Button>
      </div>
    </Form>
  );
}

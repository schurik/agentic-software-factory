"use client";

import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Role } from "@/convex/forge/forge";
import { refusal } from "@/convex/model/trigger";
import type { Offered, Triggered } from "@/convex/trigger";
import { said } from "../said";
import { Button, control, Field, Notice } from "../ui";
import { useWho } from "../viewer";

/**
 * The trigger in a factory's page header: enabled from triage up, which is what the
 * forge asks of a labeller, and otherwise disabled with the reason. Pure, so a
 * test renders it.
 */
export function TriggerButton({ role, open, onToggle }: { role: Role | null; open: boolean; onToggle: () => void }) {
  const because = refusal(role);
  return (
    <>
      <Button size="sm" disabled={because !== null} title={because ?? undefined} aria-expanded={open} onClick={onToggle}>
        Trigger…
      </Button>
      {because !== null ? <span className="text-sm text-muted"> {because}</span> : null}
    </>
  );
}

/** What the form is filled in with. */
export interface Asked {
  issue: string;
  label: string;
}

/**
 * The trigger form: which workflow, on which issue, and what pressing the
 * button will do — before it is pressed, and once it has been. Pure.
 */
export function TriggerFormView({ factory, routes, asked, busy, outcome, as, onChange, onSubmit }: {
  factory: string;
  routes: Offered | null;
  asked: Asked;
  busy: boolean;
  outcome: Triggered | null;
  /** Whose name the labels go on under: the viewer's login. */
  as: string;
  onChange: (asked: Asked) => void;
  onSubmit: () => void;
}) {
  const who = useWho();
  if (routes === null) return <p className="text-sm text-muted">Reading {factory}&apos;s route labels from the forge…</p>;
  if (!routes.ok) return <Notice className="text-sm">Nothing can be triggered on {factory} from here: {routes.because}.</Notice>;
  const route = routes.routes.find(({ label }) => label === asked.label) ?? routes.routes[0];
  const by = as ? who(as) : "you";
  const number = Number(asked.issue);
  const ready = Number.isInteger(number) && number > 0 && !busy;
  return (
    <form className="my-2 grid max-w-lg gap-3" onSubmit={(event) => { event.preventDefault(); if (ready) onSubmit(); }}>
      <Field label="Workflow">
        <select value={route.label} className={control} onChange={(event) => onChange({ ...asked, label: event.target.value })}>
          {routes.routes.map(({ label, workflow }) => (
            <option key={label} value={label}>{workflow} ({label})</option>
          ))}
        </select>
      </Field>
      <Field label="Issue">
        <input inputMode="numeric" placeholder="42" value={asked.issue} className={control}
               onChange={(event) => onChange({ ...asked, issue: event.target.value.replace(/^#/, "") })} />
      </Field>
      <p className="text-sm text-muted">
        Adds <code>{route.label}</code> and <code>{routes.queued}</code> to the issue as {by}. The
        factory&apos;s issues watcher starts {route.workflow} on its next poll, and records {by} as who
        triggered it.
      </p>
      <Button type="submit" variant="primary" className="justify-self-start" disabled={!ready}>
        {busy ? "Labelling…" : `Trigger ${route.workflow}`}
      </Button>
      {outcome?.ok ? (
        <Notice tone="ok" className="text-sm">
          Labelled <a href={outcome.url} target="_blank" rel="noreferrer">#{asked.issue} {outcome.title}</a>: {outcome.workflow} starts
          when the factory&apos;s issues watcher next polls.
        </Notice>
      ) : outcome ? <Notice tone="bad" className="text-sm">Not triggered: {outcome.because}.</Notice> : null}
    </form>
  );
}

/** The form for one factory, with its route labels read from the forge as it opens. */
export function TriggerForm({ factory, signIn, as }: { factory: string; signIn: string | undefined; as: string }) {
  const readRoutes = useAction(api.trigger.routes);
  const trigger = useAction(api.trigger.trigger);
  const [routes, setRoutes] = useState<Offered | null>(null);
  const [asked, setAsked] = useState<Asked>({ issue: "", label: "" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Triggered | null>(null);

  useEffect(() => {
    let current = true;
    readRoutes({ factory, signIn }).then(
      (got) => { if (current) setRoutes(got); },
      (error: unknown) => { if (current) setRoutes({ ok: false, because: said(error) }); });
    return () => { current = false; };
  }, [readRoutes, factory, signIn]);

  const submit = async () => {
    if (routes === null || !routes.ok) return;
    setBusy(true);
    setOutcome(null);
    try {
      const label = asked.label || routes.routes[0].label;
      setOutcome(await trigger({ factory, issue: Number(asked.issue), label, signIn }));
    } catch (error) {
      setOutcome({ ok: false, because: said(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <TriggerFormView factory={factory} routes={routes} asked={asked} busy={busy} outcome={outcome} as={as}
                     onChange={(next) => { setAsked(next); setOutcome(null); }} onSubmit={() => void submit()} />
  );
}

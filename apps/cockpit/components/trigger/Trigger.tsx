"use client";

import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Role } from "@/convex/forge/forge";
import { refusal } from "@/convex/model/trigger";
import type { Offered, Triggered } from "@/convex/trigger";
import { said } from "../Shell";

/**
 * The trigger on a factory's row: enabled from triage up, which is what the
 * forge asks of a labeller, and otherwise disabled with the reason. Pure, so a
 * test renders it.
 */
export function TriggerButton({ role, open, onToggle }: { role: Role | null; open: boolean; onToggle: () => void }) {
  const because = refusal(role);
  return (
    <>
      <button type="button" className="button quiet" disabled={because !== null} title={because ?? undefined}
              aria-expanded={open} onClick={onToggle}>
        Trigger…
      </button>
      {because !== null ? <span className="small muted"> {because}</span> : null}
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
  if (routes === null) return <p className="muted small">Reading {factory}&apos;s route labels from the forge…</p>;
  if (!routes.ok) return <p className="notice small">Nothing can be triggered on {factory} from here: {routes.because}.</p>;
  const route = routes.routes.find(({ label }) => label === asked.label) ?? routes.routes[0];
  const number = Number(asked.issue);
  const ready = Number.isInteger(number) && number > 0 && !busy;
  return (
    <form className="form trigger-form" onSubmit={(event) => { event.preventDefault(); if (ready) onSubmit(); }}>
      <label>
        Workflow
        <select value={route.label} onChange={(event) => onChange({ ...asked, label: event.target.value })}>
          {routes.routes.map(({ label, workflow }) => (
            <option key={label} value={label}>{workflow} ({label})</option>
          ))}
        </select>
      </label>
      <label>
        Issue
        <input inputMode="numeric" placeholder="42" value={asked.issue}
               onChange={(event) => onChange({ ...asked, issue: event.target.value.replace(/^#/, "") })} />
      </label>
      <small>
        Adds <code>{route.label}</code> and <code>{routes.queued}</code> to the issue as {as || "you"}. The
        factory&apos;s issues watcher starts {route.workflow} on its next poll, and records {as || "you"} as who
        triggered it.
      </small>
      <button type="submit" className="button" disabled={!ready}>{busy ? "Labelling…" : `Trigger ${route.workflow}`}</button>
      {outcome?.ok ? (
        <p className="notice small">
          Labelled <a href={outcome.url} target="_blank" rel="noreferrer">#{asked.issue} {outcome.title}</a>: {outcome.workflow} starts
          when the factory&apos;s issues watcher next polls.
        </p>
      ) : outcome ? <p className="notice small">Not triggered: {outcome.because}.</p> : null}
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

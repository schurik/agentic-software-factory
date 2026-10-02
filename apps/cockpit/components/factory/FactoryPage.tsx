"use client";

import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import type { ClaimView } from "@/convex/model/claim";
import { needsAttention } from "@/convex/model/attention";
import { useClock } from "../clock";
import { SessionsList } from "../SessionsList";
import { RunPanel } from "../run/RunPrompt";
import { said, useCockpit } from "../Shell";
import { useSignIn } from "../signIn";
import { ActivityTab } from "./ActivityTab";
import { ConfigEditor } from "./ConfigEditor";
import { ConfigTab } from "./ConfigTab";
import { FactoryHeader } from "./FactoryHeader";
import { StationsTab } from "./StationsTab";
import { drifts, promptWorkflows } from "./view";
import { WorkflowsTab } from "./WorkflowsTab";

const TABS = {
  activity: "Activity", workflows: "Workflows", stations: "Stations", sessions: "Sessions", config: "Config",
} as const;
type Tab = keyof typeof TABS;

/**
 * One factory (spec #40): the fixed header, and its tabs — Activity (what
 * needs attention, what runs now, what finished), Workflows, from the
 * factory's own self-description, Stations, with what each one holds,
 * Sessions, its whole history narrowed as on the Sessions page across
 * factories, and Config, whose files a writer edits into a pull request.
 * Live: the queries keep themselves current; the forge is looked at once when
 * the page opens, and again whenever a station reports a commit it has not
 * measured. Every tab stays mounted, so a draft — or a filter — outlives a
 * look at another one.
 */
export function FactoryPage({ factory }: { factory: string }) {
  const signIn = useSignIn();
  const { forge, viewer } = useCockpit();
  const page = useQuery(api.factory.page, { factory, signIn });
  const ask = useAction(api.factory.look);
  const [look, setLook] = useState<Look | null>(null);
  const facts = useQuery(api.activity.attention, { factory, signIn });
  const happening = useQuery(api.activity.page, { factory, signIn });
  const stations = useQuery(api.activity.stations, { factory, signIn });
  const release = useAction(api.claims.release);
  const [released, setReleased] = useState("");
  const [station, setStation] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("activity");
  const [running, setRunning] = useState<{ workflow?: string } | null>(null);
  // The file open in the config editor, and the commit the editor reads every file at — fixed when it first opens.
  const [editing, setEditing] = useState<{ path: string; base: string } | null>(null);
  const now = useClock();

  // Which commits the look must measure: the stations' — a new one asks again.
  const heads = page ? page.stations.map((row) => row.head).filter(Boolean).sort().join(" ") : null;
  useEffect(() => {
    if (heads === null) return;
    let current = true;
    void ask({ factory, signIn })
      .then((looked) => { if (current) setLook(looked); })
      .catch((error: unknown) => { if (current) setLook({ ok: false, because: said(error) }); });
    return () => { current = false; };
  }, [ask, factory, signIn, heads]);

  const measured = useMemo(() => (page ? drifts(page, look) : new Map()), [page, look]);
  // Drift as the header measures it, against the forge's tip, once the look has measured anything.
  const drifted = useMemo(() => (page && look?.ok ? page.stations.flatMap((row) => {
    const each = measured.get(row.station);
    return each?.drifted ? [{ station: row.station, name: row.name, badges: each.badges }] : [];
  }) : undefined), [page, look, measured]);
  const attention = useMemo(() => (facts ? needsAttention(facts, now, drifted) : undefined), [facts, now, drifted]);
  if (page === undefined) return <p className="muted">Loading…</p>;
  if (page === null) return <p className="notice">{factory} is not a factory you can read. <Link href="/factories">All factories</Link></p>;
  const web = `https://${forge.host}`;
  const onRelease = (claim: ClaimView) => {
    setReleased("");
    void release({ claim: claim.id, signIn })
      .then((done) => setReleased(!done.ok ? `Not released: ${done.because}` : done.relabelled ? "" : `Released — ${done.because}.`))
      .catch((error: unknown) => setReleased(`Not released: ${said(error)}`));
  };

  return (
    <div className="factory">
      <FactoryHeader page={page} look={look} drifts={measured} forge={web}
                     running={running !== null && running.workflow === undefined}
                     onRun={() => setRunning(running && running.workflow === undefined ? null : {})} />
      {running && running.workflow === undefined ? (
        <section className="run-here">
          <RunPanel factory={page.repo} workflows={promptWorkflows(page.check)} />
        </section>
      ) : null}
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((each) => (
          <button key={each} role="tab" aria-selected={each === tab} onClick={() => setTab(each)}>{TABS[each]}</button>
        ))}
      </div>
      {released ? <p className="notice">{released}</p> : null}
      <div hidden={tab !== "activity"}>
        <ActivityTab factory={factory} forge={web} now={now} attention={attention} page={happening} onRelease={onRelease} />
      </div>
      <div hidden={tab !== "workflows"}>
        <WorkflowsTab check={page.check} running={running?.workflow ?? null}
                      onRun={(workflow) => setRunning(running?.workflow === workflow ? null : { workflow })}
                      runner={(workflow) => (
                        <RunPanel factory={page.repo} workflow={workflow} workflows={promptWorkflows(page.check)} />
                      )} />
      </div>
      <div hidden={tab !== "stations"}>
        {stations ? <StationsTab stations={stations.stations} ci={stations.ci} drifts={measured} now={now} factory={factory}
                             selected={station} onSelect={setStation} onRelease={onRelease} />
          : <p className="muted">Loading…</p>}
      </div>
      <div hidden={tab !== "sessions"}>
        <SessionsList factory={factory} />
      </div>
      <div hidden={tab !== "config"}>
        <ConfigTab page={page} look={look} drifts={measured} forge={web} now={now}
                   onEdit={(path) => {
                     const base = editing?.base ?? (look?.ok ? look.tip : null);
                     if (base) setEditing({ path, base });
                   }}
                   editor={editing && page.defaultBranch ? (
                     <ConfigEditor factory={page.repo} base={editing.base} into={page.defaultBranch} as={viewer?.login ?? ""}
                                   open={editing.path} signIn={signIn} onOpen={(path) => setEditing({ ...editing, path })} />
                   ) : null} />
      </div>
    </div>
  );
}

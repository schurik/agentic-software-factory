"use client";

import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import type { ClaimView } from "@/convex/model/claim";
import { needsAttention } from "@/convex/model/attention";
import { dayOf, daysOf } from "@/convex/model/period";
import { useClock, viewersTimeZone } from "../clock";
import { CostPanel } from "../cost/CostPanel";
import { useRunPrompt } from "../run/RunDialog";
import { said } from "../said";
import { useCockpit } from "../Shell";
import { useSignIn } from "../signIn";
import { TriggerForm } from "../trigger/Trigger";
import { Loading, Notice } from "../ui";
import { ActivityTab } from "./ActivityTab";
import { ConfigEditor } from "./ConfigEditor";
import { ConfigTab } from "./ConfigTab";
import { FactoryView } from "./FactoryView";
import { StationsTab } from "./StationsTab";
import { drifts, type FactoryTab, tabOf } from "./view";
import { WorkflowsTab } from "./WorkflowsTab";

const DAY = 24 * 3600_000;

/**
 * One factory (#118): its header, and its tabs — Overview, for now what needs
 * attention, what runs, what finished and what it spent; Workflows, from the
 * factory's own self-description; Stations, a card each with the
 * registrations waiting on top; and Config, whose files a writer edits into
 * a pull request. The tab open is the address's (`?tab=`), so a link — Now's
 * "Stations →" — lands on the tab that answers it. Live: the queries keep
 * themselves current; the forge is looked at once when the page opens, and
 * again whenever a station reports a commit it has not measured.
 */
export function FactoryPage({ factory }: { factory: string }) {
  const signIn = useSignIn();
  const { forge, viewer } = useCockpit();
  const page = useQuery(api.factory.page, { factory, signIn });
  const ask = useAction(api.factory.look);
  const [look, setLook] = useState<Look | null>(null);
  const facts = useQuery(api.activity.attention, { factory, signIn });
  const happening = useQuery(api.activity.page, { factory, signIn });
  const now = useClock();
  // The last 30 days by the viewer's own midnights: the query is asked again only when the day moves on.
  const timeZone = viewersTimeZone();
  const period = daysOf(dayOf(now - 29 * DAY, timeZone), dayOf(now, timeZone), timeZone)!;
  const stations = useQuery(api.activity.stations, { factory, signIn, period });
  const registrations = useQuery(api.stations.registrations, { factory, signIn });
  const approve = useMutation(api.stations.approve);
  const revoke = useMutation(api.stations.revoke);
  const release = useAction(api.claims.release);
  const purges = useQuery(api.retention.purges, { factory, signIn });
  const purge = useAction(api.retention.purgeFactory);
  const [released, setReleased] = useState("");
  const [problem, setProblem] = useState("");
  const [triggering, setTriggering] = useState(false);
  const run = useRunPrompt();
  // The file open in the config editor, and the commit the editor reads every file at — fixed when it first opens.
  const [editing, setEditing] = useState<{ path: string; base: string } | null>(null);
  const path = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const tab = tabOf(search.get("tab"));
  const onTab = useCallback((next: FactoryTab) => {
    const query = new URLSearchParams(search.toString());
    if (next === "overview") query.delete("tab");
    else query.set("tab", next);
    const written = query.toString();
    router.replace(written ? `${path}?${written}` : path, { scroll: false });
  }, [path, router, search]);

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
  if (page === undefined) return <Loading />;
  if (page === null) return <Notice>{factory} is not a factory you can read. <Link href="/factories">All factories</Link></Notice>;
  const web = `https://${forge.host}`;
  const onRelease = (claim: ClaimView) => {
    setReleased("");
    void release({ claim: claim.id, signIn })
      .then((done) => setReleased(!done.ok ? `Not released: ${done.because}` : done.relabelled ? "" : `Released — ${done.because}.`))
      .catch((error: unknown) => setReleased(`Not released: ${said(error)}`));
  };

  const settled = (verb: string) => (done: { ok: true } | { ok: false; because: string }) => setProblem(done.ok ? "" : `Not ${verb}: ${done.because}`);
  const failed = (verb: string) => (error: unknown) => setProblem(`Not ${verb}: ${said(error)}`);

  return (
    <FactoryView page={page} look={look} drifts={measured} forge={web} now={now} tab={tab} onTab={onTab}
                 triggering={triggering} onTrigger={() => setTriggering(!triggering)}
                 trigger={triggering ? <TriggerForm factory={page.repo} signIn={signIn} as={viewer?.login ?? ""} /> : null}
                 panels={{
                   overview: (
                     <>
                       {released ? <Notice>{released}</Notice> : null}
                       <ActivityTab factory={factory} forge={web} now={now} attention={attention} page={happening} onRelease={onRelease} />
                       <section className="mt-8"><h2 className="mb-3">Spend</h2><CostPanel factory={factory} /></section>
                     </>
                   ),
                   workflows: <WorkflowsTab check={page.check} onRun={(workflow) => run({ factory: page.repo, workflow })} />,
                   stations: (
                     <>
                       {problem ? <Notice tone="bad">{problem}</Notice> : null}
                       {released ? <Notice>{released}</Notice> : null}
                       {stations && registrations ? (
                         <StationsTab stations={stations.stations} ci={stations.ci} registrations={registrations} drifts={measured}
                                      now={now} factory={factory} forge={web} defaultBranch={page.defaultBranch}
                                      release={page.check?.description.skillVersion ?? ""} onRelease={onRelease}
                                      onApprove={(asked) => {
                                        setProblem("");
                                        void approve({ code: asked.code, signIn }).then(settled("approved")).catch(failed("approved"));
                                      }}
                                      onRevoke={(station) => {
                                        setProblem("");
                                        void revoke({ factory, station: station.station, signIn }).then(settled("revoked")).catch(failed("revoked"));
                                      }} />
                       ) : <Loading />}
                     </>
                   ),
                   config: (
                     <ConfigTab page={page} look={look} drifts={measured} forge={web} now={now} purges={purges}
                                onPurge={(reason) => purge({ factory, reason, signIn })}
                                onEdit={(path) => {
                                  const base = editing?.base ?? (look?.ok ? look.tip : null);
                                  if (base) setEditing({ path, base });
                                }}
                                editor={editing && page.defaultBranch ? (
                                  <ConfigEditor factory={page.repo} base={editing.base} into={page.defaultBranch} as={viewer?.login ?? ""}
                                                open={editing.path} signIn={signIn} onOpen={(path) => setEditing({ ...editing, path })} />
                                ) : null} />
                   ),
                 }} />
  );
}

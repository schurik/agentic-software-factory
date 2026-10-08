"use client";

import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import { FACTORY_FILE } from "@/convex/forge/forge";
import type { ClaimView } from "@/convex/model/claim";
import { dayOf, daysOf, lastDays } from "@/convex/model/period";
import { useClock, viewersTimeZone } from "../clock";
import { useRunPrompt } from "../run/RunDialog";
import { said } from "../said";
import { useCockpit } from "../Shell";
import { useSignIn } from "../signIn";
import { TriggerForm } from "../trigger/Trigger";
import { Loading, Notice } from "../ui";
import { ConfigEditor } from "./ConfigEditor";
import { ConfigTab } from "./ConfigTab";
import { FactoryView } from "./FactoryView";
import { OverviewTab, type OverviewDays } from "./OverviewTab";
import { IngestTokens, StationsTab } from "./StationsTab";
import { drifts, type FactoryTab, tabOf } from "./view";
import { WorkflowsTab } from "./WorkflowsTab";

const DAY = 24 * 3600_000;

/**
 * One factory (#118): its header, and its tabs — Overview, what the factory
 * spent and how its sessions and gates went over the last 7 or 30 days
 * (#119); Workflows, from the factory's own self-description, each with its
 * last 30 days (#120); Stations, a
 * card each with the registrations waiting on top; and Config, whose files a
 * writer edits into a pull request. The tab open is the address's (`?tab=`), so a link — Now's
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
  const now = useClock();
  // The last days by the viewer's own midnights: a query is asked again only when the day moves on.
  const timeZone = viewersTimeZone();
  const period = daysOf(dayOf(now - 29 * DAY, timeZone), dayOf(now, timeZone), timeZone)!;
  const [days, setDays] = useState<OverviewDays>(30);
  const midnights = lastDays(days, now, timeZone);
  const overview = useQuery(api.overview.page, { factory, days: midnights, signIn });
  // The Workflows tab's record is always the last 30 days: the Overview's own query, when it shows those too.
  const record = useQuery(api.overview.page, { factory, days: lastDays(30, now, timeZone), signIn });
  const stations = useQuery(api.activity.stations, { factory, signIn, period });
  const registrations = useQuery(api.stations.registrations, { factory, signIn });
  const approve = useMutation(api.stations.approve);
  const revoke = useMutation(api.stations.revoke);
  const tokens = useQuery(api.tokens.list, { factory, signIn });
  const issueToken = useAction(api.tokens.issueForCi);
  const revokeToken = useMutation(api.tokens.revoke);
  // A token issued for CI, shown this once: leaving the page forgets it.
  const [issued, setIssued] = useState<string | null>(null);
  const release = useAction(api.claims.release);
  const purges = useQuery(api.retention.purges, { factory, signIn });
  const purge = useAction(api.retention.purgeFactory);
  const [released, setReleased] = useState("");
  const [problem, setProblem] = useState("");
  const [triggering, setTriggering] = useState(false);
  const run = useRunPrompt();
  // The file open in the config editor, and the commit the editor reads every file at — fixed when it first opens,
  // and kept when its dialog closes, so that its drafts outlive closing it.
  const [editing, setEditing] = useState<{ path: string; base: string; files: string[] } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
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
                   overview: <OverviewTab overview={overview} days={days} midnights={midnights} now={now} timeZone={timeZone} onDays={setDays} />,
                   workflows: (
                     <WorkflowsTab check={page.check} factory={page.repo} stations={page.stations} now={now} record={record ?? undefined}
                                   onRun={(workflow) => run({ factory: page.repo, workflow })} />
                   ),
                   stations: (
                     <div className="grid gap-4">
                       {problem ? <Notice tone="bad">{problem}</Notice> : null}
                       {released ? <Notice>{released}</Notice> : null}
                       {stations && registrations ? (
                         <StationsTab stations={stations.stations} ci={stations.ci} registrations={registrations} drifts={measured}
                                      now={now} factory={factory} forge={web} defaultBranch={page.defaultBranch}
                                      release={page.check?.description.skillVersion ?? ""} onRelease={onRelease}
                                      onApprove={(code) => {
                                        setProblem("");
                                        void approve({ code, signIn }).then(settled("approved")).catch(failed("approved"));
                                      }}
                                      onRevoke={(station) => {
                                        setProblem("");
                                        void revoke({ factory, station: station.station, signIn }).then(settled("revoked")).catch(failed("revoked"));
                                      }} />
                       ) : <Loading />}
                       {tokens ? (
                         <IngestTokens tokens={tokens} factory={factory} now={now} issued={issued}
                                       onIssue={(label) => {
                                         setProblem("");
                                         setIssued(null);
                                         void issueToken({ factory, label, signIn })
                                           .then((done) => (done.ok ? setIssued(done.token) : setProblem(`Not issued: ${done.because}`)))
                                           .catch(failed("issued"));
                                       }}
                                       onRevoke={(token) => {
                                         setProblem("");
                                         void revokeToken({ token: token.id, signIn }).then(settled("revoked")).catch(failed("revoked"));
                                       }} />
                       ) : null}
                     </div>
                   ),
                   config: (
                     <ConfigTab page={page} look={look} drifts={measured} forge={web} now={now} purges={purges} onTab={onTab}
                                onPurge={(reason) => purge({ factory, reason, signIn })}
                                onEdit={() => {
                                  const files = look?.ok ? look.files : null;
                                  if (editing === null && look?.ok && look.tip && files?.length) {
                                    setEditing({ path: files.includes(FACTORY_FILE) ? FACTORY_FILE : files[0], base: look.tip, files });
                                  }
                                  setEditorOpen(true);
                                }}
                                editor={editing && page.defaultBranch ? (
                                  <ConfigEditor forge={web} factory={page.repo} base={editing.base} into={page.defaultBranch} as={viewer?.login ?? ""}
                                                files={editing.files} file={editing.path} signIn={signIn} open={editorOpen}
                                                onFile={(path) => setEditing({ ...editing, path })} onClose={() => setEditorOpen(false)} />
                                ) : null} />
                   ),
                 }} />
  );
}

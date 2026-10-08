"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useClock } from "./clock";
import { said } from "./said";
import type { ClaimView } from "@/convex/model/claim";
import type { Command } from "./session/action";
import { LiveGate } from "./gate/GateDrawer";
import { PhaseDetails } from "./session/PhaseDetails";
import { SessionView } from "./session/SessionView";
import { readShown, type Shown, writeShown } from "./session/shown";
import { useSignIn } from "./signIn";
import { Loading, Notice } from "./ui";

/**
 * One session, live. `useQuery` is a subscription: every event a station ships
 * re-runs the query and the page moves on in place, with nothing to reload.
 * The clock ticks on its own so "last heard from" keeps counting between events.
 * What is open — the tab, chapters, stages, the drawer — is the address's
 * (`shown.ts`), so a link opens what its sender saw.
 */
export function SessionPage({ factory, session }: { factory: string; session: string }) {
  const signIn = useSignIn();
  const page = useQuery(api.sessions.get, { factory, session, signIn });
  // Apart from the page: the station polls every few seconds, and that must
  // not re-tell the whole story each time.
  const steering = useQuery(api.commands.steering, { factory, session, signIn });
  const kill = useMutation(api.commands.kill);
  const resume = useMutation(api.commands.resume);
  const claims = useQuery(api.claims.ofSession, { factory, session, signIn });
  const release = useAction(api.claims.release);
  const purge = useMutation(api.retention.purgeSession);
  const changes = useAction(api.diffs.changes);
  const readChanges = useCallback(() => changes({ factory, session, signIn }), [changes, factory, session, signIn]);
  const [problem, setProblem] = useState("");
  const [released, setReleased] = useState("");
  const [answered, setAnswered] = useState<{ what: string; url: string } | null>(null);
  const now = useClock();
  const path = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const onShow = useCallback((next: Shown) => {
    router.replace(`${path}${writeShown(next, new URLSearchParams(search.toString()))}`, { scroll: false });
  }, [path, router, search]);
  if (page === undefined) return <Loading />;
  if (page === null) {
    return (
      <Notice>
        No station has shipped session <code>{session}</code> of {factory}, or it is in a repository you cannot read.
      </Notice>
    );
  }
  const onCommand = (command: Command) => {
    setProblem("");
    void (command === "kill" ? kill : resume)({ factory, session, signIn })
      .then((queued) => { if (!queued.ok) setProblem(`Not queued: ${queued.because}`); })
      .catch((error: unknown) => setProblem(`Not queued: ${said(error)}`));
  };
  const onRelease = (claim: ClaimView) => {
    setProblem("");
    setReleased("");
    void release({ claim: claim.id, signIn })
      .then((done) => {
        if (!done.ok) setProblem(`Not released: ${done.because}`);
        else if (!done.relabelled) setReleased(`Released — ${done.because}.`);
      })
      .catch((error: unknown) => setProblem(`Not released: ${said(error)}`));
  };
  return (
    <div className="flex flex-col gap-5">
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {released ? <Notice tone="ok">{released}</Notice> : null}
      {answered ? (
        <Notice tone="ok">
          Answered {answered.what}{answered.url
            ? <>: <a href={answered.url} target="_blank" rel="noreferrer">the comment</a>. The station picks it up from the comment on the issue.</>
            : <>: sent to the station. It goes on once the station records it as your decision.</>}
        </Notice>
      ) : null}
      <SessionView page={page} now={now} shown={readShown(new URLSearchParams(search.toString()))} onShow={onShow}
                   steering={steering} onCommand={onCommand} claims={claims} onRelease={onRelease}
                   onPurge={page.mayPurge ? (reason) => purge({ factory, session, reason, signIn }) : undefined}
                   readChanges={readChanges}
                   gate={(item, tab, onTab, close) => (
                     // One gate a session waits at: answered, the drawer closes and the page says where the answer went.
                     <LiveGate key={item.phaseId} signIn={signIn} now={now} target={{ factory, session, tab, onTab, step: null, close }}
                               onAnswered={(gate, given, url) => {
                                 setAnswered({ what: `${given.verdict} at ${gate.row.gate} round ${gate.row.round}`, url });
                                 close.onClick();
                               }} />
                   )}
                   phase={(item, tab, onTab) => (
                     <PhaseDetails item={item} where={{ factory, session, forge: page.forge }} tab={tab} onTab={onTab} />
                   )} />
    </div>
  );
}

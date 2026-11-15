"use client";

import { useCallback } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Phase } from "@/convex/model/graph";
import { useSignIn } from "../signIn";
import { askedTab, PhaseTabs, type Where } from "./PhaseTabs";

/**
 * A phase's tabs, asked for as its drawer opens: its detail is a query of
 * its own (`sessions.phase`), live like the page. What the Tools, Events,
 * Agent prompt and Harness output tabs show is each a query of its own too,
 * asked for only while that tab is shown — the transcript's above all, the
 * heaviest thing a session holds (#275). A repo artifact (`artifacts.read`)
 * and a commit's diff (`diffs.commit`) are read from the forge when their tab
 * is shown.
 */
export function PhaseDetails({ item, where, tab, onTab }: {
  item: Phase; where: Where; tab: string | null; onTab: (tab: string) => void;
}) {
  const signIn = useSignIn();
  const args = { factory: where.factory, session: where.session, phaseId: item.phaseId, signIn };
  const detail = useQuery(api.sessions.phase, args);
  const asked = askedTab(tab);
  const tools = useQuery(api.sessions.phaseTools, asked === "tools" ? args : "skip");
  const events = useQuery(api.sessions.events, asked === "events" ? args : "skip");
  const prompt = useQuery(api.sessions.prompts, asked === "prompt" ? args : "skip");
  const output = useQuery(api.sessions.output, asked === "output" ? args : "skip");
  const readArtifact = useAction(api.artifacts.read);
  const read = useCallback(
    (seq: number) => readArtifact({ factory: where.factory, session: where.session, seq, signIn }),
    [readArtifact, where.factory, where.session, signIn]);
  const readCommit = useAction(api.diffs.commit);
  const readDiff = useCallback(
    (sha: string) => readCommit({ factory: where.factory, session: where.session, sha, signIn }),
    [readCommit, where.factory, where.session, signIn]);
  if (detail === undefined) return <p className="text-sm text-muted">Loading…</p>;
  if (detail === null) return <p className="text-sm text-muted">This phase is not in a session you can see.</p>;
  // Null from a tab's own query is the same answer as the detail's: not a session the viewer can see.
  const loaded = { tools: tools ?? undefined, events: events ?? undefined, prompt: prompt ?? undefined,
                   output: output ?? undefined };
  return <PhaseTabs item={item} detail={detail} loaded={loaded} where={where} tab={tab} onTab={onTab} read={read} readDiff={readDiff} />;
}

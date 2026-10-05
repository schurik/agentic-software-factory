"use client";

import { useCallback } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Phase } from "@/convex/model/graph";
import { useSignIn } from "../signIn";
import { PhaseTabs, type Where } from "./PhaseTabs";

/**
 * A phase's tabs, asked for as its drawer opens: its detail is a query of
 * its own (`sessions.phase`), live like the page, and a repo artifact is read
 * from the forge (`artifacts.read`) when its tab is shown.
 */
export function PhaseDetails({ item, where, tab, onTab }: {
  item: Phase; where: Where; tab: string | null; onTab: (tab: string) => void;
}) {
  const signIn = useSignIn();
  const detail = useQuery(api.sessions.phase, { factory: where.factory, session: where.session, phaseId: item.phaseId, signIn });
  const readArtifact = useAction(api.artifacts.read);
  const read = useCallback(
    (seq: number) => readArtifact({ factory: where.factory, session: where.session, seq, signIn }),
    [readArtifact, where.factory, where.session, signIn]);
  if (detail === undefined) return <p className="text-sm text-muted">Loading…</p>;
  if (detail === null) return <p className="text-sm text-muted">This phase is not in a session you can see.</p>;
  return <PhaseTabs item={item} detail={detail} where={where} tab={tab} onTab={onTab} read={read} />;
}

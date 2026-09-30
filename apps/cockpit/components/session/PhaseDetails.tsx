"use client";

import { useCallback } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useSignIn } from "../signIn";
import { PhaseTabs, type Where } from "./PhaseTabs";

/**
 * A phase's tabs, asked for as the phase is opened: its detail is a query of
 * its own (`sessions.phase`), live like the page, and a repo artifact is read
 * from the forge (`artifacts.read`) when its tab is shown.
 */
export function PhaseDetails({ phaseId, where, initial }: { phaseId: string; where: Where; initial?: string }) {
  const signIn = useSignIn();
  const detail = useQuery(api.sessions.phase, { factory: where.factory, session: where.session, phaseId, signIn });
  const readArtifact = useAction(api.artifacts.read);
  const read = useCallback(
    (seq: number) => readArtifact({ factory: where.factory, session: where.session, seq, signIn }),
    [readArtifact, where.factory, where.session, signIn]);
  if (detail === undefined) return <p className="muted small">Loading…</p>;
  if (detail === null) return <p className="muted small">This phase is not in a session you can see.</p>;
  return <PhaseTabs detail={detail} where={where} initial={initial} read={read} />;
}

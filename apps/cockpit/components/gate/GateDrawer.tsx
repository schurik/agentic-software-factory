"use client";

import { useAction, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Answer } from "@/convex/model/answer";
import { DrawerFrame } from "../Drawer";
import { StageIcon } from "../icons";
import { said } from "../said";
import type { Go } from "../ui";
import { comparedWith, type Gate, GateView, type Read, type Since, type Step } from "./GateView";

/** Which wait the drawer holds, and what is around it: its tab, the gates either side, and Close. */
export interface GateTarget {
  factory: string;
  session: string;
  tab: string | null;
  onTab: (tab: string) => void;
  step: Step | null;
  close: Go;
}

/**
 * A gate, live, in the drawer: the wait as the viewer may see it
 * (`inbox.gate`), its subject read from the forge as it opens — a plan's
 * since the round before too, where the forge holds both — and the answer
 * posted from it exactly as the inbox always posted it (`inbox.answer`) —
 * the Inbox and the session page's Now card open the same thing.
 * `onAnswered` is told what was given and where it went.
 */
export function LiveGate({ target, signIn, now, onAnswered }: {
  target: GateTarget;
  signIn: string | undefined;
  now: number;
  onAnswered: (gate: Gate, answer: Answer, url: string) => void;
}) {
  const { factory, session } = target;
  const where = { factory, session, signIn };
  const gate = useQuery(api.inbox.gate, where);
  const readSubject = useAction(api.inbox.subject);
  const readSince = useAction(api.inbox.sinceLastRound);
  const answer = useAction(api.inbox.answer);
  const [read, setRead] = useState<Read | null>(null);
  // Kept with the two commits it compared, so a round asked since never shows the one before's.
  const [sinceRead, setSinceRead] = useState<{ between: string; got: Since } | null>(null);
  const [posting, setPosting] = useState(false);
  const [problem, setProblem] = useState("");
  const digest = gate?.subjectDigest;
  const from = gate ? comparedWith(gate) : null;
  const between = `${factory}/${session}@${from}...${gate?.subject.headSha}`;

  useEffect(() => {
    if (digest === undefined) return;
    let current = true;
    readSubject({ factory, session, signIn }).then(
      (got) => { if (current) setRead(got); },
      (error: unknown) => { if (current) setRead({ ok: false, because: said(error) }); });
    return () => { current = false; };
  }, [readSubject, factory, session, signIn, digest]);

  useEffect(() => {
    if (from === null) return;
    let current = true;
    readSince({ factory, session, signIn }).then(
      (got) => { if (current) setSinceRead({ between, got }); },
      (error: unknown) => { if (current) setSinceRead({ between, got: { ok: false, because: said(error) } }); });
    return () => { current = false; };
  }, [readSince, factory, session, signIn, from, between]);

  if (gate === undefined || gate === null) {
    return (
      <DrawerFrame icon={<StageIcon name="" size={16} className="text-muted" />} title="gate" what="" back={null} close={target.close}>
        <p className="text-sm text-muted">{gate === undefined ? "Loading…" : "This session is not waiting at a gate you can see any more."}</p>
      </DrawerFrame>
    );
  }
  const give = async (given: Answer) => {
    setPosting(true);
    setProblem("");
    try {
      const result = await answer({ ...where, gate: gate.row.gate, round: gate.row.round, digest: gate.subjectDigest, ...given });
      if (result.ok) onAnswered(gate, given, result.url);
      else setProblem(result.because);
    } catch (error) {
      setProblem(said(error));
    } finally {
      setPosting(false);
    }
  };
  return (
    <GateView key={`${factory}/${session}/${gate.row.gate}/${gate.row.round}`} gate={gate} read={read}
              since={sinceRead?.between === between ? sinceRead.got : null} now={now}
              posting={posting} problem={problem} onAnswer={(given) => void give(given)}
              tab={target.tab} onTab={target.onTab} close={target.close} step={target.step} />
  );
}

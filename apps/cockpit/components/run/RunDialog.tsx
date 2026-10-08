"use client";

import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, type Dispatch, type ReactNode, useCallback, useContext, useEffect, useReducer, useState } from "react";
import { api } from "@/convex/_generated/api";
import { repoKey } from "@/convex/forge/forge";
import { useClock } from "../clock";
import { said } from "../said";
import { useSignIn } from "../signIn";
import { Modal } from "../ui";
import { CLOSED, factoryInView, RUN_PARAM, runDialog, type RunDialogAction, type RunDialogState } from "./dialog";
import { RunForm } from "./RunForm";

/** What opening the dialog may choose for the person: a factory other than the one in view, and a workflow. */
export interface RunAsk {
  factory?: string;
  workflow?: string;
}

const Opener = createContext<((ask?: RunAsk) => void) | null>(null);

/** Open the Run a prompt dialog: on the factory in view, unless `ask` names another, and on `ask`'s workflow. */
export function useRunPrompt(): (ask?: RunAsk) => void {
  const open = useContext(Opener);
  if (open === null) throw new Error("useRunPrompt is for pages inside the Shell");
  return open;
}

/**
 * Run a prompt, one dialog owned by the header (#108): whatever opens it —
 * the header's button, a workflow's Run, a `?run` link such as the one the
 * retired `/run` page redirects to — opens this one, on the factory the page
 * is about; `useRunPrompt` opens it from anywhere under it. Until `enabled`
 * — someone the cockpit knows — a `?run` link waits.
 */
export function RunPrompt({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const path = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [state, dispatch] = useReducer(runDialog, CLOSED);
  const inView = factoryInView(path, search.toString());

  const open = useCallback((ask: RunAsk = {}) => {
    dispatch({ type: "open", factory: ask.factory ?? inView ?? "", workflow: ask.workflow });
  }, [inView]);

  // A `?run` link opens it once, then leaves the address as the page's own.
  const asked = search.get(RUN_PARAM);
  useEffect(() => {
    if (!enabled || asked === null) return;
    open(asked ? { factory: asked } : {});
    const rest = new URLSearchParams(search.toString());
    rest.delete(RUN_PARAM);
    router.replace(rest.size ? `${path}?${rest}` : path, { scroll: false });
  }, [enabled, asked, open, path, router, search]);

  return (
    <Opener.Provider value={open}>
      {children}
      <Modal open={state.open} onClose={() => dispatch({ type: "close" })} title="Run a prompt"
             description="One of your stations on the factory starts a session from it, as you.">
        <LiveRunForm state={state} dispatch={dispatch} />
      </Modal>
    </Opener.Provider>
  );
}

/** The form, on what the backend says now: asked only while the dialog is open. */
function LiveRunForm({ state, dispatch }: { state: RunDialogState; dispatch: Dispatch<RunDialogAction> }) {
  const signIn = useSignIn();
  const now = useClock();
  const mine = useQuery(api.stations.mine, { signIn });
  // The factories the viewer has a station on, and the one asked for, spelled as their stations spell it.
  const factories = [...new Set((mine ?? []).map((row) => row.factory))].sort();
  const factory = factories.find((each) => repoKey(each) === repoKey(state.factory)) ?? state.factory;
  if (factory && !factories.includes(factory)) factories.push(factory);
  const chosen = factory ? { factory, signIn } : "skip";
  const workflows = useQuery(api.factory.promptWorkflows, chosen);
  const targets = useQuery(api.commands.runTargets, chosen);
  const runs = useQuery(api.commands.runs, chosen);
  const run = useMutation(api.commands.run);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  return (
    <RunForm factories={factories} state={{ ...state, factory }} workflows={workflows} targets={targets} runs={runs ?? []}
             now={now} busy={busy} problem={problem}
             onChange={(action) => { setProblem(""); dispatch(action); }}
             onCancel={() => dispatch({ type: "close" })}
             onRun={(asked) => {
               setBusy(true);
               setProblem("");
               // Queued, the prompt is spent: the run shows under the form, and goes on there as its station reports.
               void run({ factory, ...asked, signIn })
                 .then((queued) => { if (queued.ok) dispatch({ type: "prompt", prompt: "" }); else setProblem(queued.because); })
                 .catch((error: unknown) => setProblem(said(error)))
                 .finally(() => setBusy(false));
             }} />
  );
}

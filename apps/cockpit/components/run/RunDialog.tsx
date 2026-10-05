"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useReducer, useState } from "react";
import { api } from "@/convex/_generated/api";
import { repoKey } from "@/convex/forge/forge";
import { useClock } from "../clock";
import { said } from "../said";
import { useSignIn } from "../signIn";
import { cx } from "../ui";
import { CLOSED, factoryInView, RUN_PARAM, runDialog } from "./dialog";
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
      <Dialog.Root open={state.open} onOpenChange={(opened) => { if (!opened) dispatch({ type: "close" }); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className={cx(
            "fixed inset-0 z-40 bg-black/25 transition-opacity dark:bg-black/60",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
          )} />
          <Dialog.Popup className={cx(
            "fixed top-[8dvh] left-1/2 z-50 max-h-[84dvh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto",
            "rounded-xl border border-line bg-surface p-5 shadow-pop transition-[scale,opacity] duration-150",
            "data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
          )}>
            <div className="mb-4 flex items-start gap-3">
              <div className="grow">
                <Dialog.Title className="text-lg font-semibold">Run a prompt</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  One of your stations on the factory starts a session from it, as you.
                </Dialog.Description>
              </div>
              <Dialog.Close aria-label="Close"
                            className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
                <X size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>
            {state.open ? <Live state={state} dispatch={dispatch} /> : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </Opener.Provider>
  );
}

/** The form, on what the backend says now: asked only while the dialog is open. */
function Live({ state, dispatch }: { state: Parameters<typeof RunForm>[0]["state"]; dispatch: Parameters<typeof RunForm>[0]["onChange"] }) {
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

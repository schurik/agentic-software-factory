"use client";

import { useAction, useQuery } from "convex/react";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { repoKey } from "@/convex/forge/forge";
import type { Offered, Triggered } from "@/convex/trigger";
import { factoryInView } from "../run/dialog";
import { said } from "../said";
import { useSignIn } from "../signIn";
import { Modal } from "../ui";
import { ViewerLogin } from "../viewer";
import { type Asked, TriggerFormView } from "./Trigger";

const Opener = createContext<(() => void) | null>(null);

/** Open the Trigger a workflow dialog, on the factory in view. */
export function useTrigger(): () => void {
  const open = useContext(Opener);
  if (open === null) throw new Error("useTrigger is for pages inside the Shell");
  return open;
}

/**
 * Trigger a workflow, the header's other dialog, beside Run a prompt (#108):
 * always offered, as that one is, and opened on the factory the page is
 * about. `as` is the viewer's login, which the labels go on under.
 */
export function TriggerWorkflow({ as, children }: { as: string; children: ReactNode }) {
  const path = usePathname();
  const search = useSearchParams();
  const [opened, setOpened] = useState<{ factory: string } | null>(null);
  const inView = factoryInView(path, search.toString());
  const open = useCallback(() => setOpened({ factory: inView ?? "" }), [inView]);
  const close = () => setOpened(null);
  return (
    <Opener.Provider value={open}>
      {children}
      <Modal open={opened !== null} onClose={close} title="Trigger a workflow"
             description="Labels an issue on the forge as you, and the factory's issues watcher starts the workflow.">
        <ViewerLogin.Provider value={as || null}>
          <LiveTriggerForm start={opened?.factory ?? ""} as={as} onCancel={close} />
        </ViewerLogin.Provider>
      </Modal>
    </Opener.Provider>
  );
}

/** The form, on what the forge says now: the routes are read again whenever another factory is chosen. */
function LiveTriggerForm({ start, as, onCancel }: { start: string; as: string; onCancel: () => void }) {
  const signIn = useSignIn();
  const readRoutes = useAction(api.trigger.routes);
  const trigger = useAction(api.trigger.trigger);
  const offered = useQuery(api.trigger.factories, { signIn });
  const [asked, setAsked] = useState<Asked>({ factory: start, issue: "", label: "" });
  // The routes read, and for which factory: another factory's are none of this one's.
  const [read, setRead] = useState<{ factory: string; routes: Offered } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Triggered | null>(null);

  // The factory asked for, spelled as the forge spells it.
  const factories = [...(offered ?? [])];
  const factory = factories.find((each) => repoKey(each) === repoKey(asked.factory)) ?? asked.factory;
  if (factory && !factories.includes(factory)) factories.push(factory);
  const routes = read?.factory === factory ? read.routes : null;

  useEffect(() => {
    if (!factory) return;
    let current = true;
    readRoutes({ factory, signIn }).then(
      (got) => { if (current) setRead({ factory, routes: got }); },
      (error: unknown) => { if (current) setRead({ factory, routes: { ok: false, because: said(error) } }); });
    return () => { current = false; };
  }, [readRoutes, factory, signIn]);

  const submit = async () => {
    if (routes === null || !routes.ok) return;
    setBusy(true);
    setOutcome(null);
    try {
      const label = asked.label || routes.routes[0].label;
      setOutcome(await trigger({ factory, issue: Number(asked.issue), label, signIn }));
    } catch (error) {
      setOutcome({ ok: false, because: said(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <TriggerFormView factories={factories} routes={routes} asked={{ ...asked, factory }} busy={busy} outcome={outcome} as={as}
                     onChange={(next) => { setAsked(next); setOutcome(null); }} onSubmit={() => void submit()} onCancel={onCancel} />
  );
}

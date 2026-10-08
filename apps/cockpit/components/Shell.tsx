"use client";

import { usePathname } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { type ComponentProps, createContext, useContext, useEffect } from "react";
import { api } from "@/convex/_generated/api";
import { Header, knows, type Me } from "./Header";
import { RunPrompt, useRunPrompt } from "./run/RunDialog";
import { holdSignIn, useSignIn } from "./signIn";
import { TriggerWorkflow, useTrigger } from "./trigger/TriggerDialog";
import { SignInWall } from "./SignInPage";
import { Loading } from "./ui";
import { ViewerLogin } from "./viewer";

const Cockpit = createContext<Me | null>(null);

/** Which cockpit this is and who is looking — for anything inside the shell. */
export function useCockpit(): Me {
  const me = useContext(Cockpit);
  if (me === null) throw new Error("useCockpit is for pages inside the Shell");
  return me;
}

// The pages a person reaches before they are anyone here: registering the
// App, and coming back from the forge.
const OPEN = ["/setup", "/auth/callback"];

const REFRESH_EVERY = 5 * 60_000;

/**
 * The header, and the decision every page waits on: a team's cockpit shows
 * nothing until its App is registered and the viewer has signed in with it;
 * a local one is its owner's and asks nothing.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const signIn = useSignIn();
  const me = useQuery(api.viewer.me, { signIn });
  const pathname = usePathname();
  const refresh = useAction(api.viewer.refresh);
  const signOut = useMutation(api.auth.signOut);
  const signedIn = me?.mode === "team" && me.viewer !== null;
  const waiting = useQuery(api.inbox.count, knows(me) ? { signIn } : "skip") ?? 0;

  // The permission mirror is the forge's word from a few minutes ago; asking
  // again is the page's job, because nothing else knows anyone is looking.
  useEffect(() => {
    if (!signedIn || !signIn) return;
    const ask = () => void refresh({ signIn }).catch(() => undefined);
    ask();
    const timer = setInterval(ask, REFRESH_EVERY);
    return () => clearInterval(timer);
  }, [signedIn, signIn, refresh]);

  const open = OPEN.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const walled = me !== undefined && me.mode === "team" && me.viewer === null && !open;

  return (
    <RunPrompt enabled={knows(me)}>
      <TriggerWorkflow as={me?.viewer?.login ?? ""}>
        <ActionsHeader me={me} path={pathname} waiting={waiting}
                       onSignOut={() => { if (signIn) void signOut({ signIn }).finally(() => holdSignIn(null)); }} />
        <main className="mx-auto max-w-[1280px] px-4 pt-6 pb-16 md:px-6 md:pt-8">
          {me === undefined ? <Loading />
            : walled ? <SignInWall forge={me.forge} />
            : me.viewer && !me.viewer.reachKnown && !open
              // What was known is too old to show anything on; the refresh above is asking.
              ? <Loading what={`Asking ${me.forge.host} what you can read…`} />
              : (
                <Cockpit.Provider value={me}>
                  <ViewerLogin.Provider value={me.viewer?.login ?? null}>{children}</ViewerLogin.Provider>
                </Cockpit.Provider>
              )}
        </main>
      </TriggerWorkflow>
    </RunPrompt>
  );
}

/** The header, its Run a prompt and Trigger a workflow opening their dialogs on the factory in view. */
function ActionsHeader(props: Omit<ComponentProps<typeof Header>, "onRun" | "onTrigger">) {
  const run = useRunPrompt();
  const trigger = useTrigger();
  return <Header {...props} onRun={() => run()} onTrigger={trigger} />;
}

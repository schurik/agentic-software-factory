"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Header, type Me } from "./Header";
import { carry, holdSignIn, useSignIn } from "./signIn";
import { Loading } from "./ui";
import { ViewerLogin } from "./viewer";

const Cockpit = createContext<Me | null>(null);

/** Which cockpit this is and who is looking — for anything inside the shell. */
export function useCockpit(): Me {
  const me = useContext(Cockpit);
  if (me === null) throw new Error("useCockpit is for pages inside the Shell");
  return me;
}

/** What went wrong, as the backend put it. */
export function said(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  return error instanceof Error ? error.message : String(error);
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
    <>
      <Header me={me} path={pathname}
              onSignOut={() => { if (signIn) void signOut({ signIn }).finally(() => holdSignIn(null)); }} />
      <main className="mx-auto max-w-[1280px] px-4 pt-6 pb-16 md:px-6 md:pt-8">
        {me === undefined ? <Loading />
          : walled ? <Wall me={me} />
          : me.viewer && !me.viewer.reachKnown && !open
            // What was known is too old to show anything on; the refresh above is asking.
            ? <Loading what={`Asking ${me.forge.host} what you can read…`} />
            : (
              <Cockpit.Provider value={me}>
                <ViewerLogin.Provider value={me.viewer?.login ?? null}>{children}</ViewerLogin.Provider>
              </Cockpit.Provider>
            )}
      </main>
    </>
  );
}

function Wall({ me }: { me: Me }) {
  const start = useAction(api.auth.start);
  const [problem, setProblem] = useState("");
  const [leaving, setLeaving] = useState(false);

  if (!me.forge.ready) {
    return (
      <div className="card">
        <h1>This cockpit has no GitHub App yet</h1>
        <p>
          A team&apos;s cockpit signs people in with a GitHub App the team registers for itself, and sees
          the forge through it. Whoever runs this deployment sets it up once.
        </p>
        <p><Link href="/setup" className="button">Set up the GitHub App</Link></p>
      </div>
    );
  }

  const go = async () => {
    setLeaving(true);
    setProblem("");
    try {
      const { url, state } = await start({});
      carry("sign-in", state);
      window.location.assign(url);
    } catch (error) {
      setProblem(said(error));
      setLeaving(false);
    }
  };

  return (
    <div className="card">
      <h1>Sign in</h1>
      <p>
        You are who <strong>{me.forge.host}</strong> says you are, and you see here what you can read there.
      </p>
      <p>
        <button type="button" className="button" disabled={leaving} onClick={() => void go()}>
          Sign in with {me.forge.host === "github.com" ? "GitHub" : me.forge.host}
        </button>
      </p>
      {problem ? <p className="error">{problem}</p> : null}
    </div>
  );
}

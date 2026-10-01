"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { createContext, useContext, useEffect, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { carry, holdSignIn, useSignIn } from "./signIn";

type Me = FunctionReturnType<typeof api.viewer.me>;

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
 * The bar, and the decision every page waits on: a team's cockpit shows
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
      <header className="bar">
        <Link href="/" className="brand">cockpit</Link>
        {me && (me.mode === "local" || me.viewer !== null) ? (
          <nav>
            <Link href="/">Inbox</Link>
            <Link href="/factories">Factories</Link>
            <Link href="/sessions">Sessions</Link>
            <Link href="/stations">Stations</Link>
          </nav>
        ) : null}
        <span className="who">
          {me?.viewer ? (
            <>
              {/* An avatar is the forge's image, at whatever host the forge is. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {me.viewer.avatarUrl ? <img src={me.viewer.avatarUrl} alt="" width={20} height={20} /> : null}
              <span title={me.viewer.name || undefined}>{me.viewer.login}</span>
              {me.mode === "team" && signIn ? (
                <button type="button" className="link" onClick={() => void signOut({ signIn }).finally(() => holdSignIn(null))}>
                  Sign out
                </button>
              ) : (
                <span className="muted">local</span>
              )}
            </>
          ) : me?.mode === "local" ? <span className="muted">local</span> : null}
        </span>
      </header>
      <main>
        {me === undefined ? <p className="muted">Loading…</p>
          : walled ? <Wall me={me} />
          : me.viewer && !me.viewer.reachKnown && !open
            // What was known is too old to show anything on; the refresh above is asking.
            ? <p className="muted">Asking {me.forge.host} what you can read…</p>
            : <Cockpit.Provider value={me}>{children}</Cockpit.Provider>}
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

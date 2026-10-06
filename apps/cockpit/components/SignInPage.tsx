"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Me } from "./Header";
import { said } from "./said";
import { carried, carry, holdSignIn } from "./signIn";
import { Button, buttonClass, Loading, Notice, Standalone } from "./ui";

/** What a team's cockpit shows someone it does not know yet: sign in, or — with no App to sign in with — set one up. */
export function SignInWall({ forge }: { forge: Me["forge"] }) {
  const start = useAction(api.auth.start);
  const leave = async () => {
    const { url, state } = await start({});
    carry("sign-in", state);
    window.location.assign(url);
  };
  return <SignInView forge={forge} onSignIn={leave} />;
}

/** The wall itself. `onSignIn` leaves for the forge, or throws what went wrong, which the page then says. */
export function SignInView({ forge, onSignIn }: { forge: Me["forge"]; onSignIn: () => Promise<void> }) {
  const [problem, setProblem] = useState("");
  const [leaving, setLeaving] = useState(false);

  if (!forge.ready) {
    return (
      <Standalone title="This cockpit has no GitHub App yet">
        <p>
          A team&apos;s cockpit signs people in with a GitHub App the team registers for itself, and sees
          the forge through it. Whoever runs this deployment sets it up once.
        </p>
        <p><Link href="/setup" className={buttonClass("primary")}>Set up the GitHub App</Link></p>
      </Standalone>
    );
  }

  const go = async () => {
    setLeaving(true);
    setProblem("");
    try {
      await onSignIn();
    } catch (error) {
      setProblem(said(error));
      setLeaving(false);
    }
  };

  return (
    <Standalone title="Sign in">
      <p>
        You are who <strong>{forge.host}</strong> says you are, and you see here what you can read there.
      </p>
      <p>
        <Button variant="primary" disabled={leaving} onClick={() => void go()}>
          Sign in with {forge.host === "github.com" ? "GitHub" : forge.host}
        </Button>
      </p>
      {problem ? <Notice tone="bad" role="alert">{problem}</Notice> : null}
    </Standalone>
  );
}

export function SignInCallback({ code, state, refused }: { code: string; state: string; refused: string }) {
  const finish = useAction(api.auth.finish);
  const router = useRouter();
  const [problem, setProblem] = useState("");
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;       // a code is good once; so is this effect
    asked.current = true;
    void (async () => {
      if (refused || !code) return setProblem(refused || "The forge sent no code back.");
      if (!carried("sign-in", state)) {
        return setProblem("This sign-in was not started in this browser tab. Start it again from here.");
      }
      try {
        holdSignIn(await finish({ code, state }));
        router.replace("/");
      } catch (error) {
        setProblem(said(error));
      }
    })();
  }, [code, state, refused, finish, router]);

  return <SignInCallbackView problem={problem} />;
}

/** Back from the forge: the wait while its code is traded, or why it was not. */
export function SignInCallbackView({ problem }: { problem: string }) {
  if (!problem) return <Loading what="Signing you in…" />;
  return (
    <Standalone title="Not signed in">
      <Notice tone="bad" role="alert">{problem}</Notice>
      <p><Link href="/" className={buttonClass()}>Try again</Link></p>
    </Standalone>
  );
}

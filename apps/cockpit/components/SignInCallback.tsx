"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { said } from "./said";
import { carried, holdSignIn } from "./signIn";

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

  if (!problem) return <p className="muted">Signing you in…</p>;
  return (
    <div className="card">
      <h1>Not signed in</h1>
      <p className="error">{problem}</p>
      <p><Link href="/" className="button">Try again</Link></p>
    </div>
  );
}

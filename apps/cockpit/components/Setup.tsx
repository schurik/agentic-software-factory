"use client";

import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Me } from "./Header";
import { said } from "./said";
import { useCockpit } from "./Shell";
import { carried, carry } from "./signIn";
import { Button, buttonClass, Control, cx, Field, Loading, Notice, Pre, Standalone } from "./ui";

/** What the setup form sends GitHub's way: the code printed on the deployment, the host, and the owning organization. */
export interface Begin {
  code: string;
  host: string;
  organization: string;
}

/**
 * Registering the team's GitHub App through the manifest flow (convex/setup.ts):
 * the form here, GitHub's own page to name the App, and back to the callback.
 */
export function SetupPage() {
  const { mode, forge } = useCockpit();
  const begin = useAction(api.setup.begin);
  const webhook = useQuery(api.setup.webhook, {});

  const leave = async (fields: Begin) => {
    const begun = await begin({ ...fields, appUrl: window.location.origin });
    carry("setup", begun.state);
    // GitHub takes the manifest as a form post, and shows the admin the App it would make.
    const form = document.createElement("form");
    form.method = "post";
    form.action = begun.url;
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "manifest";
    field.value = begun.manifest;
    form.append(field);
    document.body.append(form);
    form.submit();
  };

  return <SetupView mode={mode} forge={forge} webhook={webhook} onBegin={leave} />;
}

/**
 * The setup page itself: in a local cockpit only why there is none, in a
 * team's the three steps and the form that leaves for GitHub. `onBegin`
 * leaves, or throws what went wrong, which the form then says.
 */
export function SetupView({ mode, forge, webhook, onBegin }: {
  mode: Me["mode"];
  forge: Me["forge"];
  /** Where GitHub would deliver the App's webhook, and whether it could: undefined while that is asked. */
  webhook: FunctionReturnType<typeof api.setup.webhook> | undefined;
  onBegin: (fields: Begin) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [host, setHost] = useState("github.com");
  const [organization, setOrganization] = useState("");
  const [problem, setProblem] = useState("");
  const [leaving, setLeaving] = useState(false);

  if (mode === "local") {
    return (
      <Standalone title="Nothing to set up">
        <p>
          A local cockpit needs no setup: it asks the forge with your own <code>gh auth token</code>, and nobody signs in.
        </p>
      </Standalone>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLeaving(true);
    setProblem("");
    try {
      await onBegin({ code, host, organization });
    } catch (error) {
      setProblem(said(error));
      setLeaving(false);
    }
  };

  return (
    <Standalone title="Set up the GitHub App">
      <p>
        This cockpit reaches GitHub through an App your team registers for itself: people sign in with it,
        and it is how the cockpit sees your repositories. Registering takes three steps.
      </p>
      {forge.app ? (
        <Notice>
          <strong>{forge.app.slug}</strong> is registered on {forge.host}. Registering again replaces it and
          signs everyone out. To add repositories, <a href={forge.app.installUrl}>install it</a> on them instead.
        </Notice>
      ) : null}
      {webhook && !webhook.deliverable ? (
        <Notice>
          GitHub cannot deliver webhooks to <code>{webhook.url}</code>, and refuses to register an App that asks
          it to. So this App is registered <strong>without a webhook</strong>: the cockpit finds changes by asking
          GitHub once a minute instead. For webhooks, set <code>CONVEX_SITE_ORIGIN</code> to an address GitHub can
          reach, restart, and register again.
        </Notice>
      ) : null}
      <ol className="list-decimal pl-5 marker:text-muted [&>li+li]:mt-2">
        <li>
          Print a setup code on the deployment. It shows you run this cockpit, and works once, for an hour.
          <Pre className="mt-1.5">docker compose exec app ./convex.sh run setup:code</Pre>
        </li>
        <li>
          Fill this in and continue to GitHub, which shows the App it is about to create: private to your
          account, with its sign-in{webhook?.deliverable ? " and its webhook" : ""} pointed at this cockpit.
        </li>
        <li>Back here, install the App on the repositories that hold your factories.</li>
      </ol>
      <form className="grid gap-4 pt-3" onSubmit={(event) => void submit(event)}>
        <Field label="Setup code">
          <Control value={code} onValueChange={setCode} placeholder="asf_setup_…"
                   autoComplete="off" spellCheck={false} required />
        </Field>
        <Field label="GitHub host" hint={<>github.com, or your Enterprise Server&apos;s host name. An App belongs to one host.</>}>
          <Control value={host} onValueChange={setHost} spellCheck={false} required />
        </Field>
        <Field label="Organization" hint="The organization that will own the App. Leave empty to register it under your own account.">
          <Control value={organization} onValueChange={setOrganization} placeholder="acme" spellCheck={false} />
        </Field>
        <Button type="submit" variant="primary" className="justify-self-start" disabled={leaving}>Continue to GitHub</Button>
      </form>
      {problem ? <Notice tone="bad" role="alert">{problem}</Notice> : null}
    </Standalone>
  );
}

/** The App the callback registered: its name, and where it is installed on repositories. */
type Registered = FunctionReturnType<typeof api.setup.complete>;

export function SetupCallback({ code, state }: { code: string; state: string }) {
  const complete = useAction(api.setup.complete);
  const [app, setApp] = useState<Registered | null>(null);
  const [problem, setProblem] = useState("");
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;       // the code converts once; so does this effect
    asked.current = true;
    void (async () => {
      if (!code) return setProblem("GitHub sent no code back.");
      if (!carried("setup", state)) {
        return setProblem("This registration was not begun in this browser tab. Start the setup again from here.");
      }
      try {
        setApp(await complete({ code, state }));
      } catch (error) {
        setProblem(said(error));
      }
    })();
  }, [code, state, complete]);

  return <SetupCallbackView app={app} problem={problem} />;
}

/** Back from GitHub: why the App was not registered, the App that was and the one step left, or the wait in between. */
export function SetupCallbackView({ app, problem }: { app: Registered | null; problem: string }) {
  if (problem) {
    return (
      <Standalone title="The App was not registered">
        <Notice tone="bad" role="alert">{problem}</Notice>
        <p><Link href="/setup" className={buttonClass("primary")}>Back to setup</Link></p>
      </Standalone>
    );
  }
  if (app === null) return <Loading what="Keeping the App's key and secrets…" />;
  return (
    <Standalone title={`${app.slug} is registered`}>
      <p>
        Its private key and secrets are stored in this cockpit&apos;s backend. One step is
        left: install it on the repositories that hold your factories. An organization owner can; anyone else
        sends the owner a request from the same page.
      </p>
      {/* A slug can be longer than a phone is wide: it is the title, so the button may cut it short. */}
      <p>
        <a href={app.installUrl} className={cx(buttonClass("primary"), "max-w-full")}>
          <span className="min-w-0 truncate">Install {app.slug}</span>
        </a>
      </p>
      <p className="text-muted">
        Then <Link href="/">sign in</Link>. Factories appear as the App is installed on their repositories.
      </p>
    </Standalone>
  );
}

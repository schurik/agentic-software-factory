"use client";

import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { said } from "./said";
import { useCockpit } from "./Shell";
import { carried, carry } from "./signIn";

/**
 * Registering the team's GitHub App through the manifest flow (convex/setup.ts):
 * the form here, GitHub's own page to name the App, and back to the callback.
 */
export function SetupPage() {
  const { mode, forge } = useCockpit();
  const begin = useAction(api.setup.begin);
  const webhook = useQuery(api.setup.webhook, {});
  const deployment = useQuery(api.setup.deployment, {});
  const [code, setCode] = useState("");
  const [host, setHost] = useState("github.com");
  const [organization, setOrganization] = useState("");
  const [problem, setProblem] = useState("");
  const [leaving, setLeaving] = useState(false);

  if (mode === "local") {
    return (
      <p className="notice">
        A local cockpit needs no setup: it asks the forge with your own <code>gh auth token</code>, and nobody signs in.
      </p>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLeaving(true);
    setProblem("");
    try {
      const begun = await begin({ code, host, organization, appUrl: window.location.origin });
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
    } catch (error) {
      setProblem(said(error));
      setLeaving(false);
    }
  };

  return (
    <div className="card">
      <h1>Set up the GitHub App</h1>
      <p>
        This cockpit reaches GitHub through an App your team registers for itself: people sign in with it,
        and it is how the cockpit sees your repositories. Registering takes three steps.
      </p>
      {forge.app ? (
        <p className="notice">
          <strong>{forge.app.slug}</strong> is registered on {forge.host}. Registering again replaces it and
          signs everyone out. To add repositories, <a href={forge.app.installUrl}>install it</a> on them instead.
        </p>
      ) : null}
      {webhook && !webhook.deliverable ? (
        <p className="notice">
          GitHub cannot deliver webhooks to <code>{webhook.url}</code>, and refuses to register an App that asks
          it to. So this App is registered <strong>without a webhook</strong>: the cockpit finds changes by asking
          GitHub once a minute instead. For webhooks, set <code>CONVEX_SITE_ORIGIN</code> to an address GitHub can
          reach, restart, and register again.
        </p>
      ) : null}
      <ol className="steps">
        <li>
          Print a setup code on the deployment. It shows you run this cockpit, and works once, for an hour.
          <SetupCodeRoute dashboard={deployment?.dashboard ?? null} />
        </li>
        <li>
          Fill this in and continue to GitHub, which shows the App it is about to create: private to your
          account, with its sign-in{webhook?.deliverable ? " and its webhook" : ""} pointed at this cockpit.
        </li>
        <li>Back here, install the App on the repositories that hold your factories.</li>
      </ol>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label>
          Setup code
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="asf_setup_…"
                 autoComplete="off" spellCheck={false} required />
        </label>
        <label>
          GitHub host
          <input value={host} onChange={(event) => setHost(event.target.value)} spellCheck={false} required />
          <small>github.com, or your Enterprise Server&apos;s host name. An App belongs to one host.</small>
        </label>
        <label>
          Organization
          <input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="acme"
                 spellCheck={false} />
          <small>The organization that will own the App. Leave empty to register it under your own account.</small>
        </label>
        <button type="submit" className="button" disabled={leaving}>Continue to GitHub</button>
        {problem ? <p className="error">{problem}</p> : null}
      </form>
    </div>
  );
}

/**
 * How to print a setup code where this backend runs: on Convex Cloud, its
 * dashboard's Functions page or `npx convex run`; else the compose file's
 * container. Both prove the same thing — that whoever is here can run a
 * function on this deployment — and neither needs the cockpit's source.
 */
export function SetupCodeRoute({ dashboard }: { dashboard: string | null }) {
  if (dashboard === null) return <pre>docker compose exec app ./convex.sh run setup:code</pre>;
  return (
    <>
      <p>
        This backend runs on Convex Cloud: open its <a href={dashboard}>Functions page</a> in the Convex dashboard,
        pick <code>setup:code</code> and Run it. Or, from a directory linked to this deployment:
      </p>
      <pre>npx convex run setup:code</pre>
    </>
  );
}

export function SetupCallback({ code, state }: { code: string; state: string }) {
  const complete = useAction(api.setup.complete);
  const [app, setApp] = useState<{ slug: string; installUrl: string } | null>(null);
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

  if (problem) {
    return (
      <div className="card">
        <h1>The App was not registered</h1>
        <p className="error">{problem}</p>
        <p><Link href="/setup" className="button">Back to setup</Link></p>
      </div>
    );
  }
  if (app === null) return <p className="muted">Keeping the App&apos;s key and secrets…</p>;
  return (
    <div className="card">
      <h1>{app.slug} is registered</h1>
      <p>
        Its private key and secrets are stored in this cockpit&apos;s backend. One step is
        left: install it on the repositories that hold your factories. An organization owner can; anyone else
        sends the owner a request from the same page.
      </p>
      <p><a href={app.installUrl} className="button">Install {app.slug}</a></p>
      <p className="muted">
        Then <Link href="/">sign in</Link>. Factories appear as the App is installed on their repositories.
      </p>
    </div>
  );
}

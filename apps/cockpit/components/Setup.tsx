"use client";

import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/convex/_generated/api";
import type { Me } from "./Header";
import { said } from "./said";
import { useCockpit } from "./Shell";
import { carried, carry } from "./signIn";
import { Button, buttonClass, Control, cx, Field, LinkButton, Loading, Notice, pillClass, Pre, Standalone } from "./ui";

/** What the setup form sends GitHub's way: the code printed on the deployment, the host, and the owning organization. */
export interface Begin {
  code: string;
  host: string;
  organization: string;
}

/** What the form sends to take on an App the account registered before: what that App's settings page hands over. */
export interface Adopt {
  code: string;
  host: string;
  appId: string;
  clientSecret: string;
  privateKey: string;
}

/** An App taken on: its name, where its owner edits it, the callback URL it must list, and whether its webhook delivers here. */
export type Adopted = FunctionReturnType<typeof api.setup.adopt>;

/** Registering a new App through the manifest flow, or taking on one the account has. */
type Way = "new" | "existing";

const still = () => () => {};

/**
 * Registering the team's GitHub App through the manifest flow (convex/setup.ts):
 * the form here, GitHub's own page to name the App, and back to the callback.
 * Or taking on an App the account registered before, which needs no trip.
 */
export function SetupPage() {
  const { mode, forge } = useCockpit();
  const begin = useAction(api.setup.begin);
  const adopt = useAction(api.setup.adopt);
  const webhook = useQuery(api.setup.webhook, {});
  const deployment = useQuery(api.setup.deployment, {});
  // Where these pages are served, which the App's callback URLs must list: none until there is a window.
  const appUrl = useSyncExternalStore(still, () => window.location.origin, () => "");
  const [adopted, setAdopted] = useState<Adopted | null>(null);

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
  const takeOn = async (fields: Adopt) => setAdopted(await adopt({ ...fields, appUrl: window.location.origin }));

  if (adopted) return <AdoptedView adopted={adopted} />;
  return (
    <SetupView mode={mode} forge={forge} webhook={webhook} deployment={deployment} appUrl={appUrl}
               onBegin={leave} onAdopt={takeOn} />
  );
}

/**
 * The setup page itself: in a local cockpit only why there is none, in a
 * team's the two ways to an App — register a new one, or take on one the
 * account has — each with its three steps and its form. `onBegin` leaves for
 * GitHub and `onAdopt` takes the App on; either throws what went wrong, which
 * the form then says.
 */
export function SetupView({ mode, forge, webhook, deployment, appUrl, onBegin, onAdopt }: {
  mode: Me["mode"];
  forge: Me["forge"];
  /** Where GitHub would deliver the App's webhook, and whether it could: undefined while that is asked. */
  webhook: FunctionReturnType<typeof api.setup.webhook> | undefined;
  /** Where the deployment runs — on Convex Cloud, or the compose file's: undefined while that is asked. */
  deployment: FunctionReturnType<typeof api.setup.deployment> | undefined;
  /** Where these pages are served: the origin of the callback URL an App taken on must list. */
  appUrl: string;
  onBegin: (fields: Begin) => Promise<void>;
  onAdopt: (fields: Adopt) => Promise<void>;
}) {
  const [way, setWay] = useState<Way>("new");
  const [code, setCode] = useState("");
  const [host, setHost] = useState("github.com");
  const [organization, setOrganization] = useState("");
  const [appId, setAppId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [privateKey, setPrivateKey] = useState("");
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

  const choose = (chosen: Way) => {
    setWay(chosen);
    setProblem("");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLeaving(true);
    setProblem("");
    try {
      if (way === "new") await onBegin({ code, host, organization });
      else await onAdopt({ code, host, appId, clientSecret, privateKey });
    } catch (error) {
      setProblem(said(error));
      setLeaving(false);
    }
  };
  const pick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setPrivateKey(await file.text());
  };
  const shared = (
    <>
      <Field label="Setup code">
        <Control value={code} onValueChange={setCode} placeholder="asf_setup_…"
                 autoComplete="off" spellCheck={false} required />
      </Field>
      <Field label="GitHub host" hint={<>github.com, or your Enterprise Server&apos;s host name. An App belongs to one host.</>}>
        <Control value={host} onValueChange={setHost} spellCheck={false} required />
      </Field>
    </>
  );

  return (
    <Standalone title="Set up the GitHub App">
      <p>
        This cockpit reaches GitHub through an App your team registers for itself: people sign in with it,
        and it is how the cockpit sees your repositories. Register a new one, or take on one your account
        registered before — for another cockpit, or for this one on another machine.
      </p>
      <div role="group" aria-label="Which App" className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={way === "new"} className={cx("cursor-pointer", pillClass(way === "new"))}
                onClick={() => choose("new")}>Register a new App</button>
        <button type="button" aria-pressed={way === "existing"} className={cx("cursor-pointer", pillClass(way === "existing"))}
                onClick={() => choose("existing")}>Use an App you already have</button>
      </div>
      {forge.app ? (
        <Notice>
          <strong>{forge.app.slug}</strong> is registered on {forge.host}. Registering again, or taking on another
          App, replaces it and signs everyone out. To add repositories, <a href={forge.app.installUrl}>install it</a> on
          them instead.
        </Notice>
      ) : null}
      {webhook && !webhook.deliverable ? (
        <Notice>
          GitHub cannot deliver webhooks to <code>{webhook.url}</code>
          {way === "new" ? (
            <>
              , and refuses to register an App that asks it to. So this App is registered <strong>without a
              webhook</strong>:
            </>
          ) : (
            <>, so the App&apos;s webhook is <strong>left where it is</strong>:</>
          )}{" "}
          the cockpit finds changes by asking GitHub once a minute instead. For webhooks, set{" "}
          <code>CONVEX_SITE_ORIGIN</code> to an address GitHub can reach, restart, and set it up again.
        </Notice>
      ) : null}
      {way === "existing" && webhook?.deliverable ? (
        <Notice>
          Its webhook is pointed at this cockpit, with a new secret. An App has one webhook: a cockpit it
          delivered to before finds changes by asking GitHub once a minute from then on.
        </Notice>
      ) : null}
      {way === "new" ? (
        <ol className="list-decimal pl-5 marker:text-muted [&>li+li]:mt-2">
          <li>
            Print a setup code on the deployment. It shows you run this cockpit, and works once, for an hour.
            <SetupCode cloud={deployment?.cloud ?? null} />
          </li>
          <li>
            Fill this in and continue to GitHub, which shows the App it is about to create: private to your
            account, with its sign-in{webhook?.deliverable ? " and its webhook" : ""} pointed at this cockpit.
            GitHub keeps an App&apos;s name unique on its host: if it says the name is taken by an App you
            already have, <LinkButton onClick={() => choose("existing")}>use that one</LinkButton> instead.
          </li>
          <li>Back here, install the App on the repositories that hold your factories.</li>
        </ol>
      ) : (
        <ol className="list-decimal pl-5 marker:text-muted [&>li+li]:mt-2">
          <li>
            Print a setup code on the deployment. It shows you run this cockpit, and works once, for an hour.
            <SetupCode cloud={deployment?.cloud ?? null} />
          </li>
          <li>
            Open the App&apos;s settings page on GitHub (<em>Settings → Developer settings → GitHub Apps</em>, then{" "}
            <em>Edit</em>) and add this cockpit&apos;s callback URL under <em>Callback URL</em> — an App takes up to ten:
            <Pre className="mt-1.5">{`${appUrl}/auth/callback`}</Pre>
            Then generate a new client secret and a private key there. The ones another cockpit holds keep working.
          </li>
          <li>
            Fill this in with the App ID from the top of that page, the secret and the key. The App stays
            installed where it is: there is nothing to install again.
          </li>
        </ol>
      )}
      <form className="grid gap-4 pt-3" onSubmit={(event) => void submit(event)}>
        {shared}
        {way === "new" ? (
          <>
            <Field label="Organization" hint="The organization that will own the App. Leave empty to register it under your own account.">
              <Control value={organization} onValueChange={setOrganization} placeholder="acme" spellCheck={false} />
            </Field>
            <Button type="submit" variant="primary" className="justify-self-start" disabled={leaving}>Continue to GitHub</Button>
          </>
        ) : (
          <>
            <Field label="App ID" hint="The number at the top of the App's settings page — not its client ID.">
              <Control value={appId} onValueChange={setAppId} inputMode="numeric" placeholder="123456"
                       autoComplete="off" spellCheck={false} required />
            </Field>
            <Field label="Client secret" hint="Generated beside the ones in use: GitHub shows it once.">
              <Control type="password" value={clientSecret} onValueChange={setClientSecret} autoComplete="off" required />
            </Field>
            <Field label="Private key" hint="The whole .pem file GitHub downloaded when you generated the key.">
              <Control render={<textarea rows={4} />} value={privateKey} onValueChange={setPrivateKey}
                       placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} required />
            </Field>
            <label className="grid gap-1 text-sm text-muted">
              Or pick the .pem file
              <input type="file" accept=".pem" onChange={(event) => void pick(event)} />
            </label>
            <Button type="submit" variant="primary" className="justify-self-start" disabled={leaving}>Use this App</Button>
          </>
        )}
      </form>
      {problem ? <Notice tone="bad" role="alert">{problem}</Notice> : null}
    </Standalone>
  );
}

/**
 * How to print a setup code where this deployment runs: anything that runs a
 * function with its admin key will do. On Convex Cloud that is its dashboard
 * or the Convex CLI, since there is no container; else the compose file's.
 */
function SetupCode({ cloud }: { cloud: FunctionReturnType<typeof api.setup.deployment>["cloud"] }) {
  if (cloud === null) return <Pre className="mt-1.5">docker compose exec app ./convex.sh run setup:code</Pre>;
  return (
    <>
      {" "}On Convex Cloud, open <a href={cloud.functions}>{cloud.name}&apos;s functions</a> in the Convex dashboard,
      pick <code>setup:code</code> and run it — or with the Convex CLI, pointed at that deployment:
      <Pre className="mt-1.5">npx convex run setup:code</Pre>
    </>
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
      <Logo slug={app.slug} settingsUrl={app.settingsUrl} />
    </Standalone>
  );
}

/** An App taken on from before: installed where it was, so what is left is the callback URL it must list, and signing in. */
export function AdoptedView({ adopted }: { adopted: Adopted }) {
  return (
    <Standalone title={`${adopted.slug} is set up here`}>
      <p>
        Its private key and secrets are stored in this cockpit&apos;s backend. It stays installed where it was,
        so there is nothing to install again.
      </p>
      <p>
        A sign-in comes back to <code>{adopted.callbackUrl}</code>, which <a href={adopted.settingsUrl}>its
        settings page</a> must list under <em>Callback URL</em>: add it there if you have not.
      </p>
      <p>
        {adopted.webhook
          ? "Its webhook now delivers here, signed with a secret only this cockpit holds."
          : "Its webhook was left as it was: this cockpit learns of the forge by asking GitHub once a minute."}
      </p>
      <p><Link href="/" className={buttonClass("primary")}>Sign in</Link></p>
      <p className="text-muted">
        To add repositories, <a href={adopted.installUrl}>install it</a> on them.
      </p>
      <Logo slug={adopted.slug} settingsUrl={adopted.settingsUrl} />
    </Standalone>
  );
}

/**
 * The cockpit's icon, for the App's logo. Neither a manifest nor GitHub's API
 * can give an App one: its settings page takes it, by hand, and nothing else.
 */
function Logo({ slug, settingsUrl }: { slug: string; settingsUrl: string }) {
  return (
    <Notice>
      To give {slug} this cockpit&apos;s icon, <a href="/icon-512.png" download="cockpit-icon.png">download it</a> and
      upload it under <em>Display information</em> on <a href={settingsUrl}>its settings page</a>: GitHub takes an
      App&apos;s logo there, and nowhere else.
    </Notice>
  );
}

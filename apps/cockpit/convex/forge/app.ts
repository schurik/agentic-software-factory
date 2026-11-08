/**
 * The forge through a GitHub App: team mode.
 *
 * Each team registers its own App, through the manifest flow, on its own
 * GitHub host — github.com or an Enterprise Server — so there is no App of
 * ours for anyone to trust, and nothing here names a host. Or it takes on an
 * App its account registered before, for another cockpit (`readApp`).
 *
 * An App has three ways to ask, and each has its use (spec #40):
 *   - as itself, with a JWT signed by its key: to list where it is installed
 *     and to mint installation tokens — and, while it is taken on, to read
 *     what it says of itself and point its webhook here — and nothing else;
 *   - as an installation: what the cockpit reads for itself — the
 *     repositories, and whether each holds a factory. Its budget grows with
 *     the repositories it is installed on;
 *   - as a person who signed in, with their user access token: who they are,
 *     where they can go, and everything the cockpit does on the forge — an
 *     answer to a gate is their comment — so that it is authored by them.
 */
import { type Infer, v } from "convex/values";
import { isRecord } from "../model/wire";
import type { Forge, Reach, Repository } from "./forge";
import {
  branch, commit, commitDiff, compare, type Credential, distance, ForgeError, type GitHub, items, type Memory, paths, pull, readPerson,
  readRepository, readRole, refusal, tip,
} from "./github";

/** A registered App: what GitHub hands back when a manifest is converted. */
export const appValidator = v.object({
  host: v.string(),
  appId: v.number(),
  slug: v.string(),
  htmlUrl: v.string(),
  clientId: v.string(),
  clientSecret: v.string(),
  webhookSecret: v.union(v.null(), v.string()),   // null: registered without a webhook (`deliverable`)
  privateKey: v.string(),       // PEM, as GitHub sends it
  // Where a sign-in comes back to, for an App taken on from another cockpit
  // (`readApp`): one of its callback URLs, and not its first, which GitHub uses
  // when none is named. Absent for an App registered here, whose one it is.
  callbackUrl: v.optional(v.string()),
});

export type App = Infer<typeof appValidator>;

export interface Registration {
  /** Where the cockpit's pages are served: GitHub sends browsers back here. */
  appUrl: string;
  /** The backend's site origin: GitHub delivers webhooks here. */
  siteUrl: string;
  /** The organization the App is registered under, or "" for the admin's own account. */
  organization: string;
}

/**
 * The manifest a team's App is registered from.
 *
 * It asks for what the cockpit does as the person who is signed in (spec
 * #40): read a repository's config and a gate's subject (contents), answer a
 * gate and apply a route label (issues, pull requests), and open a config
 * change as a pull request (contents, pull requests). A user access token
 * can do only what both the person and the App may, so the App has to be
 * allowed all of it. The events are the ones a cockpit is kept current by,
 * and the ones it nudges a station's watchers with (model/webhook.ts);
 * `installation` and `installation_repositories` are sent to every App and
 * cannot be asked for.
 *
 * The webhook, and the events with it, are left out where GitHub could not
 * deliver one (`deliverable`): it refuses such a manifest outright. That
 * cockpit learns of the forge by the catch-up poll alone, which is what the
 * poll is for.
 */
export function manifest({ appUrl, siteUrl, organization }: Registration): Record<string, unknown> {
  const webhook = webhookUrl(siteUrl);
  return {
    // The admin can rename it on GitHub's page; a name is at most 34 characters.
    name: (organization ? `asf-cockpit-${organization}` : "asf-cockpit").slice(0, 34),
    description: "Observes and steers the factories stamped into this account's repositories.",
    url: appUrl,
    public: false,
    redirect_url: `${appUrl}/setup/callback`,
    callback_urls: [`${appUrl}/auth/callback`],
    setup_url: `${appUrl}/factories`,
    request_oauth_on_install: false,
    // `members`: whether a person owns the organization a factory's repository is
    // in — who may purge a whole factory (retention.ts).
    default_permissions: { metadata: "read", contents: "write", issues: "write", pull_requests: "write", members: "read" },
    ...(deliverable(webhook) ? {
      hook_attributes: { url: webhook, active: true },
      default_events: [
        "push", "repository", "issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment",
      ],
    } : {}),
  };
}

/** Where GitHub delivers the App's webhooks: on the backend's site. */
export function webhookUrl(siteUrl: string): string {
  return `${siteUrl}/forge/webhook`;
}

/**
 * Whether GitHub would take `url` as a webhook. It refuses one "not reachable
 * over the public Internet" — a loopback or private address — when the App is
 * registered, so a cockpit on someone's machine, or behind a firewall, has to
 * register without.
 */
export function deliverable(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])];
    const closed = first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
    return !closed;
  }
  // IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.startsWith("[")) return !/^\[(::1\]|f[cd]|fe[89ab])/.test(host);
  return true;
}

/** Where a browser posts the manifest: the page on which the admin names the App and confirms. */
export function registrationUrl(host: string, organization: string, state: string): string {
  return `https://${host}${account(organization)}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

/**
 * Where the App's owner edits it on GitHub: its callback URLs, its keys and
 * secrets, and its logo — which only this page takes. Neither a manifest nor
 * the API can give an App one, so the cockpit's icon is uploaded here by hand.
 */
export function settingsUrl(host: string, slug: string, organization: string): string {
  return `https://${host}${account(organization)}/settings/apps/${encodeURIComponent(slug)}`;
}

/** The organization an App's `owner` (as GitHub describes an App) is, or "" for a person's own account. */
function ownedBy(owner: unknown): string {
  return isRecord(owner) && owner.type === "Organization" && typeof owner.login === "string" ? owner.login : "";
}

/** The path an account's settings sit under: an organization's, or "" for the admin's own. */
function account(organization: string): string {
  return organization ? `/organizations/${encodeURIComponent(organization)}` : "";
}

/** Where an owner installs the App on their organization's repositories. */
export function installUrl(app: Pick<App, "htmlUrl">): string {
  return `${app.htmlUrl}/installations/new`;
}

/** An App the cockpit now holds, and where its owner edits it (`settingsUrl`). */
export interface Converted {
  app: App;
  settingsUrl: string;
}

/** Trade the code GitHub sent the admin back with for the App it made. It works once, within an hour. */
export async function convert(github: GitHub, code: string): Promise<Converted> {
  const path = `/app-manifests/${encodeURIComponent(code)}/conversions`;
  const response = await github.send(null, "POST", github.api + path);
  const body: unknown = response.ok ? await response.json() : null;
  if (!isRecord(body)) {
    throw new ForgeError(response.status, `${github.host} did not convert the manifest code (${response.status}): it works once, within an hour of registering`);
  }
  // Each of these is a credential or an address the cockpit then trusts: one
  // that is missing is refused here, never kept as the text "undefined".
  const handed = (field: string): string => {
    const value = body[field];
    if (typeof value === "string" && value !== "") return value;
    throw new ForgeError(response.status, `${github.host} handed back an App with no \`${field}\`: none of it was kept`);
  };
  if (typeof body.id !== "number") throw new ForgeError(response.status, `${github.host} handed back an App with no \`id\`: none of it was kept`);
  const app: App = {
    host: github.host,
    appId: body.id,
    slug: handed("slug"),
    htmlUrl: handed("html_url"),
    clientId: handed("client_id"),
    clientSecret: handed("client_secret"),
    // Null for an App registered without a webhook. It stays null: a delivery is
    // checked against a secret or refused, never against the text of a missing one.
    webhookSecret: typeof body.webhook_secret === "string" && body.webhook_secret !== "" ? body.webhook_secret : null,
    privateKey: handed("pem"),
  };
  return { app, settingsUrl: settingsUrl(github.host, app.slug, ownedBy(body.owner)) };
}

// ── taking on an App registered before ───────────────────────────────────────

/**
 * What an App says of itself, asked as itself: what a cockpit takes on an App
 * the account registered before by (setup.ts `adopt`), with no manifest — so
 * no second App, and nothing to install again.
 */
export interface Itself {
  slug: string;
  htmlUrl: string;
  clientId: string;
  settingsUrl: string;
  /** What its webhook is subscribed to: nothing, for an App registered without one. */
  events: string[];
}

/**
 * The App whose key signed `jwt`, as GitHub describes it. A refusal means the
 * ID and the key are not one App's — the only check there is that the admin
 * typed the right ID and generated the key on the right App's page.
 */
export async function readApp(github: GitHub, appId: number, jwt: string): Promise<Itself> {
  const response = await github.send({ token: jwt, scope: null }, "GET", `${github.api}/app`);
  if (!response.ok) {
    throw new ForgeError(response.status, `${github.host} did not take App ${appId}'s ID and private key (${response.status}): ` +
      "both must be one App's, the key generated on that App's settings page");
  }
  const body: unknown = await response.json();
  const said = (field: string): string => {
    const value = isRecord(body) ? body[field] : undefined;
    if (typeof value === "string" && value !== "") return value;
    throw new ForgeError(response.status, `${github.host} described App ${appId} with no \`${field}\`: none of it was kept`);
  };
  const slug = said("slug");
  const events = isRecord(body) && Array.isArray(body.events) ? body.events.filter((event) => typeof event === "string") : [];
  return {
    slug, htmlUrl: said("html_url"), clientId: said("client_id"),
    settingsUrl: settingsUrl(github.host, slug, ownedBy(isRecord(body) ? body.owner : null)), events,
  };
}

/**
 * Point the App's webhook at `url`, signed with `secret` from now on. An App
 * has one webhook, so this takes it from the cockpit it delivered to before,
 * which learns by its poll from then on (ADR 0008: the poll is the record).
 * False when GitHub would not.
 */
export async function pointWebhook(github: GitHub, jwt: string, url: string, secret: string): Promise<boolean> {
  const response = await github.send({ token: jwt, scope: null }, "PATCH", `${github.api}/app/hook/config`, {},
    JSON.stringify({ url, content_type: "json", secret, insecure_ssl: "0" }));
  return response.ok;
}

// ── signing in: the App's OAuth web flow ─────────────────────────────────────

/** A person's user access token (8 hours) and the refresh token that renews it (6 months). */
export interface UserTokens {
  access: Expiring;
  refresh: Expiring | null;
}

export interface Expiring {
  token: string;
  /** Null for a token that does not expire: an App can opt out of expiring ones. */
  expiresAt: number | null;
}

/**
 * Where a browser goes to sign in. GitHub sends it back to the App's callback
 * URL — this cockpit's, named, where the App has others — with a code and this `state`.
 */
export function authorizeUrl(app: App, state: string): string {
  const back = app.callbackUrl ? `&redirect_uri=${encodeURIComponent(app.callbackUrl)}` : "";
  return `https://${app.host}/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}&state=${encodeURIComponent(state)}${back}`;
}

/** Trade a sign-in code, or a refresh token, for a fresh pair of tokens. Either works once. */
export async function exchange(github: GitHub, app: App, grant: { code: string } | { refreshToken: string }): Promise<UserTokens> {
  const now = Date.now();
  const response = await github.fetch(`https://${app.host}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...("code" in grant ? { code: grant.code } : { grant_type: "refresh_token", refresh_token: grant.refreshToken }),
    }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: refused below, by its status.
  }
  if (!isRecord(body) || typeof body.access_token !== "string") {
    // A refusal is a 200 with an `error` in it, which is said here as the 401 it means.
    const said = isRecord(body) ? (body.error_description ?? body.error) : undefined;
    if (said !== undefined) throw new ForgeError(401, `${app.host} refused the sign-in: ${said}`);
    throw new ForgeError(response.status, `${app.host} answered ${response.status} to the sign-in`);
  }
  const expiring = (token: unknown, seconds: unknown): Expiring | null =>
    typeof token === "string" ? { token, expiresAt: typeof seconds === "number" ? now + seconds * 1000 : null } : null;
  return {
    access: expiring(body.access_token, body.expires_in)!,
    refresh: expiring(body.refresh_token, body.refresh_token_expires_in),
  };
}

// ── webhooks ─────────────────────────────────────────────────────────────────

/** Whether `body` was signed with the App's webhook secret: `signature` is its `X-Hub-Signature-256`. */
export async function signed(secret: string, body: string, signature: string | null): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(signature ?? "")?.[1];
  if (!hex) return false;
  const claimed = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // `verify` compares in constant time.
  return await crypto.subtle.verify("HMAC", key, claimed, encoder.encode(body));
}

// ── the App as itself ────────────────────────────────────────────────────────

const JWT_SECONDS = 540;          // GitHub takes at most ten minutes
const CLOCK_DRIFT_SECONDS = 60;   // and recommends issuing it a minute in the past

/** The JWT an App authenticates as itself with: RS256 by its private key. */
export async function appJwt(app: Pick<App, "appId" | "privateKey">, now = Date.now()): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const claims = { iat: seconds - CLOCK_DRIFT_SECONDS, exp: seconds + JWT_SECONDS, iss: String(app.appId) };
  const signing = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pkcs8(app.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signing));
  return `${signing}.${base64url(new Uint8Array(signature))}`;
}

/**
 * The key as WebCrypto imports it. GitHub hands an App's key over as PKCS#1
 * (`BEGIN RSA PRIVATE KEY`) and WebCrypto takes PKCS#8 only, which is the
 * same key inside a fixed wrapper: a version, the RSA algorithm, the key.
 */
function pkcs8(pem: string): ArrayBuffer {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der.buffer;
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [...version, ...rsaEncryption, 0x04, ...derLength(der.length), ...der];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]).buffer;
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── the forge ────────────────────────────────────────────────────────────────

/** An installation token with less than this left is not used: a poll should not run out of it half way. */
const INSTALLATION_TOKEN_MARGIN = 5 * 60_000;

/**
 * The forge through `app`. `user` is the access token of the person it acts
 * for, when there is one: without it, only the cockpit's own reading works.
 */
export function appForge(github: GitHub, app: App, memory: Memory, user: string | null): Forge {
  let jwt: Promise<string> | null = null;
  const asApp = async (): Promise<Credential> => ({ token: await (jwt ??= appJwt(app)), scope: "app" });

  // An App is installed on an account, so a repository's owner says which installation reads it.
  let installations: Promise<Map<string, number>> | null = null;
  const installed = () => (installations ??= (async () => {
    const found = await github.list(await asApp(), "/app/installations?per_page=100", (body) =>
      items(body).flatMap((installation) =>
        isRecord(installation.account) && installation.suspended_at == null
          ? [[String(installation.account.login).toLowerCase(), Number(installation.id)] as const]
          : []));
    return new Map(found);
  })());

  const asInstallation = async (installation: number): Promise<Credential> => {
    const scope = `installation ${installation}`;
    const held = memory.installationToken(installation);
    if (held && held.expiresAt - Date.now() > INSTALLATION_TOKEN_MARGIN) return { token: held.token, scope };
    const path = `/app/installations/${installation}/access_tokens`;
    const response = await github.send(await asApp(), "POST", github.api + path);
    if (!response.ok) throw await refusal(response, path);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.token !== "string") throw new ForgeError(response.status, `${github.host} minted no token for installation ${installation}`);
    memory.keepInstallationToken(installation, { token: body.token, expiresAt: Date.parse(String(body.expires_at)) });
    return { token: body.token, scope };
  };

  const asUser = (): Credential => {
    if (user === null) throw new Error("the forge was asked about a person, and nobody is signed in");
    return { token: user, scope: null };
  };

  return {
    repositories: async () => {
      const all: Repository[] = [];
      for (const installation of new Set((await installed()).values())) {
        all.push(...await github.list(await asInstallation(installation), "/installation/repositories?per_page=100",
          (body) => items(isRecord(body) ? body.repositories : null).map(readRepository)));
      }
      return all;
    },
    holdsFactory: async (repo) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      // No installation on its owner any more: nothing the cockpit can read, so nothing it shows.
      if (installation === undefined) return false;
      return github.holdsFactory(await asInstallation(installation), repo);
    },
    // What a session wrote is read by the cockpit for itself, on the installation's budget:
    // whether the person may see it is the mirror's word, asked before the forge is.
    file: async (repo, path, ref) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return github.file(await asInstallation(installation), repo, path, ref);
    },
    compare: async (repo, base, head) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return compare(github, await asInstallation(installation), repo, base, head);
    },
    commitDiff: async (repo, sha) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return commitDiff(github, await asInstallation(installation), repo, sha);
    },
    // A factory's default branch and its config files, read for the Factory page on the
    // installation's budget, like a session's files: the mirror said the viewer may read it.
    tip: async (repo, branch) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return tip(github, await asInstallation(installation), repo, branch);
    },
    paths: async (repo, ref, dir) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return paths(github, await asInstallation(installation), repo, ref, dir);
    },
    distance: async (repo, base, head) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return distance(github, await asInstallation(installation), repo, base, head);
    },
    labels: async (repo) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return github.labels(await asInstallation(installation), repo);
    },
    labelled: async (repo, label) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return github.labelled(await asInstallation(installation), repo, label);
    },
    pulls: async (repo) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return github.pulls(await asInstallation(installation), repo);
    },
    touched: async (repo, since) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return github.touched(await asInstallation(installation), repo, since);
    },
    issue: async (repo, number) => {
      const installation = (await installed()).get(repo.split("/")[0].toLowerCase());
      if (installation === undefined) return null;
      return github.issue(await asInstallation(installation), repo, number);
    },
    person: () => github.one(asUser(), "/user", readPerson),
    // Whether they own an organization is theirs to show, and needs the App to read members.
    owns: (account) => github.owns(asUser(), account),
    // On the person's own token, so the comment is theirs — and GitHub shows it was made through the App.
    comment: (repo, number, body) => github.comment(asUser(), repo, number, body),
    // The same for a label: the forge's `labeled` event is what the factory records as the trigger.
    label: (repo, number, labels) => github.label(asUser(), repo, number, labels),
    unlabel: (repo, number, label) => github.unlabel(asUser(), repo, number, label),
    // A config edit, too: the commit, its branch and the pull request are the person's, and
    // the forge refuses them to anyone it would not let push — write, which the editor mirrors.
    commit: (repo, base, changes, message) => commit(github, asUser(), repo, base, changes, message),
    branch: (repo, name, sha) => branch(github, asUser(), repo, name, sha),
    pull: (repo, proposal) => pull(github, asUser(), repo, proposal),
    reach: async () => {
      // GitHub's own answer to "where can this person go through this App", with their role on each.
      const as = asUser();
      const reached = await github.list(as, "/user/installations?per_page=100", (body) =>
        items(isRecord(body) ? body.installations : null).map((installation) => Number(installation.id)));
      const reach: Reach[] = [];
      for (const installation of reached) {
        reach.push(...await github.list(as, `/user/installations/${installation}/repositories?per_page=100`, (body) =>
          items(isRecord(body) ? body.repositories : null).flatMap((repo) => {
            const role = readRole(repo);
            return role ? [{ repo: String(repo.full_name), role }] : [];
          })));
      }
      return reach;
    },
  };
}

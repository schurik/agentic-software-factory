import { vi } from "vitest";

/**
 * A fake forge: GitHub's REST API as far as the cockpit calls it, in memory.
 * It stands in for GitHub at the one place the cockpit meets it — `fetch` — so
 * both of the cockpit's credentials (the GitHub App and the person's own
 * token) run their real code against it, and no test talks to GitHub.
 *
 * It answers like GitHub where that is what the cockpit relies on: ETags and
 * `304`, `Link` paging, the `x-ratelimit-*` headers (or none, as on an
 * Enterprise Server with limits off), and the `permissions` object on a repo.
 */

export type Role = "read" | "triage" | "write" | "maintain" | "admin";

const RANK: Role[] = ["read", "triage", "write", "maintain", "admin"];

interface Repo {
  id: number;
  name: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string;
  files: Set<string>;
  roles: Record<string, Role>;
}

interface Person {
  id: number;
  login: string;
  name: string;
}

export interface Seen {
  method: string;
  path: string;
  status: number;
}

/** Who a request's token says is asking. */
type Bearer =
  | { kind: "person"; login: string }                           // a person's own token
  | { kind: "user"; login: string; expiresAt: number }          // a user access token, got through the App
  | { kind: "installation"; id: number; expiresAt: number }
  | { kind: "app" };                                            // a JWT signed with the App's key

interface Installation {
  id: number;
  account: string;
  repos: "all" | Set<string>;
}

interface App {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  pem: string;
  manifest: Record<string, unknown>;
}

export interface Delivery {
  headers: Record<string, string>;
  body: string;
}

export const USER_TOKEN_HOURS = 8;

export const FACTORY_FILE = "asf/factory.yaml";

export class FakeForge {
  /** Every request it answered, in order. */
  readonly requests: Seen[] = [];
  /** What the rate-limit headers say, or null to send none (GHES with limits off). */
  limit: { limit: number; remaining: number; reset: number } | null = null;
  pageSize = 100;
  /** No network: every request fails before it is answered. */
  down = false;
  /** Repeat the last item of each page at the top of the next, as a listing does when something is added mid-way. */
  stutter = false;
  /** Repositories whose contents the forge refuses to show, and what it refuses with. */
  readonly refusing = new Map<string, { status: number; message: string }>();

  /** The App a team registered through the manifest flow, once it has. */
  app: App | null = null;

  private readonly repos = new Map<string, Repo>();
  private readonly people = new Map<string, Person>();
  private readonly tokens = new Map<string, Bearer>();
  private readonly installations: Installation[] = [];
  private readonly manifestCodes = new Map<string, App>();
  private readonly grants = new Map<string, string>();      // an OAuth code or refresh token → login
  private ids = 1000;
  private pushes = 0;
  private minted = 0;

  constructor(readonly host = "github.com") {}

  get api(): string {
    return this.host === "github.com" ? "https://api.github.com" : `https://${this.host}/api/v3`;
  }

  // ── what a test arranges ───────────────────────────────────────────────────

  /** A person, and the token `gh auth token` would print for them. */
  person(login: string, token = `gho_${login}`): string {
    this.people.set(login, { id: ++this.ids, login, name: login[0].toUpperCase() + login.slice(1) });
    this.tokens.set(token, { kind: "person", login });
    return token;
  }

  /**
   * What GitHub does with the manifest a setup page posts to it: the admin
   * names the App and confirms, and GitHub sends their browser back to the
   * manifest's `redirect_url` with a code. Returns that code.
   */
  async register(begun: { url: string; manifest: string }, handed: { webhookSecret?: string | null } = {}): Promise<string> {
    const url = new URL(begun.url);
    const account = /^(?:\/organizations\/([^/]+))?\/settings\/apps\/new$/.exec(url.pathname);
    if (url.origin !== `https://${this.host}` || !account || !url.searchParams.get("state")) {
      throw new Error(`${begun.url} is not where ${this.host} registers an App from a manifest`);
    }
    const manifest = JSON.parse(begun.manifest) as Record<string, unknown>;
    const id = ++this.ids;
    const code = `manifest-${id}`;
    this.manifestCodes.set(code, {
      id,
      slug: String(manifest.name).toLowerCase(),
      clientId: `Iv23.${id}`,
      clientSecret: `secret-${id}`,
      webhookSecret: handed.webhookSecret === undefined ? `hook-${id}` : handed.webhookSecret,
      pem: (await appKeys()).pem,
      manifest,
    });
    return code;
  }

  /** The App installed on an account, on all of its repositories or on the ones named. */
  install(account: string, repos: "all" | string[] = "all"): number {
    const id = ++this.ids;
    this.installations.push({
      id, account, repos: repos === "all" ? "all" : new Set(repos.map((name) => name.toLowerCase())),
    });
    return id;
  }

  uninstall(id: number): void {
    this.installations.splice(this.installations.findIndex((installation) => installation.id === id), 1);
  }

  /** A person approving the App's sign-in page: the code GitHub sends their browser back with. */
  authorize(login: string): string {
    if (!this.people.has(login)) throw new Error(`the fake forge has no person ${login}`);
    const code = `code-${++this.minted}`;
    this.grants.set(code, login);
    return code;
  }

  /** A person revoking the App's access to their account: their tokens stop working. */
  revoke(login: string): void {
    for (const [token, bearer] of this.tokens) {
      if (bearer.kind === "user" && bearer.login === login) this.tokens.delete(token);
    }
    for (const [grant, whose] of this.grants) if (whose === login) this.grants.delete(grant);
  }

  /** A webhook delivery as GitHub sends it: signed with the App's webhook secret. */
  async delivery(event: string, payload: Record<string, unknown>, secret = this.app?.webhookSecret ?? ""): Promise<Delivery> {
    const body = JSON.stringify(payload);
    return {
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": `delivery-${++this.minted}`,
        "X-Hub-Signature-256": `sha256=${await hmac(secret, body)}`,
      },
      body,
    };
  }

  /** The body of the `push` event for a push to `name`'s default branch (or to `branch`). */
  pushed(name: string, branch?: string): Record<string, unknown> {
    const repo = this.known(name);
    return {
      ref: `refs/heads/${branch ?? repo.defaultBranch}`,
      repository: { id: repo.id, full_name: repo.name, default_branch: repo.defaultBranch },
    };
  }

  repo(name: string, given: { factory?: boolean; private?: boolean; roles?: Record<string, Role> } = {}): void {
    this.repos.set(name.toLowerCase(), {
      id: ++this.ids,
      name,
      defaultBranch: "main",
      private: given.private ?? true,
      pushedAt: this.stamp(),
      files: new Set(given.factory ? [FACTORY_FILE] : []),
      roles: given.roles ?? {},
    });
  }

  /** A push to the default branch that adds or removes files. */
  push(name: string, change: { add?: string[]; remove?: string[] }): void {
    const repo = this.known(name);
    for (const path of change.add ?? []) repo.files.add(path);
    for (const path of change.remove ?? []) repo.files.delete(path);
    repo.pushedAt = this.stamp();
  }

  remove(name: string): void {
    this.repos.delete(name.toLowerCase());
  }

  grant(name: string, login: string, role: Role | null): void {
    const repo = this.known(name);
    if (role === null) delete repo.roles[login];
    else repo.roles[login] = role;
  }

  /** The requests since `mark`, as `METHOD path → status` lines. */
  since(mark: number): string[] {
    return this.requests.slice(mark).map((seen) => `${seen.method} ${seen.path} → ${seen.status}`);
  }

  // ── the wire ───────────────────────────────────────────────────────────────

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("fetch failed");
    const request = new Request(input, init);
    const url = new URL(request.url);
    const response = await this.answer(request, url);
    this.requests.push({ method: request.method, path: url.pathname + url.search, status: response.status });
    return response;
  };

  private async answer(request: Request, url: URL): Promise<Response> {
    const token = /^(?:Bearer|token) (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
    if (request.url === `https://${this.host}/login/oauth/access_token` && request.method === "POST") {
      return this.reply(request, token, 200, this.exchange(await request.json()));
    }
    if (!request.url.startsWith(this.api + "/")) {
      throw new Error(`the fake forge at ${this.host} was asked for ${request.url}`);
    }
    const path = url.pathname.slice(new URL(this.api).pathname.replace(/\/$/, "").length);
    const { method } = request;

    if (this.limit && this.limit.remaining <= 0 && Date.now() < this.limit.reset * 1000) {
      return this.reply(request, token, 403, { message: "API rate limit exceeded" });
    }

    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (conversion && method === "POST") {
      const app = this.manifestCodes.get(conversion[1]);
      if (!app) return this.reply(request, token, 404, { message: "Not Found" });
      this.manifestCodes.delete(conversion[1]);       // a code converts once
      this.app = app;
      return this.reply(request, token, 201, {
        id: app.id, slug: app.slug, name: app.manifest.name, client_id: app.clientId,
        client_secret: app.clientSecret, webhook_secret: app.webhookSecret, pem: app.pem,
        html_url: `https://${this.host}/apps/${app.slug}`, owner: { login: "acme" },
      });
    }

    const bearer = await this.who(token);
    if (bearer === null) return this.reply(request, token, 401, { message: "Bad credentials" });
    const as = (...kinds: Bearer["kind"][]) => kinds.includes(bearer.kind);

    if (method === "GET" && path === "/user" && (bearer.kind === "person" || bearer.kind === "user")) {
      const person = this.people.get(bearer.login)!;
      return this.reply(request, token, 200, {
        id: person.id, login: person.login, name: person.name,
        avatar_url: `https://${this.host}/avatars/${person.login}`,
      });
    }
    if (method === "GET" && path === "/user/repos" && bearer.kind === "person") {
      const reachable = this.sorted().filter((repo) => repo.roles[bearer.login] !== undefined)
        .map((repo) => this.wire(repo, repo.roles[bearer.login]));
      return this.page(request, token, url, reachable, (items) => items);
    }
    if (method === "GET" && path === "/app/installations" && as("app")) {
      return this.page(request, token, url, this.installations.map(wireInstallation), (items) => items);
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint && method === "POST" && as("app")) {
      const installation = this.installations.find(({ id }) => id === Number(mint[1]));
      if (!installation) return this.reply(request, token, 404, { message: "Not Found" });
      const expiresAt = Date.now() + 3600_000;
      const minted = `ghs_${installation.id}_${++this.minted}`;
      this.tokens.set(minted, { kind: "installation", id: installation.id, expiresAt });
      return this.reply(request, token, 201, { token: minted, expires_at: new Date(expiresAt).toISOString() });
    }
    if (method === "GET" && path === "/installation/repositories" && bearer.kind === "installation") {
      const repos = this.installed(bearer.id).map((repo) => this.wire(repo));
      return this.page(request, token, url, repos, (repositories) => ({ total_count: repos.length, repositories }));
    }
    if (method === "GET" && path === "/user/installations" && bearer.kind === "user") {
      const reached = this.installations
        .filter(({ id }) => this.installed(id).some((repo) => repo.roles[bearer.login] !== undefined))
        .map(wireInstallation);
      return this.page(request, token, url, reached, (installations) => ({ total_count: reached.length, installations }));
    }
    const reach = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (reach && method === "GET" && bearer.kind === "user") {
      const repos = this.installed(Number(reach[1]))
        .filter((repo) => repo.roles[bearer.login] !== undefined)
        .map((repo) => this.wire(repo, repo.roles[bearer.login]));
      return this.page(request, token, url, repos, (repositories) => ({ total_count: repos.length, repositories }));
    }
    const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(path);
    if (contents && (method === "GET" || method === "HEAD") && !as("app")) {
      const repo = this.repos.get(decodeURIComponent(contents[1]).toLowerCase());
      const refused = this.refusing.get(contents[1].toLowerCase());
      if (refused !== undefined) return this.reply(request, token, refused.status, { message: refused.message });
      if (!repo || !this.reads(bearer, repo) || !repo.files.has(contents[2])) {
        return this.reply(request, token, 404, { message: "Not Found" });
      }
      return this.reply(request, token, 200, { type: "file", path: contents[2] });
    }
    return this.reply(request, token, 404, { message: `the fake forge has no ${method} ${path} for ${bearer.kind}` });
  }

  /** Who `token` is, or null when it is nobody's, or has expired. */
  private async who(token: string): Promise<Bearer | null> {
    const bearer = this.tokens.get(token);
    if (bearer !== undefined) {
      const expired = "expiresAt" in bearer && Date.now() >= bearer.expiresAt;
      return expired ? null : bearer;
    }
    if (this.app && token.split(".").length === 3 && (await signedByApp(token, this.app))) return { kind: "app" };
    return null;
  }

  private reads(bearer: Bearer, repo: Repo): boolean {
    if (bearer.kind === "installation") return this.installed(bearer.id).includes(repo);
    if (bearer.kind === "app") return false;
    return repo.roles[bearer.login] !== undefined;
  }

  /** The OAuth token endpoint: a code or a refresh token for a fresh pair. Refusals are 200s, as GitHub's are. */
  private exchange(body: unknown): Record<string, unknown> {
    const asked = body as Record<string, string>;
    if (!this.app || asked.client_id !== this.app.clientId || asked.client_secret !== this.app.clientSecret) {
      return { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." };
    }
    const grant = asked.grant_type === "refresh_token" ? asked.refresh_token : asked.code;
    const login = this.grants.get(grant);
    if (login === undefined) {
      return { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." };
    }
    this.grants.delete(grant);                          // a code, and a refresh token, works once
    const access = `ghu_${login}_${++this.minted}`;
    const refresh = `ghr_${login}_${this.minted}`;
    this.tokens.set(access, { kind: "user", login, expiresAt: Date.now() + USER_TOKEN_HOURS * 3600_000 });
    this.grants.set(refresh, login);
    return {
      access_token: access, expires_in: USER_TOKEN_HOURS * 3600, refresh_token: refresh,
      refresh_token_expires_in: 15897600, token_type: "bearer", scope: "",
    };
  }

  private sorted(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private installed(id: number): Repo[] {
    const installation = this.installations.find((known) => known.id === id);
    if (!installation) return [];
    return this.sorted().filter((repo) =>
      repo.name.split("/")[0].toLowerCase() === installation.account.toLowerCase() &&
      (installation.repos === "all" || installation.repos.has(repo.name.toLowerCase())));
  }

  private wire(repo: Repo, role?: Role): Record<string, unknown> {
    const wire: Record<string, unknown> = {
      id: repo.id,
      full_name: repo.name,
      default_branch: repo.defaultBranch,
      private: repo.private,
      pushed_at: repo.pushedAt,
    };
    if (role !== undefined) {
      const at = RANK.indexOf(role);
      wire.permissions = {
        pull: true,
        triage: at >= RANK.indexOf("triage"),
        push: at >= RANK.indexOf("write"),
        maintain: at >= RANK.indexOf("maintain"),
        admin: at >= RANK.indexOf("admin"),
      };
    }
    return wire;
  }

  private page<T>(request: Request, bearer: string, url: URL, items: T[], wrap: (items: T[]) => unknown): Response {
    const page = Number(url.searchParams.get("page") ?? "1");
    const size = Math.min(Number(url.searchParams.get("per_page") ?? "30"), this.pageSize);
    const slice = items.slice(Math.max((page - 1) * size - (this.stutter ? 1 : 0), 0), page * size);
    const headers: Record<string, string> = {};
    if (page * size < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.Link = `<${next}>; rel="next"`;
    }
    return this.reply(request, bearer, 200, wrap(slice), headers);
  }

  private reply(request: Request, bearer: string, status: number, body: unknown,
                headers: Record<string, string> = {}): Response {
    const text = JSON.stringify(body);
    const all: Record<string, string> = { "Content-Type": "application/json", ...headers };
    let answered = status;
    if (status === 200 && request.method === "GET") {
      // As GitHub's: the same body for another credential is another ETag. The
      // headers are not in it — GitHub does not say whether `Link` is, and the
      // cockpit must not depend on it.
      all.ETag = `"${hash(bearer + text)}"`;
      if (request.headers.get("If-None-Match") === all.ETag) answered = 304;
    }
    if (this.limit) {
      // A 304 is free against the primary limit.
      if (answered !== 304 && status !== 403) this.limit.remaining -= 1;
      all["x-ratelimit-limit"] = String(this.limit.limit);
      all["x-ratelimit-remaining"] = String(Math.max(this.limit.remaining, 0));
      all["x-ratelimit-reset"] = String(this.limit.reset);
    }
    const bodiless = answered === 304 || request.method === "HEAD";
    return new Response(bodiless ? null : text, { status: answered, headers: all });
  }

  private known(name: string): Repo {
    const repo = this.repos.get(name.toLowerCase());
    if (!repo) throw new Error(`the fake forge has no repository ${name}`);
    return repo;
  }

  private stamp(): string {
    this.pushes += 1;
    return new Date(Date.UTC(2026, 8, 1) + this.pushes * 1000).toISOString();
  }
}

function wireInstallation({ id, account }: Installation): Record<string, unknown> {
  return { id, account: { login: account }, suspended_at: null };
}

// ── the App's key ────────────────────────────────────────────────────────────

let keys: Promise<{ pem: string; publicKey: CryptoKey }> | null = null;

/**
 * One RSA key for every fake App (making one is the slow part), as GitHub
 * hands it over: PKCS#1, `BEGIN RSA PRIVATE KEY`, which WebCrypto does not
 * import as is.
 */
function appKeys(): Promise<{ pem: string; publicKey: CryptoKey }> {
  return (keys ??= (async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    // PKCS#8 wraps the PKCS#1 key in a fixed 26-byte header for a 2048-bit key.
    const pkcs1 = pkcs8.slice(26);
    const base64 = btoa(String.fromCharCode(...pkcs1)).replace(/(.{64})/g, "$1\n").trimEnd();
    return {
      pem: `-----BEGIN RSA PRIVATE KEY-----\n${base64}\n-----END RSA PRIVATE KEY-----\n`,
      publicKey: pair.publicKey,
    };
  })());
}

/** Whether `jwt` is what GitHub accepts from an App: RS256 by its key, issued by it, not expired. */
async function signedByApp(jwt: string, app: App): Promise<boolean> {
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(text(unbase64url(payload))) as { iss?: unknown; exp?: number; iat?: number };
  const now = Math.floor(Date.now() / 1000);
  if (JSON.parse(text(unbase64url(header))).alg !== "RS256") return false;
  if (String(claims.iss) !== String(app.id) && claims.iss !== app.clientId) return false;
  if (!(typeof claims.exp === "number" && claims.exp > now && claims.exp <= now + 600)) return false;
  if (!(typeof claims.iat === "number" && claims.iat <= now)) return false;
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", (await appKeys()).publicKey, unbase64url(signature),
    new TextEncoder().encode(`${header}.${payload}`));
}

function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
  return value.toString(16);
}

/** A forge the cockpit's `fetch` reaches for the rest of the test. */
export function fakeForge(host?: string): FakeForge {
  const forge = new FakeForge(host);
  vi.stubGlobal("fetch", forge.fetch);
  return forge;
}

/** Where the cockpit is served, as its setup page would see it. */
export const APP_URL = "https://cockpit.acme.test";
export const SITE_URL = "https://cockpit-site.acme.test";

/** The deployment as `asf up` starts it: local mode, with the person's own token. */
export function localMode(forge: FakeForge, token: string | null): void {
  vi.stubEnv("COCKPIT_MODE", "local");
  vi.stubEnv("COCKPIT_FORGE_HOST", forge.host);
  if (token !== null) vi.stubEnv("COCKPIT_FORGE_TOKEN", token);
}

/** A team's deployment: nobody is let in until they sign in with the team's GitHub App. */
export function teamMode(): void {
  vi.stubEnv("COCKPIT_MODE", "team");
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL);
}

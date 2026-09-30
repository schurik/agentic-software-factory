/**
 * GitHub's REST API, as both credentials call it: one host, one way to send a
 * request, and what its bodies mean. Nothing here assumes github.com — an
 * Enterprise Server is `https://HOST/api/v3`.
 */
import { isRecord } from "../model/wire";
import { FACTORY_FILE, type Person, type Repository, type Role } from "./forge";

export interface Credential {
  token: string;
  /**
   * What this credential is remembered under (`Memory`), when it is: the
   * cockpit's own credentials, which the poll asks with again and again, are;
   * a person's user access token is not — it asks rarely, and fresh.
   */
  scope: string | null;
}

/** An installation access token, good for an hour. */
export interface Minted {
  token: string;
  expiresAt: number;
}

/** What the forge answered a GET with, and the ETag it gave that answer. */
export interface Answer {
  etag: string;
  value: string;
}

/** A credential's rate limit, as the forge's headers last put it. */
export interface Limit {
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * What the cockpit remembers of the forge between one action and the next
 * (stored by `memory.ts`).
 *
 * The ETag of every answer it read, with what it read off it: the next GET of
 * the same thing is conditional, and a `304` — which GitHub does not count
 * against the rate limit — is answered from here.
 *
 * And each credential's rate limit, which is only ever what the headers said:
 * an Enterprise Server has limits off unless its admin turned them on, so no
 * number is assumed, and a credential whose answers carry no headers has no
 * limit here (`null`).
 */
export class Memory {
  private readonly fresh = new Map<string, Answer>();
  private readonly read = new Map<string, Limit | null>();
  private readonly minted = new Map<number, Minted>();

  constructor(
    private readonly answers: ReadonlyMap<string, Answer> = new Map(),
    private readonly limits: ReadonlyMap<string, Limit> = new Map(),
    private readonly tokens: ReadonlyMap<number, Minted> = new Map(),
  ) {}

  /** The installation's access token, kept for its hour: an ETag is only good with the token it was given to. */
  installationToken(installation: number): Minted | undefined {
    return this.minted.get(installation) ?? this.tokens.get(installation);
  }

  keepInstallationToken(installation: number, token: Minted): void {
    this.minted.set(installation, token);
  }

  answer(key: string): Answer | undefined {
    return this.fresh.get(key) ?? this.answers.get(key);
  }

  remember(key: string, answer: Answer): void {
    this.fresh.set(key, answer);
  }

  limit(scope: string): Limit | null {
    return this.read.has(scope) ? this.read.get(scope)! : (this.limits.get(scope) ?? null);
  }

  noteLimit(scope: string, limit: Limit | null): void {
    this.read.set(scope, limit);
  }

  /** What this action learned, for `memory.save`. */
  learned(): {
    answers: ({ key: string } & Answer)[];
    limits: { scope: string; limit: Limit | null }[];
    tokens: ({ installation: number } & Minted)[];
  } {
    return {
      answers: [...this.fresh].map(([key, answer]) => ({ key, ...answer })),
      limits: [...this.read].map(([scope, limit]) => ({ scope, limit })),
      tokens: [...this.minted].map(([installation, token]) => ({ installation, ...token })),
    };
  }
}

/** The forge's budget for a credential is spent, or as far down as the caller lets it go, until `until`. */
export class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`the forge's rate limit is spent until ${new Date(until).toISOString()}`);
    this.name = "RateLimited";
  }
}

/** The forge did not answer with what was asked for: `status` is its answer, or 0 when it gave none. */
export class ForgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ForgeError";
  }
}

/** What the forge answers about a repository, or a file, it will not show: not found, forbidden, empty, withheld. */
const UNSHOWN = new Set([404, 403, 409, 451]);
/** How long to wait on a secondary rate limit that names no wait of its own. */
const SECONDARY_WAIT = 60_000;
/** What GitHub pages by when a listing does not say. */
const DEFAULT_PAGE = 30;

/** One page of a listing, as it is remembered: what was read off it, and where it led. */
interface Page<T> {
  items: T[];
  next: string | null;
  /** Whether the forge sent as many entries as a page holds, so that another page may follow. */
  full: boolean;
}

export class GitHub {
  /**
   * `reserve` is the share of a credential's budget these calls leave alone.
   * Background work keeps one: in local mode the token is the person's own,
   * and their `gh` and their factory's watchers live on the same budget.
   */
  constructor(
    readonly host: string,
    private readonly memory: Memory = new Memory(),
    private readonly reserve = 0,
  ) {}

  get api(): string {
    return this.host === "github.com" ? "https://api.github.com" : `https://${this.host}/api/v3`;
  }

  /**
   * One request, as `as` — or as nobody, for the few things GitHub answers
   * anyone. Throws `RateLimited` instead of spending what `reserve` keeps,
   * and when the forge says the budget is gone.
   */
  async send(as: Credential | null, method: string, url: string, headers: Record<string, string> = {}): Promise<Response> {
    const now = Date.now();
    const scope = as?.scope ?? null;
    const known = scope === null ? null : this.memory.limit(scope);
    if (known && now < known.resetAt && known.remaining <= Math.floor(known.limit * this.reserve)) {
      throw new RateLimited(known.resetAt);
    }
    const response = await this.fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        ...(as ? { Authorization: `Bearer ${as.token}` } : {}),
        "User-Agent": "asf-cockpit",
        "X-GitHub-Api-Version": "2022-11-28",
        ...headers,
      },
    });
    const limit = readLimit(response.headers);
    if (scope !== null) this.memory.noteLimit(scope, limit);
    if (response.status === 403 || response.status === 429) {
      // A secondary limit names its own wait; the primary one is spent until it resets.
      const wait = Number(response.headers.get("retry-after"));
      if (wait > 0) throw new RateLimited(now + wait * 1000);
      if (limit && limit.remaining === 0) throw new RateLimited(limit.resetAt);
      // A secondary limit may name neither, and GitHub then says to wait at
      // least a minute. Only the body tells it from any other refusal.
      if (/rate limit/i.test(await response.clone().text())) throw new RateLimited(now + SECONDARY_WAIT);
    }
    return response;
  }

  /** `fetch`, with "no answer at all" said the way every other refusal is. */
  async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new ForgeError(0, `${this.host} could not be reached: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** One resource, read. */
  one<T>(as: Credential, path: string, read: (body: unknown) => T): Promise<T> {
    return this.get(as, this.api + path, async (response) => read(await response.json()));
  }

  /** Every page of a listing, in order. `read` takes one page's body to its items. */
  async list<T>(as: Credential, path: string, read: (body: unknown) => T[]): Promise<T[]> {
    const all: T[] = [];
    let url: string | null = this.api + path;
    while (url !== null) {
      const size = perPage(url);
      const page: Page<T> = await this.get(as, url, async (response) => {
        const body: unknown = await response.json();
        return { items: read(body), next: next(response), full: entries(body) >= size };
      });
      all.push(...page.items);
      // A full page that named no successor is asked for one anyway. A `304`
      // says its body is what it was — not that it is still the last page:
      // whether the ETag covers the `Link` header is nothing GitHub promises.
      url = page.next ?? (page.full ? following(url) : null);
    }
    return all;
  }

  /**
   * A GET, conditional on what the last one answered. What is remembered is
   * what `read` made of the answer, not the body: a page of repositories is
   * a megabyte as GitHub sends it and a few kilobytes as the cockpit needs it.
   */
  private async get<V>(as: Credential, url: string, read: (response: Response) => Promise<V>): Promise<V> {
    const key = as.scope === null ? null : `${as.scope} ${url}`;
    const known = key === null ? undefined : this.memory.answer(key);
    const response = await this.send(as, "GET", url, known ? { "If-None-Match": known.etag } : {});
    if (response.status === 304 && known) return JSON.parse(known.value) as V;
    if (!response.ok) throw await refusal(response, url.slice(this.api.length));
    const value = await read(response);
    const etag = response.headers.get("ETag");
    if (key !== null && etag) this.memory.remember(key, { etag, value: JSON.stringify(value) });
    return value;
  }

  /**
   * Whether the default branch of `repo` holds a factory, as far as `as` can
   * see. A repository the forge will not show this credential — gone, blocked,
   * behind an organization's SSO, empty — holds nothing the cockpit could
   * show either, so those are a no. Only what may pass throws: a token the
   * forge no longer takes, a rate limit, and the forge failing.
   */
  async holdsFactory(as: Credential, repo: string): Promise<boolean> {
    const where = `/repos/${repo}/contents/${FACTORY_FILE}`;
    let response = await this.send(as, "HEAD", this.api + where);
    // A 403 is also how a rate limit is said, and a HEAD has no body to say
    // which: asked again as a GET, `send` can tell.
    if (response.status === 403) response = await this.send(as, "GET", this.api + where);
    if (response.ok) return true;
    if (UNSHOWN.has(response.status)) return false;
    throw await refusal(response, where);
  }
}

export async function refusal(response: Response, path: string): Promise<ForgeError> {
  let said = "";
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.message === "string") said = `: ${body.message}`;
  } catch {
    // A body that is not JSON says nothing the status does not.
  }
  return new ForgeError(response.status, `the forge answered ${response.status} to ${path}${said}`);
}

/** The rate limit a response's headers state, or null when they state none. */
function readLimit(headers: Headers): Limit | null {
  const [limit, remaining, reset] = ["limit", "remaining", "reset"].map((name) => {
    const value = headers.get(`x-ratelimit-${name}`);
    return value === null || value === "" ? Number.NaN : Number(value);
  });
  if (Number.isNaN(limit) || Number.isNaN(remaining) || Number.isNaN(reset)) return null;
  return { limit, remaining, resetAt: reset * 1000 };
}

/** The `rel="next"` of a `Link` header, or null on the last page. */
function next(response: Response): string | null {
  const link = response.headers.get("Link") ?? "";
  return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
}

/** How many entries a page's body holds: the array it is, or the one it wraps (`{repositories: [...]}`). */
function entries(body: unknown): number {
  if (Array.isArray(body)) return body.length;
  if (!isRecord(body)) return 0;
  return Math.max(0, ...Object.values(body).map((value) => (Array.isArray(value) ? value.length : 0)));
}

function perPage(url: string): number {
  return Number(new URL(url).searchParams.get("per_page")) || DEFAULT_PAGE;
}

/** The page after `url`, by number. */
function following(url: string): string {
  const after = new URL(url);
  after.searchParams.set("page", String((Number(after.searchParams.get("page")) || 1) + 1));
  return after.toString();
}

// ── what the bodies mean ─────────────────────────────────────────────────────

export function items(body: unknown): Record<string, unknown>[] {
  return Array.isArray(body) ? body.filter(isRecord) : [];
}

export function readRepository(body: Record<string, unknown>): Repository {
  return {
    id: Number(body.id),
    name: String(body.full_name),
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "",
    private: body.private === true,
    pushedAt: typeof body.pushed_at === "string" ? body.pushed_at : "",
  };
}

/** The highest role a repository's `permissions` object grants, or null when it grants none. */
export function readRole(body: Record<string, unknown>): Role | null {
  const granted = isRecord(body.permissions) ? body.permissions : {};
  if (granted.admin === true) return "admin";
  if (granted.maintain === true) return "maintain";
  if (granted.push === true) return "write";
  if (granted.triage === true) return "triage";
  if (granted.pull === true) return "read";
  return null;
}

export function readPerson(body: unknown): Person {
  const person = isRecord(body) ? body : {};
  return {
    id: Number(person.id),
    login: String(person.login),
    name: typeof person.name === "string" ? person.name : "",
    avatarUrl: typeof person.avatar_url === "string" ? person.avatar_url : "",
  };
}

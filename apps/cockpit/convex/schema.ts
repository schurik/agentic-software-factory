import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { appValidator } from "./forge/app";
import { roleValidator } from "./forge/forge";
import { storedEventFields } from "./model/wire";

export const expiringValidator = v.object({ token: v.string(), expiresAt: v.union(v.null(), v.number()) });

/** What a handshake was offered for: it is taken only for that (handshakes.ts). */
export const purposeValidator = v.union(v.literal("setup code"), v.literal("setup"), v.literal("sign-in"));

export default defineSchema({
  // A factory-scoped, append-only credential: it can add events to its own
  // factory's sessions and nothing else — no read, no command. Only a digest is
  // kept, so the table leaking is not every station's secret leaking.
  ingestTokens: defineTable({
    factory: v.string(),
    digest: v.string(),
  }).index("by_digest", ["digest"]),

  // One document per domain event, exactly as the station sent it. The payload
  // is kept as the JSON text it arrived as (model/wire.ts) and never validated
  // against a kind: a kind or version this cockpit cannot read is kept all the
  // same, and read once the cockpit can.
  events: defineTable({
    factory: v.string(),
    session: v.string(),
    ...storedEventFields,
  }).index("by_session_seq", ["factory", "session", "seq"]),

  sessions: defineTable({
    factory: v.string(),
    session: v.string(),
    // The highest seq with every seq below it stored — what a station resumes after.
    acked: v.number(),
    // What the sessions list shows: the events up to `acked`, folded (a
    // `Summary`, model/session.ts). Kept here so the list reads one document
    // per session instead of every event. Deliberately untyped in the schema:
    // it is a cache of a fold, and a cockpit upgrade that adds a field to it
    // must not make every stored session fail schema validation on deploy.
    // Readers fill what an older fold never wrote (`readSummary`).
    summary: v.any(),
    // When the cockpit last folded anything in, for ordering the list.
    activity: v.number(),
  })
    .index("by_session", ["factory", "session"])
    .index("by_activity", ["activity"])
    .index("by_factory_activity", ["factory", "activity"]),

  // Every repository the cockpit's own forge credential reaches, as the last
  // catch-up poll or webhook left it (discovery.ts). A repository is a factory
  // when its default branch holds `asf/factory.yaml`; nothing registers one
  // here. `stale` says the forge has not been asked that since the repository
  // last moved, and `rev` counts the times it was marked, so an answer that
  // was already on its way when it moved again does not clear the mark.
  repos: defineTable({
    key: v.string(),                  // the name lowercased: the forge's names are case-insensitive
    name: v.string(),                 // `owner/name`, as the forge spells it
    forgeId: v.number(),
    defaultBranch: v.string(),
    private: v.boolean(),
    pushedAt: v.string(),
    stale: v.boolean(),
    rev: v.number(),
    factory: v.boolean(),
  })
    .index("by_key", ["key"])
    .index("by_stale", ["stale"])
    .index("by_factory", ["factory", "key"]),

  // A person the cockpit knows by their forge login: whoever signed in with
  // the team's GitHub App, or — `local` — the one person whose token a local
  // cockpit holds. The forge login is the only identity there is.
  viewers: defineTable({
    forgeId: v.number(),
    login: v.string(),
    name: v.string(),
    avatarUrl: v.string(),
    local: v.boolean(),
    // When the forge was last asked where this person can go (`reach`).
    reachAt: v.number(),
    // What the team's App acts as this person with: their user access token
    // (8 hours) and the refresh token that renews it (6 months). Never
    // returned by a public function; a local viewer has neither.
    access: v.optional(expiringValidator),
    refresh: v.optional(expiringValidator),
    // When a refresh of the two above, and of the reach, was last taken on:
    // a refresh token works once, so two tabs must not both spend it.
    refreshingAt: v.optional(v.number()),
  })
    .index("by_forge_id", ["forgeId"])
    .index("by_local", ["local"]),

  // A browser that signed in: the digest of the token it holds, and whose it
  // is. Signing out deletes it; so does the forge refusing to renew the
  // person's tokens.
  signIns: defineTable({
    digest: v.string(),
    viewer: v.id("viewers"),
    expiresAt: v.number(),
  })
    .index("by_digest", ["digest"])
    .index("by_viewer", ["viewer"])
    .index("by_expiry", ["expiresAt"]),

  // The permission mirror: what the forge said a viewer may do on each
  // repository they reach. A cache of the forge's answer and nothing more —
  // the cockpit grants nothing of its own (spec #40).
  reach: defineTable({
    viewer: v.id("viewers"),
    repo: v.string(),                 // a `repos.key`
    role: roleValidator,
  }).index("by_viewer_repo", ["viewer", "repo"]),

  // What the forge last answered a GET with, under the ETag it gave it
  // (forge/github.ts `Memory`): `key` is the credential's scope and the URL,
  // `value` what the cockpit read off the answer, as JSON.
  forgeAnswers: defineTable({
    key: v.string(),
    etag: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),

  // A forge credential's rate limit, as its headers last stated it. A
  // credential with no row has no limit the forge ever named (an Enterprise
  // Server leaves them off by default), and none is assumed.
  forgeLimits: defineTable({
    scope: v.string(),
    limit: v.number(),
    remaining: v.number(),
    resetAt: v.number(),
  }).index("by_scope", ["scope"]),

  // The GitHub App a team registered for this cockpit through the manifest
  // flow (setup.ts): at most one document, because an App belongs to one
  // GitHub host and a cockpit talks to one forge. Its key and secrets are what
  // GitHub handed back, and no public function returns them.
  forgeApps: defineTable(appValidator),

  // A secret handed out to be shown back once: a setup code the admin CLI
  // printed, or the `state` of a setup or sign-in that went to GitHub and is
  // expected back. Kept as its digest, and gone once it has been taken.
  handshakes: defineTable({
    digest: v.string(),
    purpose: purposeValidator,
    expiresAt: v.number(),
    host: v.optional(v.string()),
  })
    .index("by_digest", ["digest"])
    .index("by_expiry", ["expiresAt"]),

  // An installation's access token, kept for the hour it lasts.
  forgeTokens: defineTable({
    installation: v.number(),
    token: v.string(),
    expiresAt: v.number(),
  }).index("by_installation", ["installation"]),

  // How the catch-up poll is doing: one document, read as a `Progress`
  // (model/progress.ts), which says what each field is.
  discovery: defineTable({
    listedAt: v.union(v.null(), v.number()),
    pausedUntil: v.union(v.null(), v.number()),
    problem: v.string(),
  }),
});

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { appValidator } from "./forge/app";
import { roleValidator } from "./forge/forge";
import { claimKindValidator, releasedValidator, requeueValidator } from "./model/claim";
import { commandStateValidator, reportValidator, verbValidator } from "./model/command";
import { storedEventFields } from "./model/wire";

export const expiringValidator = v.object({ token: v.string(), expiresAt: v.union(v.null(), v.number()) });

/** What a handshake was offered for: it is taken only for that (handshakes.ts). */
export const purposeValidator = v.union(v.literal("setup code"), v.literal("setup"), v.literal("sign-in"));

export default defineSchema({
  // Every purge of a session's bodies, or of a whole factory's: who asked,
  // what, when and why (retention.ts). Written as the purge is decided, and
  // never deleted — a purge removes bodies, not the record that it happened.
  purges: defineTable({
    factory: v.string(),
    session: v.string(),              // "" for the whole factory
    by: v.string(),                   // the forge login of who asked; "" from the deployment's CLI
    via: v.union(v.literal("cockpit"), v.literal("deployment")),
    reason: v.string(),
    at: v.number(),
  }).index("by_factory_at", ["factory", "at"]),

  // A factory-scoped, append-only credential: it can add events to its own
  // factory's sessions and nothing else — no read, no command. Only a digest is
  // kept, so the table leaking is not every station's secret leaking.
  //
  // One row per token, so each is revoked alone (tokens.ts). A row the
  // operator issued with the admin key (`tokens:issue`) says no more than
  // that; one a person issued says who and when: handed to a station whose
  // registration they approved, or issued on the factory page for CI.
  // Revoking keeps the row, because the earliest token's factory is how the
  // factory's name is spelled here (`spelling.ts`).
  ingestTokens: defineTable({
    factory: v.string(),
    digest: v.string(),
    kind: v.optional(v.union(v.literal("station"), v.literal("ci"))),
    label: v.optional(v.string()),            // the station's name, or what the admin called the CI token
    station: v.optional(v.string()),          // the station id a registration handed it to
    issuedBy: v.optional(v.id("viewers")),
    issuedByLogin: v.optional(v.string()),
    issuedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_digest", ["digest"])
    .index("by_factory", ["factory"]),

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
    // Whether the summary says the session waits at a gate: what the inbox
    // reads by (inbox.ts). Written with the summary on every ingest; unset on
    // a session stored before it existed, until the next event folds in.
    waiting: v.optional(v.boolean()),
    // Whether the session holds transcript bodies not yet aged out, and — once
    // it has finished — when they age out, epoch ms (model/retention.ts). Both
    // unset on a session stored before retention existed, until the backfill
    // (retention.ts) has looked at its events.
    transcripts: v.optional(v.boolean()),
    transcriptsDue: v.optional(v.number()),
  })
    .index("by_session", ["factory", "session"])
    .index("by_transcripts", ["transcripts"])
    .index("by_transcripts_due", ["transcriptsDue"])
    .index("by_activity", ["activity"])
    .index("by_factory_activity", ["factory", "activity"])
    .index("by_waiting", ["waiting", "activity"])
    .index("by_factory_waiting", ["factory", "waiting"]),

  // What a session's agent calls cost in one quarter hour, charged to one
  // workflow, station and person (model/spend.ts), added to by ingest as each
  // `usage` event becomes contiguous — so once. What spend in a period is
  // rolled up from (cost.ts): a period in any timezone starts on a quarter
  // hour, so it takes whole rows. A row stored before it was charged to
  // anything has no charge, and is charged as its session's summary says.
  spend: defineTable({
    factory: v.string(),
    session: v.string(),
    at: v.number(),                   // the quarter hour's start, epoch ms
    cost: v.number(),                 // list-price equivalent, USD
    tokens: v.number(),
    workflow: v.optional(v.string()),
    station: v.optional(v.string()),  // the station's id
    stationName: v.optional(v.string()),
    person: v.optional(v.string()),   // the forge login of whoever triggered the run
  })
    .index("by_session_at", ["factory", "session", "at"])
    .index("by_factory_at", ["factory", "at"])
    .index("by_at", ["at"]),

  // An answer a viewer posted from the inbox: the comment on the work item,
  // which is the answer itself — this only remembers that it was sent, so the
  // row says so until the factory's answers watcher picks it up and the
  // session's own events close the wait. Nothing here is the decision.
  gateAnswers: defineTable({
    factory: v.string(),
    session: v.string(),
    gate: v.string(),
    round: v.number(),
    digest: v.string(),
    verdict: v.string(),
    by: v.string(),                   // the forge login it was posted as
    url: v.string(),                  // the comment, on the forge
    at: v.number(),
  }).index("by_wait", ["factory", "session", "gate", "round"]),

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
    // A factory's open issues queued for a route — what a watcher would start —
    // as the poll last found them; null when the forge would not say, absent
    // until it was first asked. What "nobody watching" is read against.
    queued: v.optional(v.union(v.null(), v.array(v.number()))),
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

  // A station a person approved to take commands (model/command.ts): one
  // checkout of a factory, by the id it minted for itself. `token` is the
  // digest of its command token — the owner's, for this station alone — and
  // null once revoked, which is what takes it offline for commands. `seenAt`
  // is when its long-lived loop last polled; `report` what that poll, or a
  // run's own, said it would obey and where its checkout stands.
  stations: defineTable({
    factory: v.string(),
    station: v.string(),
    name: v.string(),
    kind: v.string(),                 // local | ci
    owner: v.union(v.null(), v.id("viewers")),
    ownerLogin: v.string(),
    token: v.union(v.null(), v.string()),
    seenAt: v.number(),               // 0: its loop has never polled
    report: v.union(v.null(), reportValidator),
  })
    .index("by_station", ["factory", "station"])
    .index("by_token", ["token"])
    .index("by_owner", ["owner"]),

  // A station asking to be registered (`asf station register`): the digest of
  // the secret it polls with, and the code a person approves it by. Gone once
  // the station has its token, or once it ran out. One asked without an
  // ingest token (`open`) named its factory itself, is handed an ingest token
  // too, and counts against what may wait from its `source` and for its
  // factory (model/command.ts, OPEN_PER_SOURCE).
  registrations: defineTable({
    device: v.string(),
    code: v.string(),
    factory: v.string(),
    station: v.string(),
    name: v.string(),
    kind: v.string(),
    host: v.optional(v.string()),             // the machine's own name for itself, as it said
    open: v.optional(v.boolean()),
    source: v.optional(v.string()),           // where an open request came from: its address, or "unknown"
    expiresAt: v.number(),
    approvedBy: v.union(v.null(), v.id("viewers")),
  })
    .index("by_device", ["device"])
    .index("by_code", ["code"])
    .index("by_expiry", ["expiresAt"])
    .index("by_factory", ["factory", "expiresAt"])
    .index("by_source", ["source", "expiresAt"]),

  // When a run's own shipper last polled for its session's commands: a
  // session is attended while that is recent. Kept apart from `sessions`, so a
  // poll every few seconds does not re-run every query that lists them.
  attendance: defineTable({
    factory: v.string(),
    session: v.string(),
    station: v.string(),
    at: v.number(),
  }).index("by_session", ["factory", "session"]),

  // A command a person queued for a station. Never "done" because it was
  // sent: only the station's own `command_result` settles it — ingested with
  // the session it names (ingest.ts), or carried by a poll when it names none
  // (a run) — and a command nobody took by `expiresAt` expires (crons.ts).
  // The fields after `detail` are what a verb names besides a session, absent
  // from a command an older cockpit queued.
  commands: defineTable({
    factory: v.string(),
    station: v.string(),
    session: v.string(),              // "" for a run: the session is what it starts
    verb: verbValidator,
    notes: v.string(),
    by: v.string(),                   // the forge login of whoever queued it
    issuedAt: v.number(),
    expiresAt: v.number(),
    state: commandStateValidator,
    deliveredAt: v.union(v.null(), v.number()),
    detail: v.string(),               // what the station said it did, or why it would not
    verdict: v.optional(v.string()),  // answer: approve | reject | answer; abort: abort
    gate: v.optional(v.string()),     // answer, abort: the wait the person was shown
    round: v.optional(v.number()),
    digest: v.optional(v.string()),
    workflow: v.optional(v.string()), // run
    prompt: v.optional(v.string()),
    started: v.optional(v.string()),  // run: the session it started, once the station said
  })
    .index("by_station_state", ["factory", "station", "state"])
    .index("by_session", ["factory", "session"])
    .index("by_state_expiry", ["state", "expiresAt"]),

  // A claim on a work item (model/claim.ts, ADR 0003): which station's
  // session starts it. One row per grant, kept after it is let go — `released`
  // says when, why and by whom, which is the audit of a writer's Release
  // claim. `held` is what the one transactional `take` reads by: at most one
  // held row per item. `repo` is the item's repository, lowercased; `factory`
  // is whose ingest token asked.
  claims: defineTable({
    factory: v.string(),
    repo: v.string(),
    kind: claimKindValidator,
    number: v.number(),
    station: v.string(),
    stationName: v.string(),
    session: v.string(),
    since: v.number(),                // the session's last seq when it asked: only what follows ends it
    requeue: requeueValidator,        // how a release puts the item back, in the factory's own label names
    grantedAt: v.number(),
    aborted: v.boolean(),             // a decision after `since` aborted the run: its finish frees the claim
    held: v.boolean(),
    released: v.union(v.null(), releasedValidator),
  })
    .index("by_item", ["repo", "kind", "number", "held"])
    .index("by_session", ["factory", "session", "held"])
    .index("by_factory", ["factory", "held"]),

  // A factory's self-description, as the last `asf check --json` a CI station
  // pushed for one branch left it (describe.ts): one row per (factory, ref),
  // replaced by the next push. The description is kept as the JSON text it
  // arrived as and read by `model/description.ts`, like an event's payload, so
  // a format this cockpit cannot read yet is kept all the same. `head` and
  // `configHash` are the checkout it described — from the default branch,
  // what every station's config drift is measured against.
  checks: defineTable({
    factory: v.string(),
    ref: v.string(),
    head: v.string(),
    configHash: v.string(),
    format: v.number(),
    ok: v.boolean(),
    description: v.string(),
    station: v.string(),              // the CI job's station: its id, and what it called itself
    stationName: v.string(),
    stationKind: v.string(),
    at: v.number(),
  })
    .index("by_ref", ["factory", "ref"])
    .index("by_factory_at", ["factory", "at"]),

  // How the catch-up poll is doing: one document, read as a `Progress`
  // (model/progress.ts), which says what each field is.
  discovery: defineTable({
    listedAt: v.union(v.null(), v.number()),
    pausedUntil: v.union(v.null(), v.number()),
    problem: v.string(),
    // When an action took its turn at listing the repositories, or at asking
    // about the stale ones, and null once it gave it back (discovery.begin).
    listing: v.optional(v.union(v.null(), v.number())),
    checking: v.optional(v.union(v.null(), v.number())),
    queueing: v.optional(v.union(v.null(), v.number())),
  }),
});

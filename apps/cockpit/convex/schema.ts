import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { appValidator } from "./forge/app";
import { itemStateValidator, roleValidator } from "./forge/forge";
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
  // kept, so the table leaking is not every station's secret leaking. One row
  // per token, so each is revoked on its own (tokens.ts); a revoked one is kept,
  // `revokedAt` set, because a factory's spelling is read off every token it
  // was ever issued (spelling.ts). The fields after `digest` are absent from a
  // token issued before tokens were listed: issued on the deployment, then.
  ingestTokens: defineTable({
    factory: v.string(),
    digest: v.string(),
    // How it was issued: with the deployment's admin key (`tokens:issue`), to
    // a station a person approved (`stations.handOver`), or by a repository's
    // admin on the factory page, for CI (`tokens.issueFor`).
    via: v.optional(v.union(v.literal("deployment"), v.literal("station"), v.literal("cockpit"))),
    label: v.optional(v.string()),    // the station's name, or what the admin called it
    station: v.optional(v.string()),  // via a station: its id
    by: v.optional(v.string()),       // the forge login of who approved or issued it; "" on the deployment
    issuedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_digest", ["digest"])
    .index("by_factory", ["factory"])
    .index("by_station", ["factory", "station"]),

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
    // Whether its phases' rows (`phases`) were written from its first event.
    // Unset on a session stored before they existed: the backfill, or its next
    // batch, writes them from the start (phases.ts).
    phased: v.optional(v.boolean()),
    // Whether its chapters' rows (`chapters`) were written from its first
    // event, the same way: unset on a session stored before they existed.
    chaptered: v.optional(v.boolean()),
    // Whether its scores' rows (`scores`) were written from its first event,
    // the same way: unset on a session stored before they existed.
    scored: v.optional(v.boolean()),
  })
    .index("by_session", ["factory", "session"])
    .index("by_phased", ["phased"])
    .index("by_chaptered", ["chaptered"])
    .index("by_scored", ["scored"])
    .index("by_transcripts", ["transcripts"])
    .index("by_transcripts_due", ["transcriptsDue"])
    .index("by_activity", ["activity"])
    .index("by_factory_activity", ["factory", "activity"])
    .index("by_waiting", ["waiting", "activity"])
    .index("by_factory_waiting", ["factory", "waiting"])
    // A factory's sessions in the order they were first stored: its oldest is first.
    .index("by_factory", ["factory"]),

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

  // What one phase of a session did (model/phases.ts): its chapter, workflow
  // and stage, how it went, how long it worked, what it cost, and — a round a
  // person was asked at a gate — what they answered and how long it waited.
  // Written by ingest as the phase's events become contiguous, the way spend
  // is, so a factory's Overview and Workflows count phases without reading
  // events. `since` and `replay` are only what the next batch goes on from.
  phases: defineTable({
    factory: v.string(),
    session: v.string(),
    phase: v.string(),                // the phase's id
    chapter: v.number(),
    workflow: v.string(),
    stage: v.union(v.null(), v.string()),       // none for the work item, the report, or a factory before stages
    stageIndex: v.union(v.null(), v.number()),
    kind: v.string(),                 // agent | code | gate
    name: v.string(),
    status: v.string(),               // running | waiting | success | fail
    at: v.number(),                   // when it first started, epoch ms
    duration: v.number(),             // seconds its live runs worked
    since: v.union(v.null(), v.number()),
    replay: v.boolean(),
    cost: v.number(),
    tokens: v.number(),
    gate: v.string(),
    round: v.number(),
    askedAt: v.union(v.null(), v.number()),
    verdict: v.string(),              // "" until a person answered
    wait: v.union(v.null(), v.number()),        // seconds from asked to answered
  })
    .index("by_session", ["factory", "session", "phase"])
    .index("by_factory_at", ["factory", "at"]),

  // A chapter of a session (model/chapters.ts): its workflow, what started it
  // — a prompt, an issue, a pull request's review — and when. Written by
  // ingest as each `workflow_started` arrives, so Metrics counts chapters by
  // trigger without reading events.
  chapters: defineTable({
    factory: v.string(),
    session: v.string(),
    chapter: v.number(),
    workflow: v.string(),
    trigger: v.string(),
    at: v.number(),
  })
    .index("by_session", ["factory", "session", "chapter"])
    .index("by_factory_at", ["factory", "at"]),

  // One scorer's scores of a session (model/scores.ts): each chapter's latest,
  // and whether any is failing — what a threshold counts. Written by ingest as
  // each `chapter_scored` arrives, usually long after the session finished,
  // so the Measure tab's Scorers view reads no event. `at` is when the cockpit
  // first stored the session: the order its strip lists a factory's sessions in.
  scores: defineTable({
    factory: v.string(),
    session: v.string(),
    scorer: v.string(),
    at: v.number(),
    failing: v.boolean(),
    chapters: v.array(v.object({
      chapter: v.number(), class: v.string(), failing: v.boolean(), evidence: v.array(v.number()),
    })),
  })
    .index("by_session", ["factory", "session", "scorer"])
    .index("by_factory_scorer", ["factory", "scorer", "at"]),

  // A session's pull request, as the Measure tab counts it (model/pulls.ts):
  // when its own integration opened it, how and when it closed, whether it was
  // autonomous — and the commits the session made, which decide that — and
  // what it took: when the session started, how big it was, what it cost.
  // Written by ingest as the events arrive, the way phases are, so Metrics
  // counts pull requests without reading events. The fields after `commits`
  // are absent from a row an older cockpit wrote, until its session's next
  // batch folds it again from its first event (pulls.ts).
  pulls: defineTable({
    factory: v.string(),
    session: v.string(),
    url: v.string(),
    opened: v.union(v.null(), v.number()),
    closed: v.union(v.null(), v.number()),
    merged: v.boolean(),
    mergedAt: v.union(v.null(), v.number()),
    firstReviewAt: v.union(v.null(), v.number()),
    autonomous: v.boolean(),
    commits: v.array(v.string()),
    kickoff: v.optional(v.union(v.null(), v.number())),
    prs: v.optional(v.number()),
    lines: v.optional(v.union(v.null(), v.number())),
    spent: v.optional(v.object({
      input: v.number(), output: v.number(), cacheRead: v.number(), cacheWrite: v.number(), other: v.number(),
    })),
  })
    .index("by_session", ["factory", "session"])
    .index("by_factory_opened", ["factory", "opened"])
    .index("by_factory_merged", ["factory", "mergedAt"]),

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
    // A factory's issues and pull requests (`forgeItems`) are known as they
    // stood at this time (ISO 8601): the latest change the poll has read.
    // Absent until it first looked.
    itemsSince: v.optional(v.string()),
  })
    .index("by_key", ["key"])
    .index("by_stale", ["stale"])
    .index("by_factory", ["factory", "key"]),

  // Where a factory's issue or pull request stands on the forge — open,
  // closed, a draft, merged — as the poll last read it (discovery.ts
  // `items`). No event says it: a pull request is merged long after the
  // session that opened it ended. Kept as long as its repository is, and
  // only ever replaced by a later answer; an item with no row is drawn as
  // one whose state is not known.
  forgeItems: defineTable({
    repo: v.string(),                 // a `repos.key`
    number: v.number(),
    pull: v.boolean(),
    state: itemStateValidator,
    updatedAt: v.string(),            // when it last changed, as the forge stamps it
  }).index("by_item", ["repo", "number"]),

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
  // the station has its token, or once it ran out. `tokenless` is a request
  // that named its factory itself, holding no ingest token: anyone who reaches
  // the site can make one, so they are counted (`TOKENLESS_*`), by factory and
  // by `source` — the address a proxy in front of the deployment said it came
  // from, absent when none said — and approving one hands the station an
  // ingest token too. Both absent from a request kept before they existed.
  registrations: defineTable({
    device: v.string(),
    code: v.string(),
    factory: v.string(),
    station: v.string(),
    name: v.string(),
    kind: v.string(),
    expiresAt: v.number(),
    approvedBy: v.union(v.null(), v.id("viewers")),
    host: v.optional(v.string()),
    tokenless: v.optional(v.boolean()),
    source: v.optional(v.string()),
  })
    .index("by_device", ["device"])
    .index("by_code", ["code"])
    .index("by_expiry", ["expiresAt"])
    .index("by_factory", ["factory", "expiresAt"])
    .index("by_factory_tokenless", ["factory", "tokenless", "expiresAt"])
    .index("by_tokenless", ["tokenless", "expiresAt"])
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
    station: v.string(),              // the station that pushed it — a CI job, or the first to register — its id, and what it called itself
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
    tracking: v.optional(v.union(v.null(), v.number())),
  }),
});

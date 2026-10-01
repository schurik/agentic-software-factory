# The cockpit

Observes and steers many factories from one place (ADR 0001, spec #40). A station ships a session's
domain events to `POST /ingest`, and a sessions list and a session page render live from what was
stored. The home page is the **inbox**: every gate the viewer may answer, answered in place. The forge says which factories there are and who may see them: a Factories page lists every
repository the cockpit can reach whose default branch holds `asf/factory.yaml`. It is a Next.js
front end on a **self-hosted Convex** backend (ADR 0002), and it lives here, outside
`skills/agentic-sf/`, so it never ships in a stamp.

It runs in one of two modes, and the deployment's environment says which:

- **team** (the default): people sign in with a GitHub App the team registers for itself, and each
  sees what the forge lets them read. [Set up a team cockpit](#set-up-a-team-cockpit).
- **local** (`COCKPIT_MODE=local`): one person's own machine, started by `asf up`. Nobody signs in,
  and the forge is asked with that person's `gh auth token`.
  [Local mode](#local-mode-and-the-published-images).

## Run it

```bash
docker compose up --build        # backend :3210/:3211, dashboard :6791, app :3000
```

That is the whole setup. The backend runs on SQLite and local disk inside the `data` volume; a
one-shot `keygen` service derives the deployment's admin key from the backend's own secret, and the
app deploys its Convex functions with it every time it starts, so the functions and the pages are
always the same version. To log in to the dashboard, print the key:

```bash
docker compose exec backend ./generate_admin_key.sh
```

A factory is known to the cockpit by its repository. Give it an **ingest token** — factory-scoped
and append-only: it can add events to that factory's sessions and read nothing back. It is printed
once; only its SHA-256 is stored. Name the factory as its repository, `owner/name` (in any case):
that is what a viewer's permission is looked up by, so sessions shipped under any other name are
shown to nobody in a team's cockpit.

```bash
docker compose exec app ./convex.sh run tokens:issue '{"factory": "acme/widgets"}'
```

## Set up a team cockpit

A team's cockpit has to be reachable by the people who use it and, for webhooks, by GitHub. Tell
the backend its public addresses before the first start — `CONVEX_CLOUD_ORIGIN` is where browsers
reach the backend's API (`:3210`) and `CONVEX_SITE_ORIGIN` where GitHub and stations reach its site
(`:3211`) — then register the GitHub App. There is one App per GitHub host (github.com, or your
Enterprise Server), and it is yours: private to your account, registered through GitHub's **manifest
flow**, so nobody copies a key by hand.

GitHub refuses to register an App whose webhook it could not deliver to: a loopback or private
address (`CONVEX_SITE_ORIGIN` left at `http://127.0.0.1:3211`, say). Such a cockpit — on one
machine for a trial, or behind a firewall GitHub.com cannot cross — is registered **without a
webhook**, and the setup page says so before you leave for GitHub. Everything else works the same;
the cockpit learns of the forge by the catch-up poll alone, once a minute. Sign-in needs only your
browser to reach the cockpit, so `http://localhost:3000` is fine for that.

1. Print a setup code. It is what shows you run the deployment; it works once, for an hour.

   ```bash
   docker compose exec app ./convex.sh run setup:code
   ```

2. Open `/setup` on the cockpit, enter the code, the GitHub host and the organization that will own
   the App, and continue. GitHub shows the App it is about to create; confirm it there.
3. GitHub sends you back, and the cockpit stores what it handed over: the App's private key, its
   client secret and (with a webhook) its webhook secret, in the backend's `forgeApps` table. No page or public
   function returns them.
4. Install the App on the repositories that hold your factories (the link is on the page you land
   on). An organization owner can; anyone else sends the owner a request from the same page.

People then **sign in** with the App (`/` sends them to GitHub and back). The cockpit holds each
person's user access token (8 hours) and refresh token (6 months) in the backend and hands the
browser only a token of its own, which it stores as a digest. What a person sees is what GitHub
says they can read: their permission on each repository is asked with their own token and kept (the
**permission mirror**), and the cockpit grants nothing itself. The Factories list, the sessions
list and a session page are all filtered by it. The page asks again every five minutes, and an
answer older than fifteen shows nothing at all until it has: a browser that stopped asking, or a
forge that cannot be reached, confirms nothing.

GitHub's answer is the repositories a person has been given access to — as a member, a team member
or a collaborator — through the App's installations. So a public repository is shown to the people
who have access to it, not to everyone with a GitHub account who signs in.

The App asks for what the cockpit does as the signed-in person (spec #40): `contents`, `issues` and
`pull_requests` write, and `metadata` read. A user access token can do only what both the person
and the App may, so the App's permissions are a ceiling, never a grant. Registering again with a
fresh setup code replaces the App and signs everyone out — the way out of a registration under the
wrong account.

### How the cockpit learns of the forge

- **Webhooks.** The App has one webhook for every repository it is installed on, delivered to
  `POST /forge/webhook` on the backend's site. A delivery is checked against the webhook secret
  (`X-Hub-Signature-256`), handed to a mutation and answered at once; the forge is asked nothing
  until after, because GitHub waits ten seconds and never retries. A push to a default branch has
  the cockpit look at that one repository again; a change to the installation or to a repository
  has it list them all.
- **The catch-up poll.** `discovery:catchUp` runs once as the deployment starts and every minute
  after, and finds whatever a delivery that never arrived would have said. It lists the
  repositories with ETags — a `304` costs nothing against the rate limit — and asks a repository
  whether it holds a factory only when it was pushed to since the last look. A repository the forge
  will not show the cockpit (gone, blocked, behind an organization's SSO) is not a factory here.
- **Rate limits** are read from the response headers, never assumed: an Enterprise Server has them
  off unless its admin turned them on. The poll leaves a quarter of a budget untouched, stops when
  it gets there, and carries on when the limit resets; the Factories page says so meanwhile.

What the cockpit reads for itself goes on the App's installation token; what it asks about a person
goes on that person's token. Both are behind one interface, `convex/forge/forge.ts`, with the App
in `convex/forge/app.ts` and local mode's token in `convex/forge/token.ts`.

A session's **repo artifacts** are read that way too. A handoff file (findings, a review, the
issue a chapter answers) travels inline in its `artifact_written` and is on the page already; a
repo file (the spec, the doc) travels only as a path, because it is committed on the session's
branch. When a person opens a phase's Artifacts tab, `artifacts:read` asks the forge for the file at
the sha of the first `committed` after it — the factory commits the whole tree, so that commit holds
it as written — and never at the branch tip, which later phases and people move on. It checks the
bytes against the digest the phase shipped, cuts them at the factory's own cap (256 KB), and keeps
nothing: the cockpit stores no file bodies. The page says when a later commit changed the file (with
a link to the forge's comparison), and when a later phase wrote it again before anything committed
it, so that version never reached the forge. The session must be one the person may see; the read
itself goes on the installation token, like the cockpit's other reading.

## The inbox

The home page lists every gate, across every factory, that the viewer is **permitted** to answer:
they can read its repository, and the factory's trust list for the wait's channel names them or
nobody. That list is the factory's own word, carried by the `suspended` event (`trusted`, from
`issues.trusted_authors` for a wait on an issue), so the cockpit offers the answer to exactly the
people the factory will hear. The rows that are **for the viewer** — a run they triggered, an issue
they wrote, an issue assigned to them — are marked and sorted first; it is a ranking, never a filter,
so every row the viewer may answer stays. Who triggered a run is the factory's word
(`session_started`'s `triggered_by`: whoever labelled the issue, or the operator who ran it), and the
issue's author and assignees ride on `provenance_recorded` v2. The rest wait longest first, and a
wait older than a day is flagged. The list and the open answer view are live queries.

## Triggering a workflow

A factory's row on the Factories page has a **Trigger** button: pick a workflow and an issue, and the
cockpit adds that workflow's route label and the factory's queued label to the issue **as the
viewer** — on their user access token in a team cockpit, or the local cockpit's `gh auth token`.
Nothing is started here: the factory's issues watcher dequeues the issue on its next poll, as it
would one labelled on the forge, and records whoever the forge's `labeled` event names as the run's
trigger. The button is enabled from **triage** up, which is what the forge asks of a labeller, and
otherwise disabled with the reason; the forge is what enforces it. A closed issue, a pull request, a
label that routes nothing, an issue already queued (no new `labeled` event would name the viewer) and
one a run already has (a run parked at a gate keeps it on `running`; queueing it again would start a
second) are refused before anything is labelled (`convex/trigger.ts`).

The cockpit never reads a factory's config to learn its routes (#26: only the factory's own code
does). It finds them on the forge: `asf labels --create` describes each route label as `asf route: a
person asked for the <workflow> workflow here` and the queued label as `asf: waiting for a watcher to
claim it`, and `convex/model/trigger.ts` recognises those two descriptions — `tests/golden/labels/`
holds them (and the running label's), and both suites read it. A label made by hand says nothing,
and is not offered. The forge's labels are not the factory's config, though: a route removed from
`issues.route` keeps its label, and is offered until someone deletes it — the watcher then leaves an
issue carrying only that label queued. The self-description (#57) is where routes belong once a
factory ships one.

An answer is a **comment on the work item, posted as the viewer**: on their own user access token
in a team cockpit (GitHub shows it as theirs, made through the App), or with the `gh auth token` a
local cockpit holds. Its first line is the verdict the factory's answers watcher reads — `/approve`,
`/reject <notes>`, `/abort`, or a question round's answers in prose — and it ends with a mark naming
the session, gate, round and subject digest it answered, so the watcher ignores it once the run has
moved past them (`convex/model/answer.ts`). Nothing in the cockpit records a decision: the row says
"answered" until the session's own events close the wait. `tests/golden/answers/` holds each
rendering; this suite renders them byte for byte and the factory's proves its watcher hears them.
What the factory would refuse — a reject without notes, an answer at a gate, a reject at a question
round — is refused before anything is posted, and so is an answer to a round or subject that has
moved on since the view opened.

The answer view reads the subject from the forge at the commit the question was asked about
(`head_sha`), never the branch tip: the files, which it hashes the factory's way to say whether they
are still what was asked about, or — for a subject the station alone holds, such as the integrate
gate's diff — the forge's comparison of `base_commit` with `head_sha`. Rows that cannot be answered
here stay, disabled, with the reason: a run started from a prompt (no work item), a wait on a pull
request (nothing reads those yet), a subject not on the forge (`worktree.publish: on_integrate`),
a gate being asked at the station's terminal, an answer already given. Keys: `j`/`k` next and
previous, `a` approve (at a question round, take every recommendation), `r` reject.

## The ingest wire

A station sends one session's lines of `events.jsonl`, unchanged, to the backend's **site** origin
(`:3211`, `CONVEX_SITE_ORIGIN`):

```http
POST /ingest
Authorization: Bearer asf_ingest_…
Content-Type: application/json

{"session": "5c0075aa", "events": [{"seq": 1, "ts": "…", "kind": "session_started", "v": 1, "payload": {…}}]}
```

```json
{"acked": 1}
```

- Each event is stored as one document keyed by (factory, session, `seq`). The factory comes from
  the token, never from the body.
- `acked` is the highest `seq` with every `seq` below it stored: what the station resumes after. A
  batch with a gap is stored, and `acked` catches up when the gap is filled.
- A batch holds at most 500 events and 4 MB of payload (one event at most 900 KB); a bigger one is
  refused with `413` and nothing of it is stored. A station sends a backlog as several batches.
- Resending is harmless. A `seq` already stored is skipped, never overwritten, because a `seq` means
  one line forever.
- No event is refused for its kind or version. One this cockpit has no reader for (an unknown kind,
  or a `v` newer than it reads) is stored raw, shown as a generic row, and counted in the "upgrade
  the cockpit" banner. `401` is for a missing or unknown token, and `400` is for a body that is not a
  batch. Neither says anything about the events. A payload is stored as the JSON text it arrived as,
  so no key a factory writes can make an event unstorable.

## Ship from a station

A stamped factory ships on its own once its `.env` (or a CI job's environment) names the cockpit:

```bash
ASF_COCKPIT_URL=http://127.0.0.1:3211      # the site origin, not :3210
ASF_COCKPIT_TOKEN=asf_ingest_…
```

Every `asf run` then ships its session from a background thread as it goes, and `asf station sync`
sends whatever the cockpit has not acknowledged, for every session in the checkout. That is a CI
job's last step, and the way to catch up after the cockpit was down. The station keeps the
acknowledged `seq` per session and resends from there, so nothing is lost while the cockpit is
away. The factory's half is `engine/station.py` in the skill's templates.

A manual smoke test, with the stack up and a token issued:

```bash
cd /path/to/a/stamped/repo                 # fake harness: see tests/asf_helpers.fake_roster
echo "ASF_COCKPIT_URL=http://127.0.0.1:3211" >> .env
echo "ASF_COCKPIT_TOKEN=asf_ingest_…" >> .env
uv run asf/asf.py run quick "add a health check"   # appears on :3000 within seconds
```

## Commands: register a station, and kill from the session page

A station takes commands — the steering the forge cannot carry — once a person approved it. In a
stamped checkout, with `ASF_COCKPIT_URL` and `ASF_COCKPIT_TOKEN` set:

```bash
uv run asf/asf.py station register       # prints a code, and /stations/approve?code=… to open
```

The person opens that page signed in (write on the repository), approves, and the station's next
poll of `POST /station/register/poll` is handed a command token: theirs, for that station alone,
kept as a digest here (`convex/stations.ts`). The link is built from `COCKPIT_APP_URL`, which the
compose file passes to the backend; without it the station names the Stations page instead. A local
cockpit issues its station that token itself (`stations:local`, through `docker compose exec`).

The station loop and every run's own shipper then `POST /commands` every few seconds with it
(`convex/commands.ts`). Each poll says what the station would obey and where its checkout stands,
and is all the liveness there is: a session is attended while its run polls, a station online while
its loop does. A kill queued from the session page goes to the run while it is attended and to the
loop otherwise, waits for an offline station until it expires, and is done only when the station's
`command_result` arrives through `/ingest`. Revoking a token under Stations makes its polls `401`.
The factory's half is `engine/commands.py`.

## Local mode, and the published images

One person with no team deployment gets the same cockpit on their own machine. `asf up` in a stamped
repository, with no `ASF_COCKPIT_URL`, starts it through the stamped `asf/cockpit/compose.yaml`: the
backend, `keygen` and the app, all bound to 127.0.0.1, as one compose project (`asf-cockpit`) shared
by every factory on the machine. The station loop inside `asf up` gets an ingest token from it
(`tokens:issue`, through `docker compose exec`), keeps it in the factory's gitignored
`asf/data/cockpit.json`, and ships every session to it. The Convex dashboard is left out.

Local mode has no sign-in and no App: GitHub cannot deliver a webhook to localhost, and the one
person in front of it is whoever ran `asf up`. So `asf up` hands the cockpit that person's own
`gh auth token` (for `GH_HOST`, else github.com) in the `cockpit` child's environment, the app
container passes it to the backend as it starts, and the catch-up poll is the only way anything is
learned: every repository the token reaches, with ETags. Without a `gh` login the cockpit asks the
forge nothing and lists the factories its stations ship from; `asf doctor` says which it will be.
Every port is bound to 127.0.0.1, which is what stands in for the sign-in. The token is kept where
everything the cockpit knows is kept — in the backend, in the `data` volume on that machine — until
the next `asf up` hands over another, or none; `docker compose -p asf-cockpit down --volumes`
deletes it with the rest.

It runs **published images, not this directory**: a release (`.github/workflows/release.yml`, on a
`vX.Y.Z` tag that matches `.claude-plugin/plugin.json`) builds `ghcr.io/<owner>/asf-cockpit` from
this Dockerfile for amd64 and arm64, and re-tags the Convex backend this compose file pins as
`ghcr.io/<owner>/asf-cockpit-backend`, both with the release's version. A stamp names the oldest
cockpit it ships to in `asf/cockpit/min-version`, and `asf up` runs that version or a newer one that
`ASF_COCKPIT_VERSION` names, never an older one (ADR 0004). A second `asf up` joins a newer cockpit
already running rather than downgrading it. A release refuses to publish when `min-version` names a
cockpit newer than itself. ghcr.io makes a new package private, so set both public after the first
release.

## How the pieces connect

![A stamped repo as a station, the Docker project asf-cockpit with the Next.js app and the Convex backend, and the browser](../../docs/diagrams/local-cockpit-components.svg)

On the left is a stamped repository, a **station**. The watchers, the station loop and the cockpit
child live in the one `asf up` process; a session is its own `asf run` process, and it never talks
to the cockpit: it appends to `events.jsonl`, and the loop sends what lies past the acknowledged
`seq`. On the right is the compose project. The backend has two ports with two jobs: the **site**
(`:3211`) is plain HTTP and takes only `POST /ingest` from stations; the **API** (`:3210`) is what
the app deploys its functions to and what a browser holds a live connection to. The app serves the
pages, and the session data goes from the backend straight to the browser.

![The order of calls between the session directory, the station loop, the Next.js app, the backend and the browser](../../docs/diagrams/local-cockpit-data-flow.svg)

Dashed arrows are replies. At start-up the app deploys its functions with the admin key `keygen`
left in the `keys` volume — after copying the mode, and in local mode the forge token `asf up` gave
its container, into the deployment's environment, which the diagram leaves out — and the loop gets
its ingest token by running `tokens:issue` inside the app container. For each event the loop posts the new lines, the backend stores each `seq` once and
answers with the highest `seq` it holds without a gap, and the loop records that in the session's
`shipped.json`. Against a shared cockpit (`ASF_COCKPIT_URL`) the right-hand side is the team's
deployment: there is no cockpit child and no token step (`ASF_COCKPIT_TOKEN` is the token), every
`asf run` also ships its own session, and the ingest request is the same.

## Develop

```bash
bun install
docker compose up -d backend
printf 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\nCONVEX_URL=http://127.0.0.1:3210\n' \
  "$(docker compose exec -T backend ./generate_admin_key.sh | tail -n 1)" > .env.local
bun x convex env set COCKPIT_MODE local            # no sign-in; leave it unset to work on team mode
gh auth token | bun x convex env set COCKPIT_FORGE_TOKEN   # optional: ask GitHub as yourself
bun x convex dev                 # pushes convex/ on every save, regenerates convex/_generated
bun run dev                      # the app on :3000
```

The whole stack in local mode is `COCKPIT_MODE=local COCKPIT_FORGE_TOKEN="$(gh auth token)" docker
compose up --build`: `docker/start.sh` copies both into the deployment's environment, which is where
a Convex function reads them from.

`bun run typecheck`, `bun run lint` and `bun run test` are what CI runs (`bun run test`, not
`bun test`, which is Bun's own test runner rather than vitest). The tests are `convex-test`
under vitest, and they need no backend: they ingest every fixture in the golden corpus
(`../../tests/golden/events/`, which the factory's pytest suite writes against) and assert what the
sessions list and the session page return. When the factory adds a kind or a version, its fixture
lands there, and this suite fails until `convex/model/session.ts` has a reader for it. That is the
rule from `CLAUDE.md`: the cockpit's reader ships in the same pull request.

The corpus also holds whole sessions (`../../tests/golden/sessions/<name>/`), recorded off the fake
harness by `tests/test_asf_golden_sessions.py`: one line per kind proves a reader exists, but only a
real session proves the session page's story reads right — chapters, what a resume replayed, whose
decision closed which round. `tests/story.test.ts` asserts the story the query tells of each, and
that its Journal view is byte for byte the `journal.md` the factory rendered and the journal every
task prompt in the recording ended with; `tests/sessionview.test.tsx` renders the page itself from
the same session to static markup, with no backend and no browser. A phase opens into its tabs
(Artifacts · Overview · Checks · Tools · Transcript · Cost · Events) through a query of its own,
`sessions:phase`, asked only when someone opens it: `tests/phase.test.ts` says what each tab holds
for the recorded session, `tests/phasetabs.test.tsx` renders every tab of every phase of it, and
`tests/artifacts.test.ts` reads repo artifacts from the fake forge. `tests/inbox.test.ts` drives the inbox
against it — who is permitted, why a row is disabled, the comment posted as whom, the subject at
the pinned commit — and `tests/answer.test.ts` renders the golden answers. `tests/trigger.test.ts`
drives the trigger: the routes found by their golden descriptions, the labels added as whom, and
every refusal, below triage first.

No test talks to GitHub. `tests/forge.ts` is a **fake forge**: GitHub's REST API as far as the
cockpit calls it, in memory, installed as `fetch`. It stands in at the wire rather than behind the
forge interface, so both credentials run their real code against it — the App's JWT is verified
with its key, a user access token lapses after its eight hours, an ETag answers `304`, a spent rate
limit answers `403`. A test arranges people, repositories and installations on it, then drives the
cockpit's public functions.

`convex/_generated/` is committed, so typecheck and tests run on a fresh clone. Regenerate it with
`bun x convex codegen` (or `bun x convex dev`) after changing a function's signature.

## Licence of what it runs on

The Convex backend and dashboard images (`ghcr.io/get-convex/convex-backend`,
`…/convex-dashboard`) are licensed **FSL-1.1-Apache-2.0**. That was confirmed from `LICENSE.md` in
`get-convex/convex-backend` when this app was scaffolded. Its Permitted Purpose covers "your internal
use and access", which is what a team's own cockpit is. It excludes offering the software to others
as a competing commercial product or service. Each version becomes Apache-2.0 two years after its
release. The `convex` npm client used here is Apache-2.0.

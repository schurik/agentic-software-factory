# Changelog

What changed between releases of the agentic-sf skill, and — the part a stamped factory needs —
what to do to a factory stamped by the release before. It lives in the skill directory, not beside
it, so it reaches every install: `npx skills add` copies this directory and nothing above it.

A release is a semver git tag, `vX.Y.Z`, on the commit whose `.claude-plugin/plugin.json` names
`X.Y.Z`. `plugin.json` is the one version source and is bumped in the pull request that cuts the
release, together with its mirrors (`.claude-plugin/marketplace.json` and
`templates/asf/.skill-version`, which a test holds to it) and this file's `Unreleased` heading,
renamed to the version and dated.

The installer stamps that version into the target repo as `asf/.skill-version`: skipped by a
re-run like every stamped file, overwritten by `--force`, never edited by hand. A factory without
one was stamped before 1.1, and `asf doctor` says so; a re-run without `--force` leaves it without
one, because the files it keeps are still the old release's.

Every entry has the same shape: `## X.Y.Z — YYYY-MM-DD`, the date its tag was cut (or
`## Unreleased`), what changed, and an `### Upgrade` section naming the steps from the release
before — `None` when there are none, never omitted.

## Unreleased

- **A session whose branch is checked out elsewhere is refused, in words.** An engineer who
  checked out `asf/<id>` in the main checkout to fix review feedback by hand left that session's
  next run (a `pr-review` the watcher launched, say) dying in `git worktree add` with a raw
  traceback. The run now stops before it touches anything, names where the branch is checked out
  and how to free it, and `asf doctor` — and every run's preflight — warns when the main checkout
  is on a session's branch.

### Upgrade

Re-stamp with `--force` to pick up the refusal and the warning; nothing else changes.

## 1.2.0 — 2026-10-02

The first tagged release, and the first to publish the cockpit images (`asf-cockpit` and
`asf-cockpit-backend` on ghcr.io). 1.1.0 below was never tagged: everything it lists ships here.

- `asf/cockpit/min-version` is **1.2.0**. It named 1.1.0, a cockpit no release ever published, so
  `asf up` from a stamp made before this release pulls an image that does not exist; re-stamping
  fixes it, and so does `ASF_COCKPIT_VERSION=1.2.0` in `.env` until then.
- **The session directory is the record.** The SQLite trace db and the legacy trace UI that read it
  (the skill's `apps/visualizer`) are gone: a run writes its own directory under
  `asf/data/sessions/` and nothing else, and a cockpit receives its events. `asf/data/asf.db` is
  no longer written, and `doctor` no longer checks a trace UI or the db's directory.
- `asf up` has no `obs` child: `--with` is gone, and `--only` names `cockpit`, `issues`, `answers`
  and `prs`. A factory stamped by an older release keeps running its own engine, which drops its
  `obs` child with the warning it always gave once the skill carries no visualizer.
- **`asf sessions`** (`just sessions`) lists the newest sessions from their own `run.json`, and
  `just tail <id>` prints the end of the session's `events.jsonl`. `just phases` and `just obs`
  are gone. A run's closing panel names its session directory where it named the db.
- `observability:` in `asf/factory.yaml` is ignored; `install.py` still names it as obsolete.
- **`worktree.integration.mode: none` is refused** by every command that loads the config —
  `check` and `doctor` included — with what to say instead; `integrate: {mode: none}` in a
  workflow is refused by `check`. It is never remapped: `mode: pr`, with `open_pr: false` to push
  and open nothing; `worktree.publish: on_integrate` to keep a branch off the remote; no
  `integrate` stage in a workflow that should land nothing. `worktree.publish` no longer defaults
  differently under it.
- An agent's `color:` still loads and nothing reads it.
- `ASF_SKILL` stays in `.env`: `just uninstall` and `doctor`'s release comparison find the skill
  through it.

### Upgrade

From 1.1, in this order (`cookbooks/upgrade.md` walks them). Until this release the stamp template
said 1.0.0, so a factory stamped from the repository's main branch records `1.0.0` whatever it
carries: take 1.1.0's steps first, then these.

1. If `asf/factory.yaml` says `worktree.integration.mode: none`, or a workflow says
   `integrate: {mode: none}`, decide what it meant and change it in the same change as the
   re-stamp: from 1.2 nothing runs while it says `none`.
2. Commit, then `install.py --harness <harness> --force` from the target repo root.
3. Delete `observability:` from `asf/factory.yaml`, and the database it placed:
   `asf/data/asf.db` with its `-wal` and `-shm`, or wherever `observability.db` pointed.
4. A justfile the re-stamp kept (the repository's own, or a stamped one that diverged): drop
   `obs` and `phases`, and take `sessions` and `tail` from the fresh stamp.
5. A repository that vendors the skill and once ran `just obs` has
   `<skill>/apps/visualizer/node_modules/` left in its tree, and the ignore file that kept it out
   of `git add -A` went with the visualizer: delete the directory before a commit stage runs.

## 1.1.0

Never tagged, so it has no date: `plugin.json` still named 1.0.0 when 1.2 began, and these changes
first shipped in 1.2.0. Its upgrade steps still apply to a factory stamped from main before then.

- Releases are semver tags, and `plugin.json` is the one version source.
- `install.py` stamps `asf/.skill-version`. `uninstall.py` removes it with the rest of `asf/`.
- **The upgrade path for an old stamp.** `asf doctor` compares the stamp's record with the skill's
  own release (found through `ASF_SKILL`) — `stamped at 1.1.0 · skill is 1.2.0`, or `stamped before
  1.1` when there is none — and warns when the stamp is older, pointing at the skill's new
  `cookbooks/upgrade.md`; it warns the other way too, when the skill checkout is older than the
  stamp. `SKILL.md`'s Startup makes the same comparison and offers that cookbook first. Nothing is
  refused: an old stamp runs as it did.
- `install.py` **lints the `asf/factory.yaml` it keeps** on every re-run, `--force` included, and
  names each obsolete key with its line: `observability:` (ignored from 1.2, can be deleted) and
  `worktree.integration.mode: none` (refused from 1.2: set `pr`). It never refuses to stamp and
  never edits the file.
- A fresh stamp's `asf/factory.yaml` no longer carries `observability:`; the trace db stays where
  that block put it, `asf/data/asf.db`, which is the default without it.
- A checkout is a **station**: a random id kept in `asf/data/station.json` (gitignored with the rest
  of `asf/data/`), a name that defaults to `<login>@<host>:<dir>` (`ASF_STATION_NAME` overrides it)
  and a kind, `ci` under a CI job and `local` otherwise. Every `session_started` names the station.
- With `ASF_COCKPIT_URL` and `ASF_COCKPIT_TOKEN` set, a run (and `approve`, `reject`, `answer`,
  `abort`) ships its session's events to that cockpit from a background thread, from the last seq the
  cockpit acknowledged (kept in the session's `shipped.json`). A cockpit that is down loses nothing,
  and a run never waits on one beyond a bounded flush as it exits. `asf station sync` (`just
  station-sync`) ships every session a cockpit has not acknowledged, and fails only on a refused
  token. Without `ASF_COCKPIT_URL`, a run ships nothing.
- `asf up` is the **station loop**: it holds the station and ships every session on the checkout,
  whichever process wrote it. Its children are `cockpit`, `issues`, `answers` and `prs`, with the
  same restart, backoff and give-up rules as before. `asf station` (`just station`) is the same loop
  without watchers.
- `cockpit` is a **local cockpit**, started only when `ASF_COCKPIT_URL` is unset: the published
  images a team deploys, run through the stamped `asf/cockpit/compose.yaml` on Docker at
  `http://localhost:3000`, one per machine. The station issues itself a token from it (kept in
  `asf/data/cockpit.json`) and ships to it. `asf/cockpit/min-version` names the oldest cockpit this
  release ships to (1.1.0); `ASF_COCKPIT_VERSION` can name a newer one, never an older one. An `up`
  that finds a newer local cockpit already running joins it instead of downgrading it. Without
  Docker, `up` warns, drops the cockpit and runs the watchers.
- The local cockpit asks the forge **as you**: `asf up` hands the `cockpit` child the token `gh auth
  token` prints (for `GH_HOST`, else github.com) in its environment, and the stamped
  `asf/cockpit/compose.yaml` starts the cockpit in local mode with it — no sign-in, every port on
  127.0.0.1. Its Factories page lists every repository that token reaches whose default branch holds
  `asf/factory.yaml`, whether or not a station has reported from it. `up` prints a `forge` line and
  `asf doctor` a `cockpit forge` one; neither shows the token. Without a `gh` login the cockpit
  lists only the factories its stations ship from.
- `obs`, the legacy trace UI, starts only on request: `asf up --with obs`, `--only …,obs`, or
  `just obs`.
- `asf doctor` checks for Docker and names the cockpit version `up` would run, whether its images
  are pulled yet, and a local cockpit already running. It no longer crashes on a machine without `gh`.
- Cutting a release publishes `ghcr.io/schurik/asf-cockpit` and `…/asf-cockpit-backend`, tagged with
  the release's version, and refuses when `asf/cockpit/min-version` is newer than the release.
- A session's events say what a cockpit's session page needs. It reads in **chapters**, one per
  workflow it passes through (`workflow_started`, `workflow_finished`); a `--resume` continues its
  workflow's chapter (`session_resumed`) and names each agent phase it answered from the record
  (`phase_replayed`). `phase_started` is at version 2: an agent phase names its task file and the
  digest of the prompt it was sent. `artifact_written` carries a handoff file inline (cut at 256 KB,
  and it says so) or names a repo file, and `committed` names the sha that landed it. `tool_called`
  is a tool's name, outcome and duration, never its arguments or its result.
- **Transcripts are opt-in.** With `cockpit: {transcripts: true}` in `asf/factory.yaml`, a session
  also writes every prompt its agents were sent (`prompt_rendered`) and the harness's raw output in
  chunks (`harness_output`). Without it, neither is ever written.
- **Transcripts age out; bodies can be purged.** A cockpit keeps a finished session's transcript for
  30 days — its operator's `COCKPIT_TRANSCRIPT_DAYS`, or on a local cockpit `ASF_COCKPIT_TRANSCRIPT_DAYS`
  in `.env` — then replaces each transcript event's body with a `pruned` marker, keeping the event,
  and its Transcript tab says "transcript aged out on <date>". `transcript_retention_days` under
  `cockpit:` in `asf/factory.yaml` can only shorten that; `check` refuses a value that is not a whole
  number of days from 1. `session_started` is **v3**: it carries the retention the process ran under.
  A repository's admin can purge one session's bodies (artifact contents, command output, the
  transcript) from the cockpit, and an owner of its account the whole factory's — or the deployment,
  with `retention:purgeFactoryFromDeployment` — each with an audit line. Core events, and so cost,
  are never purged, and nothing is purged on its own.
- A stage that commits does it through `run.commit(ph.phase, message)`, which is what appends
  `committed`.
- The write boundary reads paths as they are on disk. A file whose name git would quote (any
  non-ASCII name) is no longer refused inside an agent's `writes:`, and one outside it is really
  rolled back. A file moved with `git mv` out of an allowed directory is now a breach at the path
  it landed on.
- A breach undoes what an agent STAGED, too. A new file it ran `git add` on leaves the index as
  well as the disk, and a staged edit or `git rm` of a tracked file is restored from `HEAD`; before,
  each was reported as rolled back and left for the next commit stage to land.
- The claude_code harness's shipped `safe_mode` default is now `false`: a fresh install runs with
  your `CLAUDE.md`, skills, plugins, hooks and MCP servers available, same as an interactive
  session. Turn it on in `asf/factory.yaml` for a run that must not depend on whose machine ran it.
- **`worktree.publish: on_create | on_integrate`** says when a session's branch first reaches the
  remote. Unset, it is `on_create` once a cockpit is configured (`ASF_COCKPIT_URL`, or a local
  cockpit that has issued this factory a token) and `on_integrate` without one — and always
  `on_integrate` under `integration.mode: none`. `asf doctor` prints the value in force and why.
- Under `on_create` the branch is pushed as the session starts, together with the commit it is cut
  from (so commits the base branch has not pushed go with it, on the session's branch), and again
  before every suspend — after committing what the gate asks about, in the producing agent's own
  `commit_message`. `head_sha` in `suspended` is therefore a commit the remote has, with the
  subject in its tree. A push the remote refuses refuses the run, before a branch or a worktree
  exists; with no remote of that name the run starts and `doctor` warns.
- A branch published that way and never integrated is **deleted from the remote** when its session
  is aborted or finishes accepted; the local branch is kept. A failed session keeps its remote
  branch, so `resume` works. A branch with a pull request, one an integration (or a person)
  pushed with `-u`, or one whose commits were merged into its base branch is never deleted. A pull
  request opened on the forge while its session was still working is not something the factory
  can see: finishing or aborting that session deletes the branch under it.
- `keep_published` no longer sets the branch's upstream: tracking the remote branch is how a
  session records that it was proposed.
- **`worktree.integration.mode: none` warns** wherever the config is loaded, and `asf doctor`
  lists it; `integrate: {mode: none}` in a workflow warns in `asf check`. Both still work in this
  release and are refused in 1.2. A stage may now declare `warn(opts)` for exactly this.
- **A gate on a tracked issue is answerable there.** The answers watcher hears a reply whose first
  line is a verdict — `/approve`, `/reject <what should change>`, `/abort` — at a gate, and at a
  question round too, where any other reply is still an answer; at a gate any other reply is
  discussion. A reply that names what it answers (`<!-- asf:answer adw=… gate=… round=… digest=…
  -->`, which a cockpit's inbox adds) is ignored once the run has moved past that round or subject.
- `suspended` is **v2**: it says whether the subject reached the forge (`published`), carries a
  question round's `questions`, and names whose reply on the wait's channel the factory will hear
  (`trusted`: `issues.trusted_authors` on an issue, empty for anyone). A cockpit's **inbox** offers
  the answer to those people only, and posts it as the person signed in.
- **A run records who triggered it**, as `triggered_by` in `run.json` and on `session_started`: for
  an issue the watcher dequeued, whoever last applied its route or queued label (read from the
  issue's `labeled` events through the new `issues.labeller_command`, `gh api graphql` by default;
  empty records nobody); for a session the review watcher starts, nobody; for any other run, the
  operator's forge login as `gh config get -h <host> user` reads it — no network — else
  `GITHUB_ACTOR` in a GitHub Actions job, else `ENGINEER_NAME` / git's `user.name`. The session's
  first process records it and every later one keeps it: answering, resuming or joining is not
  triggering. It authorizes nothing; `trusted_authors` keeps its meaning.
- `provenance_recorded` is **v2**: an issue run also says who wrote the issue and whom it was
  assigned to. A cockpit's inbox marks and sorts first what is **for you** — a run you triggered, an
  issue you wrote, an issue assigned to you — and hides nothing else you may answer.
- A cockpit can **trigger** a workflow on an issue from the Factories page: it adds the route and
  queued labels as you, from triage up, and refuses an issue already queued or one a run already
  has. It finds those labels by the descriptions `asf labels --create` writes (route, queued and
  running), which are now a contract (`tests/golden/labels/`).
- **Stations take commands.** `asf station register` (`just station-register`) asks a shared
  cockpit for a code, prints where to approve it, and keeps the command token a signed-in writer's
  approval issues — theirs, for this station alone — in `asf/data/station-token.json`. A local
  cockpit's station is its owner's without approving anything; a CI station never takes commands.
  Revoking a station's token in the cockpit (Stations) stops every command reaching it.
- The station loop, and every run's own shipper, poll the cockpit for commands every few seconds,
  and each poll reports the verbs the station obeys, the commit it has out, a hash of `asf/` and the
  watchers it runs. Those polls are how a cockpit knows a session is **attended** and a station
  **online**; the session page shows both, with when it was last seen.
- `cockpit.commands` in `asf/factory.yaml` opts verbs in, from `answer`, `abort`, `kill`, `resume`
  and `run`; a fresh stamp lists `[answer, abort, kill, resume]`, and `run` is off unless listed. A
  station refuses a verb that is not listed, a command whose `by` fails `issues.trusted_authors`,
  and one past its expiry; it records each outcome in `asf/data/commands/<id>.json`, so a command
  delivered twice acts once, and reports it as a `command_result` — the cockpit's only source for
  "done". A result with no session of the station's to travel in (a `run`'s) goes back with the
  station's next poll, as the same payload.
- **Kill from the session page.** A running session's kill goes to the run itself while it is
  attended — it stops through its own SIGTERM handler, children first — and to the station loop
  otherwise; a station that is offline gets it when it is back, until it expires (minutes). The
  button is disabled, with the reason, for a reader, for a station nobody registered, and for one
  whose report says it does not take `kill`.
- **Resume from the session page.** A failed session's resume goes only to the station that holds
  it, which relaunches it detached through `asf resume` — refused, in `asf resume`'s own words, for
  a session still running or waiting on an unanswered gate. A session that ran in CI is disabled:
  "ran in CI: re-trigger from the forge". `session_started` is **v2**: it carries `station_kind`,
  which is how a cockpit tells.
- **A gate on no work item is answerable from the inbox.** A prompt run's gate (the terminal
  channel) is answered by command: `answer` carries approve, reject or a question round's answers,
  `abort` ends the run, each opted in on its own. The station refuses an answer whose gate, round or
  subject digest the session is past, or whose round already has a decision, and one for a gate on
  any other channel — an issue's is answered on the issue; otherwise it records the decision as the person's (`channel: cockpit`) and relaunches
  the run, or leaves it to a run asking in place, which takes it at once.
- **Run a prompt workflow from the cockpit** (`/run`, linked from Stations), off by default. A run
  goes only to one of the asking person's own stations — their most recently seen, or another of
  theirs they pick — and the station takes it only from the person it is registered to. It starts
  `asf run <workflow> <prompt>` detached and unattended, recorded as triggered by that person,
  after checking the workflow takes a prompt.
- **Claims: a shared cockpit decides which station starts a work item** (ADR 0003). The forge
  label is not a lock — two watchers that listed the same queued issue both flip it — so with
  `ASF_COCKPIT_URL` set, the issues watcher, the pull-request watcher and `asf run <workflow>
  <number>` each ask the cockpit for a claim on the item before they touch a label, and exactly one
  station is granted it; the others leave it as it is and say who holds it. `asf run … --force`
  starts a run by hand without asking. A claim is held until its session finishes or is aborted,
  and kept when it fails (so `asf resume` still works) and while its station is offline; a station
  gives back only a claim no session used (its label would not flip, or its run never started). A
  writer frees one on the session page with **Release claim**, which relabels the item
  `asf:queued` (a pull request loses `asf:pr-failed`) as them, abandons the session, and keeps who
  did it. A resume asks too, and is refused for a session a writer abandoned — so it cannot carry
  on beside the run that took its item afresh — but goes on when the cockpit does not answer, since
  its session holds the claim already. Without a shared cockpit there are no claims, and `asf issues once|loop` warns as it
  starts that only one issues watcher per repository is safe; a shared cockpit too old to grant
  claims is treated the same, and said once.
- A watcher that holds a claim launches its run as the session the claim names (`--adw-id`), and
  tells it so (`ASF_CLAIMED`), so the run does not ask again.
- Each verb waits for an offline station as long as its TTL — kill 5 minutes, run 15, resume an
  hour, an answer or abort 7 days — showing "queued, station offline" until then, and the cockpit
  expires what nobody took every minute.
- **The factory describes itself**: `asf check --json` prints its **self-description** — every
  workflow's purpose, trigger (route labels, and whether a watcher launches it), stage chain, the
  agents it binds with their `tools` and `writes`, its gates and whether each is on — plus the
  per-session budget, the skill version, and the checkout it checked (HEAD, branch, and the hash
  over `asf/` a station's report carries). It has its own format version (`SelfDescription.FORMAT`)
  and a golden fixture per version under `tests/golden/self-description/`. A workflow that does not
  load is listed under `problems`, the others are still described, and the exit code is `check`'s.
  `--ship` sends it to `ASF_COCKPIT_URL` with the ingest token as a CI station; it fails only on a
  refused token, and ships nothing without a token (a fork's pull request) or outside CI — the
  default branch's description is what stations' drift is measured against.
- A stage may name the gate it places (`GATE`, and `GATE_KIND = "questions"` for a question round):
  `plan`, `integrate` and `refine` do, and the self-description shows them.
- **An optional CI workflow**: `install.py --ci` (or yes when asked on a terminal) stamps
  `.github/workflows/asf-check.yml`, which runs `asf check --json --ship` on every pull request and
  default-branch push — a normal check on the pull request, and the description shipped to the
  cockpit as a CI station. A re-run keeps it, `--force` refreshes it once it is there, `--no-ci`
  neither asks nor stamps, and `uninstall.py` removes it unless it changed.
- The cockpit's **Factory page** (`/factories/<owner>/<repo>`, linked from Factories): a header with
  the repository, the default branch's commit, the check's state, flags and Run a prompt; a
  **Workflows** tab rendered from the self-description (with Run in place for a prompt workflow and
  the configured budget); and a read-only **Config** tab — the files under `asf/` on the default
  branch, the check's result, and each station's drift from it ("3 commits behind", "local edits")
  from the HEAD and config hash its polls report. A factory with no CI workflow is "unchecked", not
  broken. A local cockpit with one factory opens straight onto its page.
- **Config edits become pull requests opened as the person**: a writer edits the files under `asf/`
  as text in the Config tab, with a diff preview, and the cockpit commits exactly what was typed —
  comments included — on a `cockpit/<login>/<slug>` branch and opens the pull request into the
  default branch as them, with a body saying where it came from. It checks YAML syntax only and
  blocks the submit with the parse error; the repository's CI and branch protection do the rest.
  Disabled, with the reason, below write.
- The cockpit's **Factories list** ranks what needs attention first, then the most recently active,
  with an A–Z toggle. Each row shows live sessions, gates waiting (on you / in all), stations
  online of all, spend in a calendar period of your own timezone (today, this week, or this month
  by default; list-price equivalent, tokens alongside), and flags for a fresh failure, a claim whose
  station has been offline over a day, drift, a failing check and nobody watching.
- The cockpit's **Sessions** page, and a Factory page's **Sessions** tab: every session as one table,
  narrowed by workflow, person (who triggered the run), station (every CI job as one CI entry),
  status and a calendar period of your own timezone. Across factories it shows only the factories
  you can read, and names each row's factory.
- The cockpit's **Cost** page, and a Cost tab on each Factory page, roll spend up by session,
  workflow, factory, station (whose machine and key paid, named with its owner) and person (who
  triggered the run), over today, this week or this month in your own timezone, or a range of days
  — list-price equivalent, tokens alongside. Each agent call is charged to the workflow, station and
  person current when it was made. A session page shows its spend against the per-session `budget:`
  ceiling the factory's self-description names; no per-period or per-factory budget appears anywhere.

### Upgrade

None required: a factory without `asf/.skill-version` runs exactly as it did, and `asf doctor`
names it `stamped before 1.1`. A plain re-run of `install.py` does not change that — it keeps every
file that exists, so they are still the old release's. The version is recorded by the run that
refreshes them: commit, then `install.py --harness <harness> --force` from the target repo root, and
put back any agent prose or task you had edited (`asf/factory.yaml` is never overwritten; a fresh
render lands beside it as `.new`). `cookbooks/upgrade.md` walks the steps below in order, one
decision at a time; `observability:` can be deleted from `asf/factory.yaml` unless it moved the
trace db.

To ship to a cockpit, the same `--force` re-stamp brings the engine and the `station-sync` recipe;
then add `ASF_COCKPIT_URL` and `ASF_COCKPIT_TOKEN` to `.env` by hand, because the installer never
rewrites an existing `.env` (a re-stamped `.env.sample` names both). A CI job that ships ends with
`uv run asf/asf.py station sync`, with both set from the job's secrets.

To steer runs from a cockpit, add `commands: [answer, abort, kill, resume]` under `cockpit:` in
`asf/factory.yaml` (a `--force` re-stamp never edits it; the `.new` beside it shows the block), and
`run` too if people may start prompt workflows on their own stations from it; commit it, and run
`asf station register` once per checkout against a shared cockpit; a local cockpit needs no
registering. Nothing is obeyed until then.

The same `--force` re-stamp brings `asf/cockpit/` and the station loop. After it, `just up` starts
a local cockpit unless `.env` names a shared one; install Docker for it, or accept the warning. The
trace UI no longer starts with `up`: use `just obs`, or `just up --with obs`, if you still want it.
That cockpit is given your `gh auth token` to ask the forge with, and keeps it in its own backend
on this machine: run `gh auth login` first for a Factories page that knows your repositories, or
leave `gh` logged out to hand it nothing.

The same re-stamp brings the new events; a session started before it keeps its events and gains
chapters from its next run. Transcripts stay off: to send them, add `cockpit: {transcripts: true}`
to `asf/factory.yaml` by hand (the installer never rewrites that file; the `.new` beside it shows
the block). A stage of your own that calls `git_helper.commit_all` still commits, but says nothing
to a cockpit until it calls `run.commit(ph.phase, message)` instead. A cockpit keeps a transcript
for 30 days after its session finishes; to keep it for less, add `transcript_retention_days: <days>`
under `cockpit:` by hand. A session started before the re-stamp is kept for the cockpit's maximum.
A team's cockpit whose GitHub App was registered before this release cannot tell an organization's
owners, so purging a whole factory from it is refused until the App is granted *Organization
permissions → Members: read* in its settings on GitHub and the installation accepts it; the
deployment's CLI purges a factory without it.

Once a cockpit is configured, a re-stamped factory pushes each session's branch as it is created. To
keep branches on the machine until they are integrated, add `publish: on_integrate` under
`worktree:` in `asf/factory.yaml` (the `.new` beside it shows the key); the cockpit then cannot
show what those sessions' gates ask about. If `factory.yaml` says `integration: {mode:
none}`, nothing changes yet, but every command warns: before 1.2, either remove the `integrate`
stage from the workflows that should land nothing, or switch to `mode: pr` (with `open_pr: false`
to push a branch and open nothing) and set `worktree.publish` to say when it is pushed.

Gates answered on the work item and the inbox come with the same `--force` re-stamp: `just answers`
(or `just up`) then hears `/approve`, `/reject …` and `/abort` replies. A reply whose first line
already began that way was discussion before and is a verdict now.

Claims come with the same `--force` re-stamp and need nothing in `asf/factory.yaml`; they apply
once `ASF_COCKPIT_URL` names a shared cockpit new enough to grant them — upgrade the team's cockpit
first. From then on a failed issue run keeps its claim: requeueing the issue by hand no longer
starts it again on another station — resume the session, or Release claim in the cockpit, which
requeues it. Without a shared cockpit, run one issues watcher per repository.

Who triggered a run comes with the same re-stamp, and needs nothing in `asf/factory.yaml`: the
default `issues.labeller_command` applies without the key (the `.new` beside it shows it). Set it
to `[]` on a tracker that is not the forge. Sessions started before keep an empty `triggered_by`.
For the cockpit's Trigger button, run `just labels --create` once more if your route and queued
labels were made by hand: it creates only missing labels, so give an existing one its description
on the forge (`gh label edit <name> --description …`, the text `just labels` would have written).

To have the cockpit show a factory's workflows and measure its stations' drift, re-stamp with
`install.py --harness <harness> --force --ci` (the engine brings `check --json`; `--ci` stamps the
workflow), commit `.github/workflows/asf-check.yml`, and set `vars.ASF_COCKPIT_URL` and
`secrets.ASF_COCKPIT_TOKEN` (the factory's ingest token) on the repository. The shared cockpit must
be this release's or newer: an older one answers the push with a 404, which the job reports and
passes. A stage of your own that places a gate may add `GATE = "<the gate's name>"` to show it.

## 1.0.0

The version `plugin.json` named before there were releases. It was never tagged, so it has no
date. A factory stamped before `asf/.skill-version` existed records nothing, and counts as before
1.1.

### Upgrade

None — there is no earlier release.

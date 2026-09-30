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

- Releases are semver tags, and `plugin.json` is the one version source.
- `install.py` stamps `asf/.skill-version`; `asf doctor` prints it, or `before 1.1` when a factory
  has none. `uninstall.py` removes it with the rest of `asf/`.
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
- A stage that commits does it through `run.commit(ph.phase, message)`, which is what appends
  `committed`.
- The write boundary reads paths as they are on disk. A file whose name git would quote (any
  non-ASCII name) is no longer refused inside an agent's `writes:`, and one outside it is really
  rolled back. A file moved with `git mv` out of an allowed directory is now a breach at the path
  it landed on.
- A breach undoes what an agent STAGED, too. A new file it ran `git add` on leaves the index as
  well as the disk, and a staged edit or `git rm` of a tracked file is restored from `HEAD`; before,
  each was reported as rolled back and left for the next commit stage to land.
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

### Upgrade

None required: a factory without `asf/.skill-version` runs exactly as it did, and `asf doctor`
names it `before 1.1`. A plain re-run of `install.py` does not change that — it keeps every file
that exists, so they are still the old release's. The version is recorded by the run that refreshes
them: commit, then `install.py --harness <harness> --force` from the target repo root, and put back
any agent prose or task you had edited (`asf/factory.yaml` is never overwritten; a fresh render
lands beside it as `.new`).

To ship to a cockpit, the same `--force` re-stamp brings the engine and the `station-sync` recipe;
then add `ASF_COCKPIT_URL` and `ASF_COCKPIT_TOKEN` to `.env` by hand, because the installer never
rewrites an existing `.env` (a re-stamped `.env.sample` names both). A CI job that ships ends with
`uv run asf/asf.py station sync`, with both set from the job's secrets.

The same `--force` re-stamp brings `asf/cockpit/` and the station loop. After it, `just up` starts
a local cockpit unless `.env` names a shared one; install Docker for it, or accept the warning. The
trace UI no longer starts with `up`: use `just obs`, or `just up --with obs`, if you still want it.

The same re-stamp brings the new events; a session started before it keeps its events and gains
chapters from its next run. Transcripts stay off: to send them, add `cockpit: {transcripts: true}`
to `asf/factory.yaml` by hand (the installer never rewrites that file; the `.new` beside it shows
the block). A stage of your own that calls `git_helper.commit_all` still commits, but says nothing
to a cockpit until it calls `run.commit(ph.phase, message)` instead.

Once a cockpit is configured, a re-stamped factory pushes each session's branch as it is created. To
keep branches on the machine until they are integrated, add `publish: on_integrate` under
`worktree:` in `asf/factory.yaml` (the `.new` beside it shows the key); the cockpit then cannot
show what those sessions' gates ask about. If `factory.yaml` says `integration: {mode:
none}`, nothing changes yet, but every command warns: before 1.2, either remove the `integrate`
stage from the workflows that should land nothing, or switch to `mode: pr` (with `open_pr: false`
to push a branch and open nothing) and set `worktree.publish` to say when it is pushed.

## 1.0.0

The version `plugin.json` named before there were releases. It was never tagged, so it has no
date. A factory stamped before `asf/.skill-version` existed records nothing, and counts as before
1.1.

### Upgrade

None — there is no earlier release.

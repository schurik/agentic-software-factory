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
  token. Without `ASF_COCKPIT_URL`, nothing is shipped.

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

## 1.0.0

The version `plugin.json` named before there were releases. It was never tagged, so it has no
date. A factory stamped before `asf/.skill-version` existed records nothing, and counts as before
1.1.

### Upgrade

None — there is no earlier release.

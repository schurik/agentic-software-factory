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
one was stamped before 1.1, and `asf doctor` says so.

Every entry has the same shape: `## X.Y.Z — YYYY-MM-DD` (or `## Unreleased`), what changed, and an
`### Upgrade` section naming the steps from the release before — `none` when there are none, never
omitted.

## Unreleased

- Releases are semver tags, and `plugin.json` is the one version source.
- `install.py` stamps `asf/.skill-version`; `asf doctor` prints it, or `before 1.1` when a factory
  has none. `uninstall.py` removes it with the rest of `asf/`.

### Upgrade

None required: a factory without `asf/.skill-version` runs exactly as it did. To record the
version, re-run `install.py --harness <harness>` from the target repo root without `--force` — it
stamps the files that are missing, this one included, and leaves every file that exists alone.

## 1.0.0

The version `plugin.json` named before there were releases. It was never tagged; every factory
stamped from it has no `asf/.skill-version`, and counts as before 1.1.

### Upgrade

None — there is no earlier release.

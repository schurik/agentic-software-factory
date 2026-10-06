# Upgrade

Walk a stamped factory forward to the release this skill is. Reached from
Startup, when `asf/.skill-version` is missing or older than
`<skill>/templates/asf/.skill-version`, and whenever `just doctor` prints
`skill version  stamped at X · skill is Y` with this cookbook as its fix.

**An old stamp is never refused.** It keeps running exactly as it did, so
nothing here is urgent and nothing here is yours to do unasked: say what the
two versions are, offer the upgrade, and do it when the engineer says so. The
one thing a re-stamp can refuse is its own config: from 1.2 a config saying
`worktree.integration.mode: none` stops every command until it says something
else — so settle that one (below) in the same change. A
missing `asf/.skill-version` means "stamped before 1.1" — older than any
release that records one.

Stamp **newer** than the skill? Stop. The skill checkout is the one left
behind: update it, never stamp from it — `--force` from an older skill stamps
older code over newer.

## Why `--force` alone is not the upgrade

`install.py --force` refreshes the code, the recipes and the record. It cannot
do the rest, by design:

- **It never rewrites `asf/factory.yaml`**, the file the repository owns. A
  fresh render lands beside it as `asf/factory.yaml.new`, and every key a
  release added stays unset in the real one — so a feature that needs one
  (`cockpit.commands`, say) arrives in the code and stays off.
- **It overwrites what you edited** under what it stamps: the starter agents'
  prose, the shipped workflows and their task files, `asf/engine/quality.py`
  (re-detected), a stamped `justfile`.
- **It cannot approve anything for anyone.** Registering a station with a
  shared cockpit is a person's approval, signed in.

A plain re-run, without `--force`, does none of it: it stamps only the files a
release added, keeps every one that exists, and so leaves the record saying
what the rest still is. That is not an upgrade.

## Before: what is changing, and what is in flight

1. **Read the steps.** `<skill>/CHANGELOG.md` — every `### Upgrade` section
   after the stamp's release ([CHANGELOG.md](../CHANGELOG.md); all of them up
   to the current one for a stamp before 1.1). This cookbook is the order to
   take them in; the changelog is what each one says.
2. **A clean tree.** `git status` — commit the engineer's own work first. The re-stamp is reviewed as one diff, and a diff mixed with theirs
   cannot be.
3. **Which harness.** `defaults.harness` in `asf/factory.yaml`. Pass that one
   to `--harness`; another would stamp another roster's prompts.
4. **Nothing mid-flight.** `just status` and `just pending`. Stop `just up`
   (ctrl-c where it runs). A run still working would carry on in code that
   changed under it: let it finish, or `just kill <id>` with the engineer's
   say-so. A session waiting at a gate is fine — it resumes in the new code.

## Re-stamp

```bash
uv run <skill>/scripts/install.py --harness <harness> --force
```

From the **target repo root**. Read three things in what it prints:

- the version line — `skill version <X>  (asf/.skill-version)`: the record is
  now the skill's release;
- `YOUR CONFIG WAS NOT TOUCHED` — where the fresh render landed
  (`asf/factory.yaml.new`);
- `YOUR CONFIG NAMES OBSOLETE KEYS` — each key the operator's config still
  says that a release dropped, with its line and what to do. The stamp was not
  refused for them; `mode: none` will be, by the code it just stamped.

## Put back what was yours

`git diff --stat` over `asf/`, `justfile` and `.github/`, then file by file:

- **`asf/engine/quality.py`** — re-detected from the repo, so a command
  written by hand is gone. Restore those lines from the diff; keep what the new
  file adds.
- **Agent prose** (`asf/agents/<name>/agent.md`) and **task files** under the
  shipped workflows — re-apply the edits rather than reverting the file: a
  release may have changed a task's `## Report` block, and `just check` refuses
  a report block that drifted from its envelope.
- A workflow, agent or stage of the repository's own (a name the skill does not
  ship) was never touched.

## The config: one decision at a time

`diff asf/factory.yaml asf/factory.yaml.new` shows what a fresh stamp would say.
Most new keys have defaults that apply without them — the `.new` shows them, and
nothing needs copying. These do not, and each is the repository's call: put each
to the engineer with what it does, and edit `asf/factory.yaml` with their answer.

1. **`observability:`** — obsolete and ignored since 1.2: delete it. The
   database it placed is no longer written; the file it names (by default
   `asf/data/asf.db`, with its `-wal` and `-shm`) can be deleted too.
2. **`worktree.integration.mode: none`** (or `integration: {mode: none}`) —
   refused since 1.2 (it warned in 1.1), and never remapped for them, because
   `none` did two jobs. Ask which was meant:
   - *land nothing* → `mode: pr`, and drop the `integrate` stage from the
     workflows that should land nothing;
   - *push nothing* → `mode: pr` and `worktree.publish: on_integrate`;
   - *push, open no pull request* → `mode: pr` and `open_pr: false`.
   A workflow's own `integrate: {mode: none}` is the same question; `just check`
   names each one.
3. **`worktree.publish`** — unset, it follows the cockpit: `on_create` once one
   is configured (a session's branch is pushed as it starts and before every
   gate, so the cockpit can show what the gate asks about, and deleted from the
   remote when the session finishes unintegrated), `on_integrate` without one.
   Leaving it unset is a fine answer; `on_integrate` keeps branches local at the
   price of gates the cockpit cannot show.
4. **`cockpit.commands`** — without it a station obeys **no** command a cockpit
   sends: no kill, no resume, no answering a prompt run's gate from the inbox.
   A fresh stamp lists `commands: [answer, abort, kill, resume]` under
   `cockpit:`; `run` (starting prompt workflows from the cockpit) is off unless
   listed. Opting a verb in is the repository's decision, made in this reviewed
   file — never add one on the engineer's behalf.
5. **`cockpit.transcripts`** — off unless the file says `true`. It sends every
   prompt and the harness's raw output, tool arguments and results included:
   say so before they choose, and never turn it on for them.

Then delete `asf/factory.yaml.new` — it was a proposal, and leaving it is how
the next `--force` writes over the one they read.

## Outside the config

- **`.env`** is never rewritten: compare it with the re-stamped `.env.sample`.
  A shared cockpit needs `ASF_COCKPIT_URL` added by hand, and nothing else: the
  ingest token comes with registering ([connect_cockpit.md](connect_cockpit.md));
  a local cockpit needs neither.
- **A local cockpit** (no `ASF_COCKPIT_URL`) needs Docker with compose; `just
  up` starts it and warns without it. It asks the forge with the engineer's
  `gh auth token`, which `up` hands to the container — say so before the first
  `up`.
- **Station registration** — only against a **shared** cockpit, once per
  checkout: `just station-register`, as [connect_cockpit.md](connect_cockpit.md)
  walks it. It is a person's to approve, never yours. A local cockpit's station is its owner's already; a CI
  station takes no commands.
- **Labels** — `just labels`, then `just labels --create` for any a release
  added. It creates only missing labels; a route or queued label made by hand
  needs its description set on the forge for the cockpit's Trigger button to
  find it (`just labels` shows the text).
- **The optional CI check** — `install.py --harness <harness> --force --ci`
  stamps `.github/workflows/asf-check.yml`. A repository's CI is its own: ask.
- **A justfile that was kept** (the repository's own, or a stamped one that
  diverged) may still carry `obs`, `phases` and a `sessions` or `tail` that
  read the old database. They are gone since 1.2: `just sessions` and `just
  tail` read each session's own record now — copy those two from the fresh
  stamp, and drop the rest.
- **A vendored skill** (`.agents/skills/agentic-sf/` or the like) that once ran
  `just obs` holds `apps/visualizer/node_modules/` in the repository's tree,
  and the ignore file that kept it out of `git add -A` left with the
  visualizer in 1.2: delete that directory before a commit stage runs.

## Done when

```bash
just doctor
```

prints `skill version  stamped at <Y> · skill is <Y>` with a ✓ — it refuses to
run at all while the config says `integration: none` — and every workflow
checked. Commit the lot as one change, so the
upgrade is one diff in the history — `asf: upgrade the factory to <Y>`.

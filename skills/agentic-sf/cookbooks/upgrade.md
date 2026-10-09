# Upgrade

Walk a stamped factory forward to the release this skill is. Reached from
Startup, when `asf/.skill-version` is missing or older than
`<skill>/templates/asf/.skill-version`, and whenever `just doctor` prints
`skill version  stamped at X · skill is Y` with this cookbook as its fix.

**An old stamp is never refused.** It keeps running exactly as it did, so
nothing here is urgent and nothing here is yours to do unasked: say what the
two versions are, offer the upgrade with the question tool (**Upgrade now** ·
**Not now**; [SKILL.md § Asking the person](../SKILL.md#asking-the-person)),
and do it when the engineer says so. The
one thing a re-stamp can refuse is its own config: from 1.2 a config saying
`worktree.integration.mode: none` stops every command until it says something
else — so settle that one (below) in the same change. A
missing `asf/.skill-version` means "stamped before 1.1" — older than any
release that records one.

Stamp **newer** than the skill? Stop. The skill checkout is the one left
behind: [update it](#update-the-skill-first), never stamp from it — `--force`
from an older skill stamps older code over newer.

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

## Update the skill first

`--force` stamps whatever `<skill>` holds, so a stale copy stamps the old
engine back, and nothing says so: between releases a stale copy and the source
carry the same `.skill-version`, `just doctor` passes, and this cookbook is
never reached. Update the copy, check that it moved, and only then read on —
from the updated copy, since this cookbook and the changelog may have changed
with it.

**Which copy `<skill>` is** — the directory this cookbook sits in, and the
one `ASF_SKILL` in `.env` names, whichever kind it is:

- **vendored** — `.agents/skills/agentic-sf/` in the repository (with
  `.claude/skills/agentic-sf` a link to it), or `~/.agents/skills/agentic-sf/`
  for every project. The `skills` CLI put it there and records it in
  `skills-lock.json`.
- **a checkout** — a git clone of this skill's repository, outside the
  target repository.
- **the Claude Code plugin** — under `~/.claude/plugins/cache/`.

**Vendored**: from the repository root, and with `-g` added for the copy in
the home directory —

```bash
npx skills add schurik/agentic-software-factory --skill agentic-sf --agent claude-code pi -y
```

Two agents, on purpose. When every agent named shares one skills directory,
`skills` copies instead of linking: `--agent claude-code` by itself writes a
real directory over the `.claude/skills/agentic-sf` link, and every agent that
reads `.agents/skills/` (pi, Codex, Cursor, opencode…) keeps the stale copy.
pi reads `.agents/skills/` itself, so naming it makes the CLI write there and
link Claude Code to it. The same command mends a repository whose link was
already replaced, and it leaves an Eve agent's copy alone.

**Not `npx skills update`** in a repository the CLI sees Eve in — an `agent/`
directory and `eve` in `package.json`. It re-runs `skills add -y` without
naming an agent, and `-y` with Eve present installs for Eve alone, into
`agent/skills/agentic-sf/`. It then writes the new hash into
`skills-lock.json`, so `.agents/skills/` stays as it was and every `update`
after it says the skill is up to date.

**A checkout**: `git -C <skill> pull`.

**The plugin**: `claude plugin marketplace update agentic-sf`, then `claude
plugin update agentic-sf@agentic-sf`, then restart Claude Code — the session
holds the old copy until then. The update lands in a new directory beside the
old one, so `<skill>` is now that one: point `ASF_SKILL` in `.env` at it
(`install.py` never rewrites a value already there).

**Check it moved — by its files, not its version.** `.skill-version` moves at
a release, not between them.

- Vendored in the repository: `git status --short -- .agents/skills/agentic-sf`
  lists what the update changed, and `readlink .claude/skills/agentic-sf`
  prints `../../.agents/skills/agentic-sf` — a link, not a directory. A new
  `agent/skills/` in `git status` is an `update` that wrote Eve's copy instead.
- A checkout: `git -C <skill> log -1 --oneline` is the commit you meant to
  stamp from.
- Whatever the kind, the change you are upgrading for is in the files: grep
  `<skill>/templates/` for something it added. Absent, the copy is stale —
  stamp nothing from it.

A copy vendored in the repository is part of its tree. With the engineer's own
work committed first, commit the update on its own (the `.agents/skills/`
directory, the `.claude/skills/` link and `skills-lock.json`) —
`skills: update agentic-sf` — so the tree is clean for the next step and the
re-stamp is reviewed as a diff of its own.

## Before: what is changing, and what is in flight

1. **Read the steps.** `<skill>/CHANGELOG.md` — every `### Upgrade` section
   after the stamp's release ([CHANGELOG.md](../CHANGELOG.md); all of them up
   to the current one for a stamp before 1.1). This cookbook is the order to
   take them in; the changelog is what each one says.
2. **A clean tree.** `git status` — commit the engineer's own work first. The re-stamp is reviewed as one diff, and a diff mixed with theirs
   cannot be.
3. **Which harness.** `harness.name` in `asf/factory.yaml` (`defaults.harness`
   before 1.3). Pass that one
   to `--harness`; another would stamp another roster's prompts.
4. **Nothing mid-flight.** `just status` and `just pending`. Stop `just up`
   (ctrl-c where it runs). A run still working would carry on in code that
   changed under it: let it finish, or `just kill <id>` — ask first, with the
   question tool: **Wait for it** · **Kill it**. A session waiting at a gate is fine — it resumes in the new code.

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
  ship) was never touched, and nor was any scorer under `asf/scorers/` — the
  re-stamp keeps every one as written.

## The config: one decision at a time

`diff asf/factory.yaml asf/factory.yaml.new` shows what a fresh stamp would say.
Most new keys have defaults that apply without them — the `.new` shows them, and
nothing needs copying. These do not, and each is the repository's call: put the
ones that apply to the engineer in one question-tool call (up to four; the rest
in the next), each option saying what it does, and edit `asf/factory.yaml` with
their answer. The options are below each.

1. **`defaults:`** — refused since 1.3: `just check` fails until it is gone, and
   prints the block that replaces it. Take the `.new`'s `harness:` block,
   `protected_files` and `data_dir` in its place, carrying over any value the
   engineer had changed (`model`, `tools`, `permission_mode`, `data_dir`, …) —
   or paste what `just check` printed, which already carries them. Two removed
   options need a question, not a rewrite: if `setting_sources` named
   `project`, the agents had been reading the repository's skills and
   `CLAUDE.md`; ask which skills which agent needs (they go in that agent's
   `harness: {skills: [...]}`) and whether `CLAUDE.md` should reach the agents
   (`context: [CLAUDE.md]`, in factory.yaml's block or one agent's). An agent
   or a binding of the repository's own that still sets `model`, `tools`,
   `thinking`, … flat is refused the same way, with its block.
2. **`observability:`** — obsolete and ignored since 1.2: delete it. The
   database it placed is no longer written; the file it names (by default
   `asf/data/asf.db`, with its `-wal` and `-shm`) can be deleted too.
3. **`worktree.integration.mode: none`** (or `integration: {mode: none}`) —
   refused since 1.2 (it warned in 1.1), and never remapped for them, because
   `none` did two jobs. Ask which was meant:
   - *land nothing* → `mode: pr`, and drop the `integrate` stage from the
     workflows that should land nothing;
   - *push nothing* → `mode: pr` and `worktree.publish: on_integrate`;
   - *push, open no pull request* → `mode: pr` and `open_pr: false`.
   A workflow's own `integrate: {mode: none}` is the same question; `just check`
   names each one. One option per meaning; none `(Recommended)`.
4. **`worktree.publish`** — unset, it follows the cockpit: `on_create` once one
   is configured (a session's branch is pushed as it starts and before every
   gate, so the cockpit can show what the gate asks about, and deleted from the
   remote when the session finishes unintegrated), `on_integrate` without one.
   Leaving it unset is a fine answer; `on_integrate` keeps branches local at the
   price of gates the cockpit cannot show. Options: **Leave it unset**
   `(Recommended)` · **`on_integrate`** · **`on_create`**.
5. **`cockpit.commands`** — without it a station obeys **no** command a cockpit
   sends: no kill, no resume, no answering a prompt run's gate from the inbox.
   A fresh stamp lists `commands: [answer, abort, kill, resume]` under
   `cockpit:`; `run` (starting prompt workflows from the cockpit) is off unless
   listed. Opting a verb in is the repository's decision, made in this reviewed
   file — never add one on the engineer's behalf. Ask with `multiSelect`:
   **`answer` + `abort`** (a prompt run's gate, from the inbox) · **`kill`** ·
   **`resume`** · **`run`**; what they tick is the list.
6. **`cockpit.transcripts`** — off unless the file says `true`. It sends every
   prompt and the harness's raw output, tool arguments and results included:
   say so in the options' descriptions, and never turn it on for them: **Leave
   it off** `(Recommended)` · **Send transcripts**.

Then delete `asf/factory.yaml.new` — it was a proposal, and leaving it is how
the next `--force` writes over the one they read.

## Outside the config

- **`.env`** is never rewritten: compare it with the re-stamped `.env.sample`.
  A shared cockpit needs `ASF_COCKPIT_URL` added by hand, and the station
  registered ([connect_cockpit.md](connect_cockpit.md)); a local cockpit needs
  neither.
- **A local cockpit** (no `ASF_COCKPIT_URL`) needs Docker with compose; `just
  up` starts it and warns without it. It asks the forge with the engineer's
  `gh auth token`, which `up` hands to the container — say so before the first
  `up`.
- **Station registration** — only against a **shared** cockpit, once per
  checkout: `just station-register`, as [connect_cockpit.md](connect_cockpit.md)
  walks it. It is theirs to approve, never yours. A local cockpit's station is its owner's already; a CI station
  takes no commands.
- **Labels** — `just labels`, then `just labels --create` for any a release
  added. It creates only missing labels; a route or queued label made by hand
  needs its description set on the forge for the cockpit's Trigger button to
  find it (`just labels` shows the text).
- **The optional CI check** — `install.py --harness <harness> --force --ci`
  stamps `.github/workflows/asf-check.yml`. A repository's CI is its own: ask
  with the question tool — unless it ships to a **team cockpit** (`ASF_COCKPIT_URL` set), where it
  comes with the cockpit and you say why
  ([connect_cockpit.md](connect_cockpit.md#ci)).
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

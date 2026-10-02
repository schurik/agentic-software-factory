# Install

Stamp the factory out of the skill and into the current working directory.
Reached however this harness names it — `/agentic-sf install` in Claude Code,
`/skill:agentic-sf install` in pi, or plain words in any agent that just read
`SKILL.md`.

## Never stamp it by hand

`install.py` is the only supported way in. Copying `templates/asf/` into the
repo yourself reproduces the *files* and none of the decisions around them:

| Skipped by hand | What breaks, and when you find out |
|---|---|
| `.env` with `ASF_SKILL=` | `just uninstall` fails outright, and `doctor` cannot say which release the skill is. `.env` is gitignored, so it also never arrives with a clone |
| the `# agentic-sf runtime` block in `.gitignore` | `asf/data/` and `.asf-worktrees/` become tracked, and a commit stage running `git add -A` sweeps the run record into the repository |
| quality detection | every `verify` block stays a placeholder, and a placeholder **fails** with exit 78 |
| `justfile` vs `asf.justfile` | a repository's own justfile gets overwritten, or the recipes never land |
| the assembled `asf/factory.yaml` | the roster is the harness's `defaults.yaml` merged with `templates/factory.yaml`; neither half is the config on its own |

If you are looking at a repo that has `asf/` but no `.env`, that is what
happened. Re-running `install.py` from the repo root repairs it: it skips every
file that already exists and writes only what is missing.

## Ask first, stamp second

`install.py` stamps ONE set of defaults. Four of them are decisions the
repository owns, not the factory, and each is cheap to answer now and annoying
to discover later. **Put them to the engineer in one message**, with the
defaults named so they can say "all defaults" and be done.

The first has no default: **which harness**. It decides which roster, which
prompts and which `.env.sample` get stamped, so the installer asks rather than
guessing — `--harness <name>` answers ahead of time, and with no terminal to ask
at, a missing flag is an error rather than a silent choice.

| Ask | Default if they shrug | Why it is not the installer's call |
|---|---|---|
| **Which harness?** (`claude_code`, `pi`) | none — it is asked | `claude_code` runs `claude -p`, takes model *aliases* (`opus`, `sonnet`, `haiku`) and brings its own auth: **no API key at all**, which is usually the shortest path to a first green run. `pi` runs `pi -p --mode json`, takes `provider/model-id`, and needs that provider's key in `.env`. |
| **How does this repo run its tests, lint, typecheck and build?** | whatever the installer detects; **anything it cannot detect stays a placeholder, and a placeholder fails** | `install.py` reads `package.json` scripts, the lockfiles and `pyproject.toml`, and writes what it finds into `asf/engine/quality.py` marked `# detected at install`. Confirm those lines — a detected command is a guess from a filename. An unwired block exits 78 rather than passing, because a chain that reports a green suite it never ran is the most expensive default this factory could ship. |
| **How should a run's branch land?** (`worktree.integration.mode`: `merge`, `pr`) | `pr`, opened with `gh pr create` (`open_pr: true`) | Repositories genuinely disagree about whether a machine may move the base branch. `pr` suits anywhere a human reviews first; `merge` suits a solo repo; a workflow with no `integrate` stage leaves its branch for a person (`none` said the same, and is refused from 1.2). Issue- and review-triggered runs can never merge regardless — `integration` downgrades them to a pull request, in code. |
| **May issues and reviews start runs?** (`issues.enabled`, `pull_requests.enabled`) | both on; `asf:ship` routes to the `issue` workflow | Neither starts anything by itself: an issue needs a human to apply `asf:queued` plus a routing label, and a review needs a pull request the factory opened. But this is the one path where the prompt is written by whoever can file an issue or leave a review rather than by the engineer at the keyboard — where that is anyone, narrow `trusted_authors` / `trusted_reviewers`, or turn it off. |

Three more worth naming only if the answer is not the default: `worktree.enabled`
(on — every run works in its own tree on branch `asf/<adw_id>`, never the
engineer's checkout), `defaults.protected_files` (the factory's own code, so
an agent cannot edit the machinery that judges its work), and `worktree.publish`
(unset — a session's branch is pushed as it is created once a cockpit is configured,
so the cockpit can show what a gate asks about, and not before an `integrate`
stage otherwise; `on_integrate` keeps branches local even with a cockpit, at
the price of gates the cockpit cannot show).

Apply the answers by editing `asf/factory.yaml` and `asf/engine/quality.py`
**after** stamping. The installer takes no flags for any of it, on purpose: the
config is the record of what this repo decided, and a flag would hide that
decision in a shell history.

## Run it

```bash
uv run <skill>/scripts/install.py --harness claude_code    # or: pi
```

`<skill>` is the directory this skill lives in — substitute the real path.

Run it from the **target repo root**: the cwd is where everything lands, and it
is never the skill's own directory. Leave `--harness` off and it asks, listing
what this skill ships; nothing is written until the question is answered, so an
abort leaves the repo untouched.

`--no-detect-quality` leaves every quality block a placeholder, for a repo whose
commands you would rather write yourself.

`--ci` also stamps the **optional CI workflow**, `.github/workflows/asf-check.yml`:
`asf check --json --ship` on every pull request and default-branch push. It is a
normal check on the pull request — a workflow that will not load goes red where
it was broken — and it ships the factory's self-description to a cockpit as a
CI station, which is how the cockpit's Factory page knows the workflows and
measures each station's config drift. It needs `vars.ASF_COCKPIT_URL` and
`secrets.ASF_COCKPIT_TOKEN` (the factory's ingest token, which can add and never
receive) on the repository to ship; without them it checks and ships nothing.
On a terminal the installer asks; `--no-ci` neither asks nor stamps. A
repository's CI is its own, so ask the engineer rather than passing `--ci` for them.

## What gets stamped

| Stamped | From | Tracked? |
|---|---|---|
| `asf/factory.yaml` | assembled: `templates/harnesses/<harness>/defaults.yaml` + `templates/factory.yaml` | yes — the manifest, and yours the moment it lands |
| `asf/asf.py` | `templates/asf/asf.py` | yes — the one entry point |
| `asf/engine/` | `templates/asf/engine/` | yes — session, worktree, gates, permissions, hitl, tracer, harnesses |
| `asf/stages/<name>/` | `templates/asf/stages/` | yes — the closed vocabulary: scout, plan, implement, verify, review, document, commit, integrate. Each is `stage.py` plus its default task files |
| `asf/agents/<name>/agent.md` | `templates/asf/agents/` | yes — **the user-owned home for identity**: frontmatter for the engine, prose for the model |
| `asf/workflows/<name>/` | `templates/asf/workflows/` | yes — `sdlc`, `quick`, `ship`, `issue`, `pr-review` |
| `asf/.skill-version` | `templates/asf/.skill-version` | yes — the skill release that stamped it; `doctor` compares it with the skill's own. Never edit it: `--force` rewrites it, and a factory without one was stamped before 1.1 |
| `.env.sample` | `templates/harnesses/<harness>/env.sample` | yes — only the keys that harness needs |
| `.env` | copied from `.env.sample`, with `ASF_SKILL=` written in | **no** — gitignored, and the reason a clone needs `install.py` re-run |
| `justfile`, or `asf.justfile` beside a foreign one | `templates/justfile` | yes — `just --list` is the menu |
| `.gitignore` | `+5` entries under `# agentic-sf runtime` | yes |
| `.github/workflows/asf-check.yml` — only with `--ci` | `templates/ci/asf-check.yml` | yes — the optional CI check, shipping the self-description to a cockpit |
| `asf/data/sessions/<adw_id>/` | created at runtime | no — gitignored: each session's whole record |
| `.asf-worktrees/` | created at runtime | no — gitignored: one worktree per run |

`asf/agents/` is yours the moment it is stamped. Edit it there, never back
inside the skill. An agent's TASK is not in it — a task belongs to the stage
that calls the agent, and a workflow may override it with its own file.

## Idempotency

Re-running is safe and doubles as a drift check. `install.py` skips **every**
file that already exists and reports the count, so a second run over a healthy
repo stamps 0 files. It still asks which harness, because the answer decides
what it would stamp into the gaps — give it the one the repo already runs, or
pass `--harness`.

The installer's first line names the skill version it stamped. When the repo
already has an `asf/.skill-version` from an older release, or none because it
was stamped before 1.1, it says so and leaves it that way: the files that exist
were not refreshed, so the record still describes them. It points at the
skill's [`CHANGELOG.md`](../CHANGELOG.md), whose `### Upgrade` sections name the
steps between the two — and [upgrade.md](upgrade.md) is the order to take them
in.

`--force` refreshes stamped code (`asf/engine/`, `asf/stages/`, the shipped
workflows and agents, `asf/.skill-version`) to the skill's current version.
**It does not overwrite `asf/factory.yaml`**: a fresh render lands beside it as
`asf/factory.yaml.new` and the installer prints `YOUR CONFIG WAS NOT TOUCHED`,
leaving the diff to you. Everything else stamped *is* replaced, including agent
prose you edited, so commit before you force.

Every re-run also **lints the config it kept**: each key a release dropped is
printed under `YOUR CONFIG NAMES OBSOLETE KEYS`, with its line and what to say
instead — `observability:` is ignored and can be deleted;
`worktree.integration.mode: none` is refused since 1.2, so set `pr`. It never
refuses to stamp, because the stamp is what brings the code the fix needs, and
it never edits the file. Over an older stamp, that is the moment for
[upgrade.md](upgrade.md). The CI workflow counts as stamped
once it is there: `--force` refreshes it without `--ci`, and never adds it
without.

## Post-install checklist

1. **`just doctor`** — first, always. Every check with its fix, then every
   workflow loaded and validated. It spawns nothing and costs nothing, and it is
   the designated answer to "is this repo ready to run anything?".
2. **`ASF_SKILL` in `.env`** — already written by the installer, and worth
   knowing about. Two things need it: `just uninstall` runs the uninstaller out
   of the skill, and `doctor` reads the skill's release through it to say
   whether this stamp is older. `install.py` never overwrites a value that is
   already there; if the path came from another machine it says so and leaves
   it. Unset, `doctor` warns on `ASF_SKILL`.
3. **The harness's own steps** — `install.py` printed them after stamping, out
   of that harness's `about.md`: the CLI on PATH, how it authenticates, and the
   sharp edges (`safe_mode`, running as root, how a model id is resolved).
   Re-read them there rather than guessing which apply.
4. **The quality blocks** — `doctor` names every block still unwired. Write the
   real argv into `asf/engine/quality.py` as a **list**, calling binaries by
   bare name. A `verify` stage that names an unwired block fails the run.
5. **Docker, for the local cockpit** — `just up` starts a cockpit on this
   machine when `.env` names no shared one (`ASF_COCKPIT_URL`): the same
   published images a team deploys, through the stamped
   `asf/cockpit/compose.yaml`, at `http://localhost:3000`. That needs Docker
   with the compose plugin, running. Without it `up` warns, drops the cockpit
   and runs the watchers anyway — nothing is refused — and `doctor`'s `cockpit`
   line says which of the three is missing and which version it would run.
   The local cockpit asks the forge as the engineer, with their `gh auth
   token`, which `up` hands to it as it starts: `doctor`'s `cockpit forge`
   line says whether there is one. Without a `gh` login the cockpit still
   shows every session this checkout ships, and lists no factory beyond those.
   With a **shared** cockpit instead, `just station-register` lets it send
   this checkout commands (kill, resume, answering a prompt run's gate): it prints a code the
   engineer approves there, signed in — theirs to approve, not yours.
6. **`just labels --create`** — only if either watcher is on. Every label in
   `issues.route`, `issues.states`, `issues.refined_label` and
   `pull_requests.states.failed` has to EXIST at the forge before anything can
   apply it, and a fresh repository defines none of them. A route label nobody
   can apply makes the workflow behind it unreachable — it looks configured and
   is inert — and `--add-label` on an undefined name fails the write it rides
   on, which is how a `refine` run dies at its last step. `just labels` shows
   the answer without changing anything; `--create` adds exactly the missing
   ones and never edits or deletes an existing label. `doctor` asks the same
   question on every run, so an **upgrade** that adds a label is caught too —
   `install.py` never rewrites the `factory.yaml` you own, so a new label
   reference arrives in the code with no way for the name to exist.
7. **`just list`** — the workflows, one line each. Then a first run:
   [run_workflow.md](run_workflow.md).

## If the skill is vendored inside the repo

Some repos keep the skill in-tree (`.agents/skills/agentic-sf/`) rather than
pointing `ASF_SKILL` at a checkout elsewhere. That works: nothing the factory
runs writes inside the skill's tree, so it never shows up in the host repo's
`git status` — or in the `git add -A` a commit stage runs.

## Issue- and review-triggered runs

On by default, but nothing polls until a watcher is started: `just up` runs
the station loop, the local cockpit and every watcher in one process. `just issues-status` and
`just prs-status` say what the watchers would do and whether they can — both
need the forge CLI (`gh`) on PATH and authenticated, and `doctor` warns when it
is not. `issues.route` decides which label launches which workflow (`asf:ship`
→ `issue` as stamped); `issues.enabled` and `pull_requests.enabled` in
`asf/factory.yaml` turn a path off.

The labels themselves are a separate job from routing them: run
`just labels --create` once, and again after any upgrade or any edit that names
a new one. On a tracker that is not the forge, clear `issues.labels_list_command`
and `issues.labels_create_command` — empty means skip, and skipping is honest
where `gh label` has no equivalent.

A run records **who triggered it** (`triggered_by` in its `run.json` and on
`session_started`): for a labelled issue, whoever last applied its route or
queued label, which the watcher reads from the issue's `labeled` events
(`issues.labeller_command`, `gh api graphql` as stamped); for anything else,
the operator, as `gh` knows them on this machine. A cockpit ranks those runs
first for that person, and its Trigger button applies the two labels as them —
it finds them by the descriptions `just labels --create` writes, so a
hand-made route label is not offered there. It authorizes nothing: the forge
decides who may label, and `trusted_authors` still decides whose text the
agents read.

## Removing it again

[uninstall.md](uninstall.md). The skill is never touched by either direction.

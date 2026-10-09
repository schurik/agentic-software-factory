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
| the assembled `asf/factory.yaml` | the harness's `harness.yaml` (the `harness:` block) followed by `templates/factory.yaml` (everything harness-agnostic, `protected_files` and `data_dir` included); neither half is the config on its own |

If you are looking at a repo that has `asf/` but no `.env`, that is what
happened. Re-running `install.py` from the repo root repairs it: it skips every
file that already exists and writes only what is missing.

## Ask first, stamp second

`install.py` stamps ONE set of defaults. Four of them are decisions the
repository owns, not the factory, and each is cheap to answer now and annoying
to discover later. **Put them to the engineer in one question-tool call**
([SKILL.md § Asking the person](../SKILL.md#asking-the-person)) — four
questions, the default of each first and marked `(Recommended)`, so taking
every first option is "all defaults" and done:

| Question | Options, default first |
|---|---|
| Which harness? | `claude_code` — their Claude Code login, no API key · `pi` — a provider key in `.env` |
| Test, lint, typecheck and build commands? | Use what the installer detects, and confirm it after · Leave placeholders, I'll write them (`--no-detect-quality`) |
| How should a run's branch land? | `pr`, opened with `gh pr create` · `merge` into the base branch |
| May issues and reviews start runs? | Both · Issues only · Reviews only · Neither |

Then, unless they are connecting a team cockpit (which brings it), the CI
check in a call of its own: **Not now** · **Stamp it (`--ci`)** — see
[Run it](#run-it).

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
engineer's checkout), `protected_files` (the factory's own code, so
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
receive — a repository admin issues one on the factory's Stations tab, see
[connect_cockpit.md](connect_cockpit.md#ci)) on the repository to ship; without
them it checks and ships nothing.
On a terminal the installer asks; `--no-ci` neither asks nor stamps. A
repository's CI is its own, so ask the engineer with the question tool rather
than passing `--ci` for them — unless they connect a **team cockpit**, which
is the answer: it comes with connecting, and you say why
([connect_cockpit.md](connect_cockpit.md#ci)).

## What gets stamped

| Stamped | From | Tracked? |
|---|---|---|
| `asf/factory.yaml` | assembled: `templates/harnesses/<harness>/harness.yaml` + `templates/factory.yaml` | yes — the manifest, and yours the moment it lands |
| `asf/asf.py` | `templates/asf/asf.py` | yes — the one entry point |
| `asf/engine/` | `templates/asf/engine/` | yes — session, worktree, gates, permissions, hitl, tracer, harnesses |
| `asf/stages/<name>/` | `templates/asf/stages/` | yes — the closed vocabulary: scout, plan, implement, verify, review, document, commit, integrate. Each is `stage.py` plus its default task files |
| `asf/agents/<name>/agent.md` | `templates/asf/agents/` | yes — **the user-owned home for identity**: frontmatter for the engine, prose for the model |
| `asf/workflows/<name>/` | `templates/asf/workflows/` | yes — `sdlc`, `quick`, `ship`, `issue`, `pr-review` |
| `asf/scorers/<name>/scorer.md` | written by the team (none ship yet) | yes — what a workflow's finished chapters are judged by; **never rewritten, even by `--force`** ([design.md](../references/design.md#scorers)) |
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
leaving the diff to you. **Nor anything under `asf/scorers/`**: a scorer is the
team's criteria, kept as written. Everything else stamped *is* replaced,
including agent prose you edited, so commit before you force.

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
2. **The factory's settings** — after a **first** install, walk the stamped
   `asf/factory.yaml` with them, one question-tool call at a time:
   [The factory's settings](#the-factorys-settings). Not after a re-run over a
   stamp they already own.
3. **`ASF_SKILL` in `.env`** — already written by the installer, and worth
   knowing about. Two things need it: `just uninstall` runs the uninstaller out
   of the skill, and `doctor` reads the skill's release through it to say
   whether this stamp is older. `install.py` never overwrites a value that is
   already there; if the path came from another machine it says so and leaves
   it. Unset, `doctor` warns on `ASF_SKILL`.
4. **The harness's own steps** — `install.py` printed them after stamping, out
   of that harness's `about.md`: the CLI on PATH, how it authenticates, and the
   sharp edges (what of the operator's machine an agent sees, running as root,
   how a model id is resolved).
   Re-read them there rather than guessing which apply.
5. **The quality blocks** — `doctor` names every block still unwired. Write the
   real argv into `asf/engine/quality.py` as a **list**, calling binaries by
   bare name. A `verify` stage that names an unwired block fails the run.
6. **Docker, for the local cockpit** — `just up` starts a cockpit on this
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
   With a **shared** cockpit instead, connecting this checkout is
   [connect_cockpit.md](connect_cockpit.md): `ASF_COCKPIT_URL`, then `just
   station-register`, whose code a person with write approves — theirs to
   approve, not yours.
7. **`just labels --create`** — only if either watcher is on. Every label in
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
8. **`just list`** — the workflows, one line each. Then a first run:
   [run_workflow.md](run_workflow.md).

## The factory's settings

`install.py` stamped one set of defaults into `asf/factory.yaml`, and the
file is theirs from that moment. After a **first** install — and again
whenever they ask to "go through the config" — walk it with them: read the
file, and put each setting below to them with the question tool
([SKILL.md § Asking the person](../SKILL.md#asking-the-person)), in the calls
below, each question naming the value the file holds now. Skip a question
whose setting they already changed, and one whose subsystem is off (no
tracker questions when issues and reviews start nothing). The four install
decisions were asked before stamping: do not ask them again.

Each option's `preview` shows the lines it writes. Nothing is written until
they have answered, and only what they chose.

**First call — what a run may spend, and where it stops for a person.**

| Setting | Question | Options |
|---|---|---|
| `budget.max_cost_usd` | What may one session spend? | **No ceiling** (stamped `0`) · **$2** · **$5** · **$10**, or an amount through Other. Recommend a ceiling when issues or reviews start runs: those run with nobody watching. A ceiling stops the next agent turn, never the one in flight |
| `harness.model` | Which model do the agents run? | `claude_code`: **`sonnet`** (stamped) · **`opus`** — slower and dearer, for hard work · **`haiku`** — cheap, for small changes. `pi`: the stamped `provider/id`, or theirs through Other |
| `hitl.gates` | Where should a run stop for a person? (`multiSelect`) | **At the plan** (`plan: on`) — read what it will build before it builds · **Before it lands** (`integrate: on`) — the whole diff before the pull request or merge · **Nowhere** (stamped) — runs go straight through; ticked with another, ask again. The `issue` workflow stops at its plan either way: its `workflow.yaml` says so, and a workflow outranks this block |
| `issues.trusted_authors`, `pull_requests.trusted_reviewers` | Whose issues and reviews may start a run? | **Anyone who can label or review** (stamped `[]`) — the forge's permissions are the gate · **Only the people I name** — logins through Other. Recommend naming them on a repository outsiders can file issues on |

**Second call — the cockpit.**

| Setting | Question | Options |
|---|---|---|
| `cockpit.transcripts` | Send the cockpit every prompt and the harness's raw output? | **Leave it off** `(Recommended)` · **Send transcripts** — the description says it carries tool arguments and results, so whatever an agent read |
| `cockpit.commands` | Which commands may a cockpit send this factory's stations? | **`answer`, `abort`, `kill`, `resume`** `(Recommended)`, as stamped · **Those four and `run`** — anyone the station trusts can start a prompt workflow on their own station from the cockpit · **None** — the cockpit only watches |
| `hitl.when_unattended` — only when issues or reviews start runs | A gate fires on a run the tracker started — the `issue` workflow's plan, say: | **Suspend and wait** `(Recommended)`, as stamped — answered on the issue or in the cockpit · **Approve it and go on** — recorded as the policy's approval, with nobody looking. A run the engineer starts always stops |

Then edit `asf/factory.yaml` with the answers, run `uv run asf/asf.py check`,
show them `git diff asf/factory.yaml`, and record it: `just onboard --mark
settings`. Committing it, with the rest of the stamp, is the next step of
onboarding and has its own question
([onboard.md § 3](onboard.md#3-commit-and-publish-the-factory)). Anything else in the file — limits, worktrees, the
tracker's commands — keeps its stamped value; its comment says what it does,
and they can ask.

## If the skill is vendored inside the repo

Some repos keep the skill in-tree (`.agents/skills/agentic-sf/`) rather than
pointing `ASF_SKILL` at a checkout elsewhere. That works: nothing the factory
runs writes inside the skill's tree, so it never shows up in the host repo's
`git status` — or in the `git add -A` a commit stage runs.

The `skills` CLI puts it there, and the same command, from the repository
root, is how it is updated:

```bash
npx skills add schurik/agentic-software-factory --skill agentic-sf --agent claude-code pi -y
```

It writes `.agents/skills/agentic-sf/` and links `.claude/skills/agentic-sf`
to it. Name two agents, not `claude-code` alone — one agent means a copy, not a
link — and do not update with `npx skills update` where the CLI sees an Eve
agent: [upgrade.md](upgrade.md#update-the-skill-first) says why, and how to
check the copy moved before stamping from it.

## Issue- and review-triggered runs

On by default, but nothing polls until a watcher is started: `just up` runs
the station loop, the local cockpit and every watcher in one process. `just issues-status` and
`just prs-status` say what the watchers would do and whether they can — both
need the forge CLI (`gh`) on PATH and authenticated, and `doctor` warns when it
is not. `issues.route` decides which label launches which workflow (`asf:ship`
→ `issue` as stamped); `issues.enabled` and `pull_requests.enabled` in
`asf/factory.yaml` turn a path off.

The review watcher is also what tells a cockpit that a pull request merged.
Each pass it reaps the sessions whose pull request closed and records how
(`pull_request_closed` in the session, `pr_state` in its `run.json`), so a
factory nobody runs `just prs` or `just up` for shows nothing merged on the
cockpit's Measure tab. Its first pass after an upgrade finds every pull request
the factory opened that has since closed, and records 20 a pass.

A factory that runs no review watcher catches up with `just score`
(`--since 2026-10-01` for the sessions started since): for every session whose
pull request has not been recorded closed, it asks the forge and records the
same `pull_request_closed` the watcher would, so the Measure tab counts it
alike. It needs the forge CLI and `pull_requests.project` (or an origin
remote), not `pull_requests.enabled`; it only records — no worktree, run or
label is touched — and a second run adds nothing.

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

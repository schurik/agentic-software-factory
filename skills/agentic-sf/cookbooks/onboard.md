# Onboard

For someone new to the skill: what it is, where they stand, and the answer to
each question they will have, in the order they usually have it. Each answer is
short and names the cookbook that holds the rest — read that one before acting
on the answer, as the routing table says.

Do not recite this file. Find where they stand (below), say it in two lines,
offer the next step, and answer the questions they actually ask.

## What it is, in one breath

A **factory** stamped into their repository (`asf/`): workflows that plan,
build, test, review and land a change, each phase an agent working in its own
git worktree, with code — not the agent — deciding the order, the retries and
whether the result is accepted. Runs stop at **gates** for a person's verdict.
Every run is recorded under `asf/data/sessions/<id>/`, and a **cockpit** (a web
app, local or shared by a team) shows them and can steer them.

You run the factory for them; you never do a workflow's work yourself.

## Where they stand

Look, do not ask:

| What you find | Where they are | Next step |
|---|---|---|
| no `asf/factory.yaml` | nothing stamped here | [Install](#install-it) |
| `asf/.skill-version` missing or older than `<skill>/templates/asf/.skill-version` | stamped by an older release | [Update the factory](#update-the-factory) |
| stamped, current, `just doctor` has failures | stamped, not ready | [Set it up](#set-it-up) |
| stamped, current, doctor clean | ready | [First run](#the-first-run), then whatever they ask |

## Install it

**"How do I get it into my repo?"** — `install.py`, never by hand: it asks four
questions that belong to the repository (which harness, how it tests and lints,
how a run's branch lands, whether issues may start runs), stamps `asf/`, the
`justfile`, `.env` and the `.gitignore` entries, and is safe to run again.
→ [install.md](install.md)

**"Which harness?"** — `claude_code` uses the engineer's own Claude Code login
and needs no key; `pi` needs that provider's API key in `.env`. The installer
lists what the skill ships.

**"Can CI check it?"** — `--ci` stamps an optional workflow that runs `asf
check` on every pull request and tells a cockpit what the factory is. It is the
repository's CI: ask before adding it. → [install.md](install.md#run-it)

## Set it up

**"Is it ready?"** — `just doctor`: every check, each with its fix, then every
workflow loaded. Spawns nothing, costs nothing. → [install.md](install.md#post-install-checklist)

The usual first fixes, all in that checklist: the **quality blocks** (the real
test and lint commands, in `asf/engine/quality.py`), **labels** if issues start
runs (`just labels --create`), and **Docker** for the local cockpit.

## The first run

**"How do I run something?"** — `just do "<prompt>"` runs `sdlc` (plan, build,
verify, review, land); `just quick "<prompt>"` and `just ship "<prompt>"` are the
shorter shapes; `just run <workflow> "<prompt>"` any other. `just list` names
them all. The prompt is not their sentence: it carries the area, what "done"
means and what to leave alone. → [run_workflow.md](run_workflow.md)

**"It stopped and is waiting."** — a gate or a question round. `just pending`,
`just show <id>`, then `just approve <id>`, `just reject <id> -m "…"`, `just
answer <id> -m "…"` or `just abort <id>`. The verdict is theirs: never give it
for them. → [run_workflow.md](run_workflow.md)

**"It failed."** — `just show <id>` says where and why; `just resume <id>` picks
it up, replaying the agent phases already recorded; `just kill <id>` stops a
live one.

## Work from the tracker

**"Can it work my issues?"** — `just issue 42` works one; `just pr-review 17`
answers a pull request's review; `just refine 42` turns an unclear issue into
requirements by asking on the issue; `just refine-ship 42` does both. A run
started from an item asks its questions and reports back there.

**"Can it pick issues up by itself?"** — `just up`: the watchers start a run for
every issue labelled for a route, resume runs answered on their item, and take
reviews — plus the station loop and, without a shared cockpit, the local one.
`just status` says what is watching. Labels must exist first: `just labels`.

## The cockpit

**"Where do I see my runs?"** — `just up` starts a **local cockpit** at
`http://localhost:3000` (needs Docker) and ships every session to it. Nothing to
register: it is theirs. It asks the forge with their `gh auth token` — say so
before the first `up`.

**"How do I connect to our team's cockpit?"** — set `ASF_COCKPIT_URL` (the
deployment's **site** origin) in `.env`, then **register the station**: `just
station-register` prints a code, a person with write on the repository approves
it in the cockpit, and the station keeps its tokens. Never approve it for them.
→ [connect_cockpit.md](connect_cockpit.md)

**"What is a station?"** — one checkout of the repository, on a machine or in a
CI job. It ships its sessions to the cockpit and, once registered, takes the
commands the cockpit sends (kill, resume, answer, run) as far as
`cockpit.commands` in `asf/factory.yaml` allows.

**"A run isn't in the cockpit."** — `just station-sync` sends whatever the cockpit
has not acknowledged, every session from where it stopped; it fails only when
the cockpit refuses the token. `just doctor` and `just status` say what the
station ships with. → [connect_cockpit.md](connect_cockpit.md#when-it-doesnt-work)

**"We run the cockpit — how do we set it up?"** — deploy it, print a setup code
on the deployment, register the GitHub App at `/setup`, install it on the
repositories. → [connect_cockpit.md](connect_cockpit.md#once-per-cockpit--its-operator)

**"CI needs a token."** — a repository admin issues one on the factory's
Stations tab in the cockpit; it goes in `secrets.ASF_COCKPIT_TOKEN`.
→ [connect_cockpit.md](connect_cockpit.md#ci)

## Update the factory

**"There's a new release."** — update the skill copy first, then re-stamp with
`install.py --force`. `--force` never rewrites their `asf/factory.yaml`: each
key a release added is a decision put to them, and `CHANGELOG.md` names the
steps. → [upgrade.md](upgrade.md)

## Make it theirs

**"Can I add a workflow, or change one?"** — a workflow is a directory under
`asf/workflows/<name>/`: copy the closest, edit `workflow.yaml` (stages from a
closed vocabulary, each with its options), then `uv run asf/asf.py check
<name>`, which refuses anything wrong before it costs a token. No `loop:` or
`if:` in the YAML: a shape the stages cannot express is a new stage in Python.
→ [references/design.md](../references/design.md)

**"Can I change what an agent does?"** — for one workflow, its task:
`asf/workflows/<name>/tasks/<key>.md`, keeping the `## Report` block; or its
identity, appended under `agents:` with `system_append`. For every workflow,
`asf/agents/<name>/agent.md`: the frontmatter is its boundary (`tools`,
`writes`), the prose its voice. A workflow can narrow an agent, never widen it.

**"Can I change the settings?"** — `asf/factory.yaml` is theirs from the moment
it is stamped: defaults, budget, gates, worktree and landing, the tracker, the
cockpit. `uv run asf/asf.py check --json` shows them as the factory reads
them, every default resolved. What a cockpit sees
(`cockpit.transcripts`) and which commands it may send (`cockpit.commands`) are
the repository's decisions, made in that reviewed file — never yours.

## Take it out

**"How do I remove it?"** — `just uninstall --dry-run` first, and show them the
plan: the run record and unlanded branches are not recoverable. The skill
itself stays. → [uninstall.md](uninstall.md)

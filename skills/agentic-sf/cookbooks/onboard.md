# Onboard

For someone new to the skill: a fixed sequence of steps from nothing to a
first run, which the factory itself keeps track of, and the answer to each
question they will have on the way. Each answer is short and names the
cookbook that holds the rest — read that one before acting on it, as the
routing table says.

Do not recite this file. Find the step they are on (below), say in two lines
where they stand and what comes next, and take that step. Every decision on
the way is asked with the question tool
([SKILL.md § Asking the person](../SKILL.md#asking-the-person)).

## What it is, in one breath

A **factory** stamped into their repository (`asf/`): workflows that plan,
build, test, review and land a change, each phase an agent working in its own
git worktree, with code — not the agent — deciding the order, the retries and
whether the result is accepted. Runs stop at **gates** for a person's verdict.
Every run is recorded under `asf/data/sessions/<id>/`, and a **cockpit** (a web
app, local or shared by a team) shows them and can steer them.

You run the factory for them; you never do a workflow's work yourself.

## Where they stand: `just onboard`

No `asf/factory.yaml`: they are before step 1. A stamp older than this skill:
[update it](#update-the-factory) first — its engine has no `onboard`.
Otherwise run **`just onboard`** (`--json` to read it as data) and go to the
step it calls `next`. Never decide by looking around yourself what is done:

- every step is judged by **evidence** — git, the forge, `.env`, the kept
  station token, the session directory — so a step is done when it is so,
  and comes undone when it stops being so;
- the three decisions that leave no trace are **recorded** with `just onboard
  --mark …` the moment the person makes them: `settings`, `cockpit=local`,
  `ci=declined`. Record nothing else, and never mark a step for them that
  they did not decide;
- the record is `asf/data/onboarding.json` — gitignored, this checkout's. It
  says when onboarding started and finished, which is how a session a week
  later knows to offer picking it up ([SKILL.md § Startup](../SKILL.md#startup)).

Run `just onboard` again after every step: what it prints is the next thing to
say. **Do not skip ahead.** A step is not done because the next one looks
more interesting, and the order is load-bearing.

## The steps

### 1. Install

`install.py`, asking its four questions first with the question tool.
→ [Install it](#install-it), [install.md](install.md)

### 2. Ready, and the settings decided

`just doctor` until nothing is fatal (`ready`). Then walk the stamped
`asf/factory.yaml` with them, one question-tool call at a time
([install.md § The factory's settings](install.md#the-factorys-settings)),
write what they chose, and `just onboard --mark settings`.

### 3. Commit and publish the factory

**Nothing about a cockpit happens before this step is done.** A cockpit — the
local one or a team's — lists only factories whose **default branch** at the
forge holds `asf/factory.yaml`. A station registered before that prints a code
whose approval nobody can find: the Stations tab is on a factory page that
does not exist yet.

Show them `git status` for what the install stamped and the settings changed,
then ask with the question tool:

- **Commit and push to `<default>`** — `(Recommended)` where they push to it
  directly; you commit with `asf: stamp the agentic-sf factory` and push;
- **Commit on a branch and open a pull request** — where `<default>` is
  protected or reviewed; you push the branch and open it, and onboarding
  waits until it is **merged**: say so, and that `/agentic-sf onboard`
  picks it up again from there;
- **I'll do it myself** — say what has to happen (`committed`, then
  `published` in `just onboard`) and stop until it has.

`.env` and `asf/data/` stay out: the installer gitignored them. Then `just onboard`: `published` must say `on
origin/<default>` before you go on.

### 4. Choose a cockpit, and connect

Ask which, with the question tool
([connect_cockpit.md § Local or shared](connect_cockpit.md#local-or-shared)).
Local: `just onboard --mark cockpit=local`, and nothing to register. The
team's: `ASF_COCKPIT_URL` in `.env`, then `just station-register` — a person
with write approves it in the cockpit, never you. Its first registration
describes the factory.

### 5. The CI check

With a team cockpit it comes with connecting: stamp it, say why, then commit
and publish it as in step 3 ([connect_cockpit.md § CI](connect_cockpit.md#ci)).
With a local one, ask; declined: `just onboard --mark ci=declined`.

### 6. Labels

Only when issues or reviews start runs: `just labels --create`.

### 7. The first run

`just do "<prompt>"`, the prompt built as
[run_workflow.md](run_workflow.md) says. `just onboard` then reports every
step done, and the record says onboarding is finished.

## Questions they will have

### Install it

**"How do I get it into my repo?"** — `install.py`, never by hand: it asks four
questions that belong to the repository (which harness, how it tests and lints,
how a run's branch lands, whether issues may start runs), stamps `asf/`, the
`justfile`, `.env` and the `.gitignore` entries, and is safe to run again.
→ [install.md](install.md)

**"Now what?"** — `just onboard` says, every time: the next step, and what
to do about it. → [The steps](#the-steps)

**"Which harness?"** — `claude_code` uses the engineer's own Claude Code login
and needs no key; `pi` needs that provider's API key in `.env`. The installer
lists what the skill ships.

**"Can CI check it?"** — `--ci` stamps a workflow that runs `asf check` on
every pull request and tells a cockpit what the factory is. With a **team
cockpit** it comes with connecting, unasked, and you say why
([connect_cockpit.md](connect_cockpit.md#ci)); with only the local one it is
the repository's CI: ask with the question tool before adding it.
→ [install.md](install.md#run-it)

### Set it up

**"Is it ready?"** — `just doctor`: every check, each with its fix, then every
workflow loaded. Spawns nothing, costs nothing. → [install.md](install.md#post-install-checklist)

The usual first fixes, all in that checklist: the **quality blocks** (the real
test and lint commands, in `asf/engine/quality.py`), **labels** if issues start
runs (`just labels --create`), and **Docker** for the local cockpit.

### The first run

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

### Work from the tracker

**"Can it work my issues?"** — `just issue 42` works one; `just pr-review 17`
answers a pull request's review; `just refine 42` turns an unclear issue into
requirements by asking on the issue; `just refine-ship 42` does both. A run
started from an item asks its questions and reports back there.

**"Can it pick issues up by itself?"** — `just up`: the watchers start a run for
every issue labelled for a route, resume runs answered on their item, and take
reviews — plus the station loop and, without a shared cockpit, the local one.
`just status` says what is watching. Labels must exist first: `just labels`.

### The cockpit

**"Where do I see my runs?"** — `just up` starts a **local cockpit** at
`http://localhost:3000` (needs Docker) and ships every session to it. Nothing to
register: it is theirs. It asks the forge with their `gh auth token` — say so
before the first `up`.

**"How do I connect to our team's cockpit?"** — set `ASF_COCKPIT_URL` (the
deployment's **site** origin) in `.env`, then **register the station**: `just
station-register` prints a code, a person with write on the repository approves
it in the cockpit, and the station keeps its tokens — and, the first time,
describes the factory to the cockpit. Never approve it for them. Then **add the
CI check**, saying why: it keeps that description current from the default
branch. → [connect_cockpit.md](connect_cockpit.md)

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

### Update the factory

**"There's a new release."** — update the skill copy first, then re-stamp with
`install.py --force`. `--force` never rewrites their `asf/factory.yaml`: each
key a release added is a decision put to them, and `CHANGELOG.md` names the
steps. → [upgrade.md](upgrade.md)

### Make it theirs

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

### Take it out

**"How do I remove it?"** — `just uninstall --dry-run` first, and show them the
plan: the run record and unlanded branches are not recoverable. The skill
itself stays. → [uninstall.md](uninstall.md)

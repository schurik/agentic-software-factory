---
name: agentic-sf
description: Agentic Software Factory — workflows as directories (workflow.yaml + tasks + agent bindings) over a closed stage vocabulary, with one entry point. Use when the user is new to agentic-sf (`/agentic-sf onboard`, "how do I start?"), asks to install or upgrade it, run a workflow or work an issue with asf, answer a waiting run, start the watchers, connect a repository to a cockpit or register a station, list or check workflows, create or edit a workflow directory, tune an agent's identity or a stage's task, add a scorer that measures a workflow's chapters, inspect a run, or uninstall it. Keywords - agentic-sf, asf, software factory, workflow.yaml, stage, task file, agent directory, scorer, factory.yaml, cockpit, station.
argument-hint: "[onboard | install | upgrade | doctor | run <workflow> \"<prompt>\" | issue <n> | up | connect cockpit | register station | create workflow | edit agent | uninstall | ...]"
---

# Agentic Software Factory (asf)

Deterministic code owns sequencing, retries and acceptance; coding agents
work inside bounded phases; typed envelopes cross the seams; every event
lands in the session's own record, and a cockpit receives it. The surface:

- **One entry point.** `just do "<prompt>"`, or `uv run asf/asf.py run <workflow>
  "<prompt>"`. `list`, `check`, `doctor`, the gate verbs, the watchers, `up`,
  `status`, `kill` and `worktrees` beside it.
- **A workflow is a directory**, not a script you copy. `workflow.yaml` names
  stages from a closed vocabulary and gives each its options. Loops and
  conditions live in the stages; the YAML gets numbers.
- **An agent is one file**, `agent.md`: YAML frontmatter for the engine, prose
  for the model. Its task is not
  there: a task belongs to the stage that calls the agent, and a workflow may
  override it with its own file.

## `<skill>` in every command below

The directory this `SKILL.md` lives in. Substitute it, never the literal
`<skill>`. Commands run from the **target repo root**.

## Startup

A request to be onboarded — `onboard`, "I'm new to this", "how do I start?",
"what can it do?" — reads [cookbooks/onboard.md](cookbooks/onboard.md) and
follows it instead. Anything else: three steps. Then stop.

1. If `asf/factory.yaml` does not exist, say in one line that the factory is
   not installed here and offer [cookbooks/install.md](cookbooks/install.md)
   — and, to someone new to it, [cookbooks/onboard.md](cookbooks/onboard.md) —
   with the question tool ([Asking the person](#asking-the-person)).
   Stamping it by hand instead of running `install.py` is how a repo ends up
   with `asf/` but no `.env` — read the cookbook. Otherwise:
2. Compare `asf/.skill-version` (the release that stamped this factory) with
   `<skill>/templates/asf/.skill-version` (the release this skill is). If the
   stamp's is **missing** — stamped before 1.1 — or **older**, say so in one
   line, "stamped at X · skill is Y", and offer
   [cookbooks/upgrade.md](cookbooks/upgrade.md) first, before any other
   request, with the question tool (Upgrade now / Not now): read it before
   acting on it. Nothing is refused meanwhile; an old
   stamp runs as it did. A stamp **newer** than the skill means this skill
   checkout is behind — say so, and install nothing from it.
3. Run `just list` (or `uv run asf/asf.py list`) and print it — one line per
   workflow, name and description — and **wait for the engineer's request.**

Nothing else. No trace-db queries, no reading the config, no reading stages
or engine code, no "current state" summary. Everything below is lazy-loaded
when a request calls for it.

Exception: if the engineer's first message already contains a request, skip
the waiting and route it.

Onboarding left halfway: when `asf/data/onboarding.json` exists and its
`finished` is empty, run `just onboard` and add one line — "onboarding stopped
at <next>" — offering to continue with the question tool (**Continue
onboarding** · **Not now**), before or beside whatever they asked.
[cookbooks/onboard.md](cookbooks/onboard.md) is where it continues.

## Orchestrator rules

You run the system and help the engineer interact with it. **You do no
workflow work yourself**: never plan, implement or test in an agent's place —
launch the workflow and watch it. Never edit files under `asf/data/`; that is
the run record — yours to read when observing is the task, never to volunteer
a status board. Each session's `events.jsonl` is its typed domain events,
numbered by `seq` — the record a cockpit is fed, so it is read, never
rewritten.

## Asking the person

Whenever the person has to answer — a choice at install, a decision in
`factory.yaml`, a gate's verdict, whether to go ahead with something that
cannot be undone, the next step to take — ask with your harness's **question
tool**: `AskUserQuestion` in Claude Code. Never end a turn on a question
written in prose. The cookbooks say at each such point what to ask and with
which options; the rules are the same everywhere:

- **One call per stopping point**, holding every question you have there (up
  to four) — not one question per turn.
- **2–4 options each, the recommended one — or the default — first**, marked
  `(Recommended)`; each option's description says what it does and what it
  costs. The tool adds **Other** for typed answers, which is how a reason, a
  rejection's notes or a prompt's missing detail arrives.
- `multiSelect` only where the answers are not exclusive (which verbs a cockpit
  may send). A `preview` shows the lines a choice writes, when that helps.
- **Do not ask what you can look up** (where a repository stands, which harness
  `factory.yaml` names) or what has one answer (the CI check with a team
  cockpit): say it, and act.
- **The answer is theirs and you act on it** — nothing is decided by the
  question's default when they have not answered. What a person must do
  themselves — approve a station's code, issue or store a token, sign in — the
  tool never does: say what to do and where, and ask only whether it is done
  when you have to wait on it.

A harness without a question tool: ask in one message, numbered, with the same
options and the recommended one named, and wait.

## Where things live in a stamped repo

```
asf/
  factory.yaml            the manifest: harness, budget, gates, cockpit, worktree. No agents in it.
  .skill-version          the skill release that stamped this factory — `--force` rewrites it, never edit it
  asf.py                  the runner: list | check | run
  agents/<name>/          agent.md: frontmatter (purpose, writes, harness: model, tools, skills, context) + identity below it
  workflows/<name>/       workflow.yaml (input, agents, stages), optional tasks/<key>.md, optional agents/<x>.md
  scorers/<name>/         scorer.md: frontmatter (workflow, focus, kind, predicate) + criteria below it — four ship on `issue`; the team's own after that: --force never rewrites one
  stages/<name>/          stage.py (the contract) + its default task files
  engine/                 the machinery: session, worktree, gates, permissions, hitl, tracer, …
  data/                   runtime: sessions/<adw_id>/, station.json (this checkout's id), onboarding.json — never edit
```

Every run works in its own worktree on branch `asf/<adw_id>`; the checkout is
never touched. A run that is not accepted keeps its worktree. A gate a stage
turns on with `hitl: true` stops the run with exit 75 and the session reading
`waiting`. An issue- or review-triggered run can never merge: `integration`
downgrades a configured merge to a pull request on those inputs, in code.

WHEN that branch reaches the remote is `worktree.publish`, and it follows the
cockpit unless `asf/factory.yaml` sets it. A cockpit shows what a gate asks
about by reading it from the forge at the commit the run stopped on, so with
one configured the branch is pushed as the session starts and before every
suspend, the gate's subject committed first (`on_create`); without one nothing
leaves the machine until an `integrate` stage pushes it (`on_integrate`). A
branch published that way and never integrated is deleted from the remote when
its session finishes or is aborted — the local branch stays — and kept when the
session fails, so `resume` works, or when it was proposed or merged. `just
doctor` says which of the two a repository is running under, and why.

A run stops for a person in one of TWO ways, and `just show <id>` says which.
At a **gate** it is showing a work product and wants a verdict: approve, reject
or abort. At a **question round** an agent is saying what it could not settle,
and wants the missing input: answer, approve (every recommendation as it
stands) or abort. The verb that does not fit is refused before anything is
recorded. WHERE it asks follows the run, not the workflow: a run launched from
a work item asks on that item, a pull request run on its pull request, and only
a run started at somebody's keyboard asks at a terminal.

A RUN KEEPS A JOURNAL, and everything that is true of the run and not of the
plan goes on it: one line per phase as it closes, every note an agent declared
on an accepted envelope (`for_the_record`: `deviation`, `discovery`, `risk`),
and every word a person typed beside a verdict. It is appended to every agent
prompt rendered afterwards and mirrored to
`asf/data/sessions/<id>/context_handoff/journal.md`.

One timeline and not two lists, because a remark HAPPENS somewhere — at the
`approve_<gate>` phase, between the plan and the build — so a reviewer reads
why the build has a flag the plan never mentioned without being told. What
separates the two markers is authority: `✎` is a person's INSTRUCTION and
outranks the plan; `⚑` is an agent's REPORT and may be judged, but a departure
it accounts for is not unrequested work. A `deviation` that does not say what
it departed from and why is refused at parse time. The agent declares a note;
CODE files it — nothing lets an agent write the journal.

`just show <id>` prints back everything already said to a run, names the
journal file and lists its deviations.

## Request routing

Commands are inline; six requests carry a cookbook as well — onboarding,
install, upgrade, run, connecting a cockpit, uninstall — and those are the ones
whose answer is a decision process rather than a command. Read it before
acting, not after.

| Request | Do |
|---|---|
| onboard / new to the skill / "how do I start?" / "what can it do?" / "how do I …?" across install, setup, cockpit, stations, updating, workflows / "where did I leave off?" | [cookbooks/onboard.md](cookbooks/onboard.md) — **read it first**: `just onboard` says which step they are on, judged by evidence — install, ready and settings, **commit and publish the factory before any cockpit**, cockpit and station, CI, labels, first run — and the decisions that leave no trace are recorded with `just onboard --mark`. Take the steps in order. Never recite it |
| install / set up the factory here | [cookbooks/install.md](cookbooks/install.md) — **read it first**: four decisions belong to the repo, and `install.py` is the only supported way in. Then `uv run <skill>/scripts/install.py --harness claude_code\|pi` and `just doctor`, and after a first install walk the stamped `asf/factory.yaml` with them — budget, model, gates, trusted authors, transcripts, cockpit commands — each with the question tool ([cookbooks/install.md](cookbooks/install.md#the-factorys-settings)) |
| upgrade the factory / "stamped at X · skill is Y" / `asf/.skill-version` missing or older than the skill's / a re-install printed `YOUR CONFIG NAMES OBSOLETE KEYS` | [cookbooks/upgrade.md](cookbooks/upgrade.md) — **read it first**: `install.py --force` refreshes the code and never the operator's `asf/factory.yaml`, so each key a release added (`cockpit.commands`, `worktree.publish`) and each obsolete one (`observability:`, `integration.mode: none`) is a decision put to the engineer, and registering a station is theirs to approve. Never refused meanwhile; `just doctor` prints both versions |
| "is this repo ready to run?" / something failed before the first phase | `just doctor` — every check with its fix, then every workflow checked; spawns nothing. [cookbooks/install.md](cookbooks/install.md#post-install-checklist) |
| run a workflow | `just do "<prompt>"` (sdlc), `just quick`, `just ship`, or `just run <name> "<prompt>" [--hitl all\|none\|plan]` — turning the request into a prompt, watching it, gates, failures: [cookbooks/run_workflow.md](cookbooks/run_workflow.md) |
| work a tracked issue / answer a review | `just issue 42`, `just pr-review 17` — the number, never a prompt; the run reports back on the issue or in the threads |
| an issue nobody can plan from / "what is this actually asking for?" | `just refine 42` — the analyst reads the item and the code, asks what it cannot decide **as a comment on the item**, folds the answers in, writes the agreed requirements into the description and marks it `asf:refined`. Triage, not shipping: nothing is built. It suspends at each question round (exit 75), so it costs nothing while it waits |
| settle an unclear issue AND build it | `just refine-ship 42` (label `asf:refine-ship`) — `issue` with `refine` where its `scout` is. **No scout in this one**, because refine does its own recon inside its loop and hands the findings on in the same run. That does not make `issue` redundant: findings live in the session that made them, so a `refine` today and an `issue` tomorrow are two sessions, and the second gets the agreed requirements without a map of the code — requirements say what must be TRUE, never which files to touch |
| a routing label does nothing / a run died writing `asf:refined` | `just labels` — every label the config names, and whether the forge defines one; `just labels --create` defines the missing ones and nothing else (never edits, never deletes). **A label the forge never heard of cannot be applied by anybody**, so the workflow behind it looks configured and is inert, and `--add-label` on it fails the write it rides on. `just doctor` asks the same question, which is how an upgrade that adds a label gets caught — the installer never rewrites `factory.yaml` |
| start the watchers / "is anything polling?" | `just up` (the station loop, the local cockpit and all three watchers; ctrl-c stops all), `just status`; one poll: `just issues`, `just answers`, `just prs`; cron form: `just issues-watch`, `just answers-watch`, `just prs-watch`. All on by default; `factory.yaml` routes labels (`issues.route`) and turns a path off (`issues.enabled` — which drops the issue AND answer watchers — or `pull_requests.enabled`) |
| two stations (laptops, CI) on one repository / a watcher says an item is "held by" another station / `just issue 42` was refused with "held by" / "the watcher warns only one issues watcher per repository is safe" | The forge label is **not a lock**: two watchers that listed the same queued issue both flip it. With a **shared cockpit** (`ASF_COCKPIT_URL`) every starter — both watchers and `just issue 42` / `just pr-review 17` — asks it for a **claim** before touching a label, and exactly one station gets it; the others leave the item as it is. A claim is held until its session finishes or is aborted, and **kept when it fails** (so `just resume <id>` still works) and while its station is offline. Nothing releases one by the clock: a writer frees it on the session page with **Release claim**, which relabels the item `asf:queued` and abandons that session — a resume of an abandoned session is refused ("abandoned by …"); start the item afresh instead. `--force` (`just issue 42 --force`) starts a run by hand without asking — for recovering, when you know no other station has it. Without a shared cockpit there are no claims: run **one** issues watcher per repository, which is what the warning at its start says. Never pass `--force` on the engineer's behalf |
| a question round or a gate was answered ON THE ITEM and nothing happened | `just answers` — one poll; `just answers-status` lists every run waiting on a tracker answer and who may give it. The poller launches nothing: it resumes runs that are already suspended, and only the ones whose wait says `channel: issue`. Without it a reply sits on the item while the run waits for somebody to type `just answer <id>`. A GATE hears only a reply whose first line is its verdict — `/approve`, `/reject <what should change>` (notes required), `/abort` — and any other reply there is discussion; a cockpit's inbox posts exactly those, as the person signed in, so `issues.trusted_authors` decides as it does for a typed reply. A cockpit's reply names the round and subject it answered and is ignored once the run has moved past them |
| stop a run | `just kill <id>` — agents first, then the workflow; `--force` SIGKILLs |
| tidy up | `just worktrees`, `just worktrees-prune [--force]`, `just worktrees-remove <id>`; branches are never deleted |
| remove the factory from this repo | [cookbooks/uninstall.md](cookbooks/uninstall.md) — `just uninstall --dry-run` first and show the plan; the skill is untouched, the run record goes with `asf/`, and it is the one irreversible thing here |
| which workflows exist / what does X do | `uv run asf/asf.py list`; read `asf/workflows/<name>/workflow.yaml` |
| is this workflow runnable | `uv run asf/asf.py check <name>` — spawns nothing, names every problem |
| what does this factory say it is / what a cockpit shows of it | `uv run asf/asf.py check --json` — the **self-description**: every workflow's trigger, stages, agents with their `tools`/`writes`, gates, the per-session budget, and the settings (routes, gates, how work lands, transcripts, commands, the tracker's project and labels) with every default resolved, as the factory's own code loads them, and every scorer with its classes and threshold resolved (format 3). A cockpit never reads workflow files; this is all it knows of them |
| show the workflows in the cockpit / "the factory says unchecked" / a CI check for the config | the optional CI workflow: `install.py --harness <h> --ci` stamps `.github/workflows/asf-check.yml` (`check --json --ship` on pull requests and default-branch pushes); the repo sets `vars.ASF_COCKPIT_URL` and `secrets.ASF_COCKPIT_TOKEN` — a token a repository admin issues on the factory's Stations tab ([cookbooks/connect_cockpit.md](cookbooks/connect_cockpit.md#ci)). With a **team cockpit** it comes with connecting: stamp it unasked and say why (it keeps the description the first registration sent current, from the default branch). With only a local one, ask with the question tool — a repository's CI is its own. [cookbooks/install.md](cookbooks/install.md#run-it) |
| "how much of our merged work needed no human push?" / the cockpit's Measure tab is empty / autonomy is 0% | The factory page's **Measure** tab, Metrics: pull requests opened and merged over the period, and autonomy — the share of merged pull requests that were autonomous (`CONTEXT.md`). A merge reaches the cockpit only as the `pull_request_closed` the PR watcher records when it reaps the session (`just prs`, or `just up`; `pull_requests.enabled` and `reap_merged` on), so a factory nobody runs the watcher for shows nothing merged until `just score [--since 2026-10-01]` asks the forge how each session's unrecorded pull request ended and records the same event — only the record: it releases nothing and needs no watcher on, and a second run adds nothing. The watcher's first pass after an upgrade records every pull request the factory opened that has since closed, 20 a pass. A pull request counts as opened only when its session's integration opened it (`pull_request_opened`) — one a person opened from the branch is never autonomous — and a person's push onto it costs it its autonomy, where a review round driven by their comments or an "Update branch" merge does not. Never "fix" the number by editing a session's record |
| "which part of our pull requests' cycle is slow?" / "what does a PR cost us?" / "which PRs were the most expensive?" / chapters by trigger | The same Metrics view, over the pull requests that merged in the period: **PR cycle time** as a median per leg (kickoff → PR → first review → merge) and for the whole; **cost per PR** as a median by cost component and by size — S/M/L/XL at 100, 500 and 1,000 changed lines, which the `pull_request_closed` v2 the watcher and `just score` record now carries (`additions`, `deletions`); a session that opened more than one pull request is split evenly between them — and the five most expensive pull requests, each linking to its session. What a scorer's judge or a benchmark costs is measurement, recorded apart (`chapter_scored`'s `usage`), and never in cost per PR. Under them, the chapters that started in the period counted by trigger: a prompt, an issue, a pull request's review. The split by workflow is the Overview's. A pull request closed before this release has no size: it is counted, in no size |
| create or change a workflow | copy the closest directory under `asf/workflows/` (or edit one), edit `workflow.yaml`, run `check`. Read [references/design.md](references/design.md) first |
| tailor an agent's TASK for one workflow | add `asf/workflows/<name>/tasks/<key>.md` — keys are the stage's TASKS (scout, plan, implement, fix, review, revise, document, recon, ask, refine). Keep the `## Report` block matching the type; `check` verifies it. `pr-review/tasks/implement.md` is the shipped example |
| tailor an agent's IDENTITY for one workflow | bind it in `workflow.yaml` under `agents:` with `system_append: [agents/<x>.md]` — append, never replace |
| change an agent for every workflow | edit `asf/agents/<name>/agent.md` — the frontmatter is the boundary, the prose is the voice |
| measure a workflow / add a scorer / "how was this chapter judged?" / "does the builder keep needing corrections?" | a directory `asf/scorers/<name>/` with one `scorer.md`: `workflow:`, optional `focus:` (one of its agents), `kind: code` and a `predicate:` from the closed set — `corrections_above(n)`, `permission_rolled_back`, `limit_hit` (or `limit_hit(tokens|cost|timeout)`), `not_accepted`, `review_chapters_above(k)` (review rounds, counted per session) — then `just check`, which refuses a malformed one. A stamp ships four on `issue`, turned on: `corrections` (`corrections_above(2)`), `permission-rollbacks`, `limit-hits`, `not-accepted`; change or delete them like any scorer. Every chapter of that workflow is scored once it ends, as a `chapter_scored` on the session's record (the cockpit shows it under the chapter, and the factory page's Measure tab, **Scorers**, shows each scorer over the factory's last 30 sessions with the sessions counted toward its threshold); the score never changes how the chapter ended. A chapter that ended before a scorer existed gets its score from `just score [--since 2026-10-01] [--scorer <name>]` — a baseline from the sessions on disk, which a second run adds nothing to. A criterion that must block work is a gate, not a scorer. The threshold for "this keeps failing" is `self_improvement:` in factory.yaml, or the scorer's own `improve_after:`. [references/design.md](references/design.md#scorers) |
| add a stage to the vocabulary | a directory under `asf/stages/` meeting the contract in `asf/engine/stage.py`; [references/design.md](references/design.md#stages) |
| pick a failed run back up | `just resume <id>` — replays recorded agent phases, re-runs what code owns |
| "why did this session stop?" / it hit its budget or timed out / "an agent's changes were undone" / the phases passed but the session failed | The session's events say it as a fact: `limit_hit` (a `budget:` ceiling or `harness.timeout_seconds`, with the limit and the value that met it), `permission_rolled_back` (an agent wrote outside its `writes:`; the paths rolled back and the ones left as they were), or `workflow_finished` with `accepted: false` (every phase passed, and the workflow refused the chapter — its `reason` says why). A resume meets the same ceiling and the same boundary; raising either is the engineer's call in a reviewed file. [cookbooks/run_workflow.md](cookbooks/run_workflow.md#when-a-run-fails) |
| a run is waiting at a gate / "why is this run waiting?" | `just pending`, `just show <id>`, then `just approve <id> [-m]`, `just reject <id> -m "..."` or `just abort <id>`. A run on a tracked issue can also be answered there — a reply opening with `/approve`, `/reject …` or `/abort`, or from a cockpit's inbox — and `just answers` picks it up. Never approve, and never post such a reply, on the engineer's behalf |
| a run is waiting on QUESTIONS (`kind: questions` in `just show`) | `just answer <id> -m "..."` supplies what is missing; `just approve <id>` takes every recommendation as it stands. There is nothing to `reject` — the agent asked, it did not claim. The questions are also a comment on the work item, and an answer there does the same thing — any reply is an answer, `/approve` takes every recommendation and `/abort` ends the run. Never answer on the engineer's behalf |
| connect this repo to our cockpit / "where do I get an ingest token?" / "what is the setup code?" / register this station / a CI token for the cockpit | [cookbooks/connect_cockpit.md](cookbooks/connect_cockpit.md) — **read it first**: local or shared, the operator's once-per-cockpit setup (deploy, setup code by deployment, the GitHub App), then per checkout only `ASF_COCKPIT_URL` and `just station-register`, which a person with write approves in the cockpit and which hands the station its ingest token and, the first time, describes the factory — never approve it for them. The CI check comes with a team cockpit: stamp it and say why. CI's token is issued by a repository admin on the factory's Stations tab. Every failure, with its cause and fix |
| ship runs to a cockpit / "why isn't my run in the cockpit?" | set `ASF_COCKPIT_URL` (the backend's site origin, e.g. `http://127.0.0.1:3211`) in `.env` and register the station ([cookbooks/connect_cockpit.md](cookbooks/connect_cockpit.md)), or set `ASF_COCKPIT_TOKEN` (the factory's ingest token, which wins when set); from then on every run and every `approve`/`reject`/`answer`/`abort` ships its session's events from a background thread, and never waits on the cockpit. `just station-sync` sends whatever a cockpit has not acknowledged — every session, from its acknowledged seq — and is a CI job's last step; it fails only when the cockpit refuses the token. A cockpit that was down loses nothing: sync again. Unset, a run ships nothing and is exactly as before. `ASF_STATION_NAME` renames this checkout from `<login>@<host>:<dir>` |
| kill, resume, answer or run from the cockpit / "why is Kill (Resume, Approve, Run) greyed out?" / register this station | A cockpit **commands** a station only when three things hold: `asf/factory.yaml` lists the verb under `cockpit.commands` (a fresh stamp lists `[answer, abort, kill, resume]`; `run` is off unless listed; it is the repository's decision, made in a reviewed file — never add a verb on the engineer's behalf), the station is **registered** to a person, and that person's login passes `issues.trusted_authors` (empty: anyone the cockpit lets ask, which is a writer). Registering is [cookbooks/connect_cockpit.md](cookbooks/connect_cockpit.md) — never approve a code for them. A local cockpit's station is its owner's already. The station loop (`just up`) and every run's own shipper poll for commands. `kill` stops a run through its own handler; `resume` relaunches a failed session with `asf resume` on the station holding it (a CI session cannot be: it is re-triggered from the forge); `answer`/`abort` decide a gate that waits on no work item (a prompt run's) as the person who sent it — a gate on an issue is answered on the issue — and are refused once the gate, round or subject moved on; `run` starts a prompt workflow only on a station of the person asking. Each outcome is in `asf/data/commands/<id>.json` and the cockpit shows the station's `command_result`. A station that refuses says why; revoking its token under Stations stops every command reaching it. A CI station takes none |
| "what does the cockpit get to see?" / show prompts and agent output in the cockpit | A session's events, always: its chapters (one per workflow it passes through), phases, gates and decisions, spend, each commit's sha, the handoff files its phases wrote (inline, cut at 256 KB; a repo file only as a path, read from the forge), and each tool call's name, outcome and duration — **never a tool's arguments or its result**. The rest is the **transcript** — every prompt an agent was sent and its harness's raw output, tool arguments and results included — and it is written only when `asf/factory.yaml` says `cockpit: {transcripts: true}`. That is the repository's decision, made in a reviewed file: never turn it on on the engineer's behalf, and say what it sends before they do. A cockpit keeps a transcript 30 days after its session finishes (the deployment's maximum) and then ages it out; `cockpit.transcript_retention_days` can only shorten that. Everything else is kept until an admin purges a session's bodies, or an owner the factory's |
| a run pushed its branch before it was done / the cockpit cannot show what a gate asks about / a run was refused with "cannot publish" | All three are `worktree.publish` in `asf/factory.yaml` (`just doctor` prints the value in force and why). `on_create` — the default once a cockpit is configured — pushes the branch to `worktree.integration.remote` as the session starts, together with the commit it was cut from, and again before every suspend with the gate's subject committed; that push failing is what "cannot publish" means, and the run is refused before a branch or a worktree exists. `on_integrate` — the default without a cockpit — pushes nothing until an `integrate` stage does, and a cockpit then has nothing to show at that session's gates. Which one a repository wants is its own decision: ask with the question tool, each option saying what it does, and set what they choose. A published branch that was never integrated is removed from the remote when its session finishes or is aborted — one with a pull request, one pushed with `-u`, or one merged into its base is kept. What the factory cannot see is a pull request somebody opened on the forge while the session was still working: say so before an `abort` of such a session, because deleting its branch closes that pull request. Never delete or re-push a branch by hand to "fix" a waiting run |
| `worktree.integration.mode: none` refused (or `integrate: {mode: none}` in a workflow) | Refused since 1.2 — every command that loads the config says so, `asf check` names a workflow that says it, and nothing runs until it is changed. `none` meant two things, and each has its own switch now: a workflow that should land nothing drops its `integrate` stage, and `worktree.publish: on_integrate` keeps a branch off the remote until it is integrated. Otherwise `mode: pr`, with `open_pr: false` to push and open nothing. Ask which was meant with the question tool, one option per meaning — do not remap it on the engineer's behalf |
| "where is the cockpit?" / `asf up` said "no local cockpit" | Without `ASF_COCKPIT_URL`, `just up` starts a **local cockpit** at `http://localhost:3000` — the same published images a team deploys, run through the stamped `asf/cockpit/compose.yaml` on Docker — and its station loop ships every session on this checkout to it (the token is issued and kept in `asf/data/cockpit.json` by itself). With `ASF_COCKPIT_URL` set it starts none and ships to that one. It is one per machine: an `up` that finds a newer one running joins it rather than downgrading it, and the `up` that started it owns it. No Docker: `up` warns, drops the cockpit and runs the watchers anyway; `just doctor` names what is missing and which cockpit version it would run. `asf/cockpit/min-version` is the oldest cockpit this stamp ships to; `ASF_COCKPIT_VERSION` in `.env` can only name a newer one. `just station` is the loop without watchers |
| the local cockpit's Factories page is missing a repository / "no token to ask the forge with" | A local cockpit has no sign-in: it asks the forge **as the engineer**, with the token `gh auth token` prints (for `GH_HOST`, else github.com). `just up` hands it over in the `cockpit` child's environment when it starts the cockpit — never on a command line, never into `.env` — the cockpit keeps it in its own backend on this machine (the `asf-cockpit` compose project's `data` volume), and the Factories page then lists every repository that token reaches whose default branch holds `asf/factory.yaml`, stations or not. `up` prints a `forge` line saying which it was, and `just doctor`'s `cockpit forge` line says it beforehand. No token: the page shows only the factories this machine's stations ship from; `gh auth login`, then start `up` again. It is the engineer's own credential — say that it is handed to the cockpit container before they start one, and never log in, or paste a token anywhere, on their behalf. A **shared** cockpit takes no token from a station: people sign in to it with their team's GitHub App, and see a factory's sessions only if the forge lets them read its repository |
| watch a run | the cockpit (`just up`, above); `just sessions` (the newest, from their `run.json`), `just tail <id>` (its `events.jsonl`) |

## Hard rules

1. **A workflow is refused before it costs anything.** `check` and `run` load
   the whole directory first: unknown stage, unknown option, a `verify` with no
   build before it, an agent the roster lacks, a task whose report block
   drifted from the envelope type, a binding that widens `writes` or `tools`.
2. **The vocabulary is closed.** No `loop:` or `if:` in workflow.yaml, ever. A
   shape the vocabulary cannot express is a new stage in Python, or a
   `workflow.py` escape hatch (not built — nothing has needed one).
3. **Bindings narrow, never widen.** The roster is the security boundary; a
   workflow is edited often.
4. **Identity is appended, never replaced.** Five workflows must not become
   five builders.
5. **Tasks carry the words, stages carry the facts.** A stage passes
   `{{variables}}`; no prose lives in Python.
6. **The engine's rules hold under every workflow.** An agent answers with a
   typed envelope or the phase fails; gates verify its claims against the
   tree; `writes:` and `protected_files` are enforced in code after every
   call; every phase carries a description; a run ends through
   `run.finish(accepted=)` and nowhere else.
7. **A scorer measures, a gate decides.** A score is recorded beside the
   chapter it judges and never changes how that chapter ended; a scorer that
   cannot run is skipped, not fatal. Never turn a score into a reason to fail
   or block work — a criterion that must block is a gate, in Python.

## What is here, and what is not

Three slices: the eight stages; `sdlc`, `quick`, `ship`, `issue` and
`pr-review`; the loader and runner with the three inputs; the gate CLI;
doctor; both watchers, `up` (the station loop), `status`, `kill`, the worktree verbs; the
justfile; uninstall. Not ported: a `workflow.py` escape hatch — nothing has
needed one yet, `pr-review` fit the vocabulary with one option. The
cockpit does not ship with the skill: `asf up` runs its published images
(ADR 0004).

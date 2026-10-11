# Design: workflows as directories over a closed vocabulary

What agentic-sf is, the rules that hold it together, and why each exists.

## The problem it answers

The obvious shape for an agent factory is one script per workflow, and it
asks the engineer, on day one, which of a dozen. "Copy the closest and edit
the phase list" does not work, because a hundred-line chain is not a list:
its value is the fix loop, the retest-only-if-revised, the commit-after-green
— the wiring *between* phases. And an agent's behaviour for a given task ends
up spread over many places (a roster entry, a system prompt, a user prompt,
the output type, the call site, prose constants in Python, gates in config),
because a per-agent user prompt is the wrong owner when the task is per
stage.

## What Warp got right, and what to take

Warp Factories define a factory as `factory.yaml` plus an agents directory,
and route work through a *fixed* set of stages with a foreman agent choosing
the path. The manifest is inventory and policy, never a pipeline. asf takes
the manifest and the fixed vocabulary; it does not take the in-run foreman.
The stage sequence stays deterministic code, chosen before the run by a
person or the orchestrator session. Agent proposes, code disposes.

## Three layers, three owners

| Layer | Where | Owns | Edited |
|---|---|---|---|
| A · Roster | `asf/agents/<name>/` | identity, harness (model, tools, skills, context), `writes` — the security boundary | rarely, reviewed |
| B · Stages | `asf/stages/<name>/` | the contract, loops, conditions, default task files | when the vocabulary grows |
| C · Workflows | `asf/workflows/<name>/` | which stages, options, agent bindings, task overrides | often |

### Agents

```
asf/agents/planner/
  agent.md        frontmatter: purpose, color, writes, harness: {…}   (name = directory)
                  body: who the agent is
  agent.pi.md     optional: the identity for one harness, when it must differ — prose only
```

One file, two readers. `engine.factory` parses the frontmatter and enforces
it; `engine.prompts` strips it and hands the model the body. The same shape
as a Claude Code subagent file. No `user.md`: the task belongs to the stage.

What an agent runs on is one `harness:` block, the same block factory.yaml
opens with and a workflow binding narrows: `name`, `model`, `thinking`,
`timeout_seconds`, `tools`, `skills`, `context`, `harness_engineering`,
`options`. `purpose`, `color` and `writes` stay flat — they are the engine's.
`agents.merge_harness` lays the agent's block over factory.yaml's: on the same
harness a list replaces and `options` merge key by key; on another harness
only `thinking`, `timeout_seconds`, `skills` and `context` cross over, because
a model, a tool name or an option is one harness's vocabulary.

Nothing on the operator's machine reaches an agent unless a block names it.
`skills: [tdd]` resolves to `.claude/skills/tdd/` or `.agents/skills/tdd/` in
the main checkout (never `~/.claude`), and on Claude Code arrives as a plugin
directory holding exactly those skills, with `Skill` added to the tools — which
is why `Skill` written in `tools:` is refused. `context: [CLAUDE.md]` is
appended by the engine after the identity, under a heading naming the file, on
any harness. A skill or context file that resolves nowhere is refused at load,
and so are skills on a harness that cannot load them (pi, for now).

### Stages

A stage module declares `NAME, KIND, OUTPUT, NEEDS, TASKS, Options, run` and
optionally `check` and `warn`. `Options` is a pydantic model with `extra="forbid"`.
`NEEDS` is what must precede it; `OUTPUT` is what it hands on, or `None` to
pass the previous envelope through. `TASKS` maps a key to `(default file,
envelope type the agent answers with)`; the two can differ from `OUTPUT` —
`review` asks its reviewer for a `ReviewOutput` and hands on the
`BuildOutput` as revised. A workflow overrides a task with `tasks/<key>.md`,
and the report check runs against the task's own type.

The loader walks the stage list with a "current envelope type" and refuses a
stage whose `NEEDS` the chain does not satisfy. `NEEDS = ()` means "anything
or nothing": `plan` takes a `ScoutOutput` as its `previous` when a `scout`
runs first, and its task tells the planner to read the findings as recon,
not as a plan. `check(opts, earlier)` lets a
stage add its own static rule: `commit` requires `of:` to name an earlier
stage whose output carries `commit_message`. `warn(opts)` is for what loads
today and will not in a later release — `integrate` says so about `mode:
none` — and `check` prints it without refusing anything. `GATE` names the gate a
stage places (`plan`, `integrate`; `refine`'s `requirements`, with `GATE_KIND =
"questions"` for a question round), so the factory's self-description — `asf
check --json`, the only account of a workflow a cockpit reads — shows where a
run may stop for a person and whether that gate is on.

`ctx.current(stage_name)` returns that stage's work product *as it stands
now*: after `verify`, the build is the fixed build. `commit: {of: implement}` lands
that one.

A stage that must end the run without failing its phase raises `StageStop`.
The runner finishes the run as not accepted, with the reason, and nothing after
it runs.

**A stage owns its loops.** `verify` owns its fix loop, `review` its revise
rounds, and `refine` its question rounds — because the YAML has no `loop:` and
no `if:` (rule 7), and because what decides whether another round is needed is
not policy a workflow should vary but a judgement the code makes from what the
last round produced. `refine` is the clearest case: it asks a person, suspends,
and the thing that decides whether to ask again is the analyst's own answer to
what it just heard. A workflow gets the ceiling (`max_rounds`), never the
condition.

Which chain a stage belongs in is decided by WHAT TRAVELS BETWEEN RUNS, not by
what reads well in a list. `refine-ship` drops the scout because refine's recon
is already on the envelope it hands to `plan` — same run, same session. `issue`
keeps it, because a `refine` run and an `issue` run are two sessions: the second
re-fetches the item and gets the agreed requirements back in the description,
with no findings, since requirements deliberately say what must be TRUE and
never which files to touch. A stage looks redundant from the workflow file and
is not; the question to ask is which session produced the thing it would repeat.

`refine` also shows why a stage sometimes does a job another stage already
does. It runs its own recon rather than sitting behind `scout`, because a
single pass before the loop searches against the reporter's guess: once a
person says which code is really involved, findings gathered before that
describe the wrong files. So recon moves inside the loop, and the analyst
ORDERS it (`needs_recon`, `recon_focus`) while the code decides whether to
spend it. The same envelope-appending trick `scout` uses carries the
accumulated material — the reporter's words, the findings, the draft, the
answers — through the one `previous` slot every agent handoff has, each part
with a note saying where it came from, because that is what decides how much
of it to believe.

### Workflows

```yaml
name: ship
description: one line — it is what `list` shows
input: prompt
agents:
  planner: {from: planner, harness: {model: sonnet}, system_append: [agents/planner.md]}
  fixer:   {from: builder, harness: {thinking: high, skills: []}, writes: [src/]}
stages:
  - plan:   {agent: planner, hitl: true}
  - commit: {of: plan}
  - implement: {agent: builder}
  - verify: {blocks: [test, lint], max_fix_loops: 3, fix: {agent: fixer}}
  - commit: {of: implement}
```

`input:` is where the request comes from, and it is the runner's business,
not a stage's: `prompt` (the default) records the text; `issue` reads the
work item before the first stage and comments the outcome after the last;
`pr` reads the pull request BEFORE a session exists — its branch names the
session to join — and answers the threads after the last stage. The
stranger's text reaches the first stage as `ctx.previous`, an envelope whose
artifact is the text with its framing, and the operator's instruction is
`ctx.prompt`. So `issue` is `ship` with `input: issue`, and `pr-review` is
implement → verify → commit with a task override and `allow_clean: true` on
the commit — the option that gives a review run its third outcome
(`declined`: an accepted run whose tree the builder did not touch, on
purpose). Nothing in a workflow file can make an issue-triggered run merge;
`integration` downgrades it to a pull request in code.

Rules, enforced at load:

1. **Vocabulary is closed.** A stage name must be a directory under
   `asf/stages/`. No control flow keys exist.
2. **Bindings narrow.** `writes`, and the `tools`, `skills` and `context` of a
   binding's `harness:` block, must be covered by the roster's; `None` in the
   roster (unrestricted) is narrowed by anything. `model`, `thinking` and
   `timeout_seconds` replace; the harness's `name`, `options` and
   `harness_engineering` cannot be bound at all.
3. **Identity appends.** `system_append` is a list of files under the workflow
   directory; `system` is not a binding key.
4. **Tasks are checked against types.** The `## Report` JSON block of every
   task file is compared with the stage's `OUTPUT` model: no unknown keys, no
   missing required ones, and the three placeholders present.
5. **Gates layer.** `--hitl` on the command line, then the stage's `hitl:`
   option, then factory.yaml's `hitl:` block.
6. **What a run learns about itself travels forward, on one timeline.**
   `engine/journal.py` keeps a line per closed phase, every `for_the_record`
   note an agent declared on an accepted envelope, and every word a person
   typed beside a verdict — and `agents.execute` appends the lot to each later
   prompt. Not through a `{{placeholder}}`: a task file that forgot to name one
   would silently drop what somebody asked for.

   One record and not two, because a remark HAPPENS somewhere — at the
   `approve_<gate>` phase, between the plan and the build — and on a timeline
   that is visible without anyone explaining it. What separates a remark from a
   note is authority, not storage: a note is a report and may be judged, a
   remark is an instruction and may not. The preamble spends its words there;
   the code has one `file()`.

   The agent proposes a note and code files it, which is rule 1 applied to the
   record itself. A `deviation` must name `instead_of` and `because`, and
   `data_types.Note` refuses one that does not — at parse time, so the
   correction re-enters the same session wherever the field exists rather than
   only where a stage remembered to list a gate.

### Scorers

A scorer is a team's judgement of a finished **chapter** of one workflow (`CONTEXT.md`): one
`asf/scorers/<name>/scorer.md`, frontmatter for the engine and prose for the criteria, the way an
agent is one `agent.md`. Its name is the directory's.

```yaml
---
workflow: issue                    # required: the one workflow whose chapters it judges
focus: builder                     # optional: one of that workflow's agents; else the whole chapter
kind: code                         # code | judge
predicate: corrections_above(2)    # code: one predicate from the closed set
improve_after: {failures: 3, of_last: 10}   # optional: this scorer's own threshold
---
# Corrections

A builder that needs more than two corrections a chapter is guessing at its task.
```

A **code** scorer names a predicate, a pure function over the chapter's domain events whose
classes are fixed; it costs nothing. `corrections_above(n)` counts the times an agent's answer
was refused and sent back to the same session — an envelope that did not parse
(`envelope_rejected`), or a round of its gates that failed (`gate_result`, one per gate, so a
round counts once) — and is `above` (failing) past `n`, `within` otherwise; with `focus`, only that
agent's. The rest of the closed set reads the failures that are facts of their own (below, under the
engine): `permission_rolled_back` is `rolled_back` (failing) when an agent's writes outside its
boundary were undone, `clean` otherwise; `limit_hit`, or `limit_hit(tokens|cost|timeout)` for one
kind, is `hit` (failing) when a limit stopped a phase, `none` otherwise — both narrowed by `focus`,
both citing each event. `not_accepted` is `not_accepted` (failing) when the chapter's latest
`workflow_finished` says `accepted: false`, `accepted` otherwise — a chapter whose phase failed was
never judged, and is not counted. `review_chapters_above(k)` is the one counted per session: on the
chapter being scored, the session's latest, it counts every chapter opened on a pull request's
review (`workflow_started`, `input: pr`) up to and including it, and is `above` (failing) past `k`;
its evidence is those openings, earlier chapters' included. The last two judge the whole chapter,
and `check` refuses them a `focus`. A **judge** declares its own `classes`, each `{name, fail}`, how often it judges
(`sample_rate`, 0 to 1, every chapter when unset) and optionally a `model`; its prose is the
criteria, and the scorer file holds nothing else.

```yaml
---
workflow: issue
focus: reviewer
kind: judge
classes:
  - {name: checked_both, fail: false}
  - {name: plan_only, fail: true}
sample_rate: 0.2
---
Did the reviewer judge the code that was written, or only the plan it was written from?
```

Every judge scorer is run by one shipped roster agent, `asf/agents/judge/agent.md`, the same on
pi and claude_code, on a task the engine owns (`asf/engine/judge.md`, beside `engine/judge.py`
that calls it): the criteria, the classes, the chapter's events by seq, its commits, and where the
session's record is. It reads everything the station has — envelopes, the journal, the diff at each
committed sha (`git show`), prompts and raw output — and answers `JudgeOutput`, `{class,
reasoning, evidence}`. The triad holds as for a stage: the `EnvelopeBase` subclass, the task's
`## Report` block (`asf check` refuses the judge's scorers when it drifts) and `output_type=` at
the call. It runs under the factory's permissions with `writes: []`, whatever its agent.md says,
in a checkout of its own: a detached worktree at the chapter's last commit, outside the
repository, removed once it answers — never the station's main checkout, where rolling back what
changed during the call could roll back the operator's own edits. Its gates check what code can
(invariant 4): the class is one its scorer declares, and it cites at least one seq, every one an
event of the judged session (`evidence_exists`) and of the judged chapter (`evidence_in_chapter`). A failed gate re-prompts the same judge session, twice
at most; a judge that never satisfies them, or cannot start, leaves no score and says so.

A judge runs on a run of its own whose record lies **inside** the judged session's directory,
under `judges/c<chapter>-<scorer>-at-<seq>/`: its phase, gates, prompts, spend and envelope —
its reasoning with it — none of them an event of the session. The session gets one event, the
`chapter_scored` its envelope becomes, whose `usage` is what judging cost: measurement, never the
work's, and never a `usage` event the session's cost per PR would count. `reasoning` rides on that
event (v2) only under `cockpit: {transcripts: true}`, because it quotes what the judge read; without
the opt-in it is absent from the event and stays in the judge's record. Which chapters a judge
samples is drawn from a hash of the scorer, the session and the chapter, never at random: the same
answer every time it is asked, so `asf score` passes over an unsampled chapter as surely as the run
that ended it, and a higher rate keeps every chapter a lower one drew. A chapter not sampled has no
event at all. **A stamp ships one judge, `reviewer-scope`, at `sample_rate: 0`**: checked by `asf
check`, shown as inactive on the Scorers view, and judging nothing until the team gives it a rate.

Judging is paid from a budget of its own, never the work's (ADR 0006): `measurement: {usd_per_day:
5}` in factory.yaml, one UTC day's spend for judges, self-improvement's diagnoses and benchmarks alike, which the self-description
(format 4) carries resolved under `settings.measure.measurement`. It is checked before every judge
call (`engine/measurement.py`), against what every judge that started that day cost — read off the
judges' own records under each session's `judges/`, a judge that gave no score included, never off
a ledger of its own. Once the day's spend has reached the budget no judge starts: the chapter gets a
`chapter_not_judged` `{chapter, scorer, reason: "budget", day, spent, budget}` and its code scores
as usual, and `asf score` judges it on a later day with budget left — saying it again on the console
until then, but not on the record. A judge that started under the budget runs to its end, so the
last one can overrun it; two processes judging at once can each find budget left. A cockpit learns
what judging cost only from the scores' `usage`, so a judge that gave no score is in the station's
check and not in the cockpit's Measurement cost — nor is a self-improvement diagnosis, which the
same budget pays for and which no event carries (`asf/data/diagnoses/`, below). `usd_per_day: 0`
judges nothing — unlike `budget:`, 0 is not "no ceiling". A chapter its judge did not sample still
has no event: it was never going to be judged.

When a chapter ends — accepted, refused, or a phase failed — the station scores it with every
scorer bound to its workflow — the code scorers first, then each judge that samples it — after its
`workflow_finished` (`scorers.after_chapter`, from
`workflow.run`). Each score is a `chapter_scored` on the judged session's own record: the scorer,
its class, whether that class is failing, and the seqs of the events it rests on, every one in
that chapter — or, for `review_chapters_above`, in the session's chapters up to it. **A score never changes how the chapter ended** — a scorer measures, a gate decides
(ADR 0006) — and a scorer that cannot run is said on the console and skipped. A criterion that
must block work is not a scorer; it is a gate, in Python. A chapter stopped at a gate has not
ended, and is scored by the process that ends it.

A chapter that ended before its scorer existed is scored by `asf score [--since DATE] [--scorer
NAME]` (`scorers.backfill`), so a new scorer has a baseline from the sessions already on disk. It
walks the sessions started since, and scores every chapter that has ended — and was not resumed
since — with each chosen scorer bound to its workflow that has no score of it after its latest
`workflow_finished`, a judge only on the chapters it samples; a second pass adds nothing, and a chapter resumed and ended again is
scored on how it ended last. The predicate reads that chapter's own lines, which no later event
joins, so a late code score is the score the chapter would have had as it ended; a judge reads the
session's record as it is now, and cites only the chapter's own events. Each lands on the
session's record after its `session_finished`, the way a pull request's close does, and is
flushed to a cockpit at once. `--scorer` names the scorers to run, and a name no scorer has is
refused before anything is scored. Then the same command records the pull requests no watcher
saw close (§ below).

`asf check` refuses a scorer before it costs anything: a workflow the factory does not load, a
focus that is not one of its agents, a predicate outside the closed set, a judge with no failing
class or a `sample_rate` outside 0..1, a judge's key on a code scorer, a threshold that can never
be met, and a judge no judge could run: the roster has no `judge` agent, or its task's `## Report`
no longer matches `JudgeOutput`. A run reads its scorers through the same `scorers.load`, so a scorer `check` accepts is
one a run scores with. The self-description (format 3) lists each scorer with what it left
unsaid resolved — a predicate's classes, the share of chapters it judges, the threshold that
applies to it — and the factory-wide threshold under `settings.measure`.

The threshold is when one scorer's failing scores stop being a bad day: `self_improvement:
{failures: 3, of_last: 10}` in `factory.yaml` for every scorer, and a scorer's own
`improve_after:` for a stricter or looser one. A scorer is **the operator's**: `install.py
--force` never rewrites anything under `asf/scorers/`.

### Self-improvement

At the threshold the factory files an **issue on its own tracker** (`engine/improve.py`, ADR
0006) — never a pull request, and never a change to itself. It runs on the station, after a
failing score is recorded: by the process that ended the chapter, and by `asf score` once it has
scored every session, so a baseline's failures file one issue with all of them. A passing score
asks nothing of the forge.

- **The window** is the last `of_last` distinct sessions the scorer judged, by when each started —
  the sessions the Scorers view counts — and a session fails when any of its chapters' latest
  score does, so several failing chapters of one session count once. Below the threshold it says
  so on the console (`scorer <name> failed on 1 of the last 4 sessions it judged; an issue is
  filed at 3 of the last 10`) and asks nothing of the forge.
- **A merge starts the count again.** Once a pull request for the scorer's issue merges, only
  chapters that started after it count (`… sessions it judged since #14 merged`), so the failures
  it was meant to fix never file another issue. The merge is read off events, on the station as
  in a cockpit: a session that worked an issue labelled `asf:improve:<scorer>` says so in its
  `provenance_recorded` (v3, `improves`), and its `pull_request_closed` says when it merged. A
  station counts from the merges it holds the record of — the PR watcher's, or `asf score`'s
  backfill of a close no watcher saw.
- **At most one open issue per scorer**, labelled `asf:improve:<scorer>`. Before filing, the
  station lists the open issues carrying that label (`issues.list_command`); if there is one, it
  comments with the failing sessions the issue does not cite yet, and says nothing when it cites
  them all. Which sessions a body or a comment cites is written in it, in an `<!-- asf:improve
  … sessions=… -->` mark, so the tracker is the only state two stations share. A listing that
  fails files nothing: "there is none" from a search that never ran is how an issue is filed
  twice.
- **The issue** stands on its own: the pattern and the threshold that applied, the scorer's
  criteria (its file, workflow, focus, kind, classes and prose), and each failing session newest
  first, with each failing chapter's class and the events its evidence cites — kind and payload,
  cut to fit a tracker's body. A tracker may be public, and the transcripts opt-in is a
  cockpit's: a cited `prompt_rendered` or `harness_output` is named by seq and kind only, and a
  judge's reasoning never leaves the session's record (invariant 11). The station defines the label the first time (`issues.labels_create_command`),
  then files it with `issues.create_command` (`gh issue create`).
- **On the record**: what was filed — or added to an open issue — is an `improvement_filed`
  (`{scorer, number, url, title, commented, sessions, cause, surface, not_diagnosed}`) appended to
  the newest failing session it cites, a late event like the score, flushed to a cockpit as it is
  written. The cockpit's Scorers view draws the scorer's issue from it — the Issue column as a
  forge reference, never a green dot; a card with its title, its pull request's state from the
  improving session's events and its diagnosis clamped to two lines; a purple rule on the strip
  where it merged; past issues in the footer — and asks the forge nothing (ADR 0006). An issue is
  open until a pull request for it merges or a newer one is filed for the scorer.
- **Queued like any other**: it carries the route label whose workflow is `issue` and
  `issues.states.queued`, so the issues watcher takes it into the `issue` workflow, where a person
  approves its plan and merges its pull request. A config with no route to `issue` files it
  unqueued, and says so. `issues.enabled: false` files nothing, and says so.
- **Diagnosed before it is filed** (`engine/diagnose.py`): one bounded agent phase, the
  `diagnostician`, reads the failing sessions' directories and answers a `DiagnosisOutput` —
  `{cause, surface: factory|application, files, proposed_change, upstreamable}` — which the body
  carries under `## Diagnosis`, ahead of the criteria. It runs with `writes: []` whatever the
  roster says, in a detached checkout of the station's `HEAD` outside the repository, removed once
  it answers, like a judge; the sessions' records are outside that tree, read and never written.
  Its gates (invariant 4): every file is one the repository has at that `HEAD`, inside it, and at
  least one is named (`files_exist`); `surface` is `factory` when every file is under `asf/` and
  `application` when none is (`surface_agrees`). A failed gate re-prompts the same session, twice
  at most. Then **code rules**, never the model:
  - **factory code** — any `.py` under `asf/` — is where every gate is and what decides
    acceptance: it is **reported**, never proposed, because a change to what blocks work is a
    person's deliberate change, in code. Named beside other files, the proposed change is
    headed as being for those files only;
  - a **stage's own task file** of the scorer's workflow, when the skill owns it, is
    **redirected** to the workflow's override, `asf/workflows/<workflow>/tasks/<key>.md`
    (`engine/tasks.py`), in the file list and in the proposed change's own words, so the fix
    survives the next `install.py --force` — unless the skill stamps that override too (as it
    does `pr-review`'s `implement`), when the change stays where it was named;
  - any file **the skill owns** marks the diagnosis **upstreamable** — as does the diagnostician,
    of a change to the factory — a note for a person to carry the change to the skill; nothing
    files anything upstream.

  What the skill owns is `asf/.skill-files`, which `install.py` writes on every run: every file
  under `asf/` a `--force` overwrites (the scorers are not among them). A factory stamped before
  it holds everything under `asf/` but `factory.yaml` and `asf/scorers/` to be the skill's.

  A diagnosis keeps its record in a directory of its own, `asf/data/diagnoses/<scorer>-<when>/`,
  in no session — it is about a scorer, across sessions — and is paid from the measurement budget,
  checked before it starts. Once the day's is spent, or when no diagnosis could be made (no
  `diagnostician`, an answer the gates never accepted), the issue is filed undiagnosed and says
  why: the evidence is worth filing either way. New evidence for an open issue is a comment, and is
  not diagnosed again. What it writes goes on a tracker that may be public, so its task tells it to
  cite events by seq and never quote a transcript. A factory with scorers whose roster has no
  `diagnostician`, or whose `asf/engine/diagnose.md` `## Report` drifted from `DiagnosisOutput`,
  files undiagnosed without calling it — nothing is spent on an answer that cannot parse — and
  `asf check` warns of it (`~`) without failing: undiagnosed is worse, not broken, and every scorer
  still scores.

A stamp ships four code scorers on `issue`, turned on, so a factory is measured from its first
chapter: `corrections` (`corrections_above(2)`), `permission-rollbacks`
(`permission_rolled_back`), `limit-hits` (`limit_hit`) and `not-accepted` (`not_accepted`). They
are stamped from `templates/asf/scorers/` where there is none, and are the team's from then on —
changed, focused or deleted like any scorer, and kept by every re-run, `--force` or not.

### Benchmarks

A scorer says a chapter failed; a **benchmark** says whether a change to the factory makes the
failures go away (`CONTEXT.md`). It is one committed `asf/benchmarks/<name>.yaml`
(`engine/benchmarks.py`), reviewed like code, which the skill never stamps and no re-run touches:

```yaml
tasks:                             # past sessions' requests, each pinned where it started
  # failing: not_accepted
  - session: 1a0ef8ea              # a session on this station's record
    request: add a /health endpoint
    commit: 7d795f2f…              # its first `session_started`'s base_commit
  # control: accepted
  - session: dc5d8139
    request: rename the flag
    commit: 5da4f052…
variants:                          # two or more git refs of the factory's files
  - {ref: main, label: main}
  - {ref: asf/1a2b3c4d, label: 'PR #9'}   # a label is the ref where none is given
repetitions: 3                     # how often each task is worked per variant; the noise
```

A **variant** is a git ref, so models, prose, task files and options all vary the same way: by
being committed. Each task is worked `repetitions` times under each variant, which is what lets a
reader tell a difference from the run-to-run noise; a benchmark names no winner.

`asf benchmark new [<name>] --from-scorer <scorer>` seeds one. Its tasks are the sessions the
scorer cited as failing — the ones its open self-improvement issue cites, read off every
`improvement_filed` for the newest issue this station filed since the scorer's last merge
(`improve.cited`), which is what that issue's pull request was written to fix however the window
has moved since; else its self-improvement window as it stands (`improve.window`) — then the two
newest it judged passing, as **controls**: a change is tested on the failures it is meant to fix
and on work it must not break. A comment above each says which it is. A task's request is the
session's prompt,
else the one line its `provenance_recorded` says it was about (`#42 title`), and its commit is
the base its work branch was cut from; a session whose record names none is left out, and said.
Its variants default to the factory's base — `worktree.base_ref`, else the remote's default
branch, else what the main checkout has out — and the branch of the scorer's **open
self-improvement pull request**, read off the station's events as a merge is: a session that
`improves` the scorer, opened a pull request (`pull_request_opened`) and has no
`pull_request_closed`. Without one it writes nothing and asks for `--variant <ref>[=<label>]`,
which, given, replaces the defaults. It refuses a scorer that cited no failing session, and never
overwrites a definition: once written, it is the team's.

`asf check` refuses a benchmark, as it does a scorer, before it costs anything: a key it does not
know, no task, fewer than two variants, a session pinned twice or a label given twice, a session
this station has no record of (a benchmark is worked from its source sessions' records, whose
decisions answer its gates), and a commit or ref that does not resolve here — as given, or as
`<remote>/<ref>`, where a pull request's branch may only be. A CI checkout holds no session's
record and only the commit it checked out, so there (`station.kind`) the shape is checked and the
sessions and refs are not, and `check` says so; the station that runs the benchmark checks them.
The self-description lists the benchmarks it accepted, each variant labelled, and the ones it
refused (format 5).

Working a benchmark — `asf benchmark run <name>`, sessions that are never published, integrated
or reported on the tracker, paid from the measurement budget and counted in no metric — is the
next slice.

## The engine

`asf/engine/` is the run machinery: session, worktree, permissions, gates,
replay, hitl, journal, limits, the tracer, the harnesses. The workflow layer sits on
top of it through a small seam:

- `PromptEngineering.user` is optional and `system_append` exists: an
  identity is the roster's file plus what a workflow appends.
- `AgentCall.task` and `AgentCall.variables`: the user prompt per call, which
  is how a stage's task file reaches the agent.
- `session.ensure(cfg, SessionSpec(name=, request=))`: `run.json` names the workflow, and
  `session_started` carries the prompt.
- `quality.run_blocks(run, names)`: a verify stage picks its blocks.
- `agents.merge_harness(raw)`: one merge of each agent's `harness:` block over
  factory.yaml's, used by `engine.factory`.

And five modules of its own: `stage.py` (contract and registry), `tasks.py`
(resolution and the report check), `factory.py` (roster from directories),
`workflow.py` (load, validate, run), `inputs.py` (where a request comes from
and where its outcome goes). Every session writes `events.jsonl`: typed, per-kind-versioned domain events (`events.py`), each
appended by the function that writes the session file it describes — what a
station ships to a cockpit, and what `tests/projection.py` rebuilds the
session's files from.

Those events are also what a cockpit's session page is told, so they say more
than the files do. A session reads in chapters (`workflow_started` /
`workflow_finished`, one per workflow it passes through; a `--resume`
continues its workflow's chapter with `session_resumed`, and an agent phase
answered from the record says `phase_replayed`). A chapter names its workflow's stages in
order, and every phase the stage it belongs to, by its index in that list — held by the runner
(`run.stage`), so a gate, a revision or a checkpoint belongs to the stage running when it opened,
and the work item's phase and `report` to none. An agent phase names the task file it
rendered and the digest of the prompt it was sent. An artifact is
`artifact_written`: a handoff file whole, up to 256 KB, a repo file as a path
the `committed` after it says where to read — whether a phase declared it or
code wrote it as the request (the issue, the review threads, a round's answers). A tool call is its name, its
outcome and its duration, never its arguments or its result. Two rules for a
stage that adds to this: commit through `run.commit(ph.phase, message)`, not
`git_helper.commit_all`, or the commit lands without the event that names it;
and what an agent declares in `artifacts` is what is shipped, once its envelope
is accepted. The prompts themselves and the harness's raw stream are the
transcript (`prompt_rendered`, `harness_output`), written only under
`cockpit: {transcripts: true}` and only through `Run.transcript`. A cockpit
ages a transcript out once its session has been finished for as long as the
deployment allows (30 days by default); `cockpit.transcript_retention_days`
can only shorten that, and travels on every `session_started`, so the limit
holds wherever the session's events go. Aging out replaces an event's body
with a `pruned` marker and keeps the event — which is why no view but the
cockpit's Transcript tab may be built from a transcript body.

Three failures are facts, not only prose, so a cockpit — and a scorer — can count them.
`permission_rolled_back` is said by `permissions.enforce` when it undoes an agent's writes outside
its boundary: the paths it rolled back, and the ones it left as they were. `limit_hit` is said by
`agents.execute` where a limit stops a phase: a `budget:` ceiling refusing the next send (tokens
or cost, the ceiling, the session's total that met it) or a turn's wall clock (`timeout`, its
seconds and how long it ran). And `workflow_finished` (v2) carries `accepted`, what the
workflow handed `run.finish(accepted=)`: false is "the phases passed but the chapter was not
accepted", which `status` alone cannot tell from a phase that failed. Each phase's error still says
the same in words; the event is what is counted.

A session's pull request is two events of its own. `pull_request_opened` is said by the
integration that opened it — never for one it found open, which is why a cockpit can tell a pull
request the factory opened from one a person did. `pull_request_closed` is said by the PR
watcher's reap once the forge shows it merged or closed (`asf prs`), or by `asf score`, which
asks the forge the same for a factory no watcher ran for — one event, whoever saw the close, so a
cockpit counts both alike: merged or not, when, when its
first review came, its commits at close and which of them merged the base branch in, and (v2) its
changed lines, added and deleted, which a cockpit sizes its cost per PR by. It is the first
event that can arrive after `session_finished`, and a cockpit takes it on a finished session. With
the session's own `committed` shas it decides whether the pull request was autonomous (CONTEXT.md),
so a merge and autonomy reach a cockpit as events and never by a cockpit asking the forge (ADR
0006). `run.json`'s `pr_state` is written beside it, and is what keeps the watcher from reading the
same pull request twice.

### Publishing

A cockpit never reads a station's files. It renders a gate's subject from the
forge at the commit the question was asked about: the plan at `head_sha`, the
diff as `base_commit…head_sha`, both carried by `suspended`. So those two
commits have to be on the forge before anyone is asked, and `engine/publish.py`
is what puts them there — a decision of its own, `worktree.publish`, separate
from landing the branch (`engine/integration.py`):

- **`on_create`** (the default once a cockpit is configured: `ASF_COCKPIT_URL`,
  or a local cockpit that has issued this factory a token). The branch is
  pushed as `<base_commit>:refs/heads/<branch>` BEFORE the worktree is cut, so
  a base the remote has never seen gets there, and a push the remote refuses
  refuses the run while the repository is still untouched. Before every
  suspend, `hitl.decide` commits the tree through `run.commit` — in the
  producing agent's own `commit_message` where it has one — and pushes, so
  `head_sha` is a commit the remote has and the subject is in its tree. The
  commit stage that follows runs in a resumed process, finds the tree clean,
  and says `unchanged`.
- **`on_integrate`** (the default without a cockpit). Nothing is pushed or committed at a suspend; the
  factory is the one it was before this module, and a cockpit cannot show what
  that session's gates ask about.

A session that ends takes its copy with it: `publish.withdraw` deletes the
remote branch when the session is aborted or finishes accepted without
integrating, and nothing calls it on a failure, which `resume` still needs.
An INTEGRATED branch is never deleted, and `publish.integrated` reads that off
the session and the repository rather than off a flag somebody has to keep in
step: `run.pr_url`; the branch tracking its remote counterpart, which an
integration's `push -u` sets (a person's does too) and every push in
`publish.py` and `keep_published` deliberately does not; or its commits being
on the base branch, where a merge put them. What it cannot see is a pull
request opened on the forge while the session was still working — deleting
that branch closes it, and only asking the forge would know.

Nothing here decides from `refs/remotes/<remote>/<branch>` being ABSENT. A
clone with a narrowed fetch refspec keeps no such ref for a branch it pushes,
so a session that read "not published" from its absence would stop committing
its gates' subjects without a word. Present, it proves the branch was pushed;
missing, it proves nothing, and the push is made.

`integration.mode: none` is refused wherever the config is loaded
(`factory.load`), and `integrate: {mode: none}` by `check`; both warned in
1.1. It did two jobs, and each has
its own name now: a workflow that lands nothing has no `integrate` stage, and
`worktree.publish` says when a branch leaves the machine. It is never remapped.

## What this costs

- Readability moves. A script would explain a run top to bottom; now
  `workflow.yaml` plus the stage modules do. The trace shows the sequence
  either way.
- The vocabulary will want to grow. A new *stage* is Python with a contract;
  a new *option* is policy on an existing stage; anything else is a
  `workflow.py` escape hatch (not built — nothing has needed it).

## Slices

1. **Done:** plan, implement, verify, commit; `sdlc` and `quick`; loader, runner,
   installer; fake-harness e2e and layout tests.
2. **Done:** review (with revise and retest), document, integrate stages;
   scout, ahead of the planner in `ship`; the gate CLI (`pending`, `show`, `approve`, `reject`, `abort`,
   `resume`) in `engine/operate.py`; `doctor`; the justfile.
3. **Done:** `input: issue` and `input: pr` (`engine/inputs.py`), the `issue`
   and `pr-review` workflows, both watchers (`engine/watch.py`), `up` and
   `status` (`engine/supervise.py`), `kill` and the worktree verbs, the label a
   re-entered issue run lands on resume, uninstall. The `workflow.py` escape
   hatch was planned for pr-review and turned out unnecessary: one option on
   `commit` covered it. It stays unbuilt until a shape actually needs it.

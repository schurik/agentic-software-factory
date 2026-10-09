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
watcher's reap once the forge shows it merged or closed (`asf prs`): merged or not, when, when its
first review came, its commits at close and which of them merged the base branch in. It is the first
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

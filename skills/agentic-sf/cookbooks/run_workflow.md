# Run a workflow

You run the system. **You do no workflow work yourself** — never plan,
implement or test in an agent's place. Launch the workflow, watch it, and
report. If the result is wrong, that is a workflow, task or agent to fix, not a
thing for you to do by hand.

## Step 0 — turn the request into a prompt

The engineer's sentence is rarely the prompt. A workflow's first stage gets one
artifact and no conversation, so the prompt has to carry what you would have
answered a follow-up question with: which files or area, what "done" means, and
any constraint that is not obvious from the repo.

Ask for what is genuinely missing — once, in one question-tool call
([SKILL.md § Asking the person](../SKILL.md#asking-the-person)), each missing
piece a question whose options are the likely answers you read in the repo,
with Other for theirs. Then say the prompt back and ask once more: **Launch**
`(Recommended)` · **Change it** · **Pick another workflow**. Long prompts
belong in a file: `run` takes **inline text or a path to a prompt file**, so
`just do plan.md` works.

## Pick the workflow

`just list` prints what this repo has. What ships:

Stage names below are exactly what `just check` prints, so the two can be
compared line for line.

| Workflow | Input | Stages | For |
|---|---|---|---|
| `quick` | prompt | implement → verify → commit | a change one sentence describes |
| `pr-review` | pr | implement → verify → commit | answering the review threads on one of this factory's pull requests |
| `sdlc` | prompt | plan → implement → verify → commit | work whose shape is clear enough to plan in one pass — **the default** |
| `ship` | prompt | scout → plan → commit → implement → verify → review → commit → document → commit → integrate | work whose shape is not obvious; three commits, landed |
| `issue` | issue | the same ten stages as `ship` | a tracked work item, proposed as a pull request |

`ship` and `issue` are the same ten stages with the same options, and `input:`
is the only difference between them. That is the point: an issue chain is not a
different pipeline, it is `ship` fed by the tracker — which is why adding an
input never needs a new stage.

`quick` and `pr-review` share the three stage *names* but not their settings.
`pr-review` allows three fix loops rather than two, sets `allow_clean` on its
commit (a review thread answered by changing nothing is not a failed run), and
carries its own `tasks/implement.md` — the shipped example of a workflow
overriding a stage's task. Read the `workflow.yaml` before assuming two chains
that print alike behave alike.

The three `commit` stages in the long chain are why `ship` and `issue` land
three commits rather than one: the plan, the implementation and the docs each
land in the words of the agent that produced them.

`just check <name>` loads and validates one without spawning anything.

## Launch

```bash
just do "add a /health endpoint that reports db connectivity"    # sdlc
just quick "rename the --verbose flag to --debug"
just ship "add rate limiting to the public API"
just run <workflow> "<prompt>"                                   # any by name
just issue 42          # the number, never a prompt
just pr-review 17
```

Flags pass straight through: `--adw-id <id>` joins or pins a session, `--hitl
all|none|<gate,names>` overrides where the run stops for a human, for this run
only.

`just issue` and `just pr-review` take **the number**. The run reports back on
the issue or in the review threads, and neither can merge: `integration`
downgrades a configured merge to a pull request on those inputs, in code.

Every run works in its own worktree on branch `asf/<adw_id>`. The engineer's
checkout is never touched.

## Watch it

```bash
just status            # what is watching, running, waiting, left behind
just sessions          # the newest runs, from their own records
just tail <adw_id>     # the end of its events.jsonl, newest last
```

The cockpit is where a run is meant to be watched: `just up` starts one on this
machine at `http://localhost:3000` (Docker; or ships to the shared one
`ASF_COCKPIT_URL` names) and ships every session to it as it is written.

Every question about a live run is answered from its own directory under
`asf/data/sessions/<adw_id>/`, and reading it never blocks the run. **Never
edit anything under `asf/data/`**; it is the run record.

Report progress when asked, not as a standing status board.

## When a run waits at a gate

A stage with `hitl: true`, or a `--hitl` that names it, stops the run with
**exit 75** and the session reading `waiting`. Nothing spends while it waits.

```bash
just pending                      # runs stopped at a gate
just show <adw_id>                # what it wants you to read
just approve <adw_id> [-m "..."]  # continue
just reject <adw_id> -m "..."     # send it back; the agent revises, then asks again
just abort <adw_id> [-m "why"]    # end it here, not accepted
```

**Never approve or reject on the engineer's behalf.** Show them what `just show`
printed, then ask with the question tool: at a **gate** — **Approve** ·
**Reject** · **Abort** · **Leave it waiting**; at a **question round** —
**Answer** (their answer, typed through Other) · **Approve every
recommendation** · **Abort** · **Leave it waiting**. No option is
`(Recommended)`: the verdict is theirs, and so is any default. Run the verb
they chose with what they typed as its `-m`. `reject` requires `-m` — the
notes are what the agent revises against, so a Reject without typed notes gets
one more question asking what should change. `--no-resume` records the
decision without relaunching.

A run on a tracked issue (`channel: issue` in `just show`) can also be answered
on the issue: a reply whose first line is `/approve`, `/reject <what should
change>` or `/abort`, from someone `issues.trusted_authors` accepts, which `just
answers` (or the `answers` child of `just up`) picks up. A cockpit's inbox posts
the same reply as the person signed in to it. Never post one for the engineer.

Under `worktree.publish: on_create` (the default once a cockpit is configured) a
run that suspends first commits what the gate is asking about, in the words of
the agent that produced it, and pushes the branch: that commit is what the
cockpit shows the person who answers, and it is why a commit stage after the
gate reports `unchanged`. An `abort` takes the branch off the remote again,
unless it was already proposed as a pull request; the local branch stays.

## When a run fails

```bash
just resume <adw_id>              # pick it up where it stopped
just resume <adw_id> --dry-run    # print the command it would run
```

`resume` replays the recorded agent phases instead of paying for them again, and
re-runs what code owns. A failed run **keeps its worktree** on purpose — that is
where you go to see what happened. `just worktrees` lists them; `just
worktrees-prune` takes only the safe ones (ended runs, clean trees).

To stop a run: `just kill <adw_id>` — its agents first, then the workflow;
`--force` SIGKILLs.

A phase failing is not the same as the run being unacceptable, and neither is
every phase passing: a run ends through its own acceptance, so read the final
line rather than the last phase. The session's events say which it was:
`workflow_finished` carries `accepted` — `false` only when every phase passed
and the workflow still refused the chapter (a fix loop that ran out, a reviewer
who withheld approval), with `reason` saying why.

Two failures are facts of their own, and resuming does not cure either:

- **`limit_hit`** — a `budget:` ceiling refused the next agent turn (`tokens`
  or `cost`, the ceiling, and the session's total that met it), or a turn ran
  past `harness.timeout_seconds` and was terminated (`timeout`, in seconds).
  `just resume` meets the same ceiling: the spend is the session's. Raising
  the ceiling (or an agent's `timeout_seconds`) is the engineer's decision in a
  reviewed `factory.yaml` — never raise it for them.
- **`permission_rolled_back`** — an agent wrote outside its `writes:`, and the
  factory undid it before failing the phase: `paths` were rolled back,
  `not_undone` were left as they were (the engineer's own uncommitted work, or
  a path git would not restore). Name both; a resume re-asks the same agent
  with the same boundary, so the fix is the task or the binding.

## Where the work went

The branch is `asf/<adw_id>`, and what happened to it is
`worktree.integration.mode` in `asf/factory.yaml`: `pr` (the default) opened a
pull request, `merge` moved the base branch. A workflow with no `integrate`
stage left the branch for a person (`none` did the same until 1.2, which
refuses it). A `pr` run that could not push — no `origin`, a rejected
push — is still accepted, with its work on the branch; the `integrate` phase's
notes say why.

Whether the branch is ALSO on the remote is a separate answer. One that was
integrated — proposed as a pull request, or merged into its base — is, and
stays. One that was only published for a cockpit to read (`worktree.publish:
on_create`) is removed from the remote when its session finishes without
integrating — the run's last lines say `remote: deleted …` — and is still there
after a failure, for `just resume`. The local branch is kept either way.
Say which of these happened, with the branch name or the PR link — an engineer
whose run "succeeded" still needs to know where to look.

## Report

Three things, short: what the run did, whether it was accepted, and where the
work is. Then the cost if they asked. If it failed, the phase that failed and
what stopped it — a `limit_hit` or a `permission_rolled_back` when there is one,
else the error it ended with (its `phase_ended` event, or the run's closing
lines) — not a transcript.

A chapter that ended is scored by every scorer bound to its workflow: the run's
last lines say `chapter <n> scored by <scorer>: <class>`, `(failing)` where that
class is — and for a judge what judging it cost — and the session holds each as a
`chapter_scored`. A judge scores only the chapters it samples (`scorer <name> did
not sample chapter <n>` otherwise); its reasoning is in the session's `judges/`
directory, and on the event only under the transcripts opt-in. An `issue` chapter is scored
by the four a stamp ships: `corrections` (`above` past two), `permission-rollbacks`
(`rolled_back`), `limit-hits` (`hit`) and `not-accepted` — so a run that met a
rollback or a limit says `(failing)` beside it, citing the very event. A score is a measurement, not
the outcome — never report a run accepted as failed, or the reverse, because of
one. A scorer that could not run says so (`scorer <name> did not score: …`, or `did
not judge chapter <n>: …` for a judge that gave no score). A judge is paid from the
day's measurement budget (`measurement: {usd_per_day}` in factory.yaml, a UTC day),
never the run's: once the day's spend reaches it, judges stop — `did not judge chapter
<n>: the measurement budget is spent — $5.02 of $5.00 on <day>` — and the session
holds a `chapter_not_judged` saying so. That is not a failure of the run, and nothing
is to be done but wait for the next day (or raise the budget) and `just score`;
`just check` names what is wrong with it. A chapter that ended before a scorer
was written has no score from it until `just score` gives it one
(`--scorer <name>` for that scorer alone): the score it would have had when it
ended, added to the session's record and shown under the chapter like any other.

A failing score is followed by where its scorer stands against its threshold
(`self_improvement:`, or the scorer's `improve_after:`): `scorer <name> failed on
2 of the last 7 sessions it judged; an issue is filed at 3 of the last 10`. At the
threshold the factory files an issue on its own tracker — `filed #<n>
(asf:improve:<scorer>), queued for the issue workflow` — or, when one is already
open for that scorer, `added <k> session(s) to #<n>`. Tell the user about that
issue: it is the factory asking a person to look at a pattern, it is worked by
the `issue` workflow like any other, and nothing changes until a person approves
its plan. `could not search the tracker` filed nothing on purpose — a second
issue is worse than a late one; the next failing score, or `just score`, tries
again once `gh` works. None of this changes how the run ended.

Once a pull request for that issue merges, the scorer counts afresh: only
chapters that started after the merge, and the console says so — `scorer
<name> failed on 1 of the last 1 sessions it judged since #14 merged`. The
failures the change was meant to fix are not evidence against it. The station
knows of the merge from the session that worked the issue (its record says it
`improves` the scorer, and how its pull request closed), so a merge the PR
watcher never saw counts once `just score` has backfilled it. A pattern after
the merge files a new issue: the old one is closed.

Before a new issue is filed, the `diagnostician` diagnoses the pattern — a phase
of its own on the console, then `scorer <name> diagnosed: a change to the
factory, in <files>; diagnosing it cost $<x>` — and the issue's `## Diagnosis`
carries it. Tell the user what it proposes, and the two things code decided for
it: a file under `Reported, not proposed` is factory code, a gate or what
decides acceptance, which only a person changes, deliberately; and
`Upstreamable` means the change belongs in the skill too, for a person to carry
there — nothing was filed upstream. `not diagnosed, …` says why there is none
(the day's measurement budget, or a diagnosis the gates never accepted); the
issue was filed all the same.

To find out whether a self-improvement pull request fixes what its scorer
found, pin a benchmark: `just benchmark new --from-scorer <scorer>` writes
`asf/benchmarks/<scorer>.yaml` — `wrote asf/benchmarks/<scorer>.yaml: 2
session(s) <scorer> cited as failing and 2 it judged passing, as controls —
each worked 3 time(s) under main, PR #14`. Show the user the file: each task is
a past session's request at the commit it started from, with a comment saying
whether it is a failure the change should fix or a control it must not break,
and the variants are the default branch and that pull request's branch. It is
theirs to edit and commit. `only 1 passing session … to pin as a control` means
the change is tested on less of the work it must not break; say so. With no open
self-improvement pull request for the scorer it writes nothing and asks for the
variants by name — `--variant main --variant <branch>=<label>` — and with no
failing session cited there is nothing to benchmark. It never overwrites a
benchmark; `just check` checks one (`✓ benchmark <name>: 4 tasks × 2 variants
(main, PR #14) × 3`). A benchmark is never a verdict: working it, and reading
each variant's numbers against the noise, is a person's comparison to make.

Once it is committed, `just benchmark run <name>` works it on this station:
every task, `repetitions` times, under each variant — `benchmark <name>: 4 tasks
× 2 variants (main, PR #14) × 3 — 24 session(s), no winner declared`, then one
line per session (`PR #14 · 1a0ef8ea #2: 7c1d9e0a accepted, $0.41`) and each
variant's tally. Tell the user before starting what it will cost: each session
is paid from the measurement budget (`measurement.usd_per_day`), which is asked
before every session, so a benchmark larger than a day's budget stops partway —
`the measurement budget is spent … 9 of 24 session(s) not worked`, exit 1 — and
is run again on a later day, when it works only the sessions that have not ended
(`15 already worked`); a variant whose ref moved since is worked again. The sessions are isolated: never published,
integrated or reported on the tracker, so nothing reaches the forge, and each
is run by the variant's files under `asf/` with this station's engine. Their
gates are answered as the source session's person answered them; a session
that reaches a gate no person answered there — one the variant adds, or a round
the source never reached — ends `not comparable`, which is a fact about the
comparison, not a failure of the variant. They are scored by this station's
scorers and count toward no metric and no self-improvement. Report each
variant's tally as it is, never which one won.

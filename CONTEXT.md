# Agentic Software Factory

A skill that stamps a deterministic control plane — a factory — into a repository, where it runs
bounded agent phases under code-owned sequencing, gates and permissions.

## Language

**Factory**:
Exactly one stamped `asf/` in exactly one repository: its config, workflows, agents and runtime data.
A repository holds at most one factory.
_Avoid_: instance, installation, deployment

**Workflow**:
A named, checked composition of stages inside a factory, started against a prompt, an issue or a pull request.
_Avoid_: pipeline, flow

**Stage**:
One step of a workflow's fixed shape, drawn from a closed vocabulary (scout, plan, commit, verify…).
A workflow lists its stages once, and they are the same for every session it runs.
_Avoid_: step, node, task

**Phase**:
One bounded execution a session actually went through: an agent call, a code check, a person at a
gate. A stage produces one or more phases (a plan, its gate, a revision, the gate again); reading
the work item at a workflow's start and reporting on it at the end are phases that belong to no stage.
_Avoid_: step, task, attempt

**Session**:
One piece of work on one branch, identified by its id, with its own directory of state under the
factory's data dir. It may pass through several workflows in turn: an issue's workflow, then a round
of pull-request review for each round of feedback.
_Avoid_: run (as a noun for the whole thing), job, execution

**Chapter**:
One workflow's passage through a session, from the moment it takes the session until it ends;
resuming the workflow continues its chapter. A session reads as its chapters in order: an issue's
workflow, then one for each round of pull-request review.
_Avoid_: run, round, stage, step

**Gate**:
A check, made while a phase runs, of what that phase claimed against what actually happened. A
failed gate sends the same agent back to correct itself; it decides whether the phase is accepted.
_Avoid_: check, validator, scorer

**Scorer**:
A team-written judgement of a finished chapter of one workflow, optionally focused on one of its
agents. It is either a model judging against prose criteria or a fixed predicate over the chapter's
domain events. It runs on a station after the chapter ends and records a score that never changes
that chapter's outcome: a scorer measures, a gate decides. A criterion that must block work stops
being a scorer and becomes a gate.
_Avoid_: evaluator, judge, grader, metric

**Score**:
One scorer's class for one finished chapter, with the domain events it cites as evidence. Each of a
scorer's classes is declared failing or not; a score is never a number. A chapter can be scored
long after it ended, and its score joins that session's record.
_Avoid_: verdict (a person's answer at a gate), grade, rating, evaluation

**Self-improvement**:
A factory turning one scorer's repeated failing scores, across distinct sessions, into an issue
on its own tracker: the evidence, the scorer's criteria and a diagnosis of what to change in the
factory or the application. The issue is then worked like any other; nothing is changed without a
person accepting its plan and merging its pull request. There is at most one open such issue per
scorer.
_Avoid_: auto-tuning, self-healing, learning, retrospective

**Benchmark**:
A named list of past sessions' requests, each pinned at the commit it started from, worked again
under two or more variants so their scores, cost and duration can be compared. Its sessions are
never published, integrated or reported on the tracker, count toward no metric and no
self-improvement, and name no winner: a person reads the difference against the noise and decides.
_Avoid_: eval, test suite, experiment, A/B test

**Variant**:
One configuration of a factory under benchmark, named by a git ref of its files: the default branch,
or a branch such as a self-improvement pull request's. Models, prose, task files and workflow
options all vary the same way, by being committed.
_Avoid_: config, candidate, arm, profile

**Autonomous pull request**:
A merged pull request that a session opened itself and whose every commit at merge, other than
merges from the base branch, was made by that session. Rounds of review driven by human comments
keep it autonomous; a single human push does not.
_Avoid_: hands-off PR, unattended PR

**Artifact**:
A file a phase writes and declares as its output, or code writes as the request a workflow answers.
It either lives in the repository and is committed on the session's branch, or is handed off inside
the session and never committed.
_Avoid_: output file, attachment, deliverable

**Cockpit**:
A separately deployed, optional system that observes and steers many factories. It never runs a
factory's agents itself; it runs shared for a team or locally for one person, and a factory works
fully without a shared one.
_Avoid_: control tower, dashboard, hub, factory manager, visualizer

**Station**:
One checkout of a repository — on a machine or in a CI job — that runs its factory's sessions and
ships them to a cockpit. A factory is known to a cockpit through its repository; its sessions reach
the cockpit through its stations. A station on a machine belongs to one person, its **owner**, and
is **online** while its long-lived loop keeps asking the cockpit for commands; a CI station lives for
one job, has no owner and takes no commands.
_Avoid_: agent, runner, node, host

**Claim**:
One station's exclusive right, granted by a shared cockpit, to start a session for one work item.
It is what keeps two stations' watchers from both starting the same issue; without a shared cockpit
there is no claim, only the rule of one watcher per repository. Held by that session until it
finishes or is aborted — kept on failure and while its station is offline — and otherwise freed only
by a writer's **release**, which requeues the item and **abandons** the session.
_Avoid_: lock, lease, assignment

**Viewer**:
The person looking at a cockpit, known by their forge login and by nothing else: whoever signed in
to a shared cockpit with the team's GitHub App, or, in a local one, the person whose own forge token
it holds. A cockpit has no accounts or roles of its own.
_Avoid_: user, account, member, operator

**Permission mirror**:
A cockpit's copy of what the forge says a viewer may do on each repository they reach, kept for a
few minutes and asked again. It decides what the cockpit shows and offers; it never grants anything,
because the forge and the factory are what enforce.
_Avoid_: ACL, roles, permissions table, access list

**Inbox**:
The cross-repo list, in a cockpit, of every gate currently waiting on the person looking at it.
_Avoid_: queue, pending list, notifications

**Needs attention**:
Something on a factory a person should look at now, read against the clock: a gate waiting on
them, a session that failed within the last day, a claim whose station has been away for over a
day, a station whose config drifted, a failing check, or queued work no online station is watching.
_Avoid_: alerts, problems

**Stuck**:
A running session whose current phase has been running for more than ten minutes, judged against
the page's clock. It is shown where the session is listed as running, never in Needs attention:
a phase running long is worth noticing, not a fault, and nothing is done to it.
_Avoid_: hung, stalled, frozen, timed out

**Command**:
One steering action, from a closed set, that a cockpit asks a station to carry out on a named session
when the forge cannot carry it: kill, resume, answering a terminal-channel gate, or a prompt run.
_Avoid_: instruction, order, job, RPC

**Self-description**:
A factory's own machine-readable account of its workflows, stages, agents and gates, and of its
settings with every default resolved, produced by the factory's code at one commit (`asf check
--json`). A cockpit renders it and never interprets workflow files or `factory.yaml` itself. The one checked on the default branch is what a station's config drift is measured
against; a factory that never shipped one is unchecked, not broken.
_Avoid_: manifest, schema, config dump

**Domain event**:
A typed, versioned fact about a session, emitted by the factory as it happens. It is the only thing a
station ships; a cockpit builds every view it shows from domain events.
_Avoid_: trace, log line, message, file sync

**Transcript**:
A session's opt-in record of the prompts its agents were given and the raw output their harness
produced. It is the only part of a session a cockpit lets age out; everything else is kept until
someone deliberately purges it.
_Avoid_: log, raw output, trace

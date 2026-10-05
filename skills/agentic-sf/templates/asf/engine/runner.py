"""The Run object: config + adw_id + agent_map + tracer + console, bound once.

`run.phase(PhaseParams(...))` is the ONE phase primitive — a context manager
for all three kinds (engineer, agent, code). Success must be earned: every
phase defaults to fail; only a clean exit flips it (agent phases additionally
require a parsed envelope + green gates, enforced inside ph.call).

Two roots, deliberately: `repo_root` is the run's worktree — where agents are
spawned, gates measure, and commits land — while `main_root` is the engineer's
checkout, which owns `data_dir` and everything under it. The run's record has
to outlive the tree the run worked in, because that tree is pruned when the run
is accepted.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager

from . import agents, artifacts, git_helper, hitl, journal, limits, publish, replay, worktree
from .console import Console
from .data_types import (COMMIT_FILES, AgentCall, AgentConfig, AgentResult, Committed,
                         Decision, DomainEvent, EnvelopeBase, Gate, Phase, PhaseEnded,
                         PhaseParams, PhaseStarted, ProvenanceRecorded, RunSpec,
                         SessionSuspended, Subject, UsageRecorded, WaitingFor)
from .utils import anchor, ensure_dir, now_iso, write_atomic


class PhaseHandle:
    def __init__(self, run: "Run", phase: Phase):
        self.run = run
        self.phase = phase
        self.envelope: EnvelopeBase | None = None   # what ph.call() produced, for a checkpoint
        # What this phase said about itself, for the journal line. An agent
        # phase has an envelope summary; a CODE phase has only what it logged,
        # and "verify_1 · quality · success" without it does not say whether the
        # suite was green — which is the one thing a later agent needs from it.
        self.said = ""

    def log(self, **payload) -> None:
        self.said = ", ".join(f"{k}: {v}" for k, v in payload.items())
        self.run.console.note(self.said)

    def call(self, call: AgentCall) -> EnvelopeBase:
        if self.phase.params.kind != "agent":
            raise RuntimeError("ph.call() is only valid inside an agent phase")
        self.envelope = agents.execute(self.run, self.phase, call)
        return self.envelope

    def decide(self, subject: Subject) -> Decision:
        """Ask a human about `subject`, in the engineer lane. See engine/hitl.py."""
        if self.phase.params.kind != "engineer":
            raise RuntimeError("ph.decide() is only valid inside an engineer phase")
        return hitl.decide(self.run, self.phase, subject)


class Run:
    def __init__(self, spec: RunSpec, tracer):
        self.cfg = spec.cfg
        self.adw_id = spec.adw_id
        self.tracer = tracer
        self.console = Console(spec.adw_id)
        self.engineer = spec.engineer
        self.phases: list[Phase] = []
        self.tokens = 0                 # THIS process — what the banner reports
        self.cost = 0.0
        self._seq = 0                   # set below, once session_dir is known
        self._unannounced: Phase | None = None     # opened, not yet on the wire — see `announce`
        self._stage_index: int | None = None       # the workflow's stage running now — see `stage`
        self.workspace = spec.workspace
        self.repo_root = spec.workspace.repo_root      # the tree agents work in
        self.main_root = spec.workspace.main_root      # the checkout that owns data_dir
        # What asked for this run. 'engineer' until an issue phase says otherwise
        # — and integration reads it, because a prompt written by whoever can
        # file an issue does not get to move the base branch.
        self.trigger = "engineer"
        self.issue_number = 0
        self.issue_url = ""
        # Where this session's work already went. Empty until an integration
        # opens a pull request; read back from the trace by every later process
        # in the session, because a branch that is already a PR gets pushed to,
        # never proposed a second time.
        self.pr_url = ""
        # ...unless the session already knows better. A joined run inherits the
        # provenance the first process recorded; without this every re-entry
        # would claim to be engineer-triggered. session.ensure() fills it in.
        # The runtime is anchored to the MAIN checkout, not to the worktree: one
        # data_dir for every concurrent run, and a record that survives the
        # worktree being pruned. The cost is that
        # context_handoff/ now sits outside the agent's working directory, so
        # the path handed to an agent must be absolute — see agents.execute.
        data_dir = anchor(spec.workspace.main_root, self.cfg.defaults.data_dir)
        self.session_dir = ensure_dir(data_dir / "sessions" / spec.adw_id)
        self.context_handoff_dir = ensure_dir(self.session_dir / "context_handoff")
        # A joined or resumed run continues the phase sequence rather than
        # restarting at 1 — from the session's own event log.
        self._seq = artifacts.max_phase_seq(self.session_dir, spec.adw_id)
        # What the SESSION had already spent before this process opened, read
        # off its own run.json. A joined run (`--adw-id`, `just integrate`, a pr-review
        # re-entry) is the same work continuing, so the budget counts from
        # here, while `tokens`/`cost` above stay THIS process's and keep the
        # banner reporting the run in front of the engineer. A new session has
        # no record and answers (0, 0.0).
        spent = artifacts.read_run(self.session_dir)
        self._prior_tokens = spent.total_tokens if spent else 0
        self._prior_cost = spent.total_cost if spent else 0.0
        self._agent_map_path = self.session_dir / "agent_map.json"
        self.agent_map: dict = (json.loads(self._agent_map_path.read_text())
                                if self._agent_map_path.exists() else {})
        # Resuming: replay the agent phases this session already recorded rather
        # than paying for them twice. Inert on a normal run — see replay.py for
        # what is replayed and what is deliberately re-run.
        self.resuming = spec.resume
        self.replay = replay.load(self.session_dir, spec.resume)
        # ...and re-enter each of those phases under the id it already has, so a
        # resume UPDATES this session's phases rather than appending a second
        # copy of every one it re-walks. See `_identity`.
        self._recorded_phases = (artifacts.phase_identities(self.session_dir, spec.adw_id)
                                 if spec.resume else {})
        # Which gates stop for a human this run. Built once, asked at every
        # gate with the trigger the run knows THEN — an issue chain learns it is
        # issue-triggered in its first phase, after this constructor ran.
        self.hitl = hitl.HitlPolicy(self.cfg.hitl,
                                    spec.hitl or os.environ.get("ASF_HITL", ""))
        # Values a run pins once and must not re-derive on the way back in (the
        # documenter's diff baseline is the one that matters). Written every
        # run, read only by a resumed one — see `pin`.
        self._pins_path = self.session_dir / "pins.json"
        self._pins: dict = (json.loads(self._pins_path.read_text())
                            if self._pins_path.exists() else {})

    # ── pinned values (what a resumed run must not re-derive) ───────────────
    def pin(self, key: str, produce) -> str:
        """Remember a value this process derived, or hand back the resumed one.

        `baseline = run.pin("baseline", lambda: git_helper.rev(run.repo_root, "HEAD"))`.

        The problem it solves is one line long: a chain pins its diff baseline
        at HEAD before it commits anything, so a resumed run — whose HEAD now
        carries the commits the FIRST run made — would pin a baseline after its
        own work and hand the documenter an empty diff.

        Read only when resuming, written always. A joined run (`--adw-id`
        without `--resume`) is a new increment of the session and derives its
        own value, which is what makes "plan under one id, then build under it"
        keep documenting the right thing.
        """
        if self.resuming and key in self._pins:
            return str(self._pins[key])
        value = produce()
        self._pins[key] = value
        write_atomic(self._pins_path, json.dumps(self._pins, indent=2))
        return value

    # ── agent map (adw_id -> per-agent coding-agent session ids) ────────────
    def save_agent_map(self, agent: str, entry: dict) -> None:
        self.agent_map[agent] = entry
        write_atomic(self._agent_map_path, json.dumps(self.agent_map, indent=2))

    # ── issue provenance (set by an issue phase, read by integration) ──────
    def adopt_provenance(self, trigger: str, issue_url: str, pr_url: str = "") -> None:
        """Take on what the session already recorded, without re-writing it.

        The counterpart to record_issue: that one is a run LEARNING it came from
        an issue, this one is a later process being TOLD. Nothing is written
        back, because nothing changed.

        `pr_url` is the same story told forwards: the first process opened the
        pull request, and every process after it has to know that the branch is
        under review — integration pushes to it instead of opening another one.
        """
        if trigger:
            self.trigger = trigger
        if issue_url:
            self.issue_url = issue_url
            tail = issue_url.rstrip("/").rsplit("/", 1)[-1]
            self.issue_number = int(tail) if tail.isdigit() else 0
        if pr_url:
            self.pr_url = pr_url

    def record_issue(self, context) -> None:
        """Bind this run to the work item that caused it, in memory and on record.

        Lives here rather than in the ADW script (rule 6) because four
        different things need it afterwards: the session's provenance, the PR body
        template, integration's refusal to merge an externally triggered run,
        and the label a run that suspended at a gate lands when it finally ends
        — in a process the watcher that started it never sees. A script that
        set them one by one would eventually set only three.
        """
        self.trigger = "issue"
        self.issue_number = context.number
        self.issue_url = context.url
        # `request` is otherwise only known from the prompt (see
        # `session_started`), and an issue-triggered chain has none — so
        # without this every such run reads as blank on its card in a cockpit.
        # The title is what the request field is for: the one line that says
        # what this run was about.
        request = f"#{context.number} {context.title}"
        artifacts.record_provenance(self.session_dir, ProvenanceRecorded(
            request=request, trigger="issue", issue_url=context.url,
            issue_number=context.number, issue_project=context.project,
            issue_author=context.author, issue_assignees=context.assignees))

    def record_pull_request(self, context) -> None:
        """Bind this run to the pull request whose review feedback caused it.

        The counterpart to record_issue one step later, and it is CAREFUL WITH
        THE TRIGGER in a way that one does not have to be. A review run is
        almost always a re-entry into a session that already has provenance: an
        issue-triggered session whose pull request drew comments is still
        issue-triggered, and overwriting that would hand `integration` an
        "engineer" answer for the exact run that must never move a base branch.
        So the trigger is only claimed when nothing better is recorded.

        `pr_url` is written unconditionally, because it can only become MORE
        true: a session learns its pull request here or in `integration`, and
        both are the same url.
        """
        if self.trigger == "engineer":
            self.trigger = "pr_review"
        self.pr_url = context.url or self.pr_url
        artifacts.record_provenance(self.session_dir, ProvenanceRecorded(
            trigger=self.trigger, pr_url=context.url))

    # ── usage (this process's totals, and the session's on its record) ──────
    def add_usage(self, phase: Phase, agent: AgentConfig, result: AgentResult) -> None:
        """Bank one agent turn's spend."""
        self.tokens += result.tokens
        self.cost += result.cost
        # ...and into the session's own record, because the budget has to be
        # readable by the next process. Absolute totals, not an
        # increment: this process knows what came before it, so nothing has to
        # read-modify-write a number two runs could race on.
        artifacts.record_usage(self.session_dir, UsageRecorded(
            phase_id=phase.phase_id, agent=agent.name, model=agent.model,
            tokens=result.tokens, cost=result.cost, usage=result.usage,
            context_tokens=result.context_tokens, context_window=result.context_window,
            session_tokens=self._prior_tokens + self.tokens,
            session_cost=self._prior_cost + self.cost))

    def overrun(self) -> str:
        """Why this session may spend no more, or "" while it still may.

        Deliberately a question and not an enforcement point: adding usage must
        not raise, or a phase would die between paying for a turn and recording
        it. `agents.execute` asks this before each send — see limits.py on why
        a ceiling stops the next turn rather than the one in flight.
        """
        return limits.overrun(self._prior_tokens + self.tokens,
                              self._prior_cost + self.cost, self.cfg.budget)

    # ── transcripts (opt-in: the prompts sent, the harness's raw stream) ────
    def transcript(self, event: DomainEvent) -> None:
        """Append a transcript event — for a factory that opted in, and no other.

        The one door `prompt_rendered` and `harness_output` go through, so
        "never without the opt-in" is a property of this method rather than of
        every place that has a prompt in its hands.
        """
        if self.cfg.cockpit.transcripts:
            self.tracer.event(event)

    # ── commits (the sha a cockpit reads this session's repo files at) ──────
    def commit(self, phase: Phase, message: str, allow_clean: bool = False) -> str:
        """Commit the run's tree and say which commit that was.

        Returns the short sha, or "" when the tree was clean and `allow_clean`
        said that is an answer (see `git_helper.commit_all`) — nothing was
        committed then, so nothing is said. The event is appended here rather
        than by the stage that asked, so a new stage that commits cannot land
        a file a cockpit is never told where to read.
        """
        short = git_helper.commit_all(self.repo_root, message, allow_clean=allow_clean)
        if short:
            files = git_helper.commit_files(self.repo_root)
            self.tracer.event(Committed(
                phase_id=phase.phase_id, sha=git_helper.rev(self.repo_root, "HEAD"),
                message=message.strip().split("\n", 1)[0], files=files[:COMMIT_FILES],
                files_total=len(files)))
        return short

    def _withdraw(self) -> None:
        """Take this session's branch off the remote, and say so. See publish.py."""
        said = publish.withdraw(self)
        if said:
            self.console.note(f"remote: {said}")

    def _head(self) -> str:
        """The work branch's commit right now, or "" when git cannot say."""
        try:
            return git_helper.rev(self.repo_root, "HEAD")
        except (RuntimeError, OSError):   # a record of a wait is never worth failing it
            return ""

    # ── the stage a phase belongs to ───────────────────────────────────────
    @contextmanager
    def stage(self, index: int):
        """Every phase opened inside belongs to the workflow's stage `index`.

        Held by the runner rather than passed by each stage, so the phases a
        stage does not open itself — a gate `hitl.gated` asks, the revision it
        runs, a `--hitl every` checkpoint — belong to the stage that was running
        when they opened, and a new stage cannot open a phase that says nothing.
        Outside one (the work item's phase, `report`) a phase belongs to none.
        """
        self._stage_index = index
        try:
            yield
        finally:
            self._stage_index = None

    # ── the phase primitive ─────────────────────────────────────────────────
    def _identity(self, params: PhaseParams) -> tuple[int, str]:
        """The number and id this phase runs under: a new one, or the one it had.

        A resumed run re-walks the chain from the top. Everything before the
        failure is cheap — an agent phase replays from the record, a code phase
        runs again for real — but it is the SAME phase of the same session
        either way, and a fresh number would file it beside its own row instead
        of on it: two `plan`s after one resume, three after the next, and a
        cockpit drawing every completed stage once per recovery. Re-entering
        it under the recorded id makes the second walk a second telling of the
        same phase.

        Only when resuming. A joined run (`--adw-id` without `--resume`) is new
        work continuing a session, and new work gets a new number even where it
        reuses a name — see `artifacts.max_phase_seq`.
        """
        recorded = self._recorded_phases.get(params.name)
        if recorded:
            return recorded
        self._seq += 1
        return self._seq, f"{self.adw_id}_{self._seq:02d}_{params.name}"

    def announce(self, phase: Phase, task: str = "", prompt_digest: str = "") -> None:
        """Say on the wire that a phase started.

        A code or engineer phase is announced as it opens. An agent phase is
        announced a moment later by `agents.execute`, because that is where
        what it was GIVEN is known: the task file it renders and the digest of
        the prompt it is sent. One that dies before it gets that far is
        announced on its way out (`_ended`), so no `phase_ended` lacks its start.
        """
        self._unannounced = None
        params = phase.params
        self.tracer.event(PhaseStarted(
            phase_id=phase.phase_id, seq=phase.seq, name=params.name, kind=params.kind,
            owner=params.owner, description=params.description, task=task,
            prompt_digest=prompt_digest, stage_index=phase.stage_index))

    def _ended(self, phase: Phase, error: str = "", waiting: WaitingFor | None = None) -> None:
        """Say on the wire how a phase closed — after saying that it opened."""
        if self._unannounced is phase:
            self.announce(phase)
        self.tracer.event(PhaseEnded(
            phase_id=phase.phase_id, name=phase.params.name, status=phase.status,
            attempt=phase.attempt, error=error, gate=waiting.gate if waiting else "",
            round=waiting.round if waiting else 0))

    @contextmanager
    def phase(self, params: PhaseParams):
        seq, phase_id = self._identity(params)
        phase = Phase(phase_id=phase_id, adw_id=self.adw_id, seq=seq, params=params,
                      stage_index=self._stage_index, status="running", started_at=now_iso())
        self.phases.append(phase)
        self._unannounced = phase
        if params.kind != "agent":
            self.announce(phase)
        self.console.phase_started(phase)
        clock = time.monotonic()
        handle = PhaseHandle(self, phase)
        try:
            yield handle
        except hitl.Suspended as stop:
            # Not a failure. The process ends here on purpose, the session says
            # what it waits for, and `just approve` brings it back to THIS phase
            # by name. The worktree is kept — its uncommitted work is the subject.
            phase.status = "waiting"
            phase.ended_at = now_iso()
            self._ended(phase, waiting=stop.waiting)
            artifacts.suspend_run(self.session_dir, SessionSuspended(
                waiting_for=stop.waiting, base_commit=self.workspace.base_commit,
                head_sha=self._head(), published=stop.published, questions=stop.questions,
                trusted=hitl.who_answers(self.cfg, stop.waiting.channel)))
            self.console.phase_ended(phase, time.monotonic() - clock)
            self.console.waiting(stop.waiting, hitl.how_to_answer(self, stop.waiting.gate,
                                                    stop.waiting.kind))
            raise
        except BaseException as error:
            phase.status = "fail"                      # success must be earned
            phase.error = str(error)[:1000]
            phase.ended_at = now_iso()
            self._ended(phase, error=phase.error)
            artifacts.finish_run(self.session_dir, "fail",
                                 reason=f"{params.name} failed: {phase.error}")
            self.console.phase_ended(phase, time.monotonic() - clock)
            # A person ending the run is not a failure to come back to: its
            # published branch goes. Any other failure keeps it, for `resume`.
            if isinstance(error, hitl.Aborted):
                self._withdraw()
            self.console.session_finished(False, self.tokens, self.cost, self.session_dir)
            raise
        else:
            phase.status = "success"
            phase.ended_at = now_iso()
            self._ended(phase)
            # ...and one line in the run's own journal, which is the copy every
            # agent after this phase READS. The events are for a cockpit; this
            # is what makes a reviewer know that verify_1 went red and
            # fix_1 followed. See engine/journal.py.
            journal.record_phase(self, phase, handle.envelope, handle.said)
            self.console.phase_ended(phase, time.monotonic() - clock)
            # `--hitl every`: a checkpoint after each agent phase, once THIS one
            # has closed — a phase inside a phase would put a wait in an agent's
            # lane. A revise phase is skipped: the gate that follows it is the
            # one `hitl.gated()` opens itself.
            if (self.hitl.every and params.kind == "agent"
                    and "_revise_" not in params.name and handle.envelope is not None):
                self._checkpoint(phase, handle.envelope)

    def _checkpoint(self, phase: Phase, envelope: EnvelopeBase) -> None:
        """An approve/abort gate named for the phase it follows.

        Named for the PHASE, not `checkpoint_<phase>`, so a gate an ADW placed
        on the same work (`plan` after `plan`) finds the approval this
        checkpoint recorded and does not ask twice. A checkpoint cannot revise
        — the runner does not own the ADW's loop — so a reject here ends the
        run; `just reject` belongs at the gate the ADW placed.
        """
        hitl.gated(self, Gate(name=phase.params.name,
                              description=f"Checkpoint after {phase.params.name}: the "
                                          f"engineer asked to see every agent's work"),
                   envelope)

    # ── run outcome ─────────────────────────────────────────────────────────
    def finish(self, accepted: bool = True, reason: str = "") -> int:
        """Finalize the run and return its exit code. Call this exactly once.

        Two criteria, not one. Every phase must have passed, AND the ADW's own
        acceptance test must hold. They are different questions on purpose: a
        test phase that ran the suite did its job even when the suite came back
        red, so the PHASE succeeds while the RUN must not.

        This replaces a `succeeded` property that answered only the first
        question — and, being a property with side effects, wrote the session
        status and printed the banner before the caller's `and test.passed` was
        ever evaluated. A run whose suite never passed was recorded green on
        the terminal and in the UI while exiting 1. Anyone reading the trace
        saw success; only a CI job checking `$?` saw the truth. One call now
        settles the record, the banner, and the exit code together, so the
        three cannot disagree.
        """
        phases_ok = bool(self.phases) and all(p.status == "success" for p in self.phases)
        ok = phases_ok and accepted
        note = ""
        if phases_ok and not accepted:
            note = reason or "the run's acceptance criterion was not met"
            self.console.note(f"not accepted: {note}")
        # The session's own record says it, and it is the one a resume reads.
        artifacts.finish_run(self.session_dir, "success" if ok else "fail", reason=note)
        # An accepted run's worktree is a redundant copy of a branch that is
        # kept, so it goes; a failed or killed one is the evidence, so it stays.
        # `release` also keeps anything with uncommitted work in it, whatever
        # the outcome — a plan-only chain never commits, and its plan lives
        # nowhere else.
        if ok and not self.cfg.worktree.keep_on_success:
            self.console.note(f"worktree: {worktree.release(self.workspace)}")
        elif self.workspace.enabled:
            self.console.note(f"worktree: kept {self.repo_root} on {self.workspace.branch}")
        # A finished session that integrated nothing has no use for the copy of
        # its branch a cockpit was reading; one that did not finish still does.
        if ok:
            self._withdraw()
        self.console.session_finished(ok, self.tokens, self.cost, self.session_dir)
        return 0 if ok else 1

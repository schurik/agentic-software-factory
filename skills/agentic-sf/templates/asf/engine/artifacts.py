"""The runtime directory IS the record. This module reads and writes it.

`asf/data/sessions/<adw_id>/` holds everything a run produced —
`events.jsonl`, each agent's `envelope.json`, its compiled `prompts/`, the raw
harness stream, `agent_map.json`, `context_handoff/`. There is no other copy:
anything that needs to know what a session has already done reads these files,
and the record travels with the session directory.

Three artifacts are written here that the rest of the record could not supply:

  * `run.json` — the session's own state: which workflow ran, the ARGV that
    started it, the pid, and how it ended. `events.jsonl` describes phases, not
    the process that opened them, and `just resume` has to know what to launch
    again.
  * `envelopes/<phase_id>.json` — one file per agent PHASE. The per-agent
    `envelope.json` beside it is last-wins, which is right for "what did the
    builder last say" and useless for a replay: a builder that built, fixed and
    revised leaves one file and three phases.
  * `processes.jsonl` — every process this session spawned and every one that
    ended, appended as it happens. A hung coding agent emits nothing at all,
    which is exactly when you need its pid, and `ps` cannot say which run a pid
    belongs to. `just kill` reads this.

Both are small, both are rewritten rather than appended, and neither is read by
anything but the factory itself.

Every change to `run.json` and `processes.jsonl` made here also appends the
domain event that says what changed (`engine/events.py`) — in the same
function, so no caller can move the file without the event, and a station
shipping the events ships the same story the files tell. `tests/projection.py`
rebuilds `run.json` from those events alone.

Two things it says have no file of their own. Which CHAPTER a session is in —
one per workflow it passes through — is a fact about its events, read back off
them (`open_chapter`). And an ARTIFACT in the glossary's sense, a file a phase
declared or code wrote as a request, already has its file: `record_artifacts`
is where a cockpit is told what that file holds.

The same rule covers the two watchers, whose liveness is not a session at all:
`watchers/<kind>.json` is what `just status` reads.

A cockpit receives the events; it is never asked. Every answer below is a file
this session wrote, so every one of them works on a machine that has never
seen a cockpit.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import events
from .data_types import (BODY_BYTES, ArtifactRole, ArtifactWritten, DomainEvent, GateOpened,
                         ProcessEnded, ProcessStarted, ProvenanceRecorded, PullRequestClosed,
                         RecordedPhase,
                         RunState, SessionFinished, SessionResumed, SessionSpec, SessionStarted,
                         SessionSuspended, UsageRecorded, WaitingFor, WorkflowFinished,
                         WorkflowStarted)
from .utils import anchor, clip_utf8, ensure_dir, sweep_temps, utc, write_atomic

RUN_FILE = "run.json"
ENVELOPES_DIR = "envelopes"
EVENTS_FILE = events.EVENTS_FILE


# ── run.json ─────────────────────────────────────────────────────────────────

def run_path(session_dir: Path) -> Path:
    return Path(session_dir) / RUN_FILE


def read_run(session_dir: Path) -> RunState | None:
    """The session's recorded state, or None when it has none yet."""
    path = run_path(session_dir)
    if not path.is_file():
        return None
    try:
        return RunState(**json.loads(path.read_text()))
    except (ValueError, OSError):
        return None            # a truncated write is a missing answer, not a crash


def write_run(session_dir: Path, state: RunState) -> None:
    ensure_dir(Path(session_dir))
    write_atomic(run_path(session_dir), state.model_dump_json(indent=2))


def start_run(session_dir: Path, started: SessionStarted) -> RunState:
    """Record that a process has taken this session, keeping what came before.

    A joined session is worked by more than one ADW, and `workflows` is the list
    of them in order — `issue + pr-review` as `RunState.adw_name` says it. The
    command and the pid are the NEWEST process's, because they answer "what
    would running this again mean", and the newest process is the one that was
    working when the session stopped.

    The `session_started` event is the input and is appended beside the write,
    so what a cockpit receives and what `run.json` says cannot come apart.
    """
    # Taking the session is also when the last process's debris is swept: a run
    # killed mid-rewrite leaves a hidden temp file beside the file it was
    # replacing, and nothing else ever looks for it.
    sweep_temps(session_dir)
    state = RunState(adw_id=started.adw_id, workflows=[started.workflow],
                     command=started.command, pid=started.pid, engineer=started.engineer,
                     status="running", started_at=started.started_at,
                     repo_root=started.repo_root, branch=started.branch,
                     trigger=started.trigger, triggered_by=started.triggered_by,
                     issue_url=started.issue_url, pr_url=started.pr_url)
    previous = read_run(session_dir)
    if previous:
        state.workflows = previous.workflows + [
            name for name in state.workflows if name not in previous.workflows]
        # Provenance is learned once and never unlearned — an issue-triggered
        # session that a later ADW re-enters is still issue-triggered.
        state.trigger = state.trigger or previous.trigger
        state.issue_url = state.issue_url or previous.issue_url
        state.issue_number = state.issue_number or previous.issue_number
        state.issue_project = state.issue_project or previous.issue_project
        state.pr_url = state.pr_url or previous.pr_url
        state.pr_state = previous.pr_state
        # A session stopped at a gate is picked up by the process that answers
        # it, and that process has to reach the gate knowing what was asked.
        state.waiting_for = state.waiting_for or previous.waiting_for
        # Spend is the session's, not the process's, and a new process starts
        # its record at zero — so carrying it is what keeps `budget:` a ceiling
        # on the work rather than on whoever happens to be running it. Dropping
        # these two lines hands every re-entry a fresh wallet.
        state.total_tokens = previous.total_tokens
        state.total_cost = previous.total_cost
    write_run(session_dir, state)
    events.emit(session_dir, started)
    return state


def finish_run(session_dir: Path, status: str, reason: str = "",
               accepted: bool = True) -> None:
    """Close the session's record. Never raises: a run must not die reporting.

    Called from `run.finish()`, from a failed phase, from the SIGTERM handler
    and from a watcher aborting a run at its gate, so the file says how the
    session ended even when the ending was not the happy one.
    Whichever of them it is, the chapter the session was in ends with it.
    `accepted` is whether the workflow accepted the chapter, which only
    `run.finish()` is told; every other ending was never judged (`WorkflowFinished`).
    """
    from .utils import now_iso
    state = read_run(session_dir)
    if state is None:
        return
    state.status = status
    state.ended_at = now_iso()
    # Nothing this run started is still its to stop — closed first, so the
    # session's last event is the one that says it ended.
    end_all_processes(session_dir)
    try:
        write_run(session_dir, state)
        chapters = _chapters(session_dir)
        if chapters.open:
            events.emit(session_dir, WorkflowFinished(
                workflow=chapters.workflows[chapters.active], chapter=chapters.active,
                status=status, reason=reason, accepted=accepted))
        events.emit(session_dir, SessionFinished(status=status, ended_at=state.ended_at,
                                                 reason=reason))
    except OSError:
        pass


# ── chapters: one per workflow the session passes through ────────────────────

def open_chapter(session_dir: Path, workflow: str, spec: SessionSpec) -> None:
    """Say which chapter of the session this process works on, as `spec` opens it.

    A process that RESUMES a workflow continues that workflow's latest chapter
    (`session_resumed`) — the latest of ITS workflow, which need not be the
    session's latest: another workflow may have joined while this one waited at
    a gate. Every other start opens the next chapter (`workflow_started`): a
    joined run is new work, and a second round of pull-request review is a
    second chapter of the same workflow. A resume with no chapter to continue
    (the session was recorded before chapters were, or never ran this workflow)
    opens one and says it resumed.

    No file holds this: the chapters are read back off the session's own
    events, which is also how `finish_run` knows which one to close — from any
    process, including one that never opened it.
    """
    chapters = _chapters(session_dir)
    number = chapters.latest_of(workflow) if spec.resume else 0
    if not number:
        number = max(chapters.workflows, default=0) + 1
        events.emit(session_dir, WorkflowStarted(workflow=workflow, chapter=number,
                                                 input=spec.input, stages=spec.stages))
    if spec.resume:
        events.emit(session_dir, SessionResumed(workflow=workflow, chapter=number))


def ended_chapter(session_dir: Path) -> int:
    """The chapter the session's latest process took up, once it has ended —
    what a scorer judges (`engine/scorers.py`). 0 while it is still open, and
    for a session that has none."""
    chapters = _chapters(session_dir)
    return 0 if chapters.open else chapters.active


def ended_chapters(session_dir: Path) -> dict[int, tuple[str, int]]:
    """{chapter: (its workflow, the seq of its latest end)} for every chapter
    that has ended and was not taken up again since — what `asf score` may
    score. A chapter resumed after it ended is open until it ends again, and a
    chapter stopped at a gate has not ended at all."""
    chapters = _chapters(session_dir)
    return {number: (chapters.workflows[number], seq)
            for number, seq in sorted(chapters.ends.items())}


@dataclass
class _Chapters:
    """A session's chapters, as its events tell them."""

    workflows: dict[int, str] = field(default_factory=dict)   # number -> workflow, as opened
    active: int = 0               # the one the latest process took up; 0 = none yet
    open: bool = False            # ...and whether it is still unfinished
    ends: dict[int, int] = field(default_factory=dict)   # number -> seq of its latest end,
                                                          # while not taken up again since

    def latest_of(self, workflow: str) -> int:
        """The newest chapter of `workflow`, or 0 when it has none."""
        return max((number for number, name in self.workflows.items() if name == workflow),
                   default=0)


def _chapters(session_dir: Path) -> _Chapters:
    """Read off the raw payloads, so a chapter a newer or older factory opened
    still counts."""
    chapters = _Chapters()
    for line in events.read(session_dir):
        if line.kind not in (WorkflowStarted.KIND, SessionResumed.KIND, WorkflowFinished.KIND):
            continue
        number = int(line.payload.get("chapter") or 0)
        if line.kind == WorkflowStarted.KIND:
            chapters.workflows[number] = str(line.payload.get("workflow", ""))
        if number not in chapters.workflows:
            continue                # a resume or an ending of a chapter nothing opened
        if line.kind == WorkflowFinished.KIND:
            chapters.open = chapters.open and number != chapters.active
            chapters.ends[number] = line.seq
        else:
            chapters.active, chapters.open = number, True
            chapters.ends.pop(number, None)
    return chapters


def _patch(session_dir: Path, event: DomainEvent, **fields) -> None:
    """Set the truthy `fields` on the recorded state and append `event`. Never raises.

    Truthy only, because each caller is a session LEARNING something: an empty
    value is "nothing new", never "forget what you knew".
    """
    state = read_run(session_dir)
    if state is None:
        return
    for key, value in fields.items():
        if value:
            setattr(state, key, value)
    try:
        write_run(session_dir, state)
        events.emit(session_dir, event)
    except OSError:
        pass


def record_provenance(session_dir: Path, learned: ProvenanceRecorded) -> None:
    """What asked for this session: an issue, a pull request, a request line."""
    _patch(session_dir, learned, trigger=learned.trigger, issue_url=learned.issue_url,
           issue_number=learned.issue_number, issue_project=learned.issue_project,
           pr_url=learned.pr_url)


def record_pr_closed(session_dir: Path, closed: PullRequestClosed) -> None:
    """How the session's pull request ended, learned after the session did."""
    _patch(session_dir, closed, pr_state="merged" if closed.merged else "closed")


def record_usage(session_dir: Path, usage: UsageRecorded) -> None:
    """One agent turn's spend, and the session's totals after it — absolute, so
    nothing has to read-modify-write a number two runs could race on."""
    _patch(session_dir, usage, total_tokens=usage.session_tokens,
           total_cost=usage.session_cost)


# ── run.json: waiting on a human ─────────────────────────────────────────────

DECISIONS_DIR = "decisions"


def decisions_dir(session_dir: Path) -> Path:
    return Path(session_dir) / DECISIONS_DIR


def suspend_run(session_dir: Path, suspended: SessionSuspended) -> None:
    """Record that this session stopped for a human, and that nothing of it is alive.

    Not `finish_run`: `ended_at` stays empty, because a waiting run has not
    ended — it will be picked up by `just approve` and continue as the same
    session. The pid is cleared and the process rows closed for the same reason
    `finish_run` closes them: the process IS gone, and a watcher counting live
    runs must not count this one.
    """
    state = read_run(session_dir)
    if state is None:
        return
    state.status = "waiting"
    state.waiting_for = suspended.waiting_for
    state.pid = 0
    end_all_processes(session_dir)
    try:
        write_run(session_dir, state)
        events.emit(session_dir, suspended)
    except OSError:
        pass


def open_gate(session_dir: Path, waiting: WaitingFor) -> None:
    """A gate is asking at this run's own terminal — `just pending` sees it."""
    _patch(session_dir, GateOpened(waiting_for=waiting), waiting_for=waiting)


def clear_waiting(session_dir: Path) -> None:
    """The decision was consumed; the session no longer waits on it.

    No event of its own: `hitl.record` is the one caller, and the consumed
    `decision_recorded` it appends is what says so.
    """
    state = read_run(session_dir)
    if state is None or state.waiting_for is None:
        return
    state.waiting_for = None
    try:
        write_run(session_dir, state)
    except OSError:
        pass


def waiting_sessions(sessions_dir: Path) -> dict[str, WaitingFor]:
    """{adw_id: what it waits for} for every session stopped at a gate."""
    return {adw_id: state.waiting_for for adw_id, state in scan(sessions_dir).items()
            if state.status == "waiting" and state.waiting_for is not None}


# ── envelopes/<phase_id>.json ────────────────────────────────────────────────

def write_envelope(session_dir: Path, record: RecordedPhase) -> None:
    """One agent phase's envelope, keyed by the phase that produced it."""
    directory = ensure_dir(Path(session_dir) / ENVELOPES_DIR)
    write_atomic(directory / f"{record.phase_id}.json", record.model_dump_json(indent=2))


def recorded_phases(session_dir: Path) -> list[RecordedPhase]:
    """Every agent phase this session completed successfully, in run order.

    Two session artifacts answer this together, and both are needed. The
    envelope files say what each agent PRODUCED; `events.jsonl` says which
    phases actually PASSED — an envelope is written before the phase closes, so
    one whose phase then failed (a bad status, a permission breach) is on disk
    and must never be handed back. A phase with no `phase_end` recorded (the
    process was killed mid-phase) is unfinished, and therefore not offered.
    """
    directory = Path(session_dir) / ENVELOPES_DIR
    if not directory.is_dir():
        return []
    passed = _phase_outcomes(Path(session_dir))
    records = []
    for path in sorted(directory.glob("*.json")):
        try:
            record = RecordedPhase(**json.loads(path.read_text()))
        except (ValueError, OSError):
            continue           # an unreadable record is one that is not offered
        if passed.get(record.phase_id) == "success":
            records.append(record)
    return sorted(records, key=lambda record: record.seq)


def max_phase_seq(session_dir: Path, adw_id: str) -> int:
    """The highest phase number this session has already used; 0 when it is new.

    A joined or resumed run continues the sequence instead of restarting at 1 —
    restarting collides with the first process's phases on both the ordering and
    the `phase_id`, which is the name of the envelope file this module writes.
    This is where a phase the session has NOT seen before gets its number; one
    it has seen is re-entered under the one it already has — `phase_identities`.
    """
    return max((seq for seq, _ in _phase_ids(session_dir, adw_id)), default=0)


def phase_identities(session_dir: Path, adw_id: str) -> dict[str, tuple[int, str]]:
    """{phase name: (seq, phase_id)} for every phase this session has opened.

    What a RESUMED run re-enters a phase under, instead of minting a number
    nothing has seen. A resume re-walks the chain from the top — the phases
    before the failure replay from the record or, when code owns them, run
    again for real — and under fresh numbers each of those walks writes a
    SECOND row for a phase that already has one: two `plan`s after the first
    resume, three after the next, and a cockpit drawing the same stage once
    per recovery. Keyed by name because that is what a resumed chain matches on
    (`engine/replay.py`), and because `PhaseParams` already requires a name to
    be unique within a run.

    Includes phases that only ever STARTED — a run picked up at the phase that
    killed it must land back on that phase's row, not beside it.

    The LOWEST number wins per name, so a session that was resumed before this
    existed, and already holds the duplicates, converges back onto the row it
    opened first rather than adding a fourth.
    """
    found: dict[str, tuple[int, str]] = {}
    for seq, phase_id in _phase_ids(session_dir, adw_id):
        name = phase_id.removeprefix(f"{adw_id}_{seq:02d}_")
        if not name or name == phase_id:
            continue          # not this session's id shape; nothing to re-enter
        current = found.get(name)
        if current is None or seq < current[0]:
            found[name] = (seq, phase_id)
    return found


def _phase_ids(session_dir: Path, adw_id: str) -> list[tuple[int, str]]:
    """(seq, phase_id) for every phase id this session emitted, in event order.

    The seq is read out of the id, for the reason the rest of this module
    exists: the session's own files are the whole record, and the number is
    right there in every phase id the
    session wrote to its own event log (`<adw_id>_<seq>_<name>`, so the prefix
    comes off and the digits are next).
    """
    found = []
    for phase_id in _phase_outcomes(session_dir, every=True):
        tail = phase_id.removeprefix(f"{adw_id}_").split("_", 1)[0]
        if tail.isdigit():
            found.append((int(tail), phase_id))
    return found


def _phase_outcomes(session_dir: Path, every: bool = False) -> dict[str, str]:
    """{phase_id: final status} from the session's own event log.

    `events.jsonl` is the record the tracer appends as things happen. Read
    forwards, so a phase re-entered by a later process in the session ends on
    its LATEST outcome. `every` widens it to phases that only ever STARTED,
    which is what counting the phase numbers a session has used needs — see
    `max_phase_seq`.

    Two line shapes, because a session outlives an upgrade: typed domain events
    (`kind: phase_ended`, the id in the payload) and the lines an older factory
    wrote (`type: phase_end`, the id beside it). A resumed run must count both.
    """
    path = session_dir / EVENTS_FILE
    if not path.is_file():
        return {}
    outcomes: dict[str, str] = {}
    try:
        with path.open() as stream:
            for line in stream:
                line = line.strip()
                wanted = ('"phase_' if every else '"phase_end')
                if not line or wanted not in line:
                    continue   # cheap reject: most lines are not about a phase closing
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("kind") or event.get("type")
                body = event.get("payload") or {}
                phase_id = body.get("phase_id") if "kind" in event else event.get("phase_id")
                if not phase_id:
                    continue
                if kind in ("phase_ended", "phase_end"):
                    outcomes[phase_id] = body.get("status", "")
                elif every and kind in ("phase_started", "phase_start"):
                    outcomes.setdefault(phase_id, "")
    except OSError:
        return {}
    return outcomes


# ── artifacts: what a phase wrote, as a cockpit is told ──────────────────────

def record_artifacts(run, role: ArtifactRole, paths: list[str]) -> None:
    """Say what these artifacts hold now, as the run's current phase left them.
    Never raises: a run must not die reporting.

    Called where an artifact becomes part of the record: by the code that
    writes a request (`issues.fetch`, `pull_requests.attach`, the answers a
    `refine` round collected), and by `agents.execute` for what an agent
    declared on an envelope that was then
    ACCEPTED — through its gates and its write boundary, so nothing an agent
    was not allowed to write is shipped as something it produced.

    `ArtifactWritten` says what travels for a handoff file and what for a repo
    file. Either is skipped while its bytes are the ones this session last said
    it held: a resume reads the issue again and replays the scout, and neither
    wrote anything new. A path that lies in neither tree is not this run's to
    describe (`gates.artifacts_exist` has already refused it).
    """
    phase_id = run.phases[-1].phase_id if run.phases else ""
    try:
        sent = {(line.payload.get("location"), line.payload.get("path")):
                line.payload.get("digest")
                for line in events.read(run.session_dir) if line.kind == ArtifactWritten.KIND}
        located = [found for found in (_locate(run, declared) for declared in paths) if found]
        # Repo files first, so a handoff copy declared beside one finds it already named.
        for location, path, target in sorted(located, key=lambda found: found[0] != "repo"):
            data = target.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if sent.get((location, path)) == digest:
                continue
            twin = location == "handoff" and (location, path) not in sent and any(
                where == "repo" and held == digest for (where, _), held in sent.items())
            if twin:
                continue
            sent[(location, path)] = digest
            content, truncated = "", False
            if location == "handoff":
                # Git's own test for "not text". A file of NULs costs six
                # characters each on the wire, and an event a cockpit refuses
                # for its size holds up every event of the session behind it.
                content, truncated = ("", True) if b"\0" in data \
                    else clip_utf8(data, BODY_BYTES)
            events.emit(run.session_dir, ArtifactWritten(
                phase_id=phase_id, role=role, location=location, path=path, size=len(data),
                digest=digest, content=content, truncated=truncated))
    except OSError:
        pass


def _locate(run, declared: str) -> tuple[str, str, Path] | None:
    """(handoff | repo, the path relative to that tree, the file) for a declared
    artifact. The session directory is asked first: without a worktree it lies
    inside the repository, and its files are still handoff files."""
    target = anchor(run.repo_root, declared).resolve()
    if not target.is_file():
        return None
    for location, tree in (("handoff", run.session_dir.resolve()),
                           ("repo", run.repo_root.resolve())):
        if tree in target.parents:
            return location, target.relative_to(tree).as_posix(), target
    return None


# ── asking about many sessions at once ───────────────────────────────────────

def sessions_root(main_root, data_dir: str) -> Path:
    """Where session directories live, from the two things every caller has."""
    from .utils import anchor
    return anchor(main_root, f"{data_dir}/sessions")


def scan(sessions_dir: Path) -> dict[str, RunState]:
    """{adw_id: RunState} for every session on disk. {} when there are none.

    The maintenance tools — the watchers deciding how many runs are in flight,
    `just worktrees` labelling a directory, `just status`, `asf sessions` — ask
    about sessions they did not run, and these files answer. A session
    directory with no `run.json` (recorded before this file existed) is absent
    from the result, and every caller already renders that as "unknown" rather
    than guessing.
    """
    directory = Path(sessions_dir)
    if not directory.is_dir():
        return {}
    found: dict[str, RunState] = {}
    for child in sorted(directory.iterdir()):
        if not child.is_dir():
            continue
        state = read_run(child)
        if state:
            found[state.adw_id or child.name] = state
    return found


def statuses(sessions_dir: Path) -> dict[str, str]:
    """{adw_id: status} — 'running' means the record was never closed."""
    return {adw_id: state.status or "unknown"
            for adw_id, state in scan(sessions_dir).items()}


def running_pids(sessions_dir: Path) -> dict[str, int]:
    """{adw_id: pid} for every session that BELIEVES it is running.

    "Believes" is the point, and the caller is expected to check the pid. A
    record is closed by `run.finish()` or by the SIGTERM handler; a SIGKILL, an
    OOM or a reboot leaves it reading `running` forever, and anything that
    budgets on the count (the issue watcher's `max_concurrent`) would wedge
    permanently after two such deaths without the pid to test.
    """
    return {adw_id: state.pid for adw_id, state in scan(sessions_dir).items()
            if state.status == "running" and state.pid}


def pr_urls(sessions_dir: Path) -> dict[str, str]:
    """{adw_id: pr_url} for every session that became a pull request."""
    return {adw_id: state.pr_url for adw_id, state in scan(sessions_dir).items()
            if state.pr_url}


def unclosed_pr_urls(sessions_dir: Path, since: datetime | None = None) -> dict[str, str]:
    """{adw_id: pr_url} for every session whose pull request has not been seen
    closed — open still, or closed while nothing was watching — of those started
    on or after `since`."""
    return {adw_id: state.pr_url for adw_id, state in started_since(sessions_dir, since).items()
            if state.pr_url and not state.pr_state}


def started_since(sessions_dir: Path, since: datetime | None = None) -> dict[str, RunState]:
    """`scan`, narrowed to the sessions started on or after `since` — what
    `asf score --since` walks. A session with no readable start counts as
    started since: nothing says it is older."""
    return {adw_id: state for adw_id, state in scan(sessions_dir).items()
            if _started_since(state.started_at, since)}


def _started_since(started_at: str, since: datetime | None) -> bool:
    if since is None:
        return True
    try:
        return utc(datetime.fromisoformat(started_at)) >= since
    except ValueError:
        return True


def adw_names(sessions_dir: Path) -> dict[str, str]:
    """{adw_id: "issue + pr-review"} — which workflows a session ran.

    `pr_watch` reaps with this: stopping a review run whose branch has landed is
    cleanup, and stopping the SDLC run that opened that pull request and is
    still writing its docs is destroying work. Only the workflow tells them apart.
    """
    return {adw_id: state.adw_name for adw_id, state in scan(sessions_dir).items()}


# ── watchers/<kind>.json (liveness, not a session) ───────────────────────────

def watchers_dir(main_root, data_dir: str) -> Path:
    from .utils import anchor
    return anchor(main_root, f"{data_dir}/watchers")


def watcher_beat(directory: Path, kind: str, fields: dict) -> None:
    """Record that a watcher is alive and what it last saw. Never raises.

    A watcher that is not running and a watcher with nothing to do look
    identical from the outside — which is the most expensive confusion in
    operating this thing: you label an issue, wait, and find out an hour later
    that nothing was polling. This file is what lets `just status` answer it.

    `started_at` is preserved across beats, so the file also says how long this
    watcher has been up. Failure is swallowed: a watcher must not die because it
    could not describe itself.
    """
    try:
        path = ensure_dir(Path(directory)) / f"{kind}.json"
        previous = {}
        if path.is_file():
            try:
                previous = json.loads(path.read_text())
            except ValueError:
                previous = {}
        row = {**previous, **fields, "kind": kind}
        row["started_at"] = previous.get("started_at") or fields.get("started_at", "")
        write_atomic(path, json.dumps(row, indent=2))
    except OSError:
        pass


def watcher_states(directory: Path) -> dict[str, dict]:
    """{kind: row} for every watcher that has ever beaten here.

    A kind that is absent has never been started in this repo — a different
    thing from `stopped`, and readers render the two differently.
    """
    path = Path(directory)
    if not path.is_dir():
        return {}
    found = {}
    for child in sorted(path.glob("*.json")):
        try:
            row = json.loads(child.read_text())
        except (ValueError, OSError):
            continue
        found[row.get("kind") or child.stem] = row
    return found


# ── processes.jsonl (what a run has alive, so it can be stopped) ─────────────

PROCESSES_FILE = "processes.jsonl"


def record_process(session_dir: Path, kind: str, name: str, pid: int,
                   command: str) -> None:
    """Append a process this session just spawned. Never raises.

    Appended rather than rewritten because two agents can be starting and
    ending at once, and an append of one line is the only write that needs no
    coordination between them.
    """
    from .utils import now_iso
    try:
        path = ensure_dir(Path(session_dir)) / PROCESSES_FILE
        with path.open("a") as stream:
            stream.write(json.dumps({"event": "start", "kind": kind, "name": name,
                                     "pid": pid, "command": command[:500],
                                     "at": now_iso()}) + "\n")
        events.emit(session_dir, ProcessStarted(kind=kind, name=name, pid=pid,
                                                command=command[:500]))
    except OSError:
        pass


def end_process(session_dir: Path, pid: int) -> None:
    """Append the fact that a pid this session started is finished."""
    from .utils import now_iso
    try:
        path = ensure_dir(Path(session_dir)) / PROCESSES_FILE
        with path.open("a") as stream:
            stream.write(json.dumps({"event": "end", "pid": pid,
                                     "at": now_iso()}) + "\n")
        events.emit(session_dir, ProcessEnded(pid=pid))
    except OSError:
        pass


def live_processes(session_dir: Path) -> list[dict]:
    """What this session believes it still has running — children first.

    "Believes" again: a SIGKILL leaves a start with no end. The caller verifies
    each pid against the command recorded beside it, because pids get recycled
    and signalling a stranger's process is the one outcome worth checking for.

    Children before the parent, deliberately. Kill the workflow first and its
    coding agent keeps running, detached, still burning tokens against an API
    with nothing left to record what it did.
    """
    path = Path(session_dir) / PROCESSES_FILE
    if not path.is_file():
        return []
    live: dict[int, dict] = {}
    try:
        with path.open() as stream:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                pid = row.get("pid")
                if not pid:
                    continue
                if row.get("event") == "start":
                    live[pid] = row
                else:
                    live.pop(pid, None)
    except OSError:
        return []
    return sorted(live.values(), key=lambda row: 0 if row.get("kind") == "agent" else 1)


def end_all_processes(session_dir: Path) -> None:
    """Close every process this session still believes is alive.

    Called when the session ends: the run is over, so nothing it started is
    still its to stop.
    """
    for row in live_processes(session_dir):
        end_process(session_dir, row["pid"])

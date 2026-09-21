"""Human-in-the-loop gates: stop after a phase, ask a person, continue or revise.

A gate is its own `kind="engineer"` phase — the lane that until now only ever
logged the request — plus a revise loop that is the reviewer loop in
the review stage with a person where the reviewer is. `gated()` owns both.
An ADW spends one call per gate and never sees the loop, the wait, or the file.

THE WAIT IS A SUSPEND. `decide()` looks for a decision this session already
recorded for the gate and round; finding none, it records what it is waiting
for in `run.json`, exits the process with status 75, and leaves the worktree
where it is. `just approve <adw_id>` writes the decision and re-launches the
same workflow with `--resume`: replay answers every recorded agent phase from
the record, the chain reaches the gate again, and this time the decision is
there. A terminal prompt is a convenience over that — while a person is at THIS
RUN's terminal the run asks in place and polls the same file, and `d` or
`wait_seconds` turns the block into the suspend it would have been anyway. A
watcher's terminal, inherited by the run it launched, is not that terminal;
`attended()` says how the two are told apart.

THE DECISION NAMES WHAT IT DECIDED. `subject_digest` hashes the artifact files
at the moment the human was asked; a decision whose digest does not match the
subject in front of the run now is refused and the run waits again. That is
the one rule everything here rests on, and it is what makes a decision file
safe to write from anywhere.

TRUST IS RECORDED. A gate the policy skips writes `verdict=approve,
by="policy", channel="auto"` to the same directory, so the record of a run
shows every gate it passed and who passed it.

THE VERDICT IS SPENT, THE WORDS ARE NOT. Whatever a person types beside a
verdict is usually an amendment to the request, and it has to outlive the round
that heard it — `_consume` files it as a `Remark` on the run's journal, which
engine/journal.py puts in front of every agent the run calls afterwards.

Files only. The trace db mirrors the events; nothing here reads it.
"""

from __future__ import annotations

import hashlib
import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from . import artifacts, issues, journal
from .data_types import (Decision, EnvelopeBase, EventRecord, Gate, HitlConfig, IssueRef,
                         IssueUpdate, Phase, PhaseParams, Remark, Reply, Subject,
                         WaitingFor)
from .utils import now_iso

EXIT_WAITING = 75          # EX_TEMPFAIL: "try again later", which is exactly it
POLL_SECONDS = 2.0         # attended: how long one look at the keyboard waits


# ── the record ───────────────────────────────────────────────────────────────

def digest(paths: list[Path]) -> str:
    """One hash over the subject's files, independent of listing order.

    A missing file hashes as its name plus a marker, so "the plan is gone" is a
    different subject from "the plan is here" and from "there was no plan".
    """
    hasher = hashlib.sha256()
    for path in sorted(Path(p) for p in paths):
        hasher.update(str(path).encode())
        hasher.update(b"\0")
        try:
            hasher.update(path.read_bytes())
        except OSError:
            hasher.update(b"<missing>")
        hasher.update(b"\0")
    return hasher.hexdigest()


def decision_path(session_dir: Path, gate: str, round: int) -> Path:
    return artifacts.decisions_dir(session_dir) / f"{gate}_{round}.json"


def record(session_dir: Path, decision: Decision) -> Path:
    """Write one decision. Keyed by gate and round; a later write replaces."""
    path = decision_path(session_dir, decision.gate, decision.round)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(decision.model_dump_json(indent=2))
    return path


def read_decision(session_dir: Path, gate: str, round: int) -> Optional[Decision]:
    path = decision_path(session_dir, gate, round)
    if not path.is_file():
        return None
    try:
        return Decision(**json.loads(path.read_text()))
    except (ValueError, OSError):
        return None            # a half-written file is a missing answer, not a crash


# ── the keyboard ─────────────────────────────────────────────────────────────

UNATTENDED_ENV = "ASF_UNATTENDED"    # a launcher saying "my terminal is not this run's"


def attended() -> bool:
    """Whether anyone can answer at THIS RUN's terminal. False under cron, a watcher, a test.

    A TTY test alone is not enough, because a TTY can be INHERITED. `issue_watch`
    and `pr_watch` launch a chain with a blocking `subprocess.run` that passes
    their own stdin straight through, so a watcher started by hand from a
    terminal — `just up` in a window someone left open — hands every run it
    starts a keyboard that looks exactly like the engineer's. Asking there
    prompts whoever is watching the queue, about a plan they never asked to
    read, interleaved with the poll log; and because the watchers are
    deliberately serial, it stops the whole queue for `hitl.wait_seconds` (900
    by default) before suspending anyway. Under cron the same run suspends at
    once. Two very different behaviours from one line of config is the bug.

    Only the LAUNCHER knows which it is, so the launcher says so: the watchers
    set `ASF_UNATTENDED` on the runs they start. `run.trigger` cannot answer
    this — an engineer who types `uv run asf/asf.py run issue 42` at their own
    keyboard is on the `issue` trigger too, and should still be asked in place.
    """
    if os.environ.get(UNATTENDED_ENV, "").strip():
        return False
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def _insist(prompt: str) -> str:
    """A verdict whose whole content is the words. Asking again beats recording
    an empty one — a reject with no notes is an agent told to change nothing."""
    text = ""
    while not text:
        text = input(prompt).strip()
    return text


def read_keypress(waiting: WaitingFor) -> tuple[str, str]:
    """The real `ask`: one line from a TTY, or ("", "") after POLL_SECONDS so the
    caller can look at the decision record again.

    The keys on offer follow `waiting.kind`, because the two waits want
    different things. At a GATE: approve, reject, abort. At a QUESTION ROUND:
    answer, approve (take every recommendation as it stands), abort — there is
    nothing to reject, the agent did not claim anything.
    """
    ready, _, _ = select.select([sys.stdin], [], [], POLL_SECONDS)
    if not ready:
        return "", ""
    key = sys.stdin.readline().strip().lower()[:1]
    questions = waiting.kind == "questions"
    if key == "a":
        return "approve", input(
            "taking every recommendation — anything to add? (optional): " if questions
            else "notes for the next agent (optional): ").strip()
    if key == "n" and questions:
        return "answer", _insist("your answers: ")
    if key == "r" and not questions:
        return "reject", _insist("what should change: ")
    if key == "x":
        return "abort", input("reason (optional): ").strip()
    if key == "d":
        return "detach", ""
    return "", ""


# ── the policy ───────────────────────────────────────────────────────────────

OVERRIDES = ("all", "none", "every")


class HitlPolicy:
    """Whether a named gate fires, resolved most-specific-first.

    `override` is the `--hitl` flag (or `ASF_HITL`): `all`, `none`, `every`,
    or a comma-separated list of gate names. It is a person saying so at the
    keyboard, and it wins over everything in the config — including
    `when_unattended`, because a flag on an issue run's argv was put there by
    the operator who launched the watcher.

    `ask` is how an attended run asks in place: a callable taking the
    `WaitingFor` and returning `(verdict | "detach" | "", notes)`. None means
    nobody is at THIS RUN's keyboard — see `attended()`, which is not merely a
    TTY test — and the gate suspends at once. It lives here because "is anyone
    attending" is a policy input, and because this is the run-scoped object a
    test can hand a scripted answerer to.
    """

    def __init__(self, config: HitlConfig, override: str = ""):
        self.config = config
        self.override = (override or "").strip().lower()
        self.every = self.override == "every"
        self._named: set[str] = set()
        if self.override and self.override not in OVERRIDES:
            names = {part.strip() for part in self.override.split(",") if part.strip()}
            if not names or any(not part.replace("_", "").isalnum() for part in names):
                raise ValueError(f"--hitl {override!r}: expected all | none | every | "
                                 f"a comma-separated list of gate names")
            self._named = names
        self.ask = read_keypress if attended() else None

    def mode(self, gate: str, trigger: str) -> str:
        """`on` — stop and ask. `auto` — record a policy approval and go on."""
        if self.override in ("all", "every"):
            return "on"
        if self.override == "none":
            return "auto"
        if self._named:
            return "on" if gate in self._named else "auto"
        if not self.config.gates.get(gate, self.config.default):
            return "auto"
        if trigger != "engineer" and self.config.when_unattended == "auto":
            return "auto"
        return "on"

    def summary(self) -> str:
        """The one line the console prints when any gate may fire."""
        source = f"--hitl {self.override}" if self.override else "config"
        on = sorted(gate for gate, value in self.config.gates.items() if value)
        line = f"hitl: {source}"
        if self.every:
            line += " · a checkpoint after every agent phase"
        elif not self.override:
            line += f" · default {'on' if self.config.default else 'off'}"
            if on:
                line += f" · on: {', '.join(on)}"
        return line + (" · attended" if self.ask else " · unattended, gates suspend")


# ── the wait ─────────────────────────────────────────────────────────────────

class Suspended(SystemExit):
    """The run stopped for a human. Exit 75; the record says what it waits for.

    A SystemExit so an ADW's uncaught path is a clean exit with no traceback —
    a run that stopped on purpose must not look like one that crashed — and so
    `Run.phase` can tell it from every other exception and close the phase as
    `waiting` rather than `fail`.
    """

    def __init__(self, waiting: WaitingFor):
        super().__init__(EXIT_WAITING)
        self.waiting = waiting


def resolve_paths(run, paths: list[str]) -> list[Path]:
    """Subject paths as absolute files: absolute stay, relative are the worktree's."""
    return [Path(p) if Path(p).is_absolute() else Path(run.repo_root) / p for p in paths]


def channel_of(run) -> str:
    """Where this run's questions go, and where its answer comes back from.

    THE WORK ITEM FIRST, then the pull request, then the terminal. A run that
    was launched from one of the first two answers THERE — at every gate, not
    only at a question round — because the person who filed the work or asked
    for the change is already looking at that page. A terminal is the thing
    that is usually not there: under cron, inside a watcher, in CI. Deriving
    the other way round would have a suspended run claim to be waiting
    somewhere nobody is standing.

    Only "issue" has a reader today. "pr" is recorded anyway, because what a
    suspended review run is waiting on is a fact worth writing down truthfully
    before there is code that acts on it — and a watcher that cannot serve a
    channel must skip it by NAME rather than by assuming everything it does not
    recognise is its own.
    """
    if getattr(run, "issue_number", 0):
        return "issue"
    if getattr(run, "pr_url", ""):
        return "pr"
    return "terminal"


def how_to_answer(run, gate: str, kind: str = "gate") -> str:
    """The one line that tells a person how to end this wait, in the verbs that
    actually apply to it. A question round has nothing to reject."""
    verbs = ((f'asf answer {run.adw_id} -m "..."', f"asf approve {run.adw_id}")
             if kind == "questions"
             else (f"asf approve {run.adw_id}", f'asf reject {run.adw_id} -m "..."'))
    return "  ".join([*verbs, f"asf abort {run.adw_id}"])


def decide(run, phase: Phase, subject: Subject) -> Decision:
    """The decision for this gate and round — from the record, the terminal, or not yet.

    Order: a recorded decision whose digest matches wins, whoever wrote it. An
    attended run then asks in place, polling the record meanwhile so a
    `just approve` from another terminal is honoured too. Everything else
    suspends. The digest is taken ONCE, here, and every later comparison is
    against it — the human is answering about what they were shown.
    """
    paths = resolve_paths(run, subject.paths)
    fingerprint = digest(paths)
    waiting = WaitingFor(gate=subject.gate, round=subject.round, kind=subject.kind,
                         phase_id=phase.phase_id,
                         phase_name=phase.params.name, since=now_iso(),
                         subject_digest=fingerprint, paths=[str(p) for p in paths],
                         summary=subject.summary, notes=subject.notes,
                         channel=channel_of(run),
                         issue_number=getattr(run, "issue_number", 0))
    run.console.note(f"gate {subject.gate} round {subject.round}: {subject.summary}")
    for path in waiting.paths:
        run.console.note(f"subject: {path}")

    recorded = read_decision(run.session_dir, subject.gate, subject.round)
    if recorded is not None:
        if recorded.consumed_at and run.resuming:
            # This round was already walked by an earlier process, and the
            # chain is re-walking it under --resume. The subject may since have
            # moved on — a reject's revise rewrote the plan in place — so the
            # digest cannot hold and is not asked to: the human already saw
            # this one, and acting on it again is what replay means.
            run.console.note(f"↺ decision {subject.gate}_{subject.round} replayed — "
                             f"{recorded.verdict} by {recorded.by}, already acted on by "
                             f"an earlier process of this session")
            return _consume(run, phase, recorded, subject.kind)
        if recorded.subject_digest == fingerprint:
            return _consume(run, phase, recorded, subject.kind)
        run.console.note(f"decision {subject.gate}_{subject.round} is stale — it decided "
                         f"on a different {subject.gate}; asking again")

    # Nothing was recorded, so this round is really going to wait — and only
    # now is it worth putting the questions where a person will see them.
    # Publishing before the lookups above would ask again on every resume.
    publish(run, waiting, subject.questions)

    # The blocked-and-polling path. `run.hitl.ask` is None without a TTY; a
    # test injects a scripted answerer the same way a keypress would answer.
    if run.hitl.ask is not None:
        artifacts.update_run(run.session_dir, waiting_for=waiting)   # `just pending` sees it
        answer = _attended(run, waiting)
        if answer is not None:
            return _consume(run, phase, answer, subject.kind)

    _notify(run, waiting)
    raise Suspended(waiting)


def publish(run, waiting: WaitingFor, questions: list) -> None:
    """Put this round's questions where the run's channel says a person is.

    MUTATES `waiting.asked_at`, which is the point as much as the comment is:
    an answer is a reply that came AFTER the question, and the moment it went
    up is read back off the posted comment rather than taken from this
    process's clock. The two are not the same one, and a run a few seconds
    ahead of the forge would stamp a `since` in the tracker's future and throw
    away the first reply as if it had arrived before the question.

    IDEMPOTENT ACROSS A SUSPEND, and that is not a nicety: `decide()` re-enters
    the round it suspended in — that is what replay means — so without the
    check a resumed process would post the same questions under the first set,
    to someone already looking at them.

    Only the issue channel has anywhere to put them. At a terminal the subject
    is already on the screen and `asf show` prints the rest; on a pull request
    there is no reader yet, so a run there waits without asking and says so.

    A failed post is not a failed run — the questions are in the session's own
    record either way — but it IS a run about to wait for an answer nobody was
    asked for, so it says that out loud instead of suspending quietly.
    """
    if not questions or waiting.channel != "issue" or not waiting.issue_number:
        if questions and waiting.channel != "issue":
            run.console.note(f"{len(questions)} question(s) to ask, but this run answers on "
                             f"{waiting.channel} — `asf show {run.adw_id}` prints them")
        return

    config = run.cfg.issues
    ref = IssueRef(number=waiting.issue_number)
    try:
        heard = issues.comments(run.main_root, config, ref)
    except RuntimeError as error:
        run.console.note(f"could not read #{waiting.issue_number} before asking: {error}")
        heard = []

    if not issues.already_asked(heard, run.adw_id, waiting.round):
        posted = issues.comment(run.main_root, config, IssueUpdate(
            number=waiting.issue_number,
            comment=issues.render_questions(questions, run.adw_id, waiting.round,
                                            config.max_question_chars)))
        if not posted.ok:
            run.console.note(f"! the questions did NOT reach #{waiting.issue_number} "
                             f"({' · '.join(posted.notes)}) — this run is about to wait for "
                             f"an answer nobody was asked for. `asf show {run.adw_id}` "
                             f"prints them; `asf answer {run.adw_id} -m \"...\"` answers.")
            waiting.asked_at = waiting.asked_at or now_iso()
            return
        run.console.note(f"asked {len(questions)} question(s) on #{waiting.issue_number}, "
                         f"round {waiting.round}")
        try:
            heard = issues.comments(run.main_root, config, ref)
        except RuntimeError:
            heard = []

    # The forge's own stamp when it can be read back, this clock only as a
    # fallback — see the note above about which clock an answer is measured by.
    waiting.asked_at = issues.asked_at(heard, run.adw_id, waiting.round) or now_iso()


def _consume(run, phase: Phase, decision: Decision, kind: str = "gate") -> Decision:
    """Record that a decision was taken, in the trace and by clearing the wait."""
    if not decision.decided_at:
        decision.decided_at = now_iso()
    if not decision.consumed_at:
        decision.consumed_at = now_iso()
    record(run.session_dir, decision)
    _remember(run, phase, decision, kind)
    artifacts.clear_waiting(run.session_dir)
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="decision", name=decision.gate,
                                 payload=decision.model_dump()))
    run.console.decided(decision)
    return decision


def _remember(run, phase: Phase, decision: Decision, kind: str) -> None:
    """Keep the WORDS somewhere the whole rest of the run reads them.

    The counterpart to `record()`, and deliberately not the same file. That one
    keeps the verdict, keyed by gate and round, and a round reads it back to
    learn whether it is settled; this one keeps what the person typed, which
    outlives the round it was typed at — engine/journal.py has the argument.

    It goes on the run's timeline under the phase this gate IS, so a later
    agent reads it between the plan and the build rather than in a list with no
    when. Every path that takes a decision comes through `_consume`: the
    terminal, `asf approve -m`, a reply on the work item, and a resumed process
    replaying a round it already walked. That last one is why the journal is
    keyed rather than appended to.
    """
    text = decision.notes.strip()
    if not text:
        return
    journal.record_remark(run, phase, Remark(
        gate=decision.gate, round=decision.round, kind=kind, verdict=decision.verdict,
        text=text, channel=decision.channel), by=decision.by, at=decision.decided_at)


def _attended(run, waiting: WaitingFor) -> Optional[Decision]:
    """Ask at the terminal, up to `wait_seconds`, polling the record between keypresses.

    None means suspend — the human detached, or the clock ran out, which is
    the same thing with nobody at the keyboard.
    """
    deadline = time.monotonic() + max(0, run.cfg.hitl.wait_seconds)
    keys = ("[n] answer / [a]pprove all as recommended / [x] abort / [d]etach"
            if waiting.kind == "questions"
            else "[a]pprove / [r]eject / [x] abort / [d]etach")
    run.console.note(f"waiting for you — {keys}; or from another terminal: "
                     + how_to_answer(run, waiting.gate, waiting.kind))
    while True:
        recorded = read_decision(run.session_dir, waiting.gate, waiting.round)
        if recorded is not None and recorded.subject_digest == waiting.subject_digest:
            return recorded
        verdict, notes = run.hitl.ask(waiting)
        if verdict == "detach":
            return None
        if verdict in ("approve", "reject", "abort", "answer"):
            return Decision(gate=waiting.gate, round=waiting.round, verdict=verdict,
                            notes=notes, by=run.engineer, channel="terminal",
                            subject_digest=waiting.subject_digest)
        if time.monotonic() > deadline:
            run.console.note("no answer within hitl.wait_seconds — suspending")
            return None


def _notify(run, waiting: WaitingFor) -> None:
    """Run `notify_command` with the subject on stdin. Never raises."""
    argv = run.cfg.hitl.notify_command
    if not argv:
        return
    env = {**os.environ, "ASF_ADW_ID": run.adw_id, "ASF_GATE": waiting.gate,
           "ASF_ROUND": str(waiting.round)}
    try:
        subprocess.run(argv, input=waiting.model_dump_json(indent=2), text=True,
                       env=env, timeout=30, capture_output=True)
    except (OSError, subprocess.SubprocessError) as error:
        run.console.note(f"notify_command failed: {error}")


# ── answering from outside the run ───────────────────────────────────────────

def answer(session_dir: Path, reply: Reply) -> Decision:
    """A decision from OUTSIDE the run — the CLI. Takes the digest from the wait record.

    A blocked run (attended, still polling) has `waiting_for` set with
    `status == "running"`; a suspended one has it with `status == "waiting"`.
    Both are answered the same way, and the run — polling or resumed — picks
    the file up.
    """
    state = artifacts.read_run(session_dir)
    if state is None or state.waiting_for is None:
        raise RuntimeError(f"{Path(session_dir).name} is not waiting at a gate — "
                           f"`just pending` lists the sessions that are")
    verdict, notes = reply.verdict, reply.notes
    if verdict == "reject" and not notes.strip():
        raise RuntimeError("a reject needs notes (-m \"...\") — they are what the agent "
                           "revises from")
    waiting = state.waiting_for
    # The wrong verb typed at the right run is a typo, not a decision. Refusing
    # it HERE — before anything is recorded — costs the person a second command;
    # recording it would make the run act on a verdict its gate cannot read.
    if verdict == "answer" and waiting.kind != "questions":
        raise RuntimeError(f"{Path(session_dir).name} is waiting at the {waiting.gate} gate, "
                           f"which asked no questions — approve, reject or abort it")
    if verdict == "reject" and waiting.kind == "questions":
        raise RuntimeError(f"{Path(session_dir).name} is waiting on questions, and there is "
                           f"nothing to reject — `answer -m \"...\"` supplies what is "
                           f"missing, `approve` takes every recommendation as it stands")
    if verdict == "answer" and not notes.strip():
        raise RuntimeError("an answer needs words (-m \"...\") — an empty one says nothing "
                           "the agent did not already assume")
    decision = Decision(gate=waiting.gate, round=waiting.round, verdict=verdict,
                        notes=notes.strip(), by=reply.by, channel=reply.channel,
                        subject_digest=waiting.subject_digest, decided_at=now_iso())
    record(session_dir, decision)
    return decision


# ── the loop ─────────────────────────────────────────────────────────────────

REVISE_PROMPT = (
    "{prompt}\n\n"
    "The engineer reviewed what you produced and asked for changes — their notes are "
    "`notes_for_next_agent` in previous_envelope, a Decision with verdict \"reject\". "
    "Revise your existing work along those notes in this same session: update the "
    "artifacts you already wrote rather than starting over, keep the same paths, and "
    "report the same Report JSON shape as before."
)


class Aborted(SystemExit):
    """The human ended the run at a gate. Exit 1, with the reason as the message.

    Raised INSIDE the approve phase on purpose: `Run.phase` then closes that
    phase as `fail` with the reason, finalizes the session as `fail`, keeps the
    worktree and prints the banner — exactly what a `GateFailure` gets. Raised
    after the phase closed, the session would read `running` with no process
    behind it, which is the bug `_finalize_when_killed` exists to prevent.
    """


def gated(run, gate: Gate, envelope: EnvelopeBase) -> EnvelopeBase:
    """Stop at a gate, or pass it by policy; loop on reject; return what was approved.

    Phases: `approve_<gate>` (round 1), `approve_<gate>_<n>` (later rounds),
    `<gate>_revise_<n>` between them. Every one replays on `--resume` by its
    name, so a suspended run re-enters the exact round it left.
    """
    if run.hitl.mode(gate.name, run.trigger) == "auto":
        return _pass_by_policy(run, gate, envelope)
    if run.hitl.every and _already_approved(run, gate, envelope):
        # `--hitl every` put a checkpoint of the same name after the phase that
        # produced this envelope, and the human approved there. Asking again
        # would open a second `approve_<gate>` phase for the same subject.
        run.console.note(f"gate {gate.name}: approved at the checkpoint just before")
        return envelope

    round = 1
    while True:
        paths = gate.paths or envelope.artifacts
        name = f"approve_{gate.name}" if round == 1 else f"approve_{gate.name}_{round}"
        description = gate.description or (
            f"Hand the {gate.name} to the engineer and wait for a verdict")
        with run.phase(PhaseParams(name=name, kind="engineer", owner=run.engineer,
                                   description=description)) as ph:
            decision = ph.decide(Subject(gate=gate.name, round=round,
                                         summary=envelope.summary, paths=paths,
                                         notes=envelope.notes_for_next_agent))
            if decision.verdict == "abort":
                raise Aborted(f"aborted by {decision.by} at gate {gate.name}"
                              + (f": {decision.notes}" if decision.notes else ""))
            if decision.verdict == "answer":
                # `hitl.answer()` refuses this at the CLI, so reaching here means
                # a decision file written by hand or by something that did not
                # read the wait. Acting on it would mean guessing which of
                # approve or reject a person meant, at the one moment guessing
                # is least excusable.
                raise Aborted(f"gate {gate.name} takes approve, reject or abort — the "
                              f"recorded decision is an `answer`, which belongs to a "
                              f"question round, and this gate asked none")
            if decision.verdict == "reject" and gate.call is None:
                raise Aborted(f"gate {gate.name} is approve/abort only — nothing can "
                              f"revise it; rejected by {decision.by}: {decision.notes}")
            limit = run.cfg.hitl.max_rounds
            if decision.verdict == "reject" and limit and round >= limit:
                raise Aborted(f"gate {gate.name} rejected {round} time(s) — "
                              f"hitl.max_rounds reached")
        if decision.approved:
            if decision.notes:
                # The POINTED handoff, and not the only one: `_consume` already
                # filed the same words as a standing remark, which is what
                # carries them past the next agent (engine/journal.py). This
                # line stays because `notes_for_next_agent` travels further
                # than a prompt does — it is what the NEXT gate shows a person
                # as the producing agent's notes, and what an envelope carries
                # into a pull request body.
                envelope.notes_for_next_agent = (
                    f"{envelope.notes_for_next_agent}\n\n"
                    f"Engineer's remarks at the {gate.name} gate: {decision.notes}").strip()
            return envelope

        with run.phase(PhaseParams(name=f"{gate.name}_revise_{round}", kind="agent",
                                   owner=gate.owner, retries=gate.retries,
                                   description=f"Rework the {gate.name} along the "
                                               f"engineer's notes, in the same session")) as ph:
            envelope = ph.call(gate.call.model_copy(update={
                "previous": decision,
                "prompt": REVISE_PROMPT.format(prompt=gate.call.prompt)}))
        round += 1


def asked(run, subject: Subject) -> Decision:
    """Put ONE round of questions to a person and hand back what they said.

    THE LOOP IS THE CALLER'S, and that is the difference from `gated()`. A
    reject at a gate means "this same artifact, reworked", so the loop belongs
    with the gate and `gated()` owns it. What comes back from a question round
    is INPUT, not a verdict on a work product: whether another round is needed
    is the agent's answer to that input, and only the stage driving the agent
    knows. So this asks once, and the stage asks again if it must.

    Everything underneath is `decide()` unchanged — the digest, the record, the
    suspend at exit 75, the replay on `--resume`. The only thing a question
    round adds is that somebody is TOLD, which `publish()` does from inside
    `decide()`, once the round is known to be really waiting.

    A question round takes `answer`, `approve` (every recommendation as it
    stands) and `abort`. `reject` is refused at the CLI and again here.
    """
    name = (f"ask_{subject.gate}" if subject.round == 1
            else f"ask_{subject.gate}_{subject.round}")
    blocking = sum(1 for question in subject.questions if question.blocking)
    with run.phase(PhaseParams(
            name=name, kind="engineer", owner=run.engineer,
            description=f"Put {len(subject.questions)} open question(s) to a person and "
                        f"wait, rather than guess at {blocking} thing(s) the request does "
                        f"not say")) as ph:
        decision = ph.decide(subject.model_copy(update={"kind": "questions"}))
        if decision.verdict == "abort":
            raise Aborted(f"aborted by {decision.by} at the {subject.gate} questions"
                          + (f": {decision.notes}" if decision.notes else ""))
        if decision.verdict == "reject":
            raise Aborted(f"the {subject.gate} questions were rejected by {decision.by}, and "
                          f"there is nothing to reject — an agent asking what it cannot "
                          f"know has not claimed anything yet"
                          + (f": {decision.notes}" if decision.notes else ""))
    return decision


def _already_approved(run, gate: Gate, envelope: EnvelopeBase) -> bool:
    recorded = read_decision(run.session_dir, gate.name, 1)
    if recorded is None or not recorded.approved:
        return False
    return recorded.subject_digest == digest(resolve_paths(run, gate.paths or envelope.artifacts))


def _pass_by_policy(run, gate: Gate, envelope: EnvelopeBase) -> EnvelopeBase:
    """Trust, written down: the gate was passed, and the record says by whom."""
    paths = resolve_paths(run, gate.paths or envelope.artifacts)
    stamp = now_iso()
    decision = Decision(gate=gate.name, round=1, verdict="approve", by="policy",
                        channel="auto", subject_digest=digest(paths), decided_at=stamp,
                        consumed_at=stamp)
    record(run.session_dir, decision)
    run.tracer.event(EventRecord(adw_id=run.adw_id,
                                 phase_id=run.phases[-1].phase_id if run.phases else "",
                                 type="decision", name=gate.name,
                                 payload=decision.model_dump()))
    run.console.note(f"gate {gate.name}: passed by policy (hitl is off for it)")
    return envelope

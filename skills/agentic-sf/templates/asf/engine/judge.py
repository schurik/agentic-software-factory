"""A judge scorer's one agent call: the shipped `judge` reading a finished
chapter against a scorer's prose (ADR 0006).

    asf/agents/judge/agent.md     who the judge is — one agent for every judge scorer
    asf/engine/judge.md           its task: the chapter, the criteria, the classes, the Report

The scorer file holds only the criteria and the classes; the judge is a roster
agent like any other, and its call is `agents.execute` like any other: typed
envelope, gates, corrections in the same agent session, permissions after.

It runs on a Run of its own whose record lies INSIDE the session it judges,
under `judges/`: its phase, its corrections, its prompts, its spend and its
reasoning sit beside the chapter they are about, and none of them is an event
of that session. The session gets one event, the `chapter_scored` its envelope
becomes — what judging cost is that score's `usage`, measurement and never the
work's, so judging a session never makes its pull request look dearer.

It runs under the factory's permissions with `writes: []`, whatever the
roster's judge says: a judge measures and changes nothing. Its tree is a
checkout of its own — a detached worktree at the chapter's last commit, outside
the repository, removed when it answers — and never the station's main
checkout: `permissions.enforce` diffs the tree an agent ran in and rolls back
what changed, and in the main checkout what changed during a judge's minute
could be the operator's own work. Every session's commits can be read from it
with `git show`, as from any worktree of the repository.

It is not a workflow's run, and ends without `run.finish`: that releases a
session's worktree, withdraws its published branch and prints the session's
banner, none of which a judge has. Its record is opened and closed with
`artifacts.start_run` and `finish_run` instead, the two halves `finish` itself
writes through.

Its gates check what can be checked (invariant 4): the class is one the scorer
declares, and every seq it cites is an event of the judged session, in the
judged chapter. A failed gate sends it back to the same agent session; a judge
that never satisfies them gives no score, and its scorer says so.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from . import agents, artifacts, events, git_helper, tasks
from .data_types import (AgentCall, ChapterScored, EnvelopeAccepted, EnvelopeBase,
                         FactoryConfig, GateReport, JudgeOutput, Phase, PhaseEnded,
                         PhaseParams, RunSpec, SessionStarted, UsageBreakdown, UsageRecorded,
                         Workspace)
from .runner import Run
from .tracer import Tracer
from .utils import now_iso

if TYPE_CHECKING:
    from .scorers import ChapterRecord, Scorer

AGENT = "judge"
TASK = Path(__file__).with_name("judge.md")
JUDGES_DIR = "judges"           # inside the judged session's directory
RETRIES = 2                     # gate corrections, after the first answer


@dataclass
class Chapter:
    """The chapter a judge is asked about: the directory of the session it
    belongs to, its events, and the seq of the event that ended it."""

    session_dir: Path
    record: "ChapterRecord"
    ended: int


def refused(factory_root: Path) -> list[str]:
    """Why no judge scorer can run in this factory, or []: the roster has no
    judge, or its task's `## Report` no longer matches `JudgeOutput` — the
    triad's third side is `output_type=` below. `asf check` says it of every
    judge scorer, before one costs anything."""
    problems = []
    agent = Path(factory_root) / "agents" / AGENT / "agent.md"
    if not agent.is_file():
        problems.append(f"there is no {AGENT} agent at {agent} — it runs every judge scorer, "
                        f"and `install.py` stamps it")
    return problems + tasks.check(TASK, JudgeOutput)


def judge(cfg: FactoryConfig, main_root: Path, chapter: Chapter, scorer: "Scorer") -> ChapterScored:
    """`scorer`'s score of `chapter`, from the judge. Raises RuntimeError when
    the judge could not score it — a model that does not resolve, an answer the
    gates never accepted — and the caller says so; a measurement that could not
    be taken is not the chapter's failure."""
    bound = _bound(cfg, scorer)
    try:
        agents.validate(bound, [AGENT])
    except SystemExit as error:
        raise RuntimeError(str(error)) from None
    with _checkout(main_root, _last_commit(chapter.record)) as tree:
        return _judged(bound, Workspace(main_root=main_root, repo_root=tree), chapter, scorer)


def _judged(cfg: FactoryConfig, workspace: Workspace, chapter: Chapter,
            scorer: "Scorer") -> ChapterScored:
    """The judge's one phase, on a run whose record is inside the session."""
    record_dir = _record_dir(chapter, scorer)
    adw_id = chapter.session_dir.name
    run = Run(RunSpec(cfg=cfg, adw_id=adw_id, engineer=AGENT, hitl="none",
                      workspace=workspace, record_dir=record_dir), Tracer(record_dir))
    # A record of its own, opened and closed like a session's, so its spend is
    # kept (`artifacts.record_usage`) and it says when it ran and how it ended.
    artifacts.start_run(record_dir, SessionStarted(
        adw_id=adw_id, workflow=f"{AGENT}:{scorer.name}", pid=os.getpid(), engineer=AGENT,
        started_at=now_iso(), repo_root=str(workspace.repo_root),
        command=[os.path.basename(sys.argv[0]), *sys.argv[1:]]))
    number = chapter.record.number
    phase = Phase(phase_id=f"{adw_id}_judge_{scorer.name}", adw_id=adw_id, seq=1,
                  status="running", started_at=now_iso(),
                  params=PhaseParams(name="judge", kind="agent", owner=AGENT, retries=RETRIES,
                                     description=f"Read chapter {number} against "
                                                 f"{scorer.name}'s criteria and give it one "
                                                 f"of its classes, citing its events"))
    run.console.phase_started(phase)
    clock = time.monotonic()
    try:
        envelope = agents.execute(run, phase, AgentCall(
            output_type=JudgeOutput, prompt=scorer.criteria.strip(), task=str(TASK),
            gates=_gates(chapter, scorer), variables=_variables(chapter, scorer)))
    except (Exception, SystemExit) as error:
        _ended(run, phase, clock, str(error)[:1000])
        artifacts.finish_run(record_dir, "fail", reason=str(error)[:1000])
        raise RuntimeError(f"the judge gave no score: {error}") from None
    _ended(run, phase, clock)
    artifacts.finish_run(record_dir, "success")
    assert isinstance(envelope, JudgeOutput)
    failing = next(each.fail for each in scorer.classes if each.name == envelope.class_)
    return ChapterScored(chapter=number, scorer=scorer.name, kind="judge",
                         class_=envelope.class_, failing=failing,
                         evidence=sorted(set(envelope.evidence)),
                         reasoning=envelope.reasoning if cfg.cockpit.transcripts else None,
                         usage=_spent(record_dir))


@contextmanager
def _checkout(main_root: Path, ref: str) -> Iterator[Path]:
    """A detached worktree at `ref`, outside the repository, for one
    judgement — removed however it ends, with whatever the judge left in it,
    because nothing in it is anybody's work."""
    place = Path(tempfile.mkdtemp(prefix="asf-judge-"))
    tree = place / "tree"
    try:
        git_helper.worktree_add_detached(main_root, tree, ref)
    except RuntimeError as error:
        shutil.rmtree(place, ignore_errors=True)
        raise RuntimeError(f"no tree to judge in: {error}") from None
    try:
        yield tree
    finally:
        try:
            git_helper.worktree_remove(main_root, tree, force=True)
        except RuntimeError:
            shutil.rmtree(place, ignore_errors=True)
            git_helper.worktree_prune(main_root)
        shutil.rmtree(place, ignore_errors=True)


def _last_commit(record: "ChapterRecord") -> str:
    """The chapter's last commit, the tree it left; HEAD when it made none."""
    shas = [str(line.payload.get("sha") or "") for line in record.lines
            if line.kind == "committed"]
    return next((sha for sha in reversed(shas) if sha), "HEAD")


def _bound(cfg: FactoryConfig, scorer: "Scorer") -> FactoryConfig:
    """The factory's config with its judge read-only, on the scorer's model
    when it names one."""
    roster = {agent.name: agent for agent in cfg.agents}
    if AGENT not in roster:
        raise RuntimeError(f"the roster has no {AGENT} agent — it runs every judge scorer")
    update: dict = {"writes": []}
    if scorer.spec.model:
        update["model"] = scorer.spec.model
    roster[AGENT] = roster[AGENT].model_copy(update=update)
    return cfg.model_copy(update={"agents": list(roster.values())})


def _record_dir(chapter: Chapter, scorer: "Scorer") -> Path:
    """A fresh directory for this judgement: one per chapter, scorer and end,
    and another beside it when that one was already tried — a judge asked
    again starts a new agent session, never one a failed attempt left."""
    name = f"c{chapter.record.number}-{scorer.name}-at-{chapter.ended}"
    base = chapter.session_dir / JUDGES_DIR / name
    place, attempt = base, 1
    while place.exists():
        attempt += 1
        place = base.with_name(f"{base.name}-{attempt}")
    return place


def _ended(run: Run, phase: Phase, clock: float, error: str = "") -> None:
    """Close the judge's phase on its own record, and on the console: failed
    when it says why."""
    phase.status, phase.ended_at = ("fail" if error else "success"), now_iso()
    phase.error = error or None
    run.tracer.event(PhaseEnded(phase_id=phase.phase_id, name=phase.params.name,
                                status=phase.status, attempt=phase.attempt, error=error))
    run.console.phase_ended(phase, time.monotonic() - clock)


def _spent(record_dir: Path) -> UsageBreakdown:
    """What every send of the judge cost, from its own record."""
    spent = UsageBreakdown()
    for line in events.read(record_dir):
        if line.kind == UsageRecorded.KIND:
            spent.merge(UsageBreakdown.model_validate(line.payload.get("usage") or {}))
    return spent


# ── what the judge is told ───────────────────────────────────────────────────

def _variables(chapter: Chapter, scorer: "Scorer") -> dict[str, str]:
    record = chapter.record
    return {
        "scorer": scorer.name,
        "workflow": scorer.spec.workflow,
        "focus": (f"the agent `{scorer.spec.focus}` within it" if scorer.spec.focus
                  else "the whole chapter"),
        "chapter": str(record.number),
        "session": chapter.session_dir.name,
        "session_dir": str(chapter.session_dir.resolve()),
        "classes": "\n".join(f"- `{each.name}` — {'failing' if each.fail else 'passing'}"
                             for each in scorer.classes),
        "events": "\n".join(_listed(record, line) for line in record.lines),
        "commits": "\n".join(f"- `{line.payload.get('sha', '')}` {line.payload.get('message', '')}"
                             for line in record.lines if line.kind == "committed") or "(none)",
        "previous_envelope": _last_envelope(record),
    }


def _listed(record: "ChapterRecord", line) -> str:
    """One line of the chapter's event listing: its seq, its kind, and whose."""
    payload = line.payload
    said = [str(part) for part in (record.agent_of(line), payload.get("name")
                                   or payload.get("phase") or payload.get("gate")) if part]
    return f"- {line.seq} `{line.kind}`" + (f" · {' · '.join(said)}" if said else "")


def _last_envelope(record: "ChapterRecord") -> str:
    accepted = [line for line in record.lines if line.kind == EnvelopeAccepted.KIND]
    if not accepted:
        return "(none)"
    return json.dumps(accepted[-1].payload.get("envelope") or {}, indent=2)


# ── its gates ────────────────────────────────────────────────────────────────

def _gates(chapter: Chapter, scorer: "Scorer") -> list:
    """The claims a judge's envelope makes that code can check: a class its
    scorer declares, and evidence — at least one seq, each an event of this
    session and of this chapter."""
    declared = [each.name for each in scorer.classes]
    in_session = {line.seq for line in chapter.record.session}
    in_chapter = {line.seq for line in chapter.record.lines}
    number = chapter.record.number

    def class_declared(envelope: EnvelopeBase, run) -> GateReport:
        given = getattr(envelope, "class_", "")
        ok = given in declared
        return GateReport().check(
            f"class {given}", ok, f"one of {scorer.name}'s classes" if ok else
            f"{given!r} is not one of {scorer.name}'s classes: {', '.join(declared)}")

    def evidence_exists(envelope: EnvelopeBase, run) -> GateReport:
        report = GateReport()
        cited = getattr(envelope, "evidence", [])
        if not cited:
            report.check("evidence", False, "cites nothing — a score rests on the chapter's "
                                            "events: cite the seqs of the ones it rests on")
        for seq in cited:
            ok = seq in in_session
            report.check(f"seq {seq}", ok, "an event of this session" if ok else
                         f"seq {seq} is no event of this session — cite only seqs from the "
                         f"chapter's event listing")
        return report

    def evidence_in_chapter(envelope: EnvelopeBase, run) -> GateReport:
        report = GateReport()
        for seq in getattr(envelope, "evidence", []):
            if seq not in in_session:
                continue                    # that one is evidence_exists's to refuse
            ok = seq in in_chapter
            report.check(f"seq {seq}", ok, f"in chapter {number}" if ok else
                         f"seq {seq} is not in chapter {number} — it is another chapter's, "
                         f"or no chapter's")
        return report

    return [class_declared, evidence_exists, evidence_in_chapter]

"""The diagnosis: before a self-improvement issue is filed, one bounded agent
phase says what to change (`CONTEXT.md`, Self-improvement; ADR 0006).

    asf/agents/diagnostician/agent.md   who diagnoses — one agent for every scorer
    asf/engine/diagnose.md              its task: the scorer, the failing sessions, the Report

It runs once per issue, when a scorer's failures have become a pattern and no
issue is open for it (`engine/improve.py`); new evidence for an open issue is
a comment, and is not diagnosed again. The diagnostician reads the failing
sessions' directories and the factory's files, and answers a `DiagnosisOutput`:
the cause, the surface — the factory or the application — the files, and the
proposed change. It changes nothing: `writes: []` whatever the roster says, in
a detached checkout of the station's HEAD of its own (`judge.checkout`), which
`permissions.enforce` diffs after every send and which is removed once it
answers. The sessions' records lie outside that tree, and it is told to read
them and nothing more.

Its gates check what can be checked (invariant 4): every file it names is one
the repository has at HEAD, and the surface it claims is where those files
are. A diagnosis naming a file that does not exist is sent back to the same
agent session.

Then CODE rules on what it may propose — never the model:

  * FACTORY CODE — any `.py` under `asf/` — is where every gate is, and what
    decides whether work is accepted (invariant 1). It is REPORTED in the
    issue, never proposed as a change: a change to what blocks work is a
    person's deliberate change, in code.
  * A SKILL-OWNED TASK FILE — a stage's own task, which `install.py --force`
    would overwrite — is REDIRECTED to the workflow's task override,
    `asf/workflows/<workflow>/tasks/<key>.md` (`engine/tasks.py`), so the fix
    survives the next re-stamp.
  * Any skill-owned file makes the diagnosis UPSTREAMABLE: a note for a person
    to carry the change to the skill. Nothing here files anything upstream.

What is skill-owned is what `install.py` records it stamped, in
`asf/.skill-files`; a factory stamped before that record holds everything
under `asf/` but its config and its scorers to be.

Like a judge, it runs on a Run of its own and ends without `run.finish`. Its
record is a directory of its own under the data dir's `diagnoses/`, in no
session — it is about a scorer, across sessions — and what it spent is paid
from the measurement budget (`engine/measurement.py`), never a session's.
What it says goes on a tracker, which may be public: its task tells it to
cite events by seq and never to quote a transcript.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Callable, Literal

from . import agents, artifacts, factory, judge, tasks
from .data_types import (AgentCall, DiagnosisOutput, EnvelopeBase, FactoryConfig, GateReport,
                         Phase, PhaseParams, RunSpec, SessionStarted, Workspace)
from .runner import Run
from .tracer import Tracer
from .utils import now_iso

if TYPE_CHECKING:
    from .improve import Failing, Window
    from .scorers import Scorer

AGENT = "diagnostician"
TASK = Path(__file__).with_name("diagnose.md")
RETRIES = 2                     # gate corrections, after the first answer
FACTORY_DIR = PurePosixPath(factory.DEFAULT_CONFIG).parent.as_posix()      # "asf"
# What install.py records it stamped under `asf/`: what `--force` overwrites.
SKILL_FILES = ".skill-files"
# What stays the operator's under `asf/` in a stamp that records nothing.
OPERATORS = (f"{FACTORY_DIR}/factory.yaml", f"{FACTORY_DIR}/scorers/")

Ruling = Literal["proposed", "redirected", "reported"]


@dataclass
class Named:
    """One file of a diagnosis, as code ruled on it: where the change goes,
    the file the diagnostician named, and whether the skill owns that one."""

    path: str
    named: str
    ruling: Ruling
    skill_owned: bool


@dataclass
class Diagnosis:
    """A diagnosis as the issue carries it: the diagnostician's envelope with
    code's rulings applied, and what it cost the measurement budget."""

    cause: str
    surface: str
    proposed_change: str
    files: list[Named] = field(default_factory=list)
    upstreamable: bool = False
    cost: float = 0.0

    @property
    def proposes(self) -> bool:
        """Whether anything is proposed at all, or every file is reported."""
        return any(each.ruling != "reported" for each in self.files)


def refused(factory_root: Path) -> list[str]:
    """Why no diagnosis can be made in this factory, or []: the roster has no
    diagnostician, or its task's `## Report` no longer matches
    `DiagnosisOutput` — the triad's third side is `output_type=` below."""
    problems = []
    agent = Path(factory_root) / "agents" / AGENT / "agent.md"
    if not agent.is_file():
        problems.append(f"there is no {AGENT} agent at {agent} — it diagnoses every "
                        f"self-improvement issue, and `install.py` stamps it")
    return problems + tasks.check(TASK, DiagnosisOutput)


def diagnose(cfg: FactoryConfig, main_root: Path, scorer: "Scorer",
             counted: "Window") -> Diagnosis:
    """`scorer`'s failing sessions in `counted`, diagnosed and ruled on.
    Raises RuntimeError when no diagnosis could be made — a roster without
    the agent, an answer the gates never accepted — and the caller files the
    issue without one, saying why."""
    main_root = Path(main_root)
    problems = refused(main_root / FACTORY_DIR)
    if problems:                            # nothing is spent on one that cannot answer
        raise RuntimeError("; ".join(problems))
    bound = _bound(cfg)
    try:
        agents.validate(bound, [AGENT])
    except SystemExit as error:
        raise RuntimeError(str(error)) from None
    with judge.checkout(main_root, "HEAD", AGENT) as tree:
        envelope, cost = _diagnosed(bound, Workspace(main_root=main_root, repo_root=tree),
                                    scorer, counted)
    return ruled(envelope, owned_by_the_skill(main_root),
                 overrides(main_root, scorer.spec.workflow), cost)


# ── code's rulings ───────────────────────────────────────────────────────────

def ruled(envelope: DiagnosisOutput, skill_owned: Callable[[str], bool],
          redirect: dict[str, str], cost: float = 0.0) -> Diagnosis:
    """The diagnosis the issue carries: factory code reported, a skill-owned
    task file of the scorer's workflow redirected to its override (in the
    proposed change's words too), and upstreamable when the skill owns any
    file it names — or the diagnostician says so of a change to the factory."""
    change, files = envelope.proposed_change, []
    for named in dict.fromkeys(_normal(path) for path in envelope.files):
        owned = skill_owned(named)
        if _is_factory(named) and named.endswith(".py"):
            files.append(Named(named, named, "reported", owned))
        elif owned and named in redirect:
            files.append(Named(redirect[named], named, "redirected", owned))
            change = change.replace(named, redirect[named])
        else:
            files.append(Named(named, named, "proposed", owned))
    upstreamable = (any(each.skill_owned for each in files)
                    or (envelope.upstreamable and envelope.surface == "factory"))
    return Diagnosis(cause=envelope.cause, surface=envelope.surface, proposed_change=change,
                     files=files, upstreamable=upstreamable, cost=cost)


def owned_by_the_skill(main_root: Path) -> Callable[[str], bool]:
    """Whether the skill owns a repo-relative path: one `install.py` recorded
    it stamped, which `--force` would overwrite."""
    record = Path(main_root) / FACTORY_DIR / SKILL_FILES
    if record.is_file():
        stamped = {line.strip() for line in record.read_text().splitlines()
                   if line.strip() and not line.startswith("#")}
        return lambda path: path in stamped
    return lambda path: _is_factory(path) and not any(
        path == mine or path.startswith(mine) for mine in OPERATORS)


def overrides(main_root: Path, workflow_name: str) -> dict[str, str]:
    """{a stage's own task file: the override `workflow_name` would read
    instead}, repo-relative, for every task of every stage it uses. {} when
    the workflow does not load — nothing is redirected then."""
    from . import workflow                  # workflow -> scorers -> improve -> here
    main_root = Path(main_root)
    try:
        loaded = workflow.load(workflow_name, main_root / factory.DEFAULT_CONFIG)
    except SystemExit:
        return {}
    redirect = {}
    for step in loaded.steps:
        for key, (filename, _) in step.stage.tasks.items():
            default = _relative(main_root, step.stage.directory / filename)
            redirect[default] = _relative(main_root, loaded.directory / "tasks" / f"{key}.md")
    return redirect


def _relative(main_root: Path, path: Path) -> str:
    return Path(path).resolve().relative_to(main_root.resolve()).as_posix()


def _normal(path: str) -> str:
    return PurePosixPath(path.strip().removeprefix("./")).as_posix()


def _is_factory(path: str) -> bool:
    return path.startswith(f"{FACTORY_DIR}/")


# ── the diagnostician's one phase ────────────────────────────────────────────

def _bound(cfg: FactoryConfig) -> FactoryConfig:
    """The factory's config with its diagnostician read-only."""
    roster = {agent.name: agent for agent in cfg.agents}
    if AGENT not in roster:
        raise RuntimeError(f"the roster has no {AGENT} agent — it diagnoses every "
                           f"self-improvement issue")
    roster[AGENT] = roster[AGENT].model_copy(update={"writes": []})
    return cfg.model_copy(update={"agents": list(roster.values())})


def _diagnosed(cfg: FactoryConfig, workspace: Workspace, scorer: "Scorer",
               counted: "Window") -> tuple[DiagnosisOutput, float]:
    """The diagnostician's envelope and what every send of it cost, on a run
    whose record is a directory of its own."""
    record_dir = _record_dir(workspace.main_root, cfg.data_dir, scorer)
    adw_id = record_dir.name
    run = Run(RunSpec(cfg=cfg, adw_id=adw_id, engineer=AGENT, hitl="none",
                      workspace=workspace, record_dir=record_dir), Tracer(record_dir))
    artifacts.start_run(record_dir, SessionStarted(
        adw_id=adw_id, workflow=f"{AGENT}:{scorer.name}", pid=os.getpid(), engineer=AGENT,
        started_at=now_iso(), repo_root=str(workspace.repo_root),
        command=[os.path.basename(sys.argv[0]), *sys.argv[1:]]))
    phase = Phase(phase_id=f"{adw_id}_diagnose", adw_id=adw_id, seq=1, status="running",
                  started_at=now_iso(),
                  params=PhaseParams(name="diagnose", kind="agent", owner=AGENT, retries=RETRIES,
                                     description=f"Read the sessions {scorer.name} failed and "
                                                 f"say what to change, in the factory or the "
                                                 f"application, and in which files"))
    run.console.phase_started(phase)
    clock = time.monotonic()
    try:
        envelope = agents.execute(run, phase, AgentCall(
            output_type=DiagnosisOutput, prompt=scorer.criteria.strip(), task=str(TASK),
            gates=_gates(workspace.repo_root),
            variables=_variables(artifacts.sessions_root(workspace.main_root, cfg.data_dir),
                                 scorer, counted)))
    except (Exception, SystemExit) as error:
        judge.phase_ended(run, phase, clock, str(error)[:1000])
        artifacts.finish_run(record_dir, "fail", reason=str(error)[:1000])
        raise RuntimeError(f"the {AGENT} gave no diagnosis: {error}") from None
    judge.phase_ended(run, phase, clock)
    artifacts.finish_run(record_dir, "success")
    assert isinstance(envelope, DiagnosisOutput)
    return envelope, judge.spent(record_dir).total_cost


def _record_dir(main_root: Path, data_dir: str, scorer: "Scorer") -> Path:
    """A fresh directory for this diagnosis, named by the scorer and when."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = artifacts.diagnoses_root(main_root, data_dir) / f"{scorer.name}-{stamp}"
    place, attempt = base, 1
    while place.exists():
        attempt += 1
        place = base.with_name(f"{base.name}-{attempt}")
    return place


# ── what the diagnostician is told ───────────────────────────────────────────

def _variables(sessions_dir: Path, scorer: "Scorer", counted: "Window") -> dict[str, str]:
    return {
        "scorer": scorer.name,
        "workflow": scorer.spec.workflow,
        "focus": (f"its agent `{scorer.spec.focus}`" if scorer.spec.focus
                  else "the whole chapter"),
        "failed_on": counted.failed_on(),
        "classes": "\n".join(f"- `{each.name}` — {'failing' if each.fail else 'passing'}"
                             for each in scorer.classes),
        "factory_dir": FACTORY_DIR,
        "sessions": "\n".join(_session(sessions_dir, each) for each in counted.failing),
    }


def _session(sessions_dir: Path, failing: "Failing") -> str:
    """One failing session: where its record is, and each failing score."""
    lines = [f"- `{failing.adw_id}`, its record at `{(sessions_dir / failing.adw_id).resolve()}`"]
    for score in failing.scores:
        cited = ", ".join(str(seq) for seq in score.payload.get("evidence") or []) or "none"
        lines.append(f"  - chapter {score.payload.get('chapter')}: "
                     f"`{score.payload.get('class')}`, citing seqs {cited}")
    return "\n".join(lines)


# ── its gates ────────────────────────────────────────────────────────────────

def _gates(tree: Path) -> list:
    """The claims a diagnosis makes that code can check: the files it names
    are the repository's, at the HEAD it read, and its surface is where they
    are."""
    root = Path(tree).resolve()

    def files_exist(envelope: EnvelopeBase, run) -> GateReport:
        report = GateReport()
        named = getattr(envelope, "files", [])
        if not named:
            report.check("files", False, "names no file — a diagnosis says where the change "
                                         "goes: name the files whose text causes the failures")
        for path in named:
            place = (root / _normal(path)).resolve()
            ok = place.is_relative_to(root) and place.is_file()
            report.check(f"file {path}", ok, "a file of the repository" if ok else
                         f"{path} is no file of the repository at HEAD — name files as the "
                         f"repository has them, relative to its root; a file that does not "
                         f"exist yet is named by the one whose behaviour it would change")
        return report

    def surface_agrees(envelope: EnvelopeBase, run) -> GateReport:
        surface = getattr(envelope, "surface", "")
        named = [_normal(path) for path in getattr(envelope, "files", [])]
        astray = [path for path in named if _is_factory(path) != (surface == "factory")]
        where = f"under `{FACTORY_DIR}/`" if surface == "factory" else \
            f"outside `{FACTORY_DIR}/`"
        return GateReport().check(
            f"surface {surface}", not astray,
            f"every file is {where}" if not astray else
            f"surface {surface} is a change {where}, and {', '.join(astray)} is not — one "
            f"diagnosis has one surface: the factory's files are under `{FACTORY_DIR}/`, "
            f"the application's are everywhere else")

    return [files_exist, surface_agrees]

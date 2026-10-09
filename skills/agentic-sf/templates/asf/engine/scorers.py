"""Scorers: a team's judgement of a finished chapter, made on the station.

    asf/scorers/<name>/scorer.md     frontmatter for the engine, prose for the criteria

A scorer is bound to one workflow (and may focus on one of its agents), and
once a chapter of that workflow has ended it records a SCORE — one of its
classes, failing or not, with the seqs of the events it rests on — as a
`chapter_scored` on the judged session's own record (ADR 0006). A scorer
measures and a gate decides: nothing here can change how the chapter ended,
and a scorer that cannot run is said on the console and skipped, never raised.
A criterion that must block work is a gate, in Python.

Two kinds. A CODE scorer names one predicate from the closed set below, a pure
function over the chapter's domain events with fixed classes; it costs nothing.
A JUDGE is a model reading the chapter against the prose, with the classes its
frontmatter declares — checked here, not yet run: a chapter no scorer judged
simply has no score, which is how a reader tells "not judged".

`load` is what `asf check` refuses a scorer with and what a run reads its
scorers through, so a scorer `check` accepts is one a run will score with. A
scorer is the operator's file, like factory.yaml: `install.py --force` never
rewrites one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Mapping, Sequence

from pydantic import ValidationError

from . import artifacts, events, frontmatter
from .data_types import ChapterScored, EventLine, ScorerClass, ScorerSpec

if TYPE_CHECKING:
    from .runner import Run
    from .workflow import Workflow

SCORERS_DIR = "scorers"
SCORER_FILE = "scorer.md"


# ── a chapter, as its events tell it ─────────────────────────────────────────

@dataclass
class ChapterRecord:
    """The events of one chapter of one session, in order, and who owned each
    phase in it — what a predicate reads, and the only seqs it may cite."""

    number: int
    lines: list[EventLine] = field(default_factory=list)
    owners: dict[str, str] = field(default_factory=dict)      # phase_id -> agent

    def agent_of(self, line: EventLine) -> str:
        return str(line.payload.get("agent") or self.owners.get(line.payload.get("phase_id"), ""))


def chapter_record(lines: Sequence[EventLine], number: int) -> ChapterRecord:
    """The lines of chapter `number`: from its `workflow_started`, or a
    `session_resumed` that took it up again, to its `workflow_finished`.

    A resumed chapter is several stretches of the log, and another chapter may
    lie between them; a new process's `session_started` belongs to none until
    it says which chapter it took.
    """
    record = ChapterRecord(number=number)
    current = 0
    for line in lines:
        if line.kind in ("workflow_started", "session_resumed"):
            current = int(line.payload.get("chapter") or 0)
        elif line.kind == "session_started":
            current = 0
        if current == number:
            record.lines.append(line)
            if line.kind == "phase_started":
                record.owners[str(line.payload.get("phase_id"))] = str(line.payload.get("owner"))
        if line.kind == "workflow_finished":
            current = 0
    return record


# ── the closed set of code predicates ────────────────────────────────────────

@dataclass(frozen=True)
class Classed:
    """A predicate's answer: the class it gives, and the seqs it rests on."""

    name: str
    evidence: list[int]


@dataclass(frozen=True)
class Predicate:
    name: str
    takes: str                      # what goes in the parentheses, as `check` says it
    classes: tuple[ScorerClass, ...]
    classify: Callable[[ChapterRecord, str, int], Classed]     # (record, focus, argument)


def _corrections_above(record: ChapterRecord, focus: str, limit: int) -> Classed:
    """A correction is an agent's answer refused and sent back to the same
    session: an envelope that did not parse (`envelope_rejected`), or a round
    of its gates that failed (`gate_result`, one per gate, so a round is its
    phase and attempt). The evidence is every one of those events."""
    evidence, rejected, failed_rounds = [], 0, set()
    for line in record.lines:
        if focus and record.agent_of(line) != focus:
            continue
        if line.kind == "envelope_rejected":
            rejected += 1
            evidence.append(line.seq)
        elif line.kind == "gate_result" and not line.payload.get("passed", True):
            failed_rounds.add((line.payload.get("phase_id"), line.payload.get("attempt")))
            evidence.append(line.seq)
    corrections = rejected + len(failed_rounds)
    return Classed("above" if corrections > limit else "within", evidence)


PREDICATES: dict[str, Predicate] = {predicate.name: predicate for predicate in (
    Predicate("corrections_above", "n, the most corrections a chapter may take and pass",
              (ScorerClass(name="above", fail=True), ScorerClass(name="within", fail=False)),
              _corrections_above),
)}

_CALL = re.compile(r"\s*([a-z_]+)\s*(?:\(\s*([^)]*?)\s*\))?\s*")


def parse_predicate(text: str) -> tuple[Predicate, int]:
    """`corrections_above(2)` → (its predicate, 2). Raises ValueError saying why not."""
    match = _CALL.fullmatch(text or "")
    known = ", ".join(f"{name}({p.takes.split(',')[0]})" for name, p in PREDICATES.items())
    if not match or match[1] not in PREDICATES:
        raise ValueError(f"predicate {text!r} is not one of the closed set: {known}")
    predicate = PREDICATES[match[1]]
    argument = match[2]
    if argument is None or not argument.isdigit():
        raise ValueError(f"predicate {text!r} takes a whole number: {predicate.name}"
                         f"({predicate.takes})")
    return predicate, int(argument)


# ── scorers, loaded and checked ──────────────────────────────────────────────

@dataclass
class Scorer:
    name: str
    path: Path
    spec: ScorerSpec
    criteria: str                   # the prose below the frontmatter

    @property
    def classes(self) -> list[ScorerClass]:
        """Its classes: a judge's as declared, a code predicate's as fixed."""
        if self.spec.kind == "code":
            return list(parse_predicate(self.spec.predicate)[0].classes)
        return list(self.spec.classes)

    def score(self, record: ChapterRecord) -> ChapterScored:
        """A code scorer's score of `record`. A judge is not scored here."""
        predicate, argument = parse_predicate(self.spec.predicate)
        classed = predicate.classify(record, self.spec.focus, argument)
        failing = next(each.fail for each in predicate.classes if each.name == classed.name)
        return ChapterScored(chapter=record.number, scorer=self.name, kind="code",
                             class_=classed.name, failing=failing, evidence=classed.evidence)


def said(scorer: Scorer) -> str:
    """One line of what a scorer judges: `issue · builder · corrections_above(2)`."""
    how = scorer.spec.predicate if scorer.spec.kind == "code" else "judge"
    return " · ".join(part for part in (scorer.spec.workflow, scorer.spec.focus, how) if part)


@dataclass
class Refused:
    """A scorer `check` refused, and every reason it gave."""

    name: str
    path: Path
    error: str


def directory(factory_root: Path) -> Path:
    return Path(factory_root) / SCORERS_DIR


def load(factory_root: Path, workflows: Mapping[str, Sequence[str]],
         only: str = "") -> tuple[list[Scorer], list[Refused]]:
    """Every scorer under `asf/scorers/`, checked against `workflows` (each
    workflow's name and the agents it binds): the ones that hold, and the ones
    refused with why. `only` reads just the scorers bound to that workflow —
    a run has no business refusing a scorer of a workflow it did not load."""
    home = directory(factory_root)
    if not home.is_dir():
        return [], []
    found, refused = [], []
    for place in sorted(p for p in home.iterdir() if p.is_dir()):
        path = place / SCORER_FILE
        try:
            meta, criteria = _read(path)
        except ValueError as error:
            refused.append(Refused(place.name, path, str(error)))
            continue
        if only and meta.get("workflow") != only:
            continue
        try:
            spec = ScorerSpec.model_validate(meta)
        except ValidationError as error:
            refused.append(Refused(place.name, path, _flat(error)))
            continue
        problems = _problems(spec, criteria, workflows)
        if problems:
            refused.append(Refused(place.name, path, "; ".join(problems)))
        else:
            found.append(Scorer(place.name, path, spec, criteria))
    return found, refused


def _read(path: Path) -> tuple[dict, str]:
    if not path.is_file():
        raise ValueError(f"{path} is missing — a scorer is a directory with a {SCORER_FILE} in it")
    try:
        meta, criteria = frontmatter.split(path.read_text(), str(path))
    except SystemExit as error:
        raise ValueError(str(error)) from None
    if not meta:
        raise ValueError(f"{path} has no frontmatter — it opens with a `---` block naming its "
                         f"workflow and kind")
    return meta, criteria


def _problems(spec: ScorerSpec, criteria: str,
              workflows: Mapping[str, Sequence[str]]) -> list[str]:
    problems = []
    if spec.workflow not in workflows:
        problems.append(f"workflow {spec.workflow!r} is not one this factory loads "
                        f"(it has: {', '.join(sorted(workflows)) or 'none'})")
    elif spec.focus and spec.focus not in workflows[spec.workflow]:
        problems.append(f"focus {spec.focus!r} is not one of {spec.workflow}'s agents "
                        f"({', '.join(workflows[spec.workflow]) or 'it binds none'})")
    if spec.kind == "code":
        try:
            parse_predicate(spec.predicate)
        except ValueError as error:
            problems.append(str(error) if spec.predicate else
                            "a code scorer names its predicate: `predicate: corrections_above(2)`")
        judges = [key for key in ("classes", "sample_rate", "model")
                  if key in spec.model_fields_set]
        if judges:
            problems.append(f"{', '.join(judges)} {'is' if len(judges) == 1 else 'are'} a "
                            f"judge's — a code predicate's classes are fixed, and it runs "
                            f"on every chapter for nothing")
        return problems
    if spec.predicate:
        problems.append("a judge has no predicate — its prose is its criteria")
    if not any(each.fail for each in spec.classes):
        problems.append("declares no failing class — every score would pass, and "
                        "self-improvement could never count a failure")
    names = [each.name for each in spec.classes]
    if len(set(names)) != len(names):
        problems.append(f"declares a class twice: {', '.join(names)}")
    if spec.sample_rate is not None and not 0 <= spec.sample_rate <= 1:
        problems.append(f"sample_rate {spec.sample_rate} is out of range: it is the share of "
                        f"chapters judged, from 0 to 1")
    if not criteria.strip():
        problems.append("says nothing below the frontmatter — a judge's prose is its criteria")
    return problems


def _flat(error: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(part) for part in each['loc']) or 'frontmatter'}: "
                     f"{each['msg']}" for each in error.errors())


# ── scoring a chapter that has just ended ────────────────────────────────────

def after_chapter(run: "Run", workflow: "Workflow") -> None:
    """Score the chapter this process worked, if it has ended, with every code
    scorer bound to its workflow. Never raises: scoring is measurement, and a
    chapter does not fail of being measured. A chapter that stopped at a gate
    is still open, and is scored when it ends."""
    try:
        number = artifacts.ended_chapter(run.session_dir)
        if not number:
            return
        found, refused = load(workflow.directory.parent.parent,
                              {workflow.name: workflow.required_agents}, only=workflow.name)
        for each in refused:
            run.console.note(f"scorer {each.name} did not score: {each.error}")
        record = chapter_record(events.read(run.session_dir), number)
        for scorer in found:
            if scorer.spec.kind != "code":
                run.console.note(f"scorer {scorer.name} is a judge: checked, not run — "
                                 f"chapter {number} has no score from it")
                continue
            score = scorer.score(record)
            run.tracer.event(score)
            run.console.note(f"scored by {scorer.name}: {score.class_}"
                             + (" (failing)" if score.failing else ""))
    except Exception as error:              # noqa: BLE001 — see the docstring
        run.console.note(f"scoring failed, and the chapter stands as it ended: {error}")

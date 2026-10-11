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
A stamp ships four of them on `issue` (`templates/asf/scorers/`), so a factory
is measured from its first chapter.
A JUDGE is a model reading the chapter against the prose, with the classes its
frontmatter declares: the shipped `judge` agent, called by `engine/judge.py`,
on the share of chapters its `sample_rate` draws (`sampled`), and paid from the
factory's measurement budget (`engine/measurement.py`), never the work's. A
chapter no scorer judged simply has no score, which is how a reader tells "not
judged"; one a judge sampled and skipped because the day's budget was spent
says so (`ChapterNotJudged`), and is judged by a later `asf score`.
A stamp ships one judge, at `sample_rate: 0`: what one looks like, judging
nothing until a team gives it a rate.

`load` is what `asf check` refuses a scorer with and what a run reads its
scorers through, so a scorer `check` accepts is one a run will score with. A
scorer is the operator's file, like factory.yaml: `install.py --force` never
rewrites one, the shipped four included once they are there.

A chapter is scored by the process that ends it (`after_chapter`), and one
that ended before its scorer existed by `asf score` (`backfill`), with the
score it would have had then — so a new scorer has a baseline on day one.
Either way, a scorer that has just recorded a failing score is handed to
self-improvement (`engine/improve.py`), which files an issue once its failures
are a pattern.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Literal, Mapping, Sequence, get_args

from pydantic import ValidationError

from . import artifacts, events, frontmatter, git_helper, improve, judge, measurement, station
from .data_types import (ChapterNotJudged, ChapterScored, DomainEvent, EventLine, FactoryConfig,
                         LimitKind, ScorerClass, ScorerSpec)

if TYPE_CHECKING:
    from .runner import Run
    from .workflow import Workflow

SCORERS_DIR = "scorers"
SCORER_FILE = "scorer.md"


# ── a chapter, as its events tell it ─────────────────────────────────────────

@dataclass
class ChapterRecord:
    """The events of one chapter of one session, in order, and who owned each
    phase in it — what a predicate reads, and the seqs it cites. `session` is
    every line of the session, for the one predicate counted per session
    (`review_chapters_above`), whose evidence is other chapters' openings."""

    number: int
    lines: list[EventLine] = field(default_factory=list)
    owners: dict[str, str] = field(default_factory=dict)      # phase_id -> agent
    session: list[EventLine] = field(default_factory=list)

    def agent_of(self, line: EventLine) -> str:
        return str(line.payload.get("agent") or self.owners.get(line.payload.get("phase_id"), ""))

    def of(self, focus: str, line: EventLine) -> bool:
        """Whether `line` counts under `focus`: every line without one."""
        return not focus or self.agent_of(line) == focus


def chapter_record(lines: Sequence[EventLine], number: int) -> ChapterRecord:
    """The lines of chapter `number`: from its `workflow_started`, or a
    `session_resumed` that took it up again, to its `workflow_finished`.

    A resumed chapter is several stretches of the log, and another chapter may
    lie between them; a new process's `session_started` belongs to none until
    it says which chapter it took.
    """
    record = ChapterRecord(number=number, session=list(lines))
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


# What a predicate's parentheses take: nothing, a whole number, or optionally
# one kind of limit. `check` refuses anything else before a run can trip on it.
Takes = Literal["", "n", "limit_kind?"]
LIMIT_KINDS = get_args(LimitKind)


@dataclass(frozen=True)
class Predicate:
    name: str
    form: str                       # how `check` writes it: `limit_hit(kind?)`
    takes: Takes
    classes: tuple[ScorerClass, ...]
    classify: Callable[[ChapterRecord, str, object], Classed]  # (record, focus, argument)
    focuses: bool = True            # whether a `focus:` agent narrows what it counts


def _corrections_above(record: ChapterRecord, focus: str, limit: int) -> Classed:
    """A correction is an agent's answer refused and sent back to the same
    session: an envelope that did not parse (`envelope_rejected`), or a round
    of its gates that failed (`gate_result`, one per gate, so a round is its
    phase and attempt). The evidence is every one of those events."""
    evidence, rejected, failed_rounds = [], 0, set()
    for line in record.lines:
        if not record.of(focus, line):
            continue
        if line.kind == "envelope_rejected":
            rejected += 1
            evidence.append(line.seq)
        elif line.kind == "gate_result" and not line.payload.get("passed", True):
            failed_rounds.add((line.payload.get("phase_id"), line.payload.get("attempt")))
            evidence.append(line.seq)
    corrections = rejected + len(failed_rounds)
    return Classed("above" if corrections > limit else "within", evidence)


def _permission_rolled_back(record: ChapterRecord, focus: str, _: object) -> Classed:
    """An agent wrote outside its `writes:` and the factory undid it: every
    `permission_rolled_back` in the chapter is the evidence."""
    evidence = [line.seq for line in record.lines
                if line.kind == "permission_rolled_back" and record.of(focus, line)]
    return Classed("rolled_back" if evidence else "clean", evidence)


def _limit_hit(record: ChapterRecord, focus: str, kind: object) -> Classed:
    """A budget ceiling or a turn's wall clock stopped an agent phase: every
    `limit_hit` in the chapter, of `kind` when one is named."""
    evidence = [line.seq for line in record.lines if line.kind == "limit_hit"
                and (not kind or line.payload.get("kind") == kind) and record.of(focus, line)]
    return Classed("hit" if evidence else "none", evidence)


def _not_accepted(record: ChapterRecord, _focus: str, _: object) -> Classed:
    """The phases passed and the workflow still did not accept the chapter: a
    fix loop that ran out, a reviewer who withheld approval. A chapter that
    failed in a phase was never judged, and says accepted (`WorkflowFinished`).
    A resumed chapter finishes again, and its latest end is how it stands; a
    `workflow_finished` from before `accepted` was recorded says nothing of
    it, and is taken as accepted."""
    ends = [line for line in record.lines if line.kind == "workflow_finished"]
    if ends and ends[-1].payload.get("accepted", True) is False:
        return Classed("not_accepted", [ends[-1].seq])
    return Classed("accepted", [])


def _review_chapters_above(record: ChapterRecord, _focus: str, limit: int) -> Classed:
    """How many rounds of pull-request review the session has needed — counted
    per session, on the chapter being scored, which is its latest: every
    chapter opened on a pull request's review (`workflow_started`, `input:
    pr`) up to and including this one. Its evidence is each of those
    openings, earlier chapters' included: the count is the session's."""
    opened: dict[int, int] = {}
    for line in record.session:
        chapter = int(line.payload.get("chapter") or 0)
        if (line.kind == "workflow_started" and line.payload.get("input") == "pr"
                and 0 < chapter <= record.number):
            opened.setdefault(chapter, line.seq)
    evidence = sorted(opened.values())
    return Classed("above" if len(evidence) > limit else "within", evidence)


_COUNT = (ScorerClass(name="above", fail=True), ScorerClass(name="within", fail=False))

PREDICATES: dict[str, Predicate] = {predicate.name: predicate for predicate in (
    Predicate("corrections_above", "corrections_above(n)", "n", _COUNT, _corrections_above),
    Predicate("permission_rolled_back", "permission_rolled_back", "",
              (ScorerClass(name="rolled_back", fail=True), ScorerClass(name="clean", fail=False)),
              _permission_rolled_back),
    Predicate("limit_hit", "limit_hit(kind?)", "limit_kind?",
              (ScorerClass(name="hit", fail=True), ScorerClass(name="none", fail=False)),
              _limit_hit),
    Predicate("not_accepted", "not_accepted", "",
              (ScorerClass(name="not_accepted", fail=True),
               ScorerClass(name="accepted", fail=False)),
              _not_accepted, focuses=False),
    Predicate("review_chapters_above", "review_chapters_above(k)", "n", _COUNT,
              _review_chapters_above, focuses=False),
)}

_CALL = re.compile(r"\s*([a-z_]+)\s*(?:\(\s*([^)]*?)\s*\))?\s*")


def parse_predicate(text: str) -> tuple[Predicate, object]:
    """`corrections_above(2)` → (its predicate, 2); `limit_hit` → (its
    predicate, ""). Raises ValueError saying why not."""
    match = _CALL.fullmatch(text or "")
    known = ", ".join(predicate.form for predicate in PREDICATES.values())
    if not match or match[1] not in PREDICATES:
        raise ValueError(f"predicate {text!r} is not one of the closed set: {known}")
    predicate, argument = PREDICATES[match[1]], match[2] or ""
    if predicate.takes == "n":
        if not argument.isdigit():
            raise ValueError(f"predicate {text!r} takes a whole number: {predicate.form}")
        return predicate, int(argument)
    if predicate.takes == "limit_kind?":
        if argument and argument not in LIMIT_KINDS:
            raise ValueError(f"predicate {text!r} names no kind of limit: {predicate.form}, "
                             f"where kind is one of {', '.join(LIMIT_KINDS)} or left out for "
                             f"any")
        return predicate, argument
    if argument:
        raise ValueError(f"predicate {text!r} takes nothing: {predicate.form}")
    return predicate, ""


# ── scorers, loaded and checked ──────────────────────────────────────────────

@dataclass
class Scorer:
    name: str
    path: Path
    spec: ScorerSpec
    criteria: str                   # the prose below the frontmatter

    @property
    def rate(self) -> float:
        """The share of its workflow's chapters it scores: a judge's
        `sample_rate`, every chapter when it sets none, and every chapter for
        a code predicate, which costs nothing."""
        return 1.0 if self.spec.sample_rate is None else self.spec.sample_rate

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


def sampled(rate: float, adw_id: str, chapter: int, scorer: str) -> bool:
    """Whether a judge at `rate` judges chapter `chapter` of session `adw_id`.

    Drawn from a hash, never a random number, so it is the same answer every
    time it is asked: `asf score` passes over a chapter its judge did not
    sample as surely as the process that ended it did, and a chapter resumed
    and ended again is sampled as it was. Each scorer draws its own chapters,
    and a higher rate keeps every chapter a lower one drew."""
    if rate <= 0:
        return False
    digest = hashlib.sha256(f"{scorer}\0{adw_id}\0{chapter}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2 ** 64 < rate


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
        problems = _problems(spec, criteria, workflows, factory_root)
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


def _problems(spec: ScorerSpec, criteria: str, workflows: Mapping[str, Sequence[str]],
              factory_root: Path) -> list[str]:
    problems = []
    if spec.workflow not in workflows:
        problems.append(f"workflow {spec.workflow!r} is not one this factory loads "
                        f"(it has: {', '.join(sorted(workflows)) or 'none'})")
    elif spec.focus and spec.focus not in workflows[spec.workflow]:
        problems.append(f"focus {spec.focus!r} is not one of {spec.workflow}'s agents "
                        f"({', '.join(workflows[spec.workflow]) or 'it binds none'})")
    if spec.kind == "code":
        try:
            predicate, _ = parse_predicate(spec.predicate)
        except ValueError as error:
            problems.append(str(error) if spec.predicate else
                            "a code scorer names its predicate: `predicate: corrections_above(2)`")
        else:
            if spec.focus and not predicate.focuses:
                problems.append(f"{predicate.name} judges the whole chapter, not one agent — "
                                f"drop `focus: {spec.focus}`")
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
    return problems + judge.refused(factory_root)


def _flat(error: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(part) for part in each['loc']) or 'frontmatter'}: "
                     f"{each['msg']}" for each in error.errors())


# ── scoring one ended chapter ────────────────────────────────────────────────

@dataclass
class Scoring:
    """Where a chapter's scores come from and where they go: the config a judge
    runs under, the checkout it reads, how a line is said, and how a score —
    or why a judge was not called — joins the session's record. `unjudged` is
    the scorers whose record already says, since the chapter last ended, that
    the budget kept their judge from it: a second pass says it once more on
    the console, never on the record."""

    cfg: FactoryConfig
    main_root: Path
    say: Callable[[str], None]
    record: Callable[[DomainEvent], object]
    unjudged: frozenset[str] = frozenset()


@dataclass
class Scored:
    """What scoring one chapter came to."""

    recorded: int = 0               # scores recorded
    unjudged: int = 0               # judges the measurement budget kept from the chapter
    said: int = 0                   # ...of which the record was told so just now
    failing: set[str] = field(default_factory=set)      # scorers that recorded a failing score


def score_chapter(scoring: Scoring, chapter: judge.Chapter, due: Sequence[Scorer]) -> Scored:
    """Score `chapter` with each of `due`, the free ones first: a code
    predicate always, a judge scorer when it samples the chapter and the day's
    measurement budget is not spent — checked before every judge call, since
    the last one spent some of it. One whose judge could not score says why
    and leaves no score."""
    scored, number = Scored(), chapter.record.number
    for scorer in sorted(due, key=lambda each: each.spec.kind != "code"):
        if scorer.spec.kind == "code":
            score = scorer.score(chapter.record)
        elif not sampled(scorer.rate, chapter.session_dir.name, number, scorer.name):
            scoring.say(f"scorer {scorer.name} did not sample chapter {number} — it judges "
                        f"{scorer.rate:.0%} of {scorer.spec.workflow}'s chapters")
            continue
        elif (day := measurement.today(scoring.cfg, scoring.main_root)).spent_out:
            scoring.say(f"scorer {scorer.name} did not judge chapter {number}: the measurement "
                        f"budget is spent — ${day.spent:.2f} of ${day.budget:.2f} on {day.day} "
                        f"(UTC), `measurement.usd_per_day` in factory.yaml")
            if scorer.name not in scoring.unjudged:
                scoring.record(ChapterNotJudged(chapter=number, scorer=scorer.name, day=day.day,
                                                spent=day.spent, budget=day.budget))
                scored.said += 1
            scored.unjudged += 1
            continue
        else:
            try:
                score = judge.judge(scoring.cfg, scoring.main_root, chapter, scorer)
            except RuntimeError as error:
                scoring.say(f"scorer {scorer.name} did not judge chapter {number}: {error}")
                continue
        scoring.record(score)
        scored.recorded += 1
        if score.failing:
            scored.failing.add(scorer.name)
        scoring.say(f"chapter {number} scored by {scorer.name}: {score.class_}"
                    + (" (failing)" if score.failing else "")
                    + (f", judging it cost ${score.usage.total_cost:.4f}"
                       if score.kind == "judge" else ""))
    return scored


# ── scoring a chapter that has just ended ────────────────────────────────────

def after_chapter(run: "Run", workflow: "Workflow") -> None:
    """Score the chapter this process worked, if it has ended, with every
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
        if not found:
            return
        ended = artifacts.ended_chapters(run.session_dir)[number][1]
        chapter = judge.Chapter(run.session_dir,
                                chapter_record(events.read(run.session_dir), number), ended)
        scored = score_chapter(Scoring(run.cfg, run.main_root, run.console.note,
                                       run.tracer.event), chapter, found)
        improve.consider(run.cfg, run.main_root,
                         [each for each in found if each.name in scored.failing],
                         run.console.note)
    except Exception as error:              # noqa: BLE001 — see the docstring
        run.console.note(f"scoring failed, and the chapter stands as it ended: {error}")


# ── scoring chapters that ended before the scorer: `asf score` ───────────────

@dataclass
class Tally:
    scored: int = 0                 # chapters given at least one score
    already: int = 0                # chapters every chosen scorer had scored before
    unjudged: int = 0               # chapters a judge was kept from by the measurement budget
    failed: int = 0                 # sessions that could not be read or written
    failing: set[str] = field(default_factory=set)      # scorers that recorded a failing score


def score_ended_chapters(cfg: FactoryConfig, sessions_dir: Path, chosen: Sequence[Scorer],
                         since: datetime | None) -> Tally:
    """Score every chapter that has ended, in a session started on or after
    `since`, with each of `chosen` bound to its workflow that has not scored it
    since it last ended — so a second pass adds nothing, and a chapter resumed
    and ended again is scored on how it ended last. A judge scorer passes over
    the chapters it did not sample on every pass alike (`sampled`).

    Each code score is the one `after_chapter` would have given the chapter as
    it ended: a predicate reads the chapter's own lines, and nothing appended
    to the session since (a score, a pull request's close) is one of them. It
    joins the session's record as a late event, and is flushed to a cockpit
    then — the session's own shipper finished with it long ago."""
    tally = Tally()
    for adw_id in sorted(artifacts.started_since(sessions_dir, since)):
        session_dir = Path(sessions_dir) / adw_id
        try:
            if _score_session(cfg, session_dir, chosen, tally):
                station.flush(session_dir)
        except Exception as error:          # noqa: BLE001 — one session never stops the rest
            tally.failed += 1
            print(f"  {adw_id}: could not be scored ({error})")
    return tally


def _score_session(cfg: FactoryConfig, session_dir: Path, chosen: Sequence[Scorer],
                   tally: Tally) -> bool:
    """Score the session's ended chapters into `tally`; True when it wrote any."""
    lines = events.read(session_dir)
    latest: dict[tuple[int, str], int] = {}                   # (chapter, scorer) -> seq
    unjudged: dict[tuple[int, str], int] = {}                 # ...of its ChapterNotJudged
    marks = {ChapterScored.KIND: latest, ChapterNotJudged.KIND: unjudged}
    for line in lines:
        if (mark := marks.get(line.kind)) is not None:
            mark[int(line.payload.get("chapter") or 0), str(line.payload.get("scorer"))] = \
                line.seq
    wrote = False
    for number, (workflow, ended) in artifacts.ended_chapters(session_dir).items():
        # A judge that does not sample the chapter has nothing to give it, on
        # this pass or any other: it is not due, and the chapter can be done.
        bound = [each for each in chosen if each.spec.workflow == workflow and (
            each.spec.kind == "code" or sampled(each.rate, session_dir.name, number, each.name))]
        due = [each for each in bound if latest.get((number, each.name), 0) < ended]
        if bound and not due:
            tally.already += 1
        if not due:
            continue
        chapter = judge.Chapter(session_dir, chapter_record(lines, number), ended)
        said = frozenset(scorer for (at, scorer), seq in unjudged.items()
                         if at == number and seq > ended)
        scoring = Scoring(cfg, git_helper.main_root(), _printer_for(session_dir, workflow),
                          lambda event: events.emit(session_dir, event), said)
        scored = score_chapter(scoring, chapter, due)
        tally.scored += bool(scored.recorded)
        tally.unjudged += bool(scored.unjudged)
        tally.failing |= scored.failing
        wrote = wrote or bool(scored.recorded or scored.said)
    return wrote


def _printer_for(session_dir: Path, workflow: str) -> Callable[[str], None]:
    return lambda line: print(f"  {session_dir.name} ({workflow}): {line}")


def choose(factory_root: Path, workflows: Mapping[str, Sequence[str]],
           names: Sequence[str] = ()) -> tuple[list[Scorer], list[Refused]]:
    """The scorers `names` (default: every one), as `load` reads them: the
    ones that hold and the ones `check` refuses. A name no scorer has is
    refused here (SystemExit), before anything is scored or asked of the
    forge."""
    found, refused = load(factory_root, workflows)
    known = sorted({each.name for each in found} | {each.name for each in refused})
    unknown = [name for name in names if name not in known]
    if unknown:
        raise SystemExit(f"no scorer named {', '.join(unknown)} under "
                         f"{directory(factory_root)} — it has: {', '.join(known) or 'none'}")
    if not names:
        return found, refused
    return ([each for each in found if each.name in names],
            [each for each in refused if each.name in names])


def backfill(cfg: FactoryConfig, chosen: Sequence[Scorer], broken: Sequence[Refused],
             since: datetime | None = None) -> int:
    """`asf score`: give the `chosen` scorers a baseline from the sessions
    already on disk — every ended chapter of their workflow they have not
    scored, a judge's as it samples them — and say why each `broken` one
    scores nothing. Once every session is scored, a scorer that recorded a
    failing score is handed to self-improvement, so a baseline's failures
    file one issue with all of them, never one per session. 1 when a scorer
    is broken, or a session could not be scored."""
    for each in broken:
        print(f"✗ scorer {each.name} scores nothing until `asf check` accepts it\n"
              f"  {each.path}: {each.error}")
    main_root = git_helper.main_root()
    tally = score_ended_chapters(cfg, artifacts.sessions_root(main_root, cfg.data_dir), chosen,
                                 since)
    print(f"scored {tally.scored} chapter(s)" + (f" since {since.date()}" if since else "")
          + f"; {tally.already} already scored"
          + (f"; {tally.unjudged} chapter(s) not judged: the measurement budget is spent — "
             f"`asf score` judges them on a day it is not" if tally.unjudged else "")
          + (f"; {tally.failed} session(s) could not be scored — run it again"
             if tally.failed else ""))
    improve.consider(cfg, main_root, [each for each in chosen if each.name in tally.failing],
                     lambda line: print(f"  {line}"))
    return 1 if broken or tally.failed else 0

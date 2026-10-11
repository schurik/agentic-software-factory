"""Self-improvement: one scorer's repeated failing scores, filed as an issue on
the factory's own tracker (`CONTEXT.md`, Self-improvement; ADR 0006).

A failing score is one bad chapter. A PATTERN is a scorer failing on
`failures` of the last `of_last` distinct sessions it judged — its own
`improve_after:`, else `self_improvement:` in factory.yaml — and several
failing chapters of one session count once: one long review cycle is not a
pattern. At the threshold the station files an issue holding the failing
scores, the events each one cites and the scorer's criteria, labelled
`asf:improve:<scorer>` and queued for the `issue` workflow like any other. A
person approves its plan and merges its pull request; nothing here changes the
factory, and nothing here changes how a chapter ended.

Before filing, one bounded agent phase diagnoses the pattern
(`engine/diagnose.py`): the cause, whether the change belongs to the factory or
the application, the files and the proposed change, with code's rulings
applied — a skill-owned task file redirected to the workflow's override, and
factory code reported, never proposed. The issue body carries it. It is paid
from the measurement budget, so a day whose budget is spent files the issue
undiagnosed and says so, as does a diagnosis that could not be made: the
evidence is worth filing either way. New evidence for an open issue is a
comment, and is not diagnosed again.

AT MOST ONE OPEN ISSUE PER SCORER, and the tracker is the only state two
stations share: before filing, a station searches the forge for an open issue
carrying the scorer's label, and if one is there it adds the failing sessions
that issue does not cite yet as a comment. Which sessions it cites is written
into the issue itself, in a mark on the body and on each comment, so whichever
station looks next reads the same answer. A search that fails files nothing —
"there is none" from a listing that never ran is how an issue gets filed twice.

It runs after a failing score is recorded (`scorers.after_chapter`, and `asf
score` once it has scored), over the sessions in this station's data dir, and
never raises: measuring is never a reason for work to fail. A passing score
asks nothing of the forge — it is no new evidence.

A MERGE STARTS THE COUNT AGAIN. Once a pull request for the scorer's issue
merges, only chapters that started after it count: the failures it was meant
to fix are not evidence against it. The merge is read off the events alone —
a session whose `provenance_recorded` says it `improves` the scorer (its
issue carried the label) and whose `pull_request_closed` says it merged —
which is how a cockpit reads it too (`run.json`'s `pr_state`, written beside
that close, only narrows which records are read). So a station counts from a
merge it has the record of: the improving session's, or one `asf score
--since` backfilled.

What it filed, or added to, is recorded as an `improvement_filed` on the
newest failing session it cites — a late event, like the score — so a
cockpit draws the scorer's issue without asking the forge (ADR 0006).

A tracker may be public, and the transcripts opt-in (`cockpit: {transcripts:
true}`) lets a transcript reach a cockpit, not a tracker. So the issue names a
transcript event a score cites by its seq and kind only, and never carries a
judge's reasoning: both stay in the session's record, which the issue points to.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Mapping, Sequence

from . import artifacts, diagnose, events, issues, labels, measurement, station
from .data_types import (ChapterScored, EventLine, FactoryConfig, HarnessOutput, ImproveAfter,
                         ImprovementFiled, IssueUpdate, NewIssue, OpenIssue, PromptRendered,
                         ProvenanceRecorded, PullRequestClosed, RunState, WorkflowStarted)
from .utils import utc

if TYPE_CHECKING:
    from .scorers import Scorer

# The workflow a self-improvement issue is queued for: the one that works an issue.
WORKFLOW = "issue"
# The factory's own mark on the issue and on each comment it adds, naming the
# sessions that text cites — what tells the next look which evidence is new.
MARK = "<!-- asf:improve"
_CITED = re.compile(re.escape(MARK) + r"\b[^>]*?\bsessions=(?P<sessions>[\w,-]*)")
# What one issue says of the events a score cites: a forge caps a body
# (GitHub's at 65,536 characters), and the session's own record has the rest.
CITED_PER_CHAPTER = 12
PAYLOAD_CHARS = 240
MAX_BODY_CHARS = 60000
# What leaves the machine only for a cockpit, and only when the repository
# opted in (CLAUDE.md, invariant 11): cited by seq and kind, never quoted.
TRANSCRIPT_KINDS = frozenset({PromptRendered.KIND, HarnessOutput.KIND})


# ── the window: the last `of_last` distinct sessions the scorer judged ───────

@dataclass
class Failing:
    """One failing session: the latest score of each of its chapters that
    fails, and the session's lines, which the scores' evidence is read from."""

    adw_id: str
    scores: list[EventLine]
    lines: dict[int, EventLine] = field(default_factory=dict)       # seq -> line


@dataclass
class Merge:
    """Where a scorer's self-improvement last merged: the session that worked
    its issue, the number of that session's pull request, and when it merged."""

    adw_id: str
    number: int
    merged_at: datetime


@dataclass
class Window:
    """The sessions a threshold counts, and the failing ones among them —
    since the scorer's last self-improvement merge, when it has one."""

    threshold: ImproveAfter
    judged: list[str] = field(default_factory=list)       # newest first
    failing: list[Failing] = field(default_factory=list)  # newest first
    since: Merge | None = None

    @property
    def met(self) -> bool:
        return len(self.failing) >= self.threshold.failures

    def failed_on(self) -> str:
        """`2 of the last 7 sessions it judged`, `… since #9 merged`."""
        said = f"{len(self.failing)} of the last {len(self.judged)} sessions it judged"
        if self.since is None:
            return said
        return said + (f" since #{self.since.number} merged" if self.since.number
                       else " since its self-improvement merged")


def window(sessions_dir: Path, scorer: str, threshold: ImproveAfter) -> Window:
    """The last `threshold.of_last` sessions `scorer` judged in this station's
    data dir, by when each started, and which of them failed. A cockpit's
    Scorers view counts by when it first stored each session, across every
    station of the factory, so the two can differ by a session that ran
    elsewhere or arrived late; this one is the station's to act on. A session
    fails when any of its chapters' latest score does. A chapter scored again
    (resumed and ended again, or `asf score` after the scorer changed) is read
    by its latest score. After a self-improvement merge (`merged`) only the
    chapters that started after it count, and a session with none is not one
    the scorer judged since."""
    states = artifacts.scan(sessions_dir)
    counted = Window(threshold, since=merged(sessions_dir, scorer, states))
    started = sorted(states.items(), key=lambda each: (each[1].started_at, each[0]),
                     reverse=True)
    for adw_id, _ in started:
        lines = events.read(Path(sessions_dir) / adw_id)
        latest: dict[int, EventLine] = {}
        opened: dict[int, datetime | None] = {}
        for line in lines:
            if line.kind == WorkflowStarted.KIND:
                opened.setdefault(int(line.payload.get("chapter") or 0), _moment(line.ts))
            elif line.kind == ChapterScored.KIND and line.payload.get("scorer") == scorer:
                latest[int(line.payload.get("chapter") or 0)] = line
        if counted.since is not None:
            after = counted.since.merged_at
            latest = {number: line for number, line in latest.items()
                      if (moment := opened.get(number)) is not None and moment > after}
        if not latest:
            continue
        counted.judged.append(adw_id)
        failing = [latest[number] for number in sorted(latest)
                   if latest[number].payload.get("failing")]
        if failing:
            counted.failing.append(Failing(adw_id, failing, {line.seq: line for line in lines}))
        if len(counted.judged) >= threshold.of_last:
            break
    return counted


def merged(sessions_dir: Path, scorer: str, states: Mapping[str, RunState]) -> Merge | None:
    """The latest merge of a pull request for `scorer`'s self-improvement
    issue among the sessions on this station, from their events: one that
    `improves` the scorer, whose pull request closed merged. None before any."""
    latest: Merge | None = None
    for adw_id, state in states.items():
        if state.pr_state != "merged":          # what `record_pr_closed` keeps beside the event
            continue
        lines = events.read(Path(sessions_dir) / adw_id)
        if not any(line.kind == ProvenanceRecorded.KIND
                   and line.payload.get("improves") == scorer for line in lines):
            continue
        for line in lines:
            if line.kind != PullRequestClosed.KIND or not line.payload.get("merged"):
                continue
            moment = _moment(str(line.payload.get("merged_at") or "")) or _moment(line.ts)
            if moment is not None and (latest is None or moment > latest.merged_at):
                latest = Merge(adw_id, int(line.payload.get("number") or 0), moment)
    return latest


def _moment(text: str) -> datetime | None:
    try:
        return utc(datetime.fromisoformat(text))
    except ValueError:
        return None


# ── what the issue says ──────────────────────────────────────────────────────

def mark(scorer: str, cited: Sequence[Failing]) -> str:
    return f"{MARK} scorer={scorer} sessions={','.join(each.adw_id for each in cited)} -->"


def cited_in(texts: Sequence[str]) -> set[str]:
    """The sessions the factory's marks in `texts` say were cited already."""
    return {adw_id for text in texts for found in _CITED.finditer(text or "")
            for adw_id in found["sessions"].split(",") if adw_id}


def title(scorer: "Scorer", counted: Window) -> str:
    return f"Self-improvement: scorer {scorer.name} failed on {counted.failed_on()}"


def issue_body(cfg: FactoryConfig, scorer: "Scorer", counted: Window,
               diagnosed: "diagnose.Diagnosis | str" = "") -> str:
    """The whole case, standing on its own: the pattern, its diagnosis — or
    why it has none — the scorer's criteria, and each failing score with the
    events it cites."""
    threshold = counted.threshold
    whose = ("its own `improve_after:`" if scorer.spec.improve_after
             else "`self_improvement:` in `asf/factory.yaml`")
    return _bounded("\n".join([
        mark(scorer.name, counted.failing),
        f"The scorer **{scorer.name}** failed on {counted.failed_on()}. This factory files an "
        f"issue at {threshold.failures} of the last {threshold.of_last} ({whose}).",
        "",
        "A score never changed how its chapter ended: a scorer measures, a gate decides. "
        "This is the pattern, for a person to judge. It is worked by the "
        f"`{WORKFLOW}` workflow like any other issue, and nothing in the factory or the "
        "application changes until a person approves its plan and merges its pull request.",
        "",
        *_diagnosis(diagnosed),
        "## The scorer's criteria",
        "",
        *_criteria(scorer),
        "",
        "## The failing scores",
        "",
        *_failing(cfg, counted.failing),
    ]))


def comment_body(cfg: FactoryConfig, scorer: "Scorer", counted: Window,
                 new: Sequence[Failing]) -> str:
    return _bounded("\n".join([
        mark(scorer.name, new),
        f"New evidence: the scorer **{scorer.name}** has now failed on {counted.failed_on()}.",
        "",
        *_failing(cfg, new),
    ]))


def _diagnosis(diagnosed: "diagnose.Diagnosis | str") -> list[str]:
    """The diagnosis section: what to change and where, as code ruled on it."""
    if not diagnosed:
        return []
    if isinstance(diagnosed, str):
        return ["## Diagnosis", "", f"None was made: {diagnosed.rstrip('.')}.", "",
                "The evidence below stands on its own, and the plan diagnoses it.", ""]
    surface = "the factory" if diagnosed.surface == "factory" else "the application"
    text = ["## Diagnosis", "", f"**Cause:** {diagnosed.cause}", "",
            f"**Surface:** {surface}", "",
            _heading(diagnosed),
            "", *(f"> {line}".rstrip() for line in diagnosed.proposed_change.splitlines()),
            "", "**Files:**", ""]
    text += [f"- {_ruling(each)}" for each in diagnosed.files]
    if diagnosed.upstreamable:
        text += ["", "**Upstreamable:** the change belongs in the skill this factory was "
                     "stamped from as well — a note for a person to carry there. Nothing "
                     "here files anything upstream."]
    return text + [""]


def _heading(diagnosed: "diagnose.Diagnosis") -> str:
    """What the change is: proposed, reported, or proposed for some files and
    reported for the factory code beside them — never proposed for that."""
    if not diagnosed.proposed:
        return "**Reported, not proposed** — it is in factory code, where every gate is:"
    if not diagnosed.reported:
        return "**Proposed change:**"
    return (f"**Proposed change** — for {', '.join(f'`{each.path}`' for each in diagnosed.proposed)} "
            f"only; what it says of the factory code below is reported, never proposed:")


def _ruling(named: "diagnose.Named") -> str:
    if named.ruling == "reported":
        return (f"`{named.path}` — factory code, where gates decide what is accepted: "
                f"reported, never proposed. A change to what blocks work is a person's to "
                f"make, deliberately, in code.")
    if named.ruling == "redirected":
        return (f"`{named.path}` — the workflow's own task override, in place of "
                f"`{named.named}`, which the skill owns and `install.py --force` would "
                f"overwrite.")
    return f"`{named.path}`" + (" — the skill owns it, and `install.py --force` would "
                                "overwrite it" if named.skill_owned else "")


def _criteria(scorer: "Scorer") -> list[str]:
    spec = scorer.spec
    classes = ", ".join(f"`{each.name}`" + (" (failing)" if each.fail else "")
                        for each in scorer.classes)
    text = [f"From `{'/'.join(scorer.path.parts[-4:])}`:", "",       # asf/scorers/<name>/…
            f"- **Workflow:** `{spec.workflow}`" + (f", focused on `{spec.focus}`"
                                                   if spec.focus else ""),
            f"- **Kind:** {spec.kind}" + (f", `{spec.predicate}`" if spec.predicate else ""),
            f"- **Classes:** {classes}"]
    prose = scorer.criteria.strip()
    if prose:
        text += ["", *(f"> {line}".rstrip() for line in prose.splitlines())]
    return text


def _failing(cfg: FactoryConfig, failing: Sequence[Failing]) -> list[str]:
    text: list[str] = []
    for session in failing:
        text += [f"### Session `{session.adw_id}`", "",
                 f"Its record: `{cfg.data_dir}/sessions/{session.adw_id}/events.jsonl`, on the "
                 f"station that ran it.", ""]
        for score in session.scores:
            payload = score.payload
            text.append(f"- **Chapter {payload.get('chapter')}:** `{payload.get('class')}` "
                        f"(failing), scored at seq {score.seq}")
            evidence = [int(seq) for seq in payload.get("evidence") or []]
            for seq in evidence[:CITED_PER_CHAPTER]:
                text.append(f"  - {_cited(session.lines.get(seq), seq)}")
            if len(evidence) > CITED_PER_CHAPTER:
                text.append(f"  - …and {len(evidence) - CITED_PER_CHAPTER} more, in its record")
            if not evidence:
                text.append("  - it cites no event")
        text.append("")
    return text


def _cited(line: EventLine | None, seq: int) -> str:
    if line is None:
        return f"seq {seq} · not in the record"
    if line.kind in TRANSCRIPT_KINDS:
        return f"seq {seq} · `{line.kind}` · a transcript, read it in the record"
    payload = json.dumps(line.payload, ensure_ascii=False, sort_keys=True).replace("`", "'")
    if len(payload) > PAYLOAD_CHARS:
        payload = payload[:PAYLOAD_CHARS - 1] + "…"
    return f"seq {seq} · `{line.kind}` · `{payload}`"


def _bounded(text: str) -> str:
    if len(text) <= MAX_BODY_CHARS:
        return text
    return (text[:MAX_BODY_CHARS].rstrip()
            + "\n\n…\n\n*Cut to fit the tracker. Every cited event is in its session's "
              "record.*")


# ── filing it, or adding to the one that is open ─────────────────────────────

def queue_labels(cfg: FactoryConfig) -> list[str]:
    """The labels that queue an issue for the `issue` workflow: its route and
    `queued`, as a person would apply them. None when no route takes an issue
    there — the issue is then filed and left for a person to route."""
    route = next((label for label, workflow in cfg.issues.route.items()
                  if workflow == WORKFLOW), "")
    return [route, cfg.issues.states.queued] if route and cfg.issues.states.queued else []


@dataclass
class Filing:
    """Where self-improvement files, and how it says what it did: on the
    console of the run that ended the chapter, or `asf score`'s output.
    `live` is the session the running process ships itself, if any: the
    record of any other is flushed to a cockpit as it is written."""

    cfg: FactoryConfig
    main_root: Path
    say: Callable[[str], None]
    live: Path | None = None


def consider(filing: Filing, failed: Sequence["Scorer"]) -> None:
    """After `failed` each recorded a failing score: file an issue for each
    one that has reached its threshold, or add the new evidence to the one
    that is open. Never raises."""
    if not failed:
        return
    say = filing.say
    for scorer in failed:
        try:
            _consider(filing, scorer)
        except Exception as error:          # noqa: BLE001 — see the docstring
            say(f"self-improvement for scorer {scorer.name} filed nothing: {error}")


def _consider(filing: Filing, scorer: "Scorer") -> None:
    cfg, say = filing.cfg, filing.say
    threshold = scorer.threshold(cfg)
    counted = window(artifacts.sessions_root(filing.main_root, cfg.data_dir), scorer.name,
                  threshold)
    if not counted.met:
        say(f"scorer {scorer.name} failed on {counted.failed_on()}; an issue is filed at "
            f"{threshold.failures} of the last {threshold.of_last}")
        return
    if not cfg.issues.enabled:
        say(f"scorer {scorer.name} failed on {counted.failed_on()}, and no issue is filed: "
            f"`issues.enabled` is false in factory.yaml")
        return
    label = labels.improving(scorer.name)
    try:
        already = issues.labelled(filing.main_root, cfg.issues, label.name)
    except RuntimeError as error:
        say(f"scorer {scorer.name} failed on {counted.failed_on()}, and filed nothing: could not "
            f"search the tracker for {label.name} ({error})")
        return
    if already:
        _add_to(filing, scorer, counted, already[0])
        return
    if not cfg.issues.create_command:
        say(f"scorer {scorer.name} failed on {counted.failed_on()}, and no issue is filed: "
            f"`issues.create_command` is empty")
        return
    diagnosed = _diagnosed(filing, scorer, counted)
    # One that already exists stays as it is, and refuses to be defined again:
    # what that says matters only when filing then fails.
    defined = labels.define(cfg, filing.main_root, label)
    queued = queue_labels(cfg)
    result = issues.create(filing.main_root, cfg.issues, NewIssue(
        title=title(scorer, counted), body=issue_body(cfg, scorer, counted, diagnosed),
        labels=[label.name, *queued]))
    if not result.ok:
        say(f"scorer {scorer.name} failed on {counted.failed_on()}, and the issue was not "
            f"filed: {'; '.join(result.notes + defined.notes)}")
        return
    diagnosis = ({"not_diagnosed": diagnosed} if isinstance(diagnosed, str) else
                 {"cause": diagnosed.cause, "surface": diagnosed.surface})
    _record(filing, counted, ImprovementFiled(
        scorer=scorer.name, number=result.number, url=result.url,
        title=title(scorer, counted), sessions=[each.adw_id for each in counted.failing],
        **diagnosis))
    say(f"scorer {scorer.name} failed on {counted.failed_on()}: filed #{result.number} "
        f"({label.name})"
        + (f", queued for the {WORKFLOW} workflow" if queued else
           f" — no route label takes an issue to the {WORKFLOW} workflow, so it is not queued"))


def _diagnosed(filing: Filing, scorer: "Scorer", counted: Window) -> "diagnose.Diagnosis | str":
    """The pattern's diagnosis, or why there is none: the day's measurement
    budget is spent, or the diagnostician gave none."""
    cfg, say = filing.cfg, filing.say
    day = measurement.today(cfg, filing.main_root)
    if day.spent_out:
        why = (f"the measurement budget is spent — ${day.spent:.2f} of ${day.budget:.2f} on "
               f"{day.day} (UTC), `measurement.usd_per_day` in factory.yaml")
        say(f"scorer {scorer.name}: not diagnosed, {why}")
        return why
    try:
        diagnosis = diagnose.diagnose(cfg, filing.main_root, scorer, counted)
    except RuntimeError as error:
        say(f"scorer {scorer.name}: not diagnosed, {error}")
        return str(error)
    say(f"scorer {scorer.name} diagnosed: a change to the {diagnosis.surface}, in "
        f"{', '.join(each.path for each in diagnosis.files)}; diagnosing it cost "
        f"${diagnosis.cost:.4f}")
    return diagnosis


def _add_to(filing: Filing, scorer: "Scorer", counted: Window, issue: OpenIssue) -> None:
    """Comment on the open `issue` with the failing sessions it does not cite yet."""
    number = issue.number
    cited = cited_in([issue.body, *issue.comments])
    new = [each for each in counted.failing if each.adw_id not in cited]
    if not new:
        filing.say(f"scorer {scorer.name} failed on {counted.failed_on()}; #{number} already "
                   f"cites them")
        return
    result = issues.comment(filing.main_root, filing.cfg.issues, IssueUpdate(
        number=number, comment=comment_body(filing.cfg, scorer, counted, new)))
    filing.say(f"scorer {scorer.name} failed on {counted.failed_on()}: "
               + (f"added {len(new)} session(s) to #{number}" if result.ok else
                  f"could not add them to #{number}: {'; '.join(result.notes)}"))
    if result.ok:
        _record(filing, counted, ImprovementFiled(
            scorer=scorer.name, number=number, url=issue.url, title=issue.title,
            commented=True, sessions=[each.adw_id for each in new]))


def _record(filing: Filing, counted: Window, filed: ImprovementFiled) -> None:
    """Put what was filed on the record of the newest failing session it
    cites, and flush it to a cockpit unless the running process ships that
    session itself. The forge has it either way: a record that could not be
    written is said, and nothing is filed again for it."""
    session_dir = artifacts.sessions_root(filing.main_root, filing.cfg.data_dir) / \
        counted.failing[0].adw_id
    try:
        events.emit(session_dir, filed)
        if filing.live is None or Path(filing.live).resolve() != session_dir.resolve():
            station.flush(session_dir)
    except Exception as error:              # noqa: BLE001 — the issue stands
        filing.say(f"#{filed.number} is on the tracker, and not on the record of session "
                   f"{counted.failing[0].adw_id}: {error}")

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
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Sequence

from . import artifacts, events, issues, labels
from .data_types import (ChapterScored, EventLine, FactoryConfig, ImproveAfter, IssueUpdate,
                         NewIssue)

if TYPE_CHECKING:
    from .scorers import Scorer

# The workflow a self-improvement issue is queued for: the one that works an issue.
WORKFLOW = "issue"
# The factory's own mark on the issue and on each comment it adds, naming the
# sessions that text cites — what tells the next look which evidence is new.
MARK = "<!-- asf:improve"
_MARK = re.compile(r"<!-- asf:improve\b[^>]*?\bsessions=(?P<sessions>[\w,-]*)")
# What one issue says of the events a score cites: a forge caps a body
# (GitHub's at 65,536 characters), and the session's own record has the rest.
CITED_PER_CHAPTER = 12
PAYLOAD_CHARS = 240
MAX_BODY_CHARS = 60000


def threshold_of(cfg: FactoryConfig, scorer: "Scorer") -> ImproveAfter:
    """The bar `scorer` is held to: its own `improve_after:`, else the factory's."""
    return scorer.spec.improve_after or cfg.self_improvement


# ── the window: the last `of_last` distinct sessions the scorer judged ───────

@dataclass
class Failing:
    """One failing session: the latest score of each of its chapters that
    fails, and the session's lines, which the scores' evidence is read from."""

    adw_id: str
    scores: list[EventLine]
    lines: dict[int, EventLine] = field(default_factory=dict)       # seq -> line


@dataclass
class Window:
    """The sessions a threshold counts, and the failing ones among them."""

    threshold: ImproveAfter
    judged: list[str] = field(default_factory=list)       # newest first
    failing: list[Failing] = field(default_factory=list)  # newest first

    @property
    def met(self) -> bool:
        return len(self.failing) >= self.threshold.failures

    def said(self) -> str:
        return f"{len(self.failing)} of the last {len(self.judged)} sessions it judged"


def window(sessions_dir: Path, scorer: str, threshold: ImproveAfter) -> Window:
    """The last `threshold.of_last` sessions `scorer` judged, by when each
    started — the order a cockpit's Scorers view counts them in — and which of
    them failed: a session fails when any of its chapters' latest score does.
    A chapter scored again (resumed and ended again, or `asf score` after the
    scorer changed) is read by its latest score."""
    seen = Window(threshold)
    started = sorted(artifacts.scan(sessions_dir).items(),
                     key=lambda each: (each[1].started_at, each[0]), reverse=True)
    for adw_id, _ in started:
        lines = events.read(Path(sessions_dir) / adw_id)
        latest: dict[int, EventLine] = {}
        for line in lines:
            if line.kind == ChapterScored.KIND and line.payload.get("scorer") == scorer:
                latest[int(line.payload.get("chapter") or 0)] = line
        if not latest:
            continue
        seen.judged.append(adw_id)
        failing = [latest[number] for number in sorted(latest)
                   if latest[number].payload.get("failing")]
        if failing:
            seen.failing.append(Failing(adw_id, failing, {line.seq: line for line in lines}))
        if len(seen.judged) >= threshold.of_last:
            break
    return seen


# ── what the issue says ──────────────────────────────────────────────────────

def mark(scorer: str, cited: Sequence[Failing]) -> str:
    return f"{MARK} scorer={scorer} sessions={','.join(each.adw_id for each in cited)} -->"


def cited_in(texts: Sequence[str]) -> set[str]:
    """The sessions the factory's marks in `texts` say were cited already."""
    return {adw_id for text in texts for found in _MARK.finditer(text or "")
            for adw_id in found["sessions"].split(",") if adw_id}


def title(scorer: "Scorer", seen: Window) -> str:
    return f"Self-improvement: scorer {scorer.name} failed on {seen.said()}"


def issue_body(cfg: FactoryConfig, scorer: "Scorer", seen: Window) -> str:
    """The whole case, standing on its own: the pattern, the scorer's criteria,
    and each failing score with the events it cites."""
    threshold = seen.threshold
    whose = ("its own `improve_after:`" if scorer.spec.improve_after
             else "`self_improvement:` in `asf/factory.yaml`")
    return _bounded("\n".join([
        mark(scorer.name, seen.failing),
        f"The scorer **{scorer.name}** failed on {seen.said()}. This factory files an "
        f"issue at {threshold.failures} of the last {threshold.of_last} ({whose}).",
        "",
        "A score never changed how its chapter ended: a scorer measures, a gate decides. "
        "This is the pattern, for a person to judge. It is worked by the "
        f"`{WORKFLOW}` workflow like any other issue, and nothing in the factory or the "
        "application changes until a person approves its plan and merges its pull request.",
        "",
        "## The scorer's criteria",
        "",
        *_criteria(scorer),
        "",
        "## The failing scores",
        "",
        *_failing(cfg, seen.failing),
    ]))


def comment_body(cfg: FactoryConfig, scorer: "Scorer", seen: Window,
                 new: Sequence[Failing]) -> str:
    return _bounded("\n".join([
        mark(scorer.name, new),
        f"New evidence: the scorer **{scorer.name}** has now failed on {seen.said()}.",
        "",
        *_failing(cfg, new),
    ]))


def _criteria(scorer: "Scorer") -> list[str]:
    spec = scorer.spec
    classes = ", ".join(f"`{each.name}`" + (" (failing)" if each.fail else "")
                        for each in scorer.classes)
    told = [f"From `{'/'.join(scorer.path.parts[-4:])}`:", "",       # asf/scorers/<name>/…
            f"- **Workflow:** `{spec.workflow}`" + (f", focused on `{spec.focus}`"
                                                   if spec.focus else ""),
            f"- **Kind:** {spec.kind}" + (f", `{spec.predicate}`" if spec.predicate else ""),
            f"- **Classes:** {classes}"]
    prose = scorer.criteria.strip()
    if prose:
        told += ["", *(f"> {line}".rstrip() for line in prose.splitlines())]
    return told


def _failing(cfg: FactoryConfig, failing: Sequence[Failing]) -> list[str]:
    told: list[str] = []
    for session in failing:
        told += [f"### Session `{session.adw_id}`", "",
                 f"Its record: `{cfg.data_dir}/sessions/{session.adw_id}/events.jsonl`, on the "
                 f"station that ran it.", ""]
        for score in session.scores:
            payload = score.payload
            told.append(f"- **Chapter {payload.get('chapter')}:** `{payload.get('class')}` "
                        f"(failing), scored at seq {score.seq}")
            if payload.get("reasoning"):
                told += [f"  > {line}".rstrip()
                         for line in str(payload["reasoning"]).strip().splitlines()]
            evidence = [int(seq) for seq in payload.get("evidence") or []]
            for seq in evidence[:CITED_PER_CHAPTER]:
                told.append(f"  - {_cited(session.lines.get(seq), seq)}")
            if len(evidence) > CITED_PER_CHAPTER:
                told.append(f"  - …and {len(evidence) - CITED_PER_CHAPTER} more, in its record")
            if not evidence:
                told.append("  - it cites no event")
        told.append("")
    return told


def _cited(line: EventLine | None, seq: int) -> str:
    if line is None:
        return f"seq {seq} · not in the record"
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
    console of the run that ended the chapter, or `asf score`'s output."""

    cfg: FactoryConfig
    main_root: Path
    say: Callable[[str], None]


def consider(cfg: FactoryConfig, main_root: Path, failed: Sequence["Scorer"],
             say: Callable[[str], None]) -> None:
    """After `failed` each recorded a failing score: file an issue for each
    one that has reached its threshold, or add the new evidence to the one
    that is open. Never raises."""
    if not failed:
        return
    if not cfg.issues.enabled:
        say("self-improvement files on the tracker, and `issues.enabled` is false in "
            "factory.yaml — nothing is filed")
        return
    filing = Filing(cfg, Path(main_root), say)
    for scorer in failed:
        try:
            _consider(filing, scorer)
        except Exception as error:          # noqa: BLE001 — see the docstring
            say(f"self-improvement for scorer {scorer.name} filed nothing: {error}")


def _consider(filing: Filing, scorer: "Scorer") -> None:
    cfg, say = filing.cfg, filing.say
    threshold = threshold_of(cfg, scorer)
    seen = window(artifacts.sessions_root(filing.main_root, cfg.data_dir), scorer.name,
                  threshold)
    if not seen.met:
        say(f"scorer {scorer.name} failed on {seen.said()}; an issue is filed at "
            f"{threshold.failures} of the last {threshold.of_last}")
        return
    label = labels.improving(scorer.name)
    try:
        open_ = issues.labelled(filing.main_root, cfg.issues, label.name, "number,body,comments")
    except RuntimeError as error:
        say(f"scorer {scorer.name} failed on {seen.said()}, and filed nothing: could not "
            f"search the tracker for {label.name} ({error})")
        return
    if open_:
        _add_to(filing, scorer, seen, open_[0])
        return
    if not cfg.issues.create_command:
        say(f"scorer {scorer.name} failed on {seen.said()}, and no issue is filed: "
            f"`issues.create_command` is empty")
        return
    labels.define(cfg, filing.main_root, label)     # one that already exists stays as it is
    queued = queue_labels(cfg)
    result = issues.create(filing.main_root, cfg.issues, NewIssue(
        title=title(scorer, seen), body=issue_body(cfg, scorer, seen),
        labels=[label.name, *queued]))
    if not result.ok:
        say(f"scorer {scorer.name} failed on {seen.said()}, and the issue was not filed: "
            f"{'; '.join(result.notes)}")
        return
    say(f"scorer {scorer.name} failed on {seen.said()}: filed #{result.number} ({label.name})"
        + (f", queued for the {WORKFLOW} workflow" if queued else
           f" — no route label takes an issue to the {WORKFLOW} workflow, so it is not queued"))


def _add_to(filing: Filing, scorer: "Scorer", seen: Window, issue: dict) -> None:
    """Comment on the open `issue` with the failing sessions it does not cite yet."""
    number = int(issue.get("number") or 0)
    texts = [str(issue.get("body") or "")] + [str((each or {}).get("body") or "")
                                              for each in issue.get("comments") or []]
    cited = cited_in(texts)
    new = [each for each in seen.failing if each.adw_id not in cited]
    if not new:
        filing.say(f"scorer {scorer.name} failed on {seen.said()}; #{number} already cites them")
        return
    result = issues.comment(filing.main_root, filing.cfg.issues, IssueUpdate(
        number=number, comment=comment_body(filing.cfg, scorer, seen, new)))
    filing.say(f"scorer {scorer.name} failed on {seen.said()}: "
               + (f"added {len(new)} session(s) to #{number}" if result.ok else
                  f"could not add them to #{number}: {'; '.join(result.notes)}"))

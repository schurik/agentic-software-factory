"""The labels this config names, and whether the forge has heard of them.

WHY THIS EXISTS. `issues.route`, `issues.states`, `issues.refined_label` and
`pull_requests.states.failed` are all names the factory will eventually add to
an item, and a tracker answers that with an error when nothing ever defined
the name. Both halves of that fail quietly until the moment they cost something:

  * an undefined ROUTE label cannot be applied by anybody, so the workflow
    behind it can never be triggered. It looks configured and is inert.
  * an undefined `refined_label` kills a `refine` run at its LAST write, after
    every question round has been paid for.
  * an undefined `pull_requests.states.failed` means a red review run cannot
    leave its stop-mark, so the condition that launched it survives and the
    next poll buys the same failing run again.

`watch.stale_states()` already says this out loud for the removing side ("on a
name the repository never defined is an error, and it would fail the claim it
rides on"). This module is the other half.

THE SET IS DERIVED, NEVER WRITTEN DOWN. The labels grew from three to nine
across two releases and nothing noticed, because every one of them was a name
in the config and none of them was a name in a checklist. `referenced()` reads
the resolved config, so the next added label is checked by having been added.

Nothing here is on a run's path: `preflight.labels` puts it in `doctor`, which
is where a network round-trip belongs, and `operate.labels` is the command that
acts on the answer. A run that is about to apply a label does NOT ask first —
one round-trip per claim, to learn something that changes about twice a year.
"""

from __future__ import annotations

from pathlib import Path

from . import forge
from .data_types import FactoryConfig, IssueResult, Label, LabelSurvey
from .forge import ForgeError
from .issues import resolve_project

# What each role LOOKS like on the page, for the person who finds the label on a
# work item months later. The factory only ever matches on the name; everything
# below this line is for a human reading a tracker — and, for `route`, `queued`
# and `running`, for a cockpit: it finds the labels that trigger a workflow on
# the forge by these descriptions, and an issue a run already has by the third,
# so changing any of them is a change to a contract (`tests/golden/labels/`,
# read by both ends).
ROLES: dict[str, tuple[str, str]] = {
    "route":   ("5319e7", "asf route: a person asked for the {detail} workflow here"),
    "queued":  ("ededed", "asf: waiting for a watcher to claim it"),
    "running": ("1d76db", "asf: a run has this one"),
    "done":    ("0e8a16", "asf: a run finished it"),
    "failed":  ("b60205", "asf: the last run ended red"),
    "refined": ("c2e0c6", "asf: requirements were settled with a person; "
                          "survives re-queueing"),
    "pr-failed": ("b60205", "asf: a pr-review run ended red; remove this label to let "
                            "the watcher retry"),
    "improve": ("d4c5f9", "asf self-improvement: the scorer {detail} keeps failing; "
                          "one open issue per scorer"),
}

# One per scorer, so not a name the config holds: `improving` makes it, and
# self-improvement defines it the first time it files (`engine/improve.py`).
IMPROVE_PREFIX = "asf:improve:"


def _label(name: str, role: str, detail: str = "") -> Label:
    color, why = ROLES[role]
    return Label(name=name, color=color, why=why.format(detail=detail), role=role)


def improving(scorer: str) -> Label:
    """The label on a scorer's self-improvement issue — how a station finds
    the one that is open, whichever station filed it (ADR 0006)."""
    return _label(f"{IMPROVE_PREFIX}{scorer}", "improve", scorer)


def improved_by(names: list[str]) -> str:
    """The scorer an issue carrying `names` is the self-improvement issue of,
    by its `improving` label; "" for any other issue. What a session that
    works it records (`provenance_recorded.improves`)."""
    return next((name.removeprefix(IMPROVE_PREFIX) for name in names
                 if name.startswith(IMPROVE_PREFIX) and name != IMPROVE_PREFIX), "")


def referenced(cfg: FactoryConfig) -> list[Label]:
    """Every label name this config will try to apply, in reading order.

    Only for the paths that are ON: a repository with both watchers off applies
    no labels, and telling it about nine it does not need is noise. Duplicates
    collapse to their first mention — nothing stops a config from spelling the
    route and a state the same, and defining it twice would fail the second time.
    A name BLANKED OUT in the config is how a repo says it does not want that
    mark, and an empty string is not a label anything can define.
    """
    found: list[Label] = []
    if cfg.issues.enabled:
        for name, workflow in cfg.issues.route.items():
            found.append(_label(name, "route", workflow))
        states = cfg.issues.states
        for role in ("queued", "running", "done", "failed"):
            found.append(_label(getattr(states, role), role))
        found.append(_label(cfg.issues.refined_label, "refined"))
    if cfg.pull_requests.enabled:
        found.append(_label(cfg.pull_requests.states.failed, "pr-failed"))
    kept: list[Label] = []
    seen: set[str] = set()
    for label in found:
        if label.name and label.name not in seen:
            seen.add(label.name)
            kept.append(label)
    return kept


def survey(cfg: FactoryConfig, main_root: Path) -> LabelSurvey:
    """What the config names, what the forge defines, and whether we could ask.

    `asked=False` is a real answer and not a failure: there is no remote, no
    auth, no network. A tracker that does not define labels at all is the
    third answer, `applicable=False`. Every caller has to distinguish it from "the forge defines nothing",
    because reporting nine missing labels to somebody on a plane is a confident
    wrong answer that costs them an afternoon.
    """
    found = LabelSurvey(referenced=referenced(cfg))
    if not found.referenced:
        found.applicable = False
        found.note = "no path that applies labels is enabled"
        return found
    try:
        defined = forge.tracker_of(cfg).labels(main_root, resolve_project(cfg.issues, main_root))
    except ForgeError as error:
        found.note = str(error)[-300:]
        return found
    if defined is None:
        found.applicable = False
        found.note = f"the {cfg.tracker} tracker does not define labels"
        return found
    found.defined = defined
    found.asked = True
    return found


def define(cfg: FactoryConfig, main_root: Path, label: Label) -> IssueResult:
    """Define ONE label at the forge. Adds; never edits and never deletes.

    An existing label is left exactly as it is — its colour and description may
    have been set by a person on purpose, and redefining it would quietly
    overwrite that. Callers only pass what `survey().missing` returned.

    Returns an `IssueResult` although no issue is involved: it is this package's
    shape for "what a tracker write actually did — evidence, never a claim", and
    `labels_changed` is literally the field. A second result type for one call
    site would say nothing the first one does not.
    """
    result = IssueResult()
    try:
        forge.tracker_of(cfg).define_label(main_root, resolve_project(cfg.issues, main_root),
                                           label)
    except ForgeError as error:
        result.notes.append(str(error))
        return result
    result.ok = True
    result.labels_changed = [label.name]
    result.notes.append(f"defined {label.name}")
    return result

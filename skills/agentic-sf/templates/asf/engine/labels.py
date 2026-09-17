"""The labels this config names, and whether the forge has heard of them.

WHY THIS EXISTS. `issues.route`, `issues.states`, `issues.refined_label` and
`pull_requests.states.failed` are all names the factory will eventually hand to
`--add-label`, and a forge answers that with an error when nothing ever defined
the name. Both halves of that fail quietly until the moment they cost something:

  * an undefined ROUTE label cannot be applied by anybody, so the workflow
    behind it can never be triggered. It looks configured and is inert.
  * an undefined `refined_label` kills a `refine` run at its LAST write, after
    every question round has been paid for.
  * an undefined `pull_requests.states.failed` means a red review run cannot
    leave its stop-mark, so the condition that launched it survives and the
    next poll buys the same failing run again.

`watch.stale_states()` already says this out loud for the `--remove-label` side
("on a name the repository never defined is an error, and it would fail the
claim it rides on"). This module is the other half.

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

import json
import subprocess
from pathlib import Path

from .data_types import FactoryConfig, IssueResult, Label, LabelSurvey
from .issues import resolve_project
from .utils import operator_env

# `gh label list` answers 30 at a time unless told otherwise, and a repository
# with a real taxonomy has more than that. A truncated listing would report
# labels as missing and then try to create ones that already exist.
LIST_LIMIT = "500"

# What each role LOOKS like on the page, for the person who finds the label on a
# work item months later. The factory only ever matches on the name; everything
# below this line is for a human reading a tracker.
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
}


def _label(name: str, role: str, detail: str = "") -> Label:
    color, why = ROLES[role]
    return Label(name=name, color=color, why=why.format(detail=detail), role=role)


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


def _run(argv: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """As everywhere else on a forge path: never raises, and runs under the
    operator's environment rather than the ephemeral venv `uv run` hands us."""
    return subprocess.run(argv, cwd=str(cwd), env=operator_env(),
                          capture_output=True, text=True)


def survey(cfg: FactoryConfig, main_root: Path) -> LabelSurvey:
    """What the config names, what the forge defines, and whether we could ask.

    `asked=False` is a real answer and not a failure: there is no remote, no
    auth, no network, or the tracker does not define labels with a command at
    all. Every caller has to distinguish it from "the forge defines nothing",
    because reporting nine missing labels to somebody on a plane is a confident
    wrong answer that costs them an afternoon.
    """
    found = LabelSurvey(referenced=referenced(cfg))
    command = cfg.issues.labels_list_command
    if not found.referenced or not command:
        found.applicable = False
        found.note = ("no issues.labels_list_command is configured — this tracker does "
                      "not define labels that way" if found.referenced else
                      "no path that applies labels is enabled")
        return found

    project = resolve_project(cfg.issues, main_root)
    argv = [*command, *(["--repo", project] if project else []),
            "--limit", LIST_LIMIT, "--json", "name"]
    completed = _run(argv, main_root)
    if completed.returncode != 0:
        found.note = (f"`{' '.join(command)}` failed: "
                      f"{(completed.stderr or completed.stdout).strip()[-300:]}")
        return found
    try:
        payload = json.loads(completed.stdout or "[]")
    except json.JSONDecodeError as error:
        found.note = f"`{' '.join(command)}` did not return JSON: {error}"
        return found
    found.defined = [entry.get("name", "") for entry in payload if isinstance(entry, dict)]
    found.asked = True
    return found


def define(cfg: FactoryConfig, main_root: Path, label: Label) -> IssueResult:
    """Define ONE label at the forge. Adds; never edits and never deletes.

    An existing label is left exactly as it is — its colour and description may
    have been set by a person on purpose, and `--force` would quietly overwrite
    that. Callers only pass what `survey().missing` returned.

    Returns an `IssueResult` although no issue is involved: it is this package's
    shape for "what a tracker write actually did — evidence, never a claim", and
    `labels_changed` is literally the field. A second result type for one call
    site would say nothing the first one does not.
    """
    result = IssueResult()
    command = cfg.issues.labels_create_command
    if not command:
        result.notes.append("no labels_create_command is configured")
        return result
    project = resolve_project(cfg.issues, main_root)
    argv = [*command, label.name, *(["--repo", project] if project else []),
            "--color", label.color, "--description", label.why]
    completed = _run(argv, main_root)
    if completed.returncode != 0:
        result.notes.append(f"{label.name}: "
                            f"{(completed.stderr or completed.stdout).strip()[-300:]}")
        return result
    result.ok = True
    result.labels_changed = [label.name]
    result.notes.append(f"defined {label.name}")
    return result

"""Onboarding: where a repository stands between "stamped" and "running", as code.

`asf onboard` prints the steps in the order they have to be taken, each with
what the evidence says and what to do next, and the first one not done is
where the agent picks up — in this session, or in one a week later, after
somebody stopped halfway. The order is the point. The factory has to be
committed and on the forge's DEFAULT BRANCH before a cockpit is chosen,
because a cockpit lists only factories whose default branch holds
`asf/factory.yaml`: a station registered before that has a code to approve and
a Stations tab nobody can find.

Every step is DONE BY EVIDENCE: git says whether the factory is committed and
on the default branch, `.env` says which cockpit, the kept station token says
whether this checkout is registered, the forge says whether the labels exist,
the session directory says whether anything ran. So the checklist cannot claim
a step that is not so, and nothing has to remember to tick it. Three
decisions leave no trace — the settings walked with a person, a local cockpit
chosen, the CI check declined — and only those are recorded, by `--mark`, in
`<data_dir>/onboarding.json` (`OnboardingRecord`). It is gitignored with the
rest of the runtime: a teammate's fresh clone reads the shared steps off the
forge, and records its own decisions in its own checkout.

Nothing here changes the repository. It reads, fetches the default branch,
and keeps the record: a decision when told to, and when onboarding started and
finished, so the skill can offer to pick it up again.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Callable

from . import git_helper, preflight, station
from .data_types import (FactoryConfig, Finding, OnboardingMark, OnboardingProgress,
                         OnboardingRecord, OnboardingStep)
from .utils import anchor, now_iso, write_atomic

RECORD = "onboarding.json"
CI_WORKFLOW = ".github/workflows/asf-check.yml"
# What `install.py` stamps outside `asf/`; each is committed when it exists.
STAMPED = ("asf", "justfile", "asf.justfile", ".gitignore", ".env.sample", CI_WORKFLOW)
# What `--mark` may record, and the values each takes ("" = none).
MARKS = {"settings": ("",), "cockpit": ("local", "team"), "ci": ("declined",)}

COOKBOOK = "<skill>/cookbooks"


@dataclass
class _Here:
    """What the steps read, each asked once and only when a step needs it."""

    cfg: FactoryConfig
    root: Path
    doctor: Callable[[FactoryConfig, Path], list[Finding]]
    record: OnboardingRecord = field(default_factory=OnboardingRecord)
    fetched: bool = False           # whether `default` could bring the branch up to date

    @property
    def remote(self) -> str:
        return self.cfg.worktree.integration.remote

    @cached_property
    def findings(self) -> list[Finding]:
        return self.doctor(self.cfg, self.root)

    @cached_property
    def default(self) -> str:
        if not git_helper.has_remote(self.root, self.remote):
            return ""
        branch = git_helper.default_branch(self.root, self.remote)
        if branch:
            self.fetched = git_helper.fetch(self.root, self.remote, branch)
        return branch

    def on_default(self, path: str) -> bool:
        """Whether the remote's default branch holds `path`."""
        if not self.default:
            return False
        ref = f"{self.remote}/{self.default}:{path}"
        return subprocess.run(["git", "cat-file", "-e", ref], cwd=self.root,
                              capture_output=True).returncode == 0

    def mark(self, step: str) -> str | None:
        held = self.record.marks.get(step)
        return None if held is None else held.value


# ── the steps, in the order they are taken ───────────────────────────────────

def _installed(here: _Here) -> tuple[bool, str, str]:
    return True, "asf/factory.yaml", ""


def _ready(here: _Here) -> tuple[bool, str, str]:
    fatal = [finding for finding in here.findings if finding.level == "fatal"]
    if fatal:
        return (False, f"{len(fatal)} fatal: {', '.join(finding.check for finding in fatal)}",
                "`just doctor` names each with its fix (cookbooks/install.md#post-install-checklist)")
    warned = sum(1 for finding in here.findings if finding.level == "warn")
    return True, f"{warned} warning(s), in `just doctor`" if warned else "", ""


def _settings(here: _Here) -> tuple[bool, str, str]:
    if here.mark("settings") is not None:
        return True, f"walked {here.record.marks['settings'].at[:10]}", ""
    if here.on_default("asf/factory.yaml"):
        return True, f"decided before this checkout: the factory is on {here.default}", ""
    return (False, "asf/factory.yaml holds the stamped defaults",
            f"walk them with the person, each with the question tool "
            f"({COOKBOOK}/install.md#the-factorys-settings), then `just onboard --mark settings`")


def _committed(here: _Here) -> tuple[bool, str, str]:
    paths = [name for name in STAMPED if (here.root / name).exists()]
    status = subprocess.run(["git", "status", "--porcelain", "--", *paths], cwd=here.root,
                            capture_output=True, text=True).stdout.splitlines()
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", "asf/factory.yaml"],
                             cwd=here.root, capture_output=True).returncode == 0
    if status or not tracked:
        return (False, f"{len(status)} file(s) of the factory are not committed",
                "commit the factory — ask with the question tool before you do "
                f"({COOKBOOK}/onboard.md#3-commit-and-publish-the-factory)")
    return True, "the factory is committed", ""


def _published(here: _Here) -> tuple[bool, str, str]:
    how = (f"push it to the default branch, or open a pull request and merge it — a cockpit "
           f"lists only factories its default branch holds "
           f"({COOKBOOK}/onboard.md#3-commit-and-publish-the-factory)")
    if not git_helper.has_remote(here.root, here.remote):
        return False, f"no remote `{here.remote}`", f"add the repository's remote, then {how}"
    if not here.default:
        return False, f"could not tell {here.remote}'s default branch", how
    tip = f"{here.remote}/{here.default}"
    stale = "" if here.fetched else f" (could not fetch {tip}: going by what this checkout saw)"
    if not here.on_default("asf/factory.yaml"):
        return False, f"{tip} does not hold asf/factory.yaml{stale}", how
    unpublished = subprocess.run(["git", "log", "--format=%h", f"{tip}..HEAD", "--", "asf"],
                                 cwd=here.root, capture_output=True, text=True).stdout.split()
    same = subprocess.run(["git", "diff", "--quiet", tip, "HEAD", "--", "asf"],
                          cwd=here.root).returncode == 0
    if unpublished and not same:
        return False, f"{len(unpublished)} commit(s) to asf/ are not on {tip}{stale}", how
    return True, f"on {tip}", ""


def _cockpit(here: _Here) -> tuple[bool, str, str]:
    shared = station.configured(anchor(here.root, here.cfg.data_dir))
    if shared is not None:
        return True, f"the team's: {shared.url}", ""
    chosen = here.mark("cockpit")
    if chosen == "local":
        return True, "local — `just up` starts it on this machine", ""
    how = (f"ask which, with the question tool ({COOKBOOK}/connect_cockpit.md#local-or-shared); "
           f"local: `just onboard --mark cockpit=local`; the team's: ASF_COCKPIT_URL in .env")
    if chosen == "team":
        return False, "the team's, and ASF_COCKPIT_URL is not set", how
    return False, "not chosen", how


def _connected(here: _Here) -> tuple[bool, str, str]:
    shared = station.configured(anchor(here.root, here.cfg.data_dir))
    if shared is None and here.mark("cockpit") == "local":
        return True, "a local cockpit's station is its owner's: nothing to register", ""
    if shared is None:
        return False, "no cockpit chosen yet", "choose one first (the step above)"
    held = station.credential(here.root, here.cfg.data_dir)
    if held is not None and held.cockpit == shared.url:
        return True, f"registered, approved by {held.owner or 'someone'}", ""
    return (False, f"this checkout is not registered with {shared.url}",
            f"`just station-register`; a person with write approves it in the cockpit "
            f"({COOKBOOK}/connect_cockpit.md#once-per-repository-checkout)")


def _ci(here: _Here) -> tuple[bool, str, str]:
    team = station.configured(anchor(here.root, here.cfg.data_dir)) is not None
    if here.on_default(CI_WORKFLOW):
        aside = (" — its two settings are a person's to store: vars.ASF_COCKPIT_URL and "
                 "secrets.ASF_COCKPIT_TOKEN" if team else "")
        return True, f"{CI_WORKFLOW} is on {here.default}{aside}", ""
    if not team and here.mark("ci") == "declined":
        return True, "declined — the repository's call, with only a local cockpit", ""
    stamped = (here.root / CI_WORKFLOW).exists()
    detail = (f"{CI_WORKFLOW} is stamped and not yet on {here.default or 'the default branch'}"
              if stamped else f"no {CI_WORKFLOW}")
    if team:
        return (False, detail, f"a team cockpit brings it: stamp it with `install.py --ci`, say "
                               f"why, commit and publish it ({COOKBOOK}/connect_cockpit.md#ci)")
    return (False, detail, f"ask whether to stamp it, with the question tool "
                           f"({COOKBOOK}/install.md#run-it); declined: "
                           f"`just onboard --mark ci=declined`")


def _labels(here: _Here) -> tuple[bool, str, str] | None:
    if not (here.cfg.issues.enabled or here.cfg.pull_requests.enabled):
        return None
    found = [finding for finding in here.findings if finding.check == "forge labels"]
    if not found:
        return None
    if found[0].level != "ok":
        return False, found[0].detail, f"`just labels --create` — {found[0].fix}"
    return True, found[0].detail, ""


def _first_run(here: _Here) -> tuple[bool, str, str]:
    sessions = anchor(here.root, here.cfg.data_dir) / "sessions"
    ran = [path for path in sessions.glob("*/run.json")] if sessions.is_dir() else []
    if ran:
        return True, f"{len(ran)} session(s) recorded", ""
    return False, "nothing has run yet", f"`just do \"<prompt>\"` ({COOKBOOK}/run_workflow.md)"


STEPS: tuple[tuple[str, str, Callable[[_Here], tuple[bool, str, str] | None]], ...] = (
    ("installed", "the factory is stamped", _installed),
    ("ready", "doctor finds nothing fatal", _ready),
    ("settings", "the person decided the factory's settings", _settings),
    ("committed", "the factory is committed", _committed),
    ("published", "the factory is on the default branch at the forge", _published),
    ("cockpit", "a cockpit is chosen: local, or the team's", _cockpit),
    ("connected", "this checkout is connected to it", _connected),
    ("ci", "the CI check is on the default branch, or declined", _ci),
    ("labels", "the labels the tracker routes by exist", _labels),
    ("first_run", "a first run", _first_run),
)


# ── reading and recording ────────────────────────────────────────────────────

def record_path(cfg: FactoryConfig, root: Path) -> Path:
    return anchor(root, cfg.data_dir) / RECORD


def recorded(cfg: FactoryConfig, root: Path) -> OnboardingRecord:
    path = record_path(cfg, root)
    try:
        return OnboardingRecord.model_validate_json(path.read_text())
    except (OSError, ValueError):
        return OnboardingRecord()


def mark(cfg: FactoryConfig, root: Path, spoken: str) -> OnboardingRecord:
    """Record `step` or `step=value`; refused unless `MARKS` names it."""
    step, _, value = spoken.partition("=")
    if step not in MARKS or value not in MARKS[step]:
        allowed = ", ".join(f"{name}={v}" if v else name
                            for name, values in MARKS.items() for v in values)
        raise SystemExit(f"--mark {spoken!r}: one of {allowed}")
    held = recorded(cfg, root)
    held.marks[step] = OnboardingMark(value=value, at=now_iso())
    _keep(cfg, root, held)
    return held


def forget(cfg: FactoryConfig, root: Path, step: str) -> None:
    held = recorded(cfg, root)
    if held.marks.pop(step, None) is not None:
        _keep(cfg, root, held)


def _keep(cfg: FactoryConfig, root: Path, held: OnboardingRecord) -> None:
    path = record_path(cfg, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(path, held.model_dump_json(indent=2) + "\n")


def progress(cfg: FactoryConfig, root: Path,
             doctor: Callable[[FactoryConfig, Path], list[Finding]] = preflight.everything
             ) -> OnboardingProgress:
    """Every step, judged by its evidence, and the first one not done — and
    the record told when onboarding started, and whether it is finished."""
    here = _Here(cfg=cfg, root=root, doctor=doctor, record=recorded(cfg, root))
    steps, upcoming = [], ""
    for name, title, judge in STEPS:
        judged = judge(here)
        if judged is None:
            steps.append(OnboardingStep(step=name, title=title, state="skipped",
                                        detail="nothing in this config uses it"))
            continue
        done, detail, how = judged
        state = "done" if done else ("next" if not upcoming else "todo")
        if state == "next":
            upcoming = name
        steps.append(OnboardingStep(step=name, title=title, state=state, detail=detail, how=how))
    held = here.record.model_copy(deep=True)
    held.started = held.started or now_iso()
    held.finished = "" if upcoming else (held.finished or now_iso())
    if held != here.record:
        _keep(cfg, root, held)
    return OnboardingProgress(steps=steps, next=upcoming)


MARK_OF = {"done": "✓", "next": "→", "todo": "·", "skipped": "-"}


def show(progress_: OnboardingProgress, root: Path) -> str:
    done = sum(1 for step in progress_.steps if step.state == "done")
    counted = sum(1 for step in progress_.steps if step.state != "skipped")
    width = max(len(step.step) for step in progress_.steps)
    lines = [f"asf onboard — {root}   {done} of {counted} done", ""]
    for step in progress_.steps:
        lines.append(f"  {MARK_OF[step.state]} {step.step.ljust(width)}  {step.title}"
                     + (f" — {step.detail}" if step.detail else ""))
        if step.state == "next" and step.how:
            lines.append(f"    {' ' * width}  → {step.how}")
    lines.append("")
    if progress_.next:
        lines.append(f"next: {progress_.next}")
    else:
        lines.append("onboarded: every step is done")
    return "\n".join(lines)


def dumps(progress_: OnboardingProgress) -> str:
    return json.dumps(progress_.model_dump(mode="json"), indent=2) + "\n"

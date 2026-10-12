"""Benchmarks: past sessions' requests, pinned, to be worked again under variants.

    asf/benchmarks/<name>.yaml      tasks, variants, repetitions — committed

A BENCHMARK (`CONTEXT.md`) lists TASKS — each a past session of this station,
its request and the commit it started from — and two or more VARIANTS, each a
git ref of the factory's files with a label, so that models, prose, task files
and options all vary the same way: by being committed. Each task is worked
`repetitions` times per variant (default 3), which is what lets a reader tell
a difference from the run-to-run noise. A benchmark names no winner: a person
reads the difference and decides.

The definition is a file a person commits and reviews like code, and this
module only reads and writes it. `asf benchmark new --from-scorer <s>` seeds
one (`seed`): the sessions the scorer cited as failing — the ones its open
self-improvement issue cites (`improve.cited`), else the window
self-improvement counts now (`improve.window`) — and the two newest it judged
passing, as controls: a change is tested on the failures it is meant to fix
and on work it must not break. Its variants default to the default branch and
the scorer's open self-improvement pull request's branch, found from the
station's own records, as `improve.merged` finds a merge. It never overwrites a
definition: one that exists is the team's.

`load` is what `asf check` refuses a benchmark with: a session this station
has no record of — a benchmark is worked from its source sessions' records,
whose decisions answer its gates — a ref or commit that does not resolve here,
or fewer than two variants. A CI checkout holds no session's record and only
the commit it checked out, so there (`station.kind`) a benchmark's shape is
checked and its sessions and refs are not: the station that runs it checks
them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING

import yaml
from pydantic import ValidationError

from . import artifacts, events, git_helper, improve, station
from .data_types import (BenchmarkSpec, BenchmarkTask, BenchmarkVariant, FactoryConfig,
                         ProvenanceRecorded, PullRequestClosed, PullRequestOpened, SessionStarted)

from .utils import write_atomic

if TYPE_CHECKING:
    from .scorers import Scorer

BENCHMARKS_DIR = "benchmarks"
SUFFIX = ".yaml"
CONTROLS = 2                    # passing sessions pinned beside the failures
VARIANTS = 2                    # the fewest a benchmark compares
_NAME = re.compile(r"[a-z0-9][a-z0-9_-]*")


@dataclass
class Benchmark:
    name: str
    path: Path
    spec: BenchmarkSpec

    @property
    def variants(self) -> list[BenchmarkVariant]:
        """Its variants, each labelled — by the ref itself where it gave none."""
        return [BenchmarkVariant(ref=each.ref, label=each.label or each.ref)
                for each in self.spec.variants]


@dataclass
class Refused:
    """A benchmark `check` refused, and every reason it gave."""

    name: str
    path: Path
    error: str


def directory(factory_root: Path) -> Path:
    return Path(factory_root) / BENCHMARKS_DIR


def said(benchmark: Benchmark) -> str:
    """One line of what it compares: `4 tasks × 2 variants (main, PR #9) × 3`."""
    spec = benchmark.spec
    return (f"{len(spec.tasks)} tasks × {len(spec.variants)} variants "
            f"({', '.join(each.label for each in benchmark.variants)}) × {spec.repetitions}")


def on_record() -> bool:
    """Whether this checkout holds the records a benchmark's sessions and refs
    are checked against: a station's does, a CI job's does not."""
    return station.kind() != "ci"


def resolve(main_root: Path, ref: str, remote: str) -> str:
    """The commit `ref` names here — as given, else as `remote`'s branch of
    that name, which is where a pull request's branch may only be — or ""."""
    for each in (ref, f"refs/remotes/{remote}/{ref}"):
        if git_helper.ref_exists(main_root, each):
            return git_helper.rev(main_root, f"{each}^{{commit}}")
    return ""


# ── loaded and checked ───────────────────────────────────────────────────────

def load(factory_root: Path, cfg: FactoryConfig,
         main_root: Path) -> tuple[list[Benchmark], list[Refused]]:
    """Every benchmark under `asf/benchmarks/`: the ones that hold, and the
    ones refused with why."""
    home = directory(factory_root)
    if not home.is_dir():
        return [], []
    found, refused = [], []
    for path in sorted(home.glob(f"*{SUFFIX}")):
        try:
            raw = yaml.safe_load(path.read_text())
        except (OSError, yaml.YAMLError) as error:
            refused.append(Refused(path.stem, path, f"cannot be read: {error}"))
            continue
        if not isinstance(raw, dict):
            refused.append(Refused(path.stem, path, "is not a mapping of tasks, variants and "
                                                    "repetitions"))
            continue
        try:
            spec = BenchmarkSpec.model_validate(raw)
        except ValidationError as error:
            refused.append(Refused(path.stem, path, _flat(error)))
            continue
        benchmark = Benchmark(path.stem, path, spec)
        problems = _problems(benchmark, cfg, Path(main_root))
        if problems:
            refused.append(Refused(path.stem, path, "; ".join(problems)))
        else:
            found.append(benchmark)
    return found, refused


def _problems(benchmark: Benchmark, cfg: FactoryConfig, main_root: Path) -> list[str]:
    spec, problems = benchmark.spec, []
    if not spec.tasks:
        problems.append("pins no task — a benchmark works past sessions' requests again")
    if len(spec.variants) < VARIANTS:
        problems.append(f"names {len(spec.variants)} variant(s) — a benchmark compares two or "
                        f"more variants, each a git ref")
    # One ref twice is a fair comparison (of the noise alone); one label for
    # two variants is not one a reader can tell apart.
    for what, values in (("pins session", [task.session for task in spec.tasks]),
                         ("labels a variant", [each.label for each in benchmark.variants])):
        twice = sorted({value for value in values if values.count(value) > 1})
        if twice:
            problems.append(f"{what} {', '.join(twice)} twice")
    if not on_record():
        return problems
    sessions = artifacts.sessions_root(main_root, cfg.data_dir)
    remote = cfg.worktree.integration.remote
    for task in spec.tasks:
        if not (sessions / task.session / events.EVENTS_FILE).is_file():
            problems.append(f"session {task.session} is not on this station's record "
                            f"({cfg.data_dir}/sessions/{task.session}) — a task is worked from "
                            f"its source session's record")
        if not git_helper.ref_exists(main_root, task.commit):
            problems.append(f"commit {task.commit} of session {task.session} does not resolve "
                            f"here")
    for variant in spec.variants:
        if not resolve(main_root, variant.ref, remote):
            problems.append(f"variant ref {variant.ref} does not resolve here, nor as "
                            f"{remote}/{variant.ref}")
    return problems


def _flat(error: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(part) for part in each['loc']) or 'benchmark'}: "
                     f"{each['msg']}" for each in error.errors())


# ── seeded from a scorer: `asf benchmark new --from-scorer` ─────────────────

@dataclass
class Pinned:
    """A task, and why it was pinned: `failing: …` or `control: …`."""

    task: BenchmarkTask
    why: str


@dataclass
class Seed:
    """What `asf benchmark new` was asked for."""

    name: str
    scorer: "Scorer"
    variants: list[str]             # `ref` or `ref=label`; none = the defaults
    repetitions: int = 3


def seed(cfg: FactoryConfig, main_root: Path, factory_root: Path, asked: Seed) -> Path:
    """Write `asf/benchmarks/<name>.yaml` from what the scorer cited, and
    return its path. Refuses (SystemExit) before writing anything when the
    file exists, the scorer cited no failing session, or fewer than two
    variants would be named."""
    if not _NAME.fullmatch(asked.name):
        raise SystemExit(f"benchmark name {asked.name!r}: lowercase letters, digits, - and _")
    if asked.repetitions < 1:
        raise SystemExit(f"--repetitions {asked.repetitions}: each task is worked at least once")
    path = directory(factory_root) / f"{asked.name}{SUFFIX}"
    if path.exists():
        raise SystemExit(f"{path} already exists — a benchmark is the team's once written; "
                         f"edit it, or name another")
    scorer = asked.scorer
    sessions = artifacts.sessions_root(main_root, cfg.data_dir)
    variants = ([_variant(each) for each in asked.variants] if asked.variants
                else default_variants(cfg, main_root, sessions, scorer.name))
    if len(variants) < VARIANTS:
        raise SystemExit(
            f"a benchmark compares two or more variants, and scorer {scorer.name} has no open "
            f"self-improvement pull request on this station to compare {variants[0].ref} with "
            f"— name each with --variant <ref>[=<label>]")
    judged = {each.adw_id: each for each in improve.judged(sessions, scorer.name)}
    pinned = [Pinned(task, why) for adw_id, why in failures(cfg, sessions, scorer, judged)
              if (task := _pinned(sessions, adw_id))]
    if not pinned:
        raise SystemExit(f"scorer {scorer.name} cited no failing session this station can pin "
                         f"— nothing to benchmark a change against")
    taken = {each.task.session for each in pinned}
    controls = []
    for adw_id, each in judged.items():
        if len(controls) == CONTROLS:
            break
        if adw_id not in taken and not each.failing and (task := _pinned(sessions, adw_id)):
            classes = sorted({str(score.payload.get("class")) for score in each.latest.values()})
            controls.append(Pinned(task, "control: " + ", ".join(classes)))
    text = render(asked, pinned + controls, variants)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(path, text)
    print(f"wrote {path}: {len(pinned)} session(s) scorer {scorer.name} cited as failing and "
          f"{len(controls)} it judged passing, as controls — each worked {asked.repetitions} "
          f"time(s) under {', '.join(each.label for each in variants)}")
    if len(controls) < CONTROLS:
        print(f"  only {len(controls)} passing session{'' if len(controls) == 1 else 's'} "
              f"{scorer.name} judged to pin as a control: a change is not tested on work it "
              f"must not break until there are more")
    return path


def failures(cfg: FactoryConfig, sessions: Path, scorer: "Scorer",
             judged: dict[str, improve.Judged]) -> list[tuple[str, str]]:
    """The failing sessions the scorer cited, newest first, each with why it
    is pinned: the ones its open self-improvement issue cites — what that
    issue's pull request was written to fix, however the window has moved
    since — else the ones its window counts now."""
    number, issue_cites = improve.cited(sessions, scorer.name)
    if not number:
        counted = improve.window(sessions, scorer.name, scorer.threshold(cfg))
        return [(each.adw_id, "failing: " + _classes(each.scores)) for each in counted.failing]
    found = []
    for adw_id in issue_cites:
        scores = judged[adw_id].failing if adw_id in judged else []
        found.append((adw_id, f"failing: cited by #{number}"
                      + (f", {_classes(scores)}" if scores else "")))
    return found


def _classes(scores: list) -> str:
    return ", ".join(str(score.payload.get("class")) for score in scores)


def _variant(spoken: str) -> BenchmarkVariant:
    ref, _, label = spoken.partition("=")
    if not ref.strip():
        raise SystemExit(f"--variant {spoken!r} names no ref: --variant <ref>[=<label>]")
    return BenchmarkVariant(ref=ref.strip(), label=label.strip() or ref.strip())


def default_variants(cfg: FactoryConfig, main_root: Path, sessions: Path,
                     scorer: str) -> list[BenchmarkVariant]:
    """The default branch — the factory's `base_ref`, else the remote's
    default, else what the main checkout has out — and the branch of the
    scorer's open self-improvement pull request, when there is one."""
    remote = cfg.worktree.integration.remote
    base = (cfg.worktree.base_ref or git_helper.default_branch(main_root, remote)
            or git_helper.current_branch(main_root))
    variants = [BenchmarkVariant(ref=base, label=base)]
    opened = open_improvement(sessions, scorer)
    if opened is not None:
        branch, number = opened
        variants.append(BenchmarkVariant(ref=branch, label=f"PR #{number}" if number else branch))
    return variants


def open_improvement(sessions: Path, scorer: str) -> tuple[str, int] | None:
    """The branch and number of the newest pull request a session working
    `scorer`'s self-improvement issue opened and that has not closed, read off
    the events alone — None when there is none."""
    newest: tuple[str, tuple[str, int]] | None = None
    unclosed = {adw_id: state for adw_id, state in artifacts.scan(sessions).items()
                if not state.pr_state}
    for adw_id, state, lines in improve.improving(sessions, scorer, unclosed):
        kinds = {line.kind for line in lines}
        if PullRequestClosed.KIND in kinds or PullRequestOpened.KIND not in kinds:
            continue
        branch = next((str(line.payload.get("branch")) for line in lines
                       if line.kind == SessionStarted.KIND and line.payload.get("branch")), "")
        number = next(int(line.payload.get("number") or 0) for line in reversed(lines)
                      if line.kind == PullRequestOpened.KIND)
        if branch and (newest is None or state.started_at > newest[0]):
            newest = (state.started_at, (branch, number))
    return newest[1] if newest else None


def _pinned(sessions: Path, adw_id: str) -> BenchmarkTask | None:
    """`_task`, saying why a session it cannot pin is left out."""
    task = _task(sessions, adw_id)
    if task is None:
        print(f"  session {adw_id} is not pinned: its record names no commit it started from")
    return task


def _task(sessions: Path, adw_id: str) -> BenchmarkTask | None:
    """The session's request and the commit it started from, off its record;
    None for one that never said what it was cut from."""
    lines = events.read(Path(sessions) / adw_id)
    started = [line.payload for line in lines if line.kind == SessionStarted.KIND]
    commit = next((str(each.get("base_commit")) for each in started if each.get("base_commit")),
                  "")
    if not commit:
        return None
    learned = [str(line.payload.get("request")) for line in lines
               if line.kind == ProvenanceRecorded.KIND and line.payload.get("request")]
    request = next((str(each.get("request")) for each in started if each.get("request")),
                   learned[-1] if learned else "")
    return BenchmarkTask(session=adw_id, request=request, commit=commit)


def render(asked: Seed, pinned: list[Pinned], variants: list[BenchmarkVariant]) -> str:
    """The definition as a person reviews it: why each task is there, as a
    comment above it."""
    text = [f"# Benchmark {asked.name}, seeded on {date.today()} by",
            f"# `asf benchmark new --from-scorer {asked.scorer.name}`: the sessions that scorer",
            "# cited as failing, then passing ones as controls. Each task is worked",
            "# `repetitions` times per variant, and no run declares a winner.",
            "# Commit it; `asf check` checks it.",
            "tasks:"]
    for each in pinned:
        text.append(f"  # {each.why}")
        dumped = yaml.safe_dump([each.task.model_dump()], sort_keys=False, allow_unicode=True,
                                width=100)
        text += [f"  {line}" for line in dumped.splitlines()]
    text.append(yaml.safe_dump({"variants": [each.model_dump() for each in variants],
                                "repetitions": asked.repetitions},
                               sort_keys=False, allow_unicode=True).rstrip())
    return "\n".join(text) + "\n"

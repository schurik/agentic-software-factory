"""A benchmark's session: one task of a benchmark, worked again under one variant.

`asf benchmark run` (`engine/benchmarks.py`) launches each one as an ordinary
`asf run`, with what it re-works in the environment (`BENCHMARK_ENV`); the
session takes `trigger: benchmark`, says what it re-works on its
`session_started`, and keeps it in its `run.json`, so a later process of it —
a resume — is held to the same rules without being told again (`adopt`).

What makes it a measurement and not work (`CONTEXT.md`, Benchmark):

  * **It starts where its source started.** Its branch is cut from the commit
    the task pins, and it works the source's request — an issue's text as the
    source read it (`inputs.open_recorded_issue`), never the issue as it reads
    now.
  * **Nothing of it leaves the machine.** It is never published
    (`Workspace.isolated`), never integrated (`integration.integrate`), and
    never reported on the tracker or asked about there; it takes no claim.
    A push from its process is refused outright (`git_helper.push`), whatever
    a variant's stage asks for.
  * **Its gates are answered as its source's were.** A gate a person answered
    in the source session gets that person's verdict and words, round by
    round (`hitl.decide`); one no person answered there — a gate the variant
    adds, or a round the source never reached — has no answer to give, and the
    session stops as NOT COMPARABLE: what came after it would be a comparison
    with nothing.
  * **It is measurement.** Its spend is the measurement budget's
    (`engine/measurement.py`), it is scored by the station's own scorers once
    it ends, and no self-improvement window counts it (`improve.judged`).
"""

from __future__ import annotations

import os
from pathlib import Path

from . import artifacts, events
from .data_types import BenchmarkSession, FactoryConfig, RunState, WorkflowFinished

BENCHMARK_ENV = "ASF_BENCHMARK"     # the launcher saying which task, variant and repetition
TRIGGER = "benchmark"
# How the reason starts, on its `workflow_finished` and `session_finished`, when a
# session cannot be compared.
NOT_COMPARABLE = "not comparable"


class NotComparable(SystemExit):
    """The session cannot go on and still be compared: a person's answer it
    needs was never given in the session it re-works. Raised inside the phase
    that needed it, so the phase fails and the session ends with the reason —
    `NOT_COMPARABLE` first, which is how its outcome is told from a refusal."""

    def __init__(self, why: str):
        super().__init__(f"{NOT_COMPARABLE}: {why}")


def asked() -> BenchmarkSession | None:
    """What this process was launched to re-work, or None for any other run."""
    text = os.environ.get(BENCHMARK_ENV, "").strip()
    return BenchmarkSession.model_validate_json(text) if text else None


def of(cfg: FactoryConfig, main_root: Path, adw_id: str | None) -> BenchmarkSession | None:
    """What session `adw_id` re-works, as its record says — else as this
    process was launched to — or None for any other run."""
    if adw_id:
        state = artifacts.read_run(artifacts.sessions_root(main_root, cfg.data_dir) / adw_id)
        if state is not None and state.benchmark is not None:
            return state.benchmark
    return asked()


def adopt(benchmark: BenchmarkSession) -> None:
    """Hold this process — and whatever it starts — to being `benchmark`'s
    session: a resumed process learns it from the record, and says it here."""
    os.environ[BENCHMARK_ENV] = benchmark.model_dump_json()


def isolated() -> bool:
    """Whether this process works a benchmark's session, and must not reach out."""
    return bool(os.environ.get(BENCHMARK_ENV, "").strip())


def environment(benchmark: BenchmarkSession) -> dict[str, str]:
    """What the launcher adds to a session's environment."""
    return {BENCHMARK_ENV: benchmark.model_dump_json()}


def source_dir(run) -> Path:
    """The record of the session `run` re-works, on this station."""
    return artifacts.sessions_root(run.main_root, run.cfg.data_dir) / run.benchmark.task


def source_state(run) -> RunState | None:
    return artifacts.read_run(source_dir(run))


def outcome(session_dir: Path) -> str:
    """How a benchmark's session ended, in words: accepted | not accepted |
    not comparable | failed — or running, while it has not ended. Read off how
    its last chapter finished: whether its workflow accepted it, and why not."""
    state = artifacts.read_run(session_dir)
    if state is None or state.status not in ("success", "fail"):
        return "running"
    if state.status == "success":
        return "accepted"
    finished = [line.payload for line in events.read(session_dir)
                if line.kind == WorkflowFinished.KIND]
    last = finished[-1] if finished else {}
    if str(last.get("reason") or "").startswith(NOT_COMPARABLE):
        return NOT_COMPARABLE
    return "not accepted" if last.get("accepted") is False else "failed"

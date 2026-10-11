"""The measurement budget: what measuring the factory's own work may spend in a
day (`measurement: {usd_per_day: 5}` in factory.yaml, ADR 0006).

One budget pays for judges and benchmarks, apart from the work's `budget:`,
and it is checked before every judge call (`engine/scorers.py`). What
measuring spent is read off the records it left — each judge's own run, kept
inside the session it judged under `judges/` (`engine/judge.py`), with when it
started and what it cost — never off a ledger of its own: the session
directory is the record (invariant 2). A judge that gave no score was paid
for all the same, and counts.

A day is a UTC day, as every timestamp the factory writes is. Two processes
judging at once may both find budget left; what bounds an overrun is that no
judge STARTS once the day's spend has reached the budget.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import artifacts
from .data_types import FactoryConfig
from .judge import JUDGES_DIR
from .utils import utc


@dataclass(frozen=True)
class Day:
    """One UTC day's measurement: what it spent, and what it may."""

    day: str                        # YYYY-MM-DD
    spent: float                    # USD
    budget: float                   # USD, measurement.usd_per_day

    @property
    def spent_out(self) -> bool:
        """Whether no further judge may start today."""
        return self.spent >= self.budget


def today(cfg: FactoryConfig, main_root: Path) -> Day:
    """The measurement of the UTC day it is now."""
    day = _utc_day(datetime.now(timezone.utc))
    sessions = artifacts.sessions_root(main_root, cfg.data_dir)
    return Day(day=day, spent=round(spent_on(sessions, day), 6),
               budget=cfg.measurement.usd_per_day)


def spent_on(sessions_dir: Path, day: str) -> float:
    """What every judge that started on `day` (UTC) cost, in USD."""
    total = 0.0
    for record in Path(sessions_dir).glob(f"*/{JUDGES_DIR}/*"):
        state = artifacts.read_run(record)
        if state is not None and _day_of(state.started_at) == day:
            total += state.total_cost
    return total


def _day_of(started_at: str) -> str:
    try:
        return _utc_day(datetime.fromisoformat(started_at))
    except ValueError:
        return ""


def _utc_day(moment: datetime) -> str:
    """YYYY-MM-DD of `moment` in UTC; a naive moment is read as UTC already."""
    return utc(moment).astimezone(timezone.utc).date().isoformat()

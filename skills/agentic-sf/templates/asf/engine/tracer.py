"""Tracer: every event lands in the session's `events.jsonl` AS IT HAPPENS.

`Tracer.event` takes a typed domain event and appends it through
`engine/events.py` — the record a station ships to a cockpit. That is all it
does. There is no second copy: the session directory is the record, and every
question about what a session did is answered from it, through
`engine/artifacts.py`.

That is not tidiness, it is portability: a cockpit receives the events, and
nothing on this machine has to be queried for a run to know what it did. A run
works on a checkout with nothing under `data_dir` but its own session.
"""

from __future__ import annotations

from pathlib import Path

from . import events
from .data_types import DomainEvent
from .utils import ensure_dir


class Tracer:
    def __init__(self, session_dir: str | Path):
        self.session_dir = ensure_dir(Path(session_dir))

    def event(self, event: DomainEvent) -> int:
        """A typed domain event, onto the session's `events.jsonl`. Returns its seq."""
        return events.emit(self.session_dir, event)

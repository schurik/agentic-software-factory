"""A session's domain events: one writer, one reader, one file.

`<session_dir>/events.jsonl` holds one typed fact per line, `{seq, ts, kind,
v, payload}` — the payload models, and the rule for changing one, are in
`data_types.py` under "Domain events". It is what a station ships to a cockpit,
so it is a contract with a reader this factory never meets, not a log.

`seq` counts from 1 per session with no gaps, and it has to hold across
PROCESSES, not just threads: a run polling for an answer at its terminal and an
`asf answer` from another terminal both write to the same session at once. So
every append takes an exclusive `flock` on the file, reads the last seq off its
tail, and writes the next line under that lock. A shipper resumes from the last
seq a cockpit acknowledged, which only works if a seq means one line forever.

Appended, never rewritten (see `utils.write_atomic` for everything else in a
session directory). A writer killed mid-line leaves a torn last line; the next
append starts on a fresh line rather than finishing someone else's, and every
reader skips what does not parse.

Lines written before this format existed (`{"event_id", "type", ...}`) may sit
at the top of a session that an older factory started. They carry no seq, are
skipped here, and `artifacts._phase_outcomes` still reads them.
"""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
from typing import Optional

from .data_types import EVENT_KINDS, DomainEvent, EventLine
from .utils import ensure_dir, now_iso

EVENTS_FILE = "events.jsonl"
_TAIL_CHUNK = 64 * 1024


def path(session_dir: str | Path) -> Path:
    return Path(session_dir) / EVENTS_FILE


def emit(session_dir: str | Path, event: DomainEvent) -> int:
    """Append `event` to the session's log and return the seq it was given."""
    target = path(ensure_dir(Path(session_dir)))
    with open(target, "a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            seq, torn = _last_seq(stream)
            line = EventLine(seq=seq + 1, ts=now_iso(), kind=event.KIND, v=event.VERSION,
                             payload=event.model_dump(mode="json"))
            text = line.model_dump_json() + "\n"
            stream.write((("\n" if torn else "") + text).encode())
            stream.flush()
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)
    return seq + 1


def read(session_dir: str | Path) -> list[EventLine]:
    """Every well-formed line of the session's log, in order. [] when there is none."""
    source = path(session_dir)
    if not source.is_file():
        return []
    found = []
    with source.open() as stream:
        for raw in stream:
            line = _parse(raw)
            if line is not None:
                found.append(line)
    return found


def payload(line: EventLine) -> Optional[DomainEvent]:
    """The line's payload as its model — None for a kind or version this factory
    does not write. A reader of old sessions skips those rather than guessing."""
    model = EVENT_KINDS.get(line.kind)
    if model is None or model.VERSION != line.v:
        return None
    return model.model_validate(line.payload)


def _parse(raw: str | bytes) -> Optional[EventLine]:
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or "seq" not in data or "kind" not in data:
        return None
    try:
        return EventLine.model_validate(data)
    except ValueError:
        return None


def _last_seq(stream) -> tuple[int, bool]:
    """(the last seq written, whether the file ends mid-line), read off the tail.

    Backwards a chunk at a time, widening until a well-formed line turns up, so
    a 30 KB command tail on the last line costs one more read rather than a
    scan of the whole session.
    """
    size = stream.seek(0, os.SEEK_END)
    if size == 0:
        return 0, False
    stream.seek(size - 1)
    torn = stream.read(1) != b"\n"
    window = _TAIL_CHUNK
    while True:
        start = max(0, size - window)
        stream.seek(start)
        lines = stream.read(size - start).split(b"\n")
        if start > 0:
            lines = lines[1:]            # the first piece is the middle of a line
        for raw in reversed(lines):
            line = _parse(raw) if raw.strip() else None
            if line is not None:
                return line.seq, torn
        if start == 0:
            return 0, torn
        window *= 4

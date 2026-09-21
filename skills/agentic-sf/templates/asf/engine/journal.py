"""The run's record of itself: what each phase did, and what the agents learned.

`remarks.py` carries what a PERSON said to a run. This carries what the RUN
found out about its own work, and it exists for the mirror-image failure. The
plan names a library; the builder discovers it is not on the index, picks
another one, and builds something that works. Three phases later the reviewer
measures that build against the plan, finds an import the plan never mentions
and no reason for it, and sends the builder back to use a package that does not
exist. Nobody was wrong: the reviewer was reading the only spec it had.

So a run keeps a journal, and two kinds of line go into it:

  * A PHASE closing, written by `Run.phase` — what ran, who owned it, how it
    went. This is the progress half: an agent joining at `review` can see that
    `verify_1` went red and `fix_1` followed, without being told.
  * A NOTE, declared by an agent on its envelope (`for_the_record`) and lifted
    off it BY CODE once the envelope is accepted (`agents.execute`). The agent
    proposes the note; nothing lets it write the journal itself. A note typed
    `deviation` cannot be filed without saying what it departed from and why —
    `data_types.Note` refuses it at parse time, which re-prompts the same
    session the way any malformed envelope does.

Both are appended to every agent prompt rendered afterwards, and mirrored to
`<context_handoff_dir>/journal.md` so a person — and any agent that would
rather read a file than a prompt section — can open the run's story in one
place.

Keyed, not appended blindly: a resumed process re-walks phases it already
walked, and its entries must land on their old rows rather than beside them.

Files only. `<session_dir>/journal.json` is the record; the trace db mirrors
the same phases and nothing here reads it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .data_types import EnvelopeBase, JournalEntry, Note
from .utils import now_iso

LEDGER = "journal.json"
RENDERED = "journal.md"

# The frame around the journal in every prompt that carries it. The second
# paragraph is the one this module exists for.
PREAMBLE = (
    "## What this run has done so far\n"
    "\n"
    "The factory wrote this as each phase closed. The notes in it were filed by the\n"
    "agent that learned them, on the envelope it was accepted on — so a line here is\n"
    "something that actually happened, not somebody's plan for it.\n"
    "\n"
    "Read the deviations before you judge anything against a plan or a request. A\n"
    "deviation is a departure somebody already made, with the reason they made it: it\n"
    "is a decision, not a defect, and the plan is the thing that is out of date. Rule\n"
    "on what the deviation did, and say so if the reason does not hold — but do not\n"
    "report the departure itself as unrequested work or ask for it to be undone\n"
    "because the plan does not mention it.\n"
)

MARK = {"deviation": "deviation", "discovery": "discovery", "risk": "risk"}


def path(session_dir: str | Path) -> Path:
    return Path(session_dir) / LEDGER


def load(session_dir: str | Path) -> list[JournalEntry]:
    """Every entry this session has filed, in the order the run made them.

    A half-written or hand-mangled ledger reads as an empty journal rather than
    killing a run: the journal is an addition to a prompt, and a run that
    cannot read it is the run everyone had before this file existed.
    """
    ledger = path(session_dir)
    if not ledger.is_file():
        return []
    try:
        raw = json.loads(ledger.read_text())
    except (ValueError, OSError):
        return []
    found = []
    for entry in raw if isinstance(raw, list) else []:
        try:
            found.append(JournalEntry(**entry))
        except (TypeError, ValueError):
            continue
    return found


def _write(session_dir: str | Path, entries: list[JournalEntry],
           handoff_dir: Optional[Path] = None) -> None:
    ledger = path(session_dir)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(json.dumps([e.model_dump() for e in entries], indent=2))
    if handoff_dir is not None:
        # The same content, as the file a person opens. Rewritten whole every
        # time rather than appended to, so it can never disagree with the
        # ledger it is a view of.
        handoff_dir.mkdir(parents=True, exist_ok=True)
        (handoff_dir / RENDERED).write_text(render(entries) or f"{PREAMBLE}\n(nothing yet)\n")


def file(session_dir: str | Path, entry: JournalEntry,
         handoff_dir: Optional[Path] = None) -> None:
    """Add one entry, or update the one this phase already filed.

    Ordered by `seq` and then by arrival, so a resumed run that rewrites its
    third phase's line leaves it third.
    """
    if not entry.at:
        entry.at = now_iso()
    entries = load(session_dir)
    for index, existing in enumerate(entries):
        if existing.key == entry.key:
            entries[index] = entry
            break
    else:
        entries.append(entry)
    entries.sort(key=lambda e: e.seq)
    _write(session_dir, entries, handoff_dir)


def record_phase(run, phase, envelope: Optional[EnvelopeBase] = None,
                 said: str = "") -> None:
    """One line for a phase that just closed. Called by `Run.phase`, nowhere else.

    An agent phase describes itself with its envelope's summary; a code phase
    with whatever it logged, which is how "verify_1 · quality · success" comes
    to say whether the suite was actually green.
    """
    file(run.session_dir, JournalEntry(
        seq=phase.seq, kind="phase", phase=phase.params.name, by=phase.params.owner,
        status=phase.status, summary=(envelope.summary if envelope else "") or said),
        handoff_dir=run.context_handoff_dir)


def record_notes(run, phase, agent: str, notes: list[Note]) -> int:
    """Lift an accepted envelope's notes into the journal. Code, never the agent.

    Returns how many were filed, so the caller can say so on the console: a
    deviation nobody mentions out loud is one an engineer finds in a diff.
    """
    for note in notes:
        file(run.session_dir, JournalEntry(
            seq=phase.seq, kind="note", phase=phase.params.name, by=agent, note=note),
            handoff_dir=run.context_handoff_dir)
    return len(notes)


def line(entry: JournalEntry) -> str:
    """One entry as the journal prints it — a phase row, or a note under one."""
    if entry.kind == "phase":
        head = f"{entry.seq}. {entry.phase} · {entry.by or '—'} · {entry.status or 'running'}"
        return f"{head} — {entry.summary}" if entry.summary else head
    note = entry.note
    assert note is not None
    parts = [f"   ⚑ {MARK.get(note.kind, note.kind)} ({entry.by}, in {entry.phase}): "
             f"{note.what}"]
    if note.instead_of:
        parts.append(f"     instead of: {note.instead_of}")
    if note.because:
        parts.append(f"     because: {note.because}")
    return "\n".join(parts)


def render(entries: list[JournalEntry]) -> str:
    """The block a prompt carries, or "" while the run has done nothing yet."""
    if not entries:
        return ""
    return PREAMBLE + "\n" + "\n".join(line(entry) for entry in entries) + "\n"


def deviations(session_dir: str | Path) -> list[JournalEntry]:
    """Only the departures, for anyone who wants them without the progress."""
    return [e for e in load(session_dir)
            if e.kind == "note" and e.note is not None and e.note.kind == "deviation"]

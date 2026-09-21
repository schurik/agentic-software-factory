"""One record of what a run did, in the order it did it, read by every agent after.

The bug this exists for has two halves, and they are the same bug from opposite
directions: an agent late in a workflow judges work against a spec that has
since moved, because nothing carried the move forward.

  * A person approves the plan and asks for one more thing in the same breath.
    The builder reads it off `notes_for_next_agent` and builds it. The reviewer
    two phases later measures that build against a plan nobody amended, calls
    the extra work unrequested, and sends the builder back to take it out.
  * The plan names a library. The builder finds it is not on the index, uses
    another one, and ships something that works. The reviewer finds an import
    the plan never mentions and no reason for it, and sends the builder back to
    use a package that does not exist.

Both were once two mechanisms here. They are one, because a remark and a
deviation are the same kind of thing to the agent that has to read them — a
fact about this run that is later than the plan — and because a remark HAPPENS
somewhere: at the `approve_<gate>` phase, between the plan and the build. Put
it on the timeline and the causality is visible without anyone explaining it.

Three kinds of line go in:

  * A PHASE closing, written by `Run.phase` — what ran, who owned it, how it
    went. This is the progress half: an agent joining at `review` can see that
    `verify_1` went red and `fix_1` followed, without being told.
  * A NOTE, declared by an agent on its envelope (`for_the_record`) and lifted
    off it BY CODE once the envelope is accepted (`agents.execute`). The agent
    proposes; nothing lets it write the journal itself. A note typed
    `deviation` cannot be filed without saying what it departed from and why —
    `data_types.Note` refuses it at parse time, which re-prompts the same
    session the way any malformed envelope does.
  * A REMARK, what a person typed beside a verdict, filed by `hitl._consume` —
    the one funnel every taken decision passes, so the terminal, `asf approve
    -m`, a reply on the work item and a replay under `--resume` are all covered
    by recording in one place.

WHAT SEPARATES THEM IS AUTHORITY, and that is what the preamble spends its
words on rather than the code: a note is a REPORT and may be judged, a remark
is an INSTRUCTION and may not. One list, two markers, one rule each.

The whole thing is appended to every agent prompt rendered afterwards, and
mirrored to `<context_handoff_dir>/journal.md` so a person — and any agent that
would rather read a file than a prompt section — can open the run's story in
one place.

Keyed, not appended blindly: a resumed process re-walks phases it already
walked, and its entries must land on their old rows rather than beside them.

Files only. `<session_dir>/journal.json` is the record; the trace db mirrors
the same phases and decisions, and nothing here reads it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .data_types import EnvelopeBase, JournalEntry, Note, Remark
from .utils import now_iso

LEDGER = "journal.json"
RENDERED = "journal.md"

NOTE_MARK = "⚑"
REMARK_MARK = "✎"

# The frame around the journal in every prompt that carries it. Both marker
# paragraphs are load-bearing, and they say opposite things on purpose.
PREAMBLE = (
    "## This run so far\n"
    "\n"
    "The factory wrote this as the run went. Each numbered line is a phase that closed;\n"
    "the marked lines under one are what came out of it. Nothing here is a plan — it is\n"
    "what already happened, and it is later than the plan.\n"
    "\n"
    f"{NOTE_MARK} is a note an agent filed on work that was then accepted: a `deviation`,\n"
    "a `discovery` or a `risk`. It is a REPORT. Judge it like any other claim, and say\n"
    "so if the reason does not hold. But a deviation is a departure somebody already\n"
    "made, with the reason they made it — the plan is the thing that is out of date, so\n"
    "do not report the departure itself as unrequested work, and do not ask for it to be\n"
    "undone because no plan mentions it.\n"
    "\n"
    f"{REMARK_MARK} is something a PERSON typed at a gate or a question round. It is not a\n"
    "report, it is an INSTRUCTION: it amends the request, it is later than the request\n"
    "and the plan both, and where they disagree it wins. Work it asks for is in scope\n"
    "even where no plan mentions it, and an agent that already acted on one did what it\n"
    "was told — that work is not yours to take back out.\n"
)

WHERE = {"gate": "gate", "questions": "question round"}


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

    Sorted by phase number and then by `rank`, so a resumed run that rewrites
    its third phase's line leaves it third — and so what came out of a phase
    prints under that phase rather than above it.
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
    entries.sort(key=lambda e: (e.seq, e.rank))
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


def record_remark(run, phase, remark: Remark, by: str, at: str = "") -> None:
    """What a person said at this phase's gate. Called by `hitl._consume`."""
    file(run.session_dir, JournalEntry(
        seq=phase.seq, kind="remark", phase=phase.params.name, by=by or "someone",
        at=at, remark=remark), handoff_dir=run.context_handoff_dir)


def line(entry: JournalEntry) -> str:
    """One entry as the journal prints it — a phase row, or what came out of one."""
    if entry.kind == "phase":
        head = f"{entry.seq}. {entry.phase} · {entry.by or '—'} · {entry.status or 'running'}"
        return f"{head} — {entry.summary}" if entry.summary else head
    if entry.note is not None:
        note = entry.note
        parts = [f"   {NOTE_MARK} {note.kind} ({entry.by}, in {entry.phase}): {note.what}"]
        if note.instead_of:
            parts.append(f"     instead of: {note.instead_of}")
        if note.because:
            parts.append(f"     because: {note.because}")
        return "\n".join(parts)
    remark = entry.remark
    assert remark is not None
    where = WHERE.get(remark.kind, remark.kind)
    return (f"   {REMARK_MARK} {entry.by} said, {remark.verdict} at the {remark.gate} "
            f"{where} (round {remark.round}): {remark.text}")


def render(entries: list[JournalEntry]) -> str:
    """The block a prompt carries, or "" while the run has done nothing yet."""
    if not entries:
        return ""
    return PREAMBLE + "\n" + "\n".join(line(entry) for entry in entries) + "\n"


def deviations(session_dir: str | Path) -> list[JournalEntry]:
    """Only the departures, for anyone who wants them without the progress."""
    return [e for e in load(session_dir)
            if e.kind == "note" and e.note is not None and e.note.kind == "deviation"]


def remarks(session_dir: str | Path) -> list[JournalEntry]:
    """Only what people said — what `asf show` prints back to the next person."""
    return [e for e in load(session_dir) if e.kind == "remark"]

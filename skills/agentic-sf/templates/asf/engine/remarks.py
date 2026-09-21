"""What a person said to this run, carried to every agent that comes after.

A gate takes a verdict. What somebody types BESIDE that verdict is a different
kind of thing: almost always an amendment to the request — "approve, and while
you are in there, give status a --json flag". `hitl.gated()` hands those words
to the NEXT agent, on `notes_for_next_agent`, and there they stop. The builder
reads them and builds what they ask for; the reviewer two phases later measures
that build against a plan nobody amended, finds work the plan does not mention,
and sends the builder back to take it out again. The person is then asked to
approve the removal of the thing they asked for.

So a remark is not a handoff. It is a STANDING amendment to the request: said
once, kept in the session's own directory, and appended to EVERY agent prompt
the run renders afterwards — beside the prompt, because that is what it is. Who
said it, at which gate and with which verdict travel with it, since where a
sentence came from decides how much of it to believe.

Two properties are load-bearing:

  * Keyed by (kind, gate, round), so a resumed run re-walking a round it
    already walked overwrites its own remark instead of filing a second copy.
  * Appended by `agents.execute` after the task file is rendered, not through a
    `{{placeholder}}`. A task file that forgot to ask for it would be a task
    file that silently drops what a person said — and a remark's own words
    never get read as a placeholder.

Files only: `<session_dir>/remarks.json`. The trace db mirrors the decisions
these come from; nothing here reads it.
"""

from __future__ import annotations

import json
from pathlib import Path

from .data_types import Remark

LEDGER = "remarks.json"

# The frame around the remarks in every prompt that carries them. It says three
# things, and the third is the one this module exists for: a remark outranks
# the plan, work a remark asked for is IN SCOPE, and an agent that already
# acted on one was doing as it was told.
PREAMBLE = (
    "## What a person said to this run\n"
    "\n"
    "Everything below was typed by a human at one of this run's gates or question\n"
    "rounds, beside the verdict that let the run go on. It is part of the request,\n"
    "with the same standing as the prompt above and later than it: the person said\n"
    "it knowing what had been produced so far.\n"
    "\n"
    "Read it as instruction, not as background.\n"
    "\n"
    "- Where a remark and the original request, the requirements or the plan\n"
    "  disagree, the remark is the one somebody chose on purpose. It wins.\n"
    "- Work a remark asks for is IN SCOPE, even where no plan mentions it. An\n"
    "  earlier agent that acted on a remark did what it was told; do not rule that\n"
    "  work unrequested, out of scope or unplanned, and do not ask for it to be\n"
    "  taken back out.\n"
    "- A remark aimed at a phase that has already happened still tells you what the\n"
    "  person cares about. Honour it where your own phase can.\n"
)

WHERE = {"gate": "gate", "questions": "question round"}


def path(session_dir: str | Path) -> Path:
    return Path(session_dir) / LEDGER


def load(session_dir: str | Path) -> list[Remark]:
    """Every remark this session has heard, oldest first.

    A half-written or hand-mangled ledger reads as no remarks rather than
    killing a run: the remarks are an addition to a prompt, and a run that
    cannot read them is the run everyone had before this file existed.
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
            found.append(Remark(**entry))
        except (TypeError, ValueError):
            continue
    return found


def record(session_dir: str | Path, remark: Remark) -> Path:
    """Add one remark, or replace the one this round already filed.

    Keyed the way decisions are keyed, and for the same reason: a round is a
    round however many processes walk it. Order is the order remarks were first
    heard in, which is the order a person said them in.
    """
    ledger = path(session_dir)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    kept = load(session_dir)
    key = (remark.kind, remark.gate, remark.round)
    replaced = False
    for index, existing in enumerate(kept):
        if (existing.kind, existing.gate, existing.round) == key:
            kept[index] = remark
            replaced = True
            break
    if not replaced:
        kept.append(remark)
    ledger.write_text(json.dumps([r.model_dump() for r in kept], indent=2))
    return ledger


def heading(remark: Remark) -> str:
    """One line naming where a remark came from — the provenance, not the words."""
    who = remark.by or "someone"
    where = WHERE.get(remark.kind, remark.kind)
    stamp = f" · {remark.at}" if remark.at else ""
    channel = f" · {remark.channel}" if remark.channel else ""
    return (f"### {remark.gate} {where}, round {remark.round} — "
            f"{remark.verdict} by {who}{channel}{stamp}")


def render(remarks: list[Remark]) -> str:
    """The block a prompt carries, or "" when nobody has said anything yet."""
    if not remarks:
        return ""
    blocks = [PREAMBLE]
    for remark in remarks:
        blocks.append(f"{heading(remark)}\n\n{remark.text.strip()}")
    return "\n\n".join(blocks).rstrip() + "\n"

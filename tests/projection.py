"""Rebuild a session's files from its domain events — the projection test's reference.

Written from the events' own meaning, NOT by calling the engine's writers: a
projection that reused `artifacts.start_run` would agree with the files by
construction and prove nothing. This is the same job a cockpit does in
TypeScript, and the same rules it has to get right:

  * `run.json` — `session_started` opens (or re-opens) the record and carries
    forward what a session never unlearns; `provenance_recorded`, `usage`,
    `gate_opened`, `suspended`, a consumed `decision_recorded`,
    `session_finished` and — late, after it — `pull_request_closed` each
    change the fields they name.
  * `decisions/<gate>_<round>.json` — the last `decision_recorded` for that key.
  * `envelopes/<phase_id>.json` and `<agent>/envelope.json` — the last
    `envelope_accepted` per phase, and per agent.
  * `journal.json` — `journal_noted` entries, a later one replacing the entry
    with its key, ordered by phase and then the phase's own line first.

Everything is compared as parsed JSON: the files and the events are two
serialisations of the same values, and byte layout is not what either promises.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from engine import events
from engine.data_types import RunState


@dataclass
class Projection:
    run: Optional[dict] = None
    decisions: dict[str, dict] = field(default_factory=dict)
    envelopes: dict[str, dict] = field(default_factory=dict)
    agent_envelopes: dict[str, dict] = field(default_factory=dict)
    journal: list[dict] = field(default_factory=list)


LEARNED = ("trigger", "issue_url", "issue_number", "issue_project", "pr_url")


def replay(session_dir: Path) -> Projection:
    out = Projection()
    for line in events.read(session_dir):
        body = line.payload
        handler = _HANDLERS.get(line.kind)
        if handler is not None:
            handler(out, body)
    if out.run is not None:
        out.run = RunState(**out.run).model_dump()
    return out


def on_disk(session_dir: Path) -> Projection:
    """The same shapes, read off the files the factory wrote."""
    session_dir = Path(session_dir)
    out = Projection()
    run = session_dir / "run.json"
    if run.is_file():
        out.run = RunState(**json.loads(run.read_text())).model_dump()
    for path in sorted((session_dir / "decisions").glob("*.json")):
        out.decisions[path.stem] = json.loads(path.read_text())
    for path in sorted((session_dir / "envelopes").glob("*.json")):
        record = json.loads(path.read_text())
        record["payload"] = json.loads(record.pop("payload_json"))
        out.envelopes[path.stem] = record
    for path in sorted(session_dir.glob("*/envelope.json")):
        out.agent_envelopes[path.parent.name] = json.loads(path.read_text())
    journal = session_dir / "journal.json"
    if journal.is_file():
        out.journal = json.loads(journal.read_text())
    return out


# ── run.json ─────────────────────────────────────────────────────────────────

def _started(out: Projection, body: dict) -> None:
    previous = out.run
    run = {"adw_id": body["adw_id"], "workflows": [body["workflow"]],
           "command": body["command"], "pid": body["pid"], "engineer": body["engineer"],
           "status": "running", "started_at": body["started_at"], "ended_at": "",
           "repo_root": body["repo_root"], "branch": body["branch"],
           "trigger": body["trigger"], "triggered_by": body["triggered_by"],
           "issue_url": body["issue_url"],
           "pr_url": body["pr_url"], "pr_state": "", "issue_number": 0, "issue_project": "",
           "waiting_for": None, "total_tokens": 0, "total_cost": 0.0}
    if previous is not None:
        run["workflows"] = previous["workflows"] + [
            name for name in run["workflows"] if name not in previous["workflows"]]
        for key in LEARNED:
            run[key] = run[key] or previous[key]
        run["pr_state"] = previous["pr_state"]
        run["waiting_for"] = previous["waiting_for"]
        run["total_tokens"] = previous["total_tokens"]
        run["total_cost"] = previous["total_cost"]
    out.run = run


def _learn(out: Projection, fields: dict) -> None:
    if out.run is None:
        return
    for key, value in fields.items():
        if value:
            out.run[key] = value


def _provenance(out: Projection, body: dict) -> None:
    _learn(out, {key: body[key] for key in LEARNED})


def _usage(out: Projection, body: dict) -> None:
    _learn(out, {"total_tokens": body["session_tokens"], "total_cost": body["session_cost"]})


def _gate_opened(out: Projection, body: dict) -> None:
    _learn(out, {"waiting_for": body["waiting_for"]})


def _suspended(out: Projection, body: dict) -> None:
    if out.run is not None:
        out.run.update(status="waiting", waiting_for=body["waiting_for"], pid=0)


def _finished(out: Projection, body: dict) -> None:
    if out.run is not None:
        out.run.update(status=body["status"], ended_at=body["ended_at"])


def _pr_closed(out: Projection, body: dict) -> None:
    _learn(out, {"pr_state": "merged" if body["merged"] else "closed"})


# ── decisions, envelopes, journal ────────────────────────────────────────────

def _decision(out: Projection, body: dict) -> None:
    decision = body["decision"]
    out.decisions[f"{decision['gate']}_{decision['round']}"] = decision
    if body["consumed"] and out.run is not None:
        out.run["waiting_for"] = None


def _envelope(out: Projection, body: dict) -> None:
    out.envelopes[body["phase_id"]] = {
        "phase_id": body["phase_id"], "seq": body["seq"], "phase": body["phase"],
        "agent": body["agent"], "output_type": body["output_type"],
        "payload": body["envelope"]}
    out.agent_envelopes[body["agent"]] = {
        "agent_name": body["agent"], "purpose": body["purpose"],
        "output_type": body["output_type"], "attempt": body["attempt"], **body["envelope"]}


def _key(entry: dict) -> tuple:
    if entry.get("note"):
        body = f"{entry['note']['kind']}:{entry['note']['what']}"
    elif entry.get("remark"):
        remark = entry["remark"]
        body = f"{remark['gate']}:{remark['round']}:{remark['kind']}"
    else:
        body = ""
    return entry["kind"], entry["phase"], body


def _journal(out: Projection, body: dict) -> None:
    entry = body["entry"]
    for index, existing in enumerate(out.journal):
        if _key(existing) == _key(entry):
            out.journal[index] = entry
            break
    else:
        out.journal.append(entry)
    out.journal.sort(key=lambda e: (e["seq"], 0 if e["kind"] == "phase" else 1))


_HANDLERS = {
    "session_started": _started,
    "provenance_recorded": _provenance,
    "usage": _usage,
    "gate_opened": _gate_opened,
    "suspended": _suspended,
    "session_finished": _finished,
    "pull_request_closed": _pr_closed,
    "decision_recorded": _decision,
    "envelope_accepted": _envelope,
    "journal_noted": _journal,
}

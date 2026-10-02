"""Domain events: the wire a station ships, guarded from both ends.

Two seams, both from the cockpit spec (#40):

  * **The golden corpus** (`tests/golden/events/<kind>/v<N>.json`). One line
    per event kind and version, exactly as the factory writes it. The factory
    half asserts that the writer's output for the CURRENT version of every
    kind still matches its fixture; the cockpit half (later) parses every
    fixture ever checked in. A change to a kind therefore fails here until it
    bumps `VERSION` and adds a new fixture beside the old one — the old one
    stays, because a cockpit must keep reading it.
  * **The session directory and the events agree.** A fake-harness run writes
    `events.jsonl` whose every line validates against its model, and replaying
    those events (`tests/projection.py`, written independently of the engine's
    own writers) rebuilds `run.json`, the decisions, the envelopes and the
    journal exactly.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from engine import events
from engine.data_types import EVENT_KINDS, DomainEvent

from . import projection
from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster,
                          forge, forge_data, issue_json, run_state, session_dir, set_config,
                          wire, write_workflow)

GOLDEN = Path(__file__).resolve().parent / "golden" / "events"
FIXED_TS = "2026-09-29T12:00:00.000+00:00"


def plan_reply() -> dict:
    return {"writes": {"docs/asf/spec/plan.md": "# Plan\n"}, "tokens": 100, "cost": 0.01,
            "envelope": envelope(artifacts=["docs/asf/spec/plan.md"], commit_message="docs: plan")}


def build_reply(content: str, message: str) -> dict:
    return {"writes": {"app.py": content}, "tokens": 50, "cost": 0.02,
            "envelope": envelope(changed_files=["app.py"], commit_message=message)}


def fixture_path(kind: str, version: int) -> Path:
    return GOLDEN / kind / f"v{version}.json"


def written_line(tmp_path: Path, event: DomainEvent, monkeypatch) -> dict:
    """What the writer puts on disk for `event` as the first line of a session."""
    monkeypatch.setattr(events, "now_iso", lambda: FIXED_TS)
    session = tmp_path / "session"
    events.emit(session, event)
    lines = (session / events.EVENTS_FILE).read_text().splitlines()
    assert len(lines) == 1
    return json.loads(lines[0])


# ── the golden corpus ────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", sorted(EVENT_KINDS))
def test_the_writer_s_output_for_every_kind_matches_its_current_fixture(
        kind: str, tmp_path: Path, monkeypatch):
    model = EVENT_KINDS[kind]
    path = fixture_path(kind, model.VERSION)
    assert path.is_file(), (
        f"no golden fixture for {kind} v{model.VERSION} at {path.relative_to(GOLDEN.parent.parent)}"
        f" — a new kind or a new version adds one; an existing fixture is never edited")
    golden = json.loads(path.read_text())

    written = written_line(tmp_path, model.model_validate(golden["payload"]), monkeypatch)

    assert written == golden, (
        f"{kind} v{model.VERSION} no longer writes what its fixture says. A change to an "
        f"event kind bumps its VERSION and adds tests/golden/events/{kind}/"
        f"v{model.VERSION + 1}.json — the old fixture stays for the cockpit to read")


def test_every_fixture_in_the_corpus_is_a_known_kind_at_a_version_it_has_had():
    found = sorted(GOLDEN.glob("*/v*.json"))
    assert found, "the golden corpus is empty"
    for path in found:
        line = json.loads(path.read_text())
        kind, version = path.parent.name, int(path.stem.removeprefix("v"))
        assert line["kind"] == kind and line["v"] == version, path
        assert set(line) == {"seq", "ts", "kind", "v", "payload"}, path
        assert kind in EVENT_KINDS, f"{path}: a fixture for a kind the factory no longer has"
        assert version <= EVENT_KINDS[kind].VERSION, f"{path}: a version from the future"


# ── the writer ───────────────────────────────────────────────────────────────

def test_seq_counts_from_one_with_no_gaps_even_with_writers_racing(tmp_path: Path):
    session = tmp_path / "session"
    started = EVENT_KINDS["process_ended"]

    def write(offset: int) -> None:
        for pid in range(offset, offset + 25):
            events.emit(session, started(pid=pid))

    threads = [threading.Thread(target=write, args=(n * 100,)) for n in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert [line.seq for line in events.read(session)] == list(range(1, 101))


def test_a_torn_last_line_is_skipped_and_never_glued_to_the_next_one(tmp_path: Path):
    session = tmp_path / "session"
    ended = EVENT_KINDS["process_ended"]
    events.emit(session, ended(pid=1))
    with (session / events.EVENTS_FILE).open("a") as stream:
        stream.write('{"seq": 2, "ts": "x", "ki')          # a writer killed mid-line

    events.emit(session, ended(pid=3))

    lines = events.read(session)
    assert [line.seq for line in lines] == [1, 2]
    assert events.payload(lines[-1]) == ended(pid=3)


# ── what a real run writes ───────────────────────────────────────────────────

def test_a_run_writes_only_typed_events_numbered_without_gaps_and_the_db_still_fills(
        stamped: Path):
    fake_roster(stamped, planner=[plan_reply()],
                builder=[{"text": "not json at all"}, build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    commit_all(stamped)

    result = asf(stamped, "run", "sdlc", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    session = session_dir(stamped, adw_id)

    raw = (session / events.EVENTS_FILE).read_text().splitlines()
    lines = events.read(session)
    assert len(lines) == len(raw)                                   # nothing unparseable
    assert [line.seq for line in lines] == list(range(1, len(lines) + 1))
    typed = [events.payload(line) for line in lines]
    assert all(event is not None for event in typed)                # every line validates
    kinds = [line.kind for line in lines]
    assert kinds[0] == "session_started" and kinds[-1] == "session_finished"
    for kind in ("phase_started", "phase_ended", "envelope_accepted", "envelope_rejected",
                 "gate_result", "journal_noted", "usage", "process_started", "process_ended",
                 "command_finished"):
        assert kind in kinds, kind

    # What the session is about travels in the events.
    started = typed[0]
    assert started.base_ref == "main" and len(started.base_commit) == 40
    assert started.request == "add app.py" and started.workflow == "sdlc"
    rejected = next(e for e in typed if e.KIND == "envelope_rejected")
    assert rejected.agent == "builder" and rejected.raw == "not json at all"
    assert any(e.KIND == "usage" and e.agent == "planner" and e.tokens == 100 for e in typed)
    verify = next(e for e in typed if e.KIND == "command_finished")
    assert verify.name == "test" and verify.exit_code == 0 and verify.argv == PY_CHECK

    # ...and they are the whole record: the session directory is all a run
    # writes, with no database file beside it.
    assert not [path for path in (stamped / "asf" / "data").rglob("*")
                if path.suffix == ".db" or ".db-" in path.name]


# ── the projection: the events rebuild the session's files ───────────────────

STORY_ID = "0a1b2c3d"          # pinned, so scripted agents can name the handoff dir


def handoff(repo: Path, name: str) -> str:
    return str(session_dir(repo, STORY_ID) / "context_handoff" / name)


def a_story(repo: Path) -> None:
    """An issue run that asks a question, has its plan rejected and then
    approved, and builds with a deviation on the record — four processes."""
    base = forge(repo)
    set_config(repo, issues={
        "enabled": True, "project": "acme/widgets",
        "fetch_command": [*base, "view"], "comments_command": [*base, "view"],
        "body_command": [*base, "edit"], "state_command": [*base, "edit"],
        "comment_command": [*base, "comment"], "list_command": [*base, "list"]})
    forge_data(repo, "issue.json", issue_json())
    requirements = handoff(repo, "requirements.md")
    asking = {"topic": "scope", "question": "Which endpoint?",
              "options": [{"answer": "login", "because": "named", "recommended": True},
                          {"answer": "refresh", "because": "500s today"}]}
    fake_roster(
        repo,
        scout=[{"writes": {handoff(repo, "recon_1.md"): "# recon\n"},
                "envelope": envelope(findings=[{"file": "app.py", "note": "missing"}],
                                     artifacts=[handoff(repo, "recon_1.md")])}],
        analyst=[{"writes": {requirements: "# Requirements\n\n- draft\n"}, "tokens": 30,
                  "cost": 0.003,
                  "envelope": envelope(artifacts=[requirements], open_questions=[asking])},
                 {"writes": {requirements: "# Requirements\n\n- refresh 200s\n"},
                  "envelope": envelope(artifacts=[requirements])}],
        planner=[{"writes": {"docs/asf/spec/plan.md": "# Plan v1\n"}, "tokens": 100,
                  "cost": 0.01, "context_tokens": 900, "context_window": 200_000,
                  "envelope": envelope(artifacts=["docs/asf/spec/plan.md"])},
                 {"writes": {"docs/asf/spec/plan.md": "# Plan v2\n"}, "tokens": 70,
                  "cost": 0.007,
                  "envelope": envelope(artifacts=["docs/asf/spec/plan.md"])}],
        builder=[{"text": "let me think about this first"},
                 {"writes": {"app.py": "ok = 1\n"}, "tokens": 50, "cost": 0.02,
                  "envelope": envelope(changed_files=["app.py"], commit_message="feat: app",
                                       for_the_record=[{
                                           "kind": "deviation", "what": "used a module flag",
                                           "instead_of": "a function",
                                           "because": "nothing calls it yet"}])}])
    write_workflow(repo, "story", {
        "description": "settle the ask, plan with a person, build, commit",
        "input": "issue",
        "stages": [{"refine": {}}, {"plan": {"hitl": True}}, {"implement": {}},
                   {"commit": {"of": "implement"}}]})
    commit_all(repo)


def assert_projects(repo: Path) -> None:
    session = session_dir(repo, STORY_ID)
    rebuilt, written = projection.replay(session), projection.on_disk(session)
    assert rebuilt.run == written.run
    assert rebuilt.decisions == written.decisions
    assert rebuilt.envelopes == written.envelopes
    assert rebuilt.agent_envelopes == written.agent_envelopes
    assert rebuilt.journal == written.journal


def test_replaying_a_session_s_events_rebuilds_its_files_exactly(stamped: Path, monkeypatch):
    monkeypatch.chdir(stamped)
    a_story(stamped)

    asked = asf(stamped, "run", "story", "42", "--adw-id", STORY_ID)
    assert asked.returncode == 75, asked.stdout + asked.stderr          # the question round
    assert run_state(stamped, STORY_ID)["waiting_for"]["kind"] == "questions"
    assert_projects(stamped)

    answered = asf(stamped, "answer", STORY_ID, "-m", "the refresh path")
    assert answered.returncode == 75, answered.stdout + answered.stderr   # now the plan gate
    assert run_state(stamped, STORY_ID)["waiting_for"]["gate"] == "plan"
    assert_projects(stamped)

    rejected = asf(stamped, "reject", STORY_ID, "-m", "say which module")
    assert rejected.returncode == 75, rejected.stdout + rejected.stderr   # round 2 of the gate
    assert_projects(stamped)

    approved = asf(stamped, "approve", STORY_ID)
    assert approved.returncode == 0, approved.stdout + approved.stderr
    state = run_state(stamped, STORY_ID)
    assert state["status"] == "success" and state["issue_number"] == 42
    assert_projects(stamped)

    # What the story was meant to exercise really is in the files being rebuilt.
    written = projection.on_disk(session_dir(stamped, STORY_ID))
    assert {"requirements_1", "plan_1", "plan_2"} <= set(written.decisions)
    assert written.decisions["plan_1"]["verdict"] == "reject"
    assert {e["kind"] for e in written.journal} == {"phase", "note", "remark"}
    assert written.run["workflows"] == ["story"] and written.run["total_cost"] > 0

    lines = events.read(session_dir(stamped, STORY_ID))
    assert [line.seq for line in lines] == list(range(1, len(lines) + 1))
    assert all(events.payload(line) is not None for line in lines)
    assert sum(line.kind == "session_started" for line in lines) == 4
    request = next(events.payload(line) for line in lines if line.kind == "provenance_recorded")
    assert request.request == "#42 health check broken (#42)"
    # What the person answered is a request the workflow works from, like the issue itself.
    [answers] = [line.payload for line in lines if line.kind == "artifact_written"
                 and line.payload["path"] == "context_handoff/answers_1.md"]
    assert answers["role"] == "request" and "the refresh path" in answers["content"]
    assert answers["content"] == Path(handoff(stamped, "answers_1.md")).read_text()

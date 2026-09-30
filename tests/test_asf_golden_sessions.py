"""Whole sessions in the golden corpus: what a cockpit's session view is built from.

`tests/golden/events/` holds one line per event kind and version, which is
enough to prove a reader exists for each. It is not enough to prove a page
reads right: a story in chapters is about how the lines FOLLOW each other —
which process opened which chapter, what a resume replayed, whose decision
closed which round. So the corpus also holds real sessions, recorded off the
fake harness by the code that ships, under `tests/golden/sessions/<name>/`:

  * `events.jsonl` — the session's events, exactly as its station shipped them
    (with the machine's paths replaced, so the recording is the same anywhere);
  * `journal.md` — the journal the factory rendered for the next agent, the
    file a cockpit's Journal view must match byte for byte.

Like an event fixture, a recording is never edited once checked in: a cockpit
reads sessions written by every factory there ever was, so an old recording is
exactly as worth keeping as an old fixture. A new one is added beside it with

    ASF_RECORD_SESSIONS=1 pytest tests/test_asf_golden_sessions.py

which tells the story below and writes it under a name that says what it
exercises. Without that variable the story is still told, so the recorder
cannot rot unnoticed between recordings — but nothing is written.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from engine import events
from engine.data_types import EVENT_KINDS

from .asf_helpers import (PY_CHECK, asf, commit_all, envelope, fake_roster, forge, forge_data,
                          git, issue_json, new_repo, pr_json, session_dir, set_config, stamp,
                          wire, with_origin)

SESSIONS = Path(__file__).resolve().parent / "golden" / "sessions"
EVENT_FIXTURES = Path(__file__).resolve().parent / "golden" / "events"
RECORDING = "issue-then-two-reviews"
ID = "a9f259f0"
PR = 9
WORK = "/work/widgets"          # where the recording says the repository was


def handoff(repo: Path, name: str) -> str:
    return str(session_dir(repo, ID) / "context_handoff" / name)


ISSUE = """\
Rules and decisions from a meeting are extracted as tasks, and a relative
deadline ("in four weeks") stays relative.

## Requirements (agreed with schurik)

- R1 The prompt receives the meeting date; there is no fallback to now.
- R2 One action item is one task with one owner.
"""
FINDINGS = """\
# Findings

- app.py: `build_prompt` takes the transcript, and no date.
- tests: nothing covers the prompt yet.
"""
PLAN = "# Plan\n\n1. `build_prompt(meeting_date)`, required.\n2. A test for the format.\n"
PLAN_2 = PLAN + "3. Name the module the date is converted in.\n"
REVIEW = "# Review\n\nVerdict: approved. R1 and R2 are met.\n"


def replies(repo: Path) -> dict:
    """Every agent's script for the first chapter, in the order they are spent."""
    return {
        "scout": [{
            "writes": {handoff(repo, "scout_findings.md"): FINDINGS},
            "tokens": 1_900, "cost": 0.021, "context_tokens": 58_000, "context_window": 200_000,
            "tool_calls": [{"tool": "grep", "args": {"pattern": "build_prompt"}, "result": "1"},
                           {"tool": "read", "args": {"path": "app.py"}, "result": "..."},
                           {"tool": "read", "args": {"path": "tests/"}, "ok": False,
                            "result": "is a directory"}],
            "envelope": envelope(summary="the prompt is built in app.py; no date reaches it",
                                 findings=[{"file": "app.py", "note": "no date"}],
                                 artifacts=[handoff(repo, "scout_findings.md")])}],
        "planner": [
            {"writes": {"docs/asf/spec/plan.md": PLAN},
             "tokens": 6_100, "cost": 0.102, "context_tokens": 121_000, "context_window": 200_000,
             "tool_calls": [{"tool": "read", "args": {"path": "app.py"}, "result": "..."}],
             "envelope": envelope(summary="a required meeting date, and a test for its format",
                                  artifacts=["docs/asf/spec/plan.md"],
                                  commit_message="docs: plan the meeting date",
                                  for_the_record=[{
                                      "kind": "risk", "what": "the date is local midnight",
                                      "because": "converted in UTC it is the previous day"}])},
            {"text": "I revised the plan."},        # no envelope: one correction
            {"writes": {"docs/asf/spec/plan.md": PLAN_2},
             "tokens": 2_400, "cost": 0.041,
             "envelope": envelope(summary="the plan now names the module",
                                  artifacts=["docs/asf/spec/plan.md"],
                                  commit_message="docs: plan the meeting date")}],
        "builder": [{
            "writes": {"app.py": "def build_prompt(meeting_date):\n    return meeting_date\n"},
            "tokens": 8_200, "cost": 0.135, "context_tokens": 148_000, "context_window": 200_000,
            "tool_calls": [{"tool": "read", "args": {"path": "app.py"}, "result": "..."},
                           {"tool": "edit", "args": {"path": "app.py"}, "result": "ok"},
                           {"tool": "bash", "args": {"command": "pytest"}, "result": "ok"}],
            "envelope": envelope(summary="build_prompt takes the meeting date",
                                 changed_files=["app.py"],
                                 commit_message="feat: the prompt knows the meeting date",
                                 for_the_record=[{
                                     "kind": "deviation", "what": "kept the summary helpers",
                                     "instead_of": "reworking every prompt",
                                     "because": "only the action items need a date"}])}],
        "reviewer": [{
            "writes": {handoff(repo, "review.md"): REVIEW},
            "tokens": 3_300, "cost": 0.066,
            "envelope": envelope(summary="approved: R1 and R2 are met", approved=True,
                                 blocking=[], findings=[],
                                 artifacts=[handoff(repo, "review.md")])}],
        "documenter": [{
            "writes": {"docs/asf/meeting-date.md": "# The meeting date\n\nThe prompt knows it.\n"},
            "tokens": 1_200, "cost": 0.018,
            "envelope": envelope(summary="documented the meeting date",
                                 artifacts=["docs/asf/meeting-date.md"],
                                 document_path="docs/asf/meeting-date.md",
                                 documented_files=["app.py"],
                                 commit_message="docs: the meeting date")}],
    }


def review_round(repo: Path, said: str, content: str, message: str) -> None:
    fake_roster(repo, builder=[{
        "writes": {"app.py": content}, "tokens": 2_000, "cost": 0.04,
        "tool_calls": [{"tool": "edit", "args": {"path": "app.py"}, "result": "ok"}],
        "envelope": envelope(summary=f"addressed: {said}", changed_files=["app.py"],
                             commit_message=message)}])
    forge_data(repo, "pr.json", pr_json(PR, f"asf/{ID}", [{"body": said, "author": "schurik"}]))
    result = asf(repo, "run", "pr-review", str(PR))
    assert result.returncode == 0, result.stdout + result.stderr


def tell(repo: Path) -> None:
    """One session, the way a team's would go.

    Chapter 1 is issue #42: scouted, planned, and stopped at the plan gate,
    where a person rejects the plan with a remark and approves the second one
    with another. The approval resumes the session — the scout and the planner
    are replayed from the record, not called again — and the build, review,
    documentation and pull request follow; the gates hitl leaves off pass by
    policy. Chapters 2 and 3 are two rounds of review on that pull request.
    Transcripts are on, so the prompts each agent was sent are in the stream.
    """
    base = forge(repo)
    set_config(repo,
               issues={"enabled": True, "project": "acme/widgets",
                       "fetch_command": [*base, "view"], "list_command": [*base, "list"],
                       "comment_command": [*base, "comment"], "state_command": [*base, "edit"],
                       "route": {"asf:ship": "issue"}},
               pull_requests={"enabled": True, "project": "acme/widgets",
                              "list_command": [*base, "list"],
                              "comment_command": [*base, "comment"],
                              "state_command": [*base, "edit"],
                              "graphql_command": [*base, "graphql"]},
               worktree={"integration": {"mode": "pr", "open_pr": True,
                                         "pr_command": [*base, "pr-create"]}},
               cockpit={"transcripts": True})
    forge_data(repo, "issue.json", {**issue_json(42, author="schurik", body=ISSUE),
                                    "title": "Resolve relative due dates via the meeting date"})
    fake_roster(repo, **replies(repo))
    wire(repo, "test", PY_CHECK)
    with_origin(repo)
    commit_all(repo)

    asked = asf(repo, "run", "issue", "42", "--adw-id", ID, "--hitl", "plan")
    assert asked.returncode == 75, asked.stdout + asked.stderr
    rejected = asf(repo, "reject", ID, "-m", "name the module the date is converted in")
    assert rejected.returncode == 75, rejected.stdout + rejected.stderr
    approved = asf(repo, "approve", ID, "-m", "keep the prompt in English")
    assert approved.returncode == 0, approved.stdout + approved.stderr

    review_round(repo, "the date should read like Sep 25, 2026",
                 "def build_prompt(meeting_date):\n    return f'{meeting_date:%b %d, %Y}'\n",
                 "fix: the date reads like Sep 25, 2026")
    review_round(repo, "use that format two lines below too",
                 "def build_prompt(meeting_date):\n    day = f'{meeting_date:%b %d, %Y}'\n"
                 "    return day\n",
                 "fix: one date format throughout")


def recorded(repo: Path) -> tuple[str, str]:
    """The session's events and journal, with the machine they ran on taken out."""
    session = session_dir(repo, ID)
    where = {str(repo.resolve()): WORK, str(repo): WORK,
             str(Path(sys.executable).resolve()): "python", sys.executable: "python"}

    def anonymous(text: str) -> str:
        for real, shown in sorted(where.items(), key=lambda pair: -len(pair[0])):
            text = text.replace(real, shown)
        return text

    lines = events.path(session).read_text()
    journal = (session / "context_handoff" / "journal.md").read_text()
    return anonymous(lines), anonymous(journal)


def fixture_for(kind: str, version: int) -> Path:
    return EVENT_FIXTURES / kind / f"v{version}.json"


# ── the story is still tellable ──────────────────────────────────────────────

def test_the_recorded_story_still_runs_and_is_written_only_when_asked(tmp_path: Path,
                                                                    monkeypatch):
    monkeypatch.setenv("ASF_STATION_NAME", "schurik@mbp:widgets")     # not this machine's name
    monkeypatch.delenv("CI", raising=False)
    repo = stamp(new_repo(tmp_path / "repo"))
    tell(repo)

    lines = events.read(session_dir(repo, ID))
    chapters = [(line.payload["workflow"], line.payload["chapter"])
                for line in lines if line.kind == "workflow_started"]
    assert chapters == [("issue", 1), ("pr-review", 2), ("pr-review", 3)]
    assert json.loads((session_dir(repo, ID) / "run.json").read_text())["status"] == "success"
    assert git(repo, "log", "-1", "--format=%s", f"asf/{ID}") == "fix: one date format throughout"

    if os.environ.get("ASF_RECORD_SESSIONS") != "1":
        return
    target = SESSIONS / RECORDING
    assert not target.exists(), (
        f"{target.relative_to(SESSIONS.parent.parent)} is checked in and never edited — "
        f"change RECORDING to record a new session beside it")
    target.mkdir(parents=True)
    stream, journal = recorded(repo)
    (target / "events.jsonl").write_text(stream)
    (target / "journal.md").write_text(journal)


# ── every recording stays readable ───────────────────────────────────────────

RECORDINGS = sorted(path.parent.name for path in SESSIONS.glob("*/events.jsonl"))


def test_the_corpus_holds_a_recorded_session():
    assert RECORDING in RECORDINGS


@pytest.mark.parametrize("name", RECORDINGS)
def test_a_recorded_session_is_whole_and_every_line_has_a_fixture(name: str):
    """What lets a cockpit test trust a recording: numbered without a gap, and
    made only of kinds and versions the per-kind corpus already holds — so a
    reader exists for every line, and the page built from it has no generic rows."""
    directory = SESSIONS / name
    lines = [json.loads(text) for text in (directory / "events.jsonl").read_text().splitlines()]

    assert [line["seq"] for line in lines] == list(range(1, len(lines) + 1))
    for line in lines:
        assert set(line) == {"seq", "ts", "kind", "v", "payload"}, line["seq"]
        assert line["kind"] in EVENT_KINDS, f"{name} seq {line['seq']}: {line['kind']}"
        assert fixture_for(line["kind"], line["v"]).is_file(), (
            f"{name} seq {line['seq']}: no fixture for {line['kind']} v{line['v']}")
    assert (directory / "journal.md").read_text().startswith("## This run so far\n")

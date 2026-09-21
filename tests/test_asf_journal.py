"""The run's journal: what each phase did, and what the agents learned doing it.

The failure this machinery exists for has no test that could have caught it,
because nothing was ever written down. The plan named a library; the builder
found it was not on the index, used another one, and shipped something that
worked. The reviewer measured that build against the plan, found an import the
plan never mentions, and sent the builder back to use a package that does not
exist. Every agent in that loop did its job with the context it had.

So a deviation is DECLARED on the envelope, LIFTED by code, and READ by every
agent afterwards — and the tests below check all three, plus the progress half
that puts a red check and its fix in front of whoever comes next.
"""

from __future__ import annotations

import json
from pathlib import Path

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster,
                          phase_names, session_dir, wire, write_workflow)

DEVIATION = {"kind": "deviation", "what": "used `httpx` for the probe",
             "instead_of": "the plan names `requests`",
             "because": "`requests` is not in this repo's lockfile and adding it would "
                        "pull in a new transitive dependency"}


def plan_reply() -> dict:
    return {"writes": {"docs/asf/spec/plan.md": "# Plan\n\nUse `requests`.\n"},
            "envelope": envelope(artifacts=["docs/asf/spec/plan.md"],
                                 commit_message="docs: plan")}


def build_reply(content: str, message: str, **fields) -> dict:
    return {"writes": {"app.py": content},
            "envelope": envelope(changed_files=["app.py"], commit_message=message, **fields)}


def review_reply(approved: bool = True) -> dict:
    return {"envelope": envelope(approved=approved, blocking=[], findings=[], artifacts=[])}


def journal_of(repo: Path, adw_id: str) -> list[dict]:
    return json.loads((session_dir(repo, adw_id) / "journal.json").read_text())


def reviewed_with(repo: Path, adw_id: str) -> str:
    return (session_dir(repo, adw_id) / "reviewer" / "prompts" / "user.md").read_text()


def plan_build_review(repo: Path, name: str = "journalled") -> None:
    write_workflow(repo, name, {
        "description": "plan, build, then judge the build against that plan",
        "stages": [{"plan": {}}, {"implement": {}},
                   {"review": {"max_rounds": 1, "retest": []}},
                   {"commit": {"of": "implement"}}]})


def test_a_deviation_reaches_the_reviewer_that_would_otherwise_undo_it(stamped: Path):
    fake_roster(stamped, planner=[plan_reply()],
                builder=[build_reply("ok = 1\n", "feat: app", for_the_record=[DEVIATION])],
                reviewer=[review_reply()])
    wire(stamped, "test", PY_CHECK)
    plan_build_review(stamped)
    commit_all(stamped)

    result = asf(stamped, "run", "journalled", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)

    # Code lifted it off the envelope — the agent never wrote the journal.
    notes = [e for e in journal_of(stamped, adw_id) if e["kind"] == "note"]
    assert len(notes) == 1
    assert notes[0]["by"] == "builder" and notes[0]["phase"] == "implement"
    assert notes[0]["note"]["instead_of"] == "the plan names `requests`"

    # And the reviewer read it, with the reason, before ruling on the build.
    reviewed = reviewed_with(stamped, adw_id)
    assert "## What this run has done so far" in reviewed
    assert "deviation (builder, in implement): used `httpx` for the probe" in reviewed
    assert "instead of: the plan names `requests`" in reviewed
    assert "not in this repo's lockfile" in reviewed

    # The planner ran before the build, so it saw the run so far and none of
    # what the builder had not done yet — the journal is a record, not a plan.
    planned = (session_dir(stamped, adw_id) / "planner" / "prompts" / "user.md").read_text()
    assert "## What this run has done so far" in planned
    assert "⚑" not in planned and "2. implement" not in planned

    # A file a person can open, saying the same thing as the ledger.
    story = (session_dir(stamped, adw_id) / "context_handoff" / "journal.md").read_text()
    assert "used `httpx` for the probe" in story and "1. request" in story


def test_a_deviation_that_will_not_say_what_it_departed_from_is_sent_back(stamped: Path):
    """The validator is on the type, so it fires wherever the field exists and
    the correction re-enters the same session — exactly as a malformed envelope
    already did. A deviation nobody can compare with the plan would reach a
    reviewer as an unexplained import, which is the bug, not the fix."""
    bare = {"kind": "deviation", "what": "used `httpx`"}
    fake_roster(stamped, planner=[plan_reply()],
                builder=[build_reply("ok = 1\n", "feat: app", for_the_record=[bare]),
                         build_reply("ok = 1\n", "feat: app", for_the_record=[DEVIATION])],
                reviewer=[review_reply()])
    wire(stamped, "test", PY_CHECK)
    plan_build_review(stamped)
    commit_all(stamped)

    result = asf(stamped, "run", "journalled", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)

    # One phase, two sends: the first reply never became an envelope.
    assert phase_names(stamped, adw_id) == ["request", "plan", "implement", "review_1",
                                            "commit_implement"]
    notes = [e for e in journal_of(stamped, adw_id) if e["kind"] == "note"]
    assert len(notes) == 1 and notes[0]["note"]["because"].startswith("`requests` is not")
    assert "instead of: the plan names `requests`" in reviewed_with(stamped, adw_id)


def test_the_journal_carries_the_run_s_progress_red_check_and_fix_included(stamped: Path):
    """The other half of what a later agent is missing: not what was decided,
    but what happened. A reviewer that can see `verify_1` came back red and
    `fix_1` followed does not have to ask why the build has two commits' worth
    of change in it."""
    fake_roster(stamped, builder=[build_reply("1/0\n", "feat: app"),
                                  build_reply("ok = 1\n", "feat: app, division fixed")],
                reviewer=[review_reply()])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "fixed", {
        "description": "build, let the suite fail once, then review what stands",
        "stages": [{"implement": {}}, {"verify": {"blocks": ["test"], "max_fix_loops": 2}},
                   {"review": {"max_rounds": 1, "retest": []}},
                   {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "fixed", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)

    entries = [e for e in journal_of(stamped, adw_id) if e["kind"] == "phase"]
    assert [e["phase"] for e in entries] == ["request", "implement", "verify_1", "fix_1",
                                             "verify_2", "review_1", "commit_implement"]
    assert [e["seq"] for e in entries] == sorted(e["seq"] for e in entries)
    # A code phase describes itself with what it logged, so "success" does not
    # read as "the suite was green" when it was not.
    verify_1 = next(e for e in entries if e["phase"] == "verify_1")
    assert verify_1["by"] == "quality" and "passed: False" in verify_1["summary"]

    reviewed = reviewed_with(stamped, adw_id)
    assert "verify_1 · quality · success — passed: False" in reviewed
    assert "fix_1 · builder · success — " in reviewed

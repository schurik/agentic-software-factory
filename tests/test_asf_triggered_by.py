"""Who triggered a session, end to end on the fake harness.

A labelled issue's run is triggered by whoever applied the label the watcher
dequeued it on, and the watcher hands that login to the run it launches
(`test_asf_watchers.py` proves the reading). Any other run is triggered by its
operator, named as the forge knows them: the account `gh` acts as on this
machine. The session records it once — in `run.json` and on `session_started`
— and every later process that takes the session keeps it.

`gh` here is a script on PATH: the operator's login is read from `gh`'s own
config, so nothing opens a socket.
"""

from __future__ import annotations

import os
from pathlib import Path

from engine import events

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster, forge,
                          forge_data, issue_json, run_state, session_dir, set_config, wire,
                          write_workflow)

GH = """#!/bin/sh
if [ "$1 $2 $3 $4 $5" = "config get -h github.com user" ]; then
  {answer}
fi
exit 1
"""


def gh_says(repo: Path, login: str | None) -> dict:
    """An environment whose `gh` is logged in to github.com as `login` (None: not at all)."""
    bin_dir = repo.parent / "bin"
    bin_dir.mkdir(exist_ok=True)
    script = bin_dir / "gh"
    script.write_text(GH.format(answer=f"echo {login}; exit 0" if login else "exit 1"))
    script.chmod(0o755)
    return {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "ENGINEER_NAME": "Alex Doe"}


def plan_reply() -> dict:
    return {"writes": {"docs/asf/spec/plan.md": "# Plan\n"},
            "envelope": envelope(artifacts=["docs/asf/spec/plan.md"], commit_message="docs: plan")}


def build_reply() -> dict:
    return {"writes": {"app.py": "ok = 1\n"},
            "envelope": envelope(changed_files=["app.py"], commit_message="feat: app")}


def started(repo: Path, adw_id: str) -> list[str]:
    """`triggered_by` on every `session_started` the session has, in order."""
    return [line.payload["triggered_by"] for line in events.read(session_dir(repo, adw_id))
            if line.kind == "session_started"]


def run(stamped: Path, env: dict) -> str:
    fake_roster(stamped, planner=[plan_reply()], builder=[build_reply()])
    wire(stamped, "test", PY_CHECK)
    commit_all(stamped)
    result = asf(stamped, "run", "sdlc", "add app.py", env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    return adw_id_of(result)


def test_a_run_started_by_hand_is_triggered_by_its_operator_as_the_forge_knows_them(
        stamped, monkeypatch):
    monkeypatch.delenv("ASF_TRIGGERED_BY", raising=False)
    monkeypatch.setenv("GITHUB_ACTOR", "ci-bot")         # `gh`'s own login comes first
    adw_id = run(stamped, gh_says(stamped, "schurik"))
    assert run_state(stamped, adw_id)["triggered_by"] == "schurik"
    assert started(stamped, adw_id) == ["schurik"]


def test_an_operator_gh_cannot_name_is_named_as_the_factory_names_them(stamped, monkeypatch):
    monkeypatch.delenv("ASF_TRIGGERED_BY", raising=False)
    adw_id = run(stamped, gh_says(stamped, None))
    assert run_state(stamped, adw_id)["triggered_by"] == "Alex Doe"


def test_in_a_ci_job_the_operator_is_the_actor_the_forge_ran_it_for(stamped, monkeypatch):
    monkeypatch.delenv("ASF_TRIGGERED_BY", raising=False)
    adw_id = run(stamped, {**gh_says(stamped, None), "GITHUB_ACTOR": "carol"})
    assert run_state(stamped, adw_id)["triggered_by"] == "carol"


def test_a_watcher_s_launch_is_triggered_by_the_labeller_not_by_whoever_runs_the_watcher(stamped):
    adw_id = run(stamped, {**gh_says(stamped, "schurik"), "ASF_TRIGGERED_BY": "carol"})
    assert run_state(stamped, adw_id)["triggered_by"] == "carol"
    assert started(stamped, adw_id) == ["carol"]


def test_a_labeller_the_watcher_could_not_name_is_nobody_not_the_operator(stamped):
    adw_id = run(stamped, {**gh_says(stamped, "schurik"), "ASF_TRIGGERED_BY": ""})
    assert run_state(stamped, adw_id)["triggered_by"] == ""


def test_every_later_process_keeps_who_triggered_the_session(stamped):
    fake_roster(stamped, planner=[plan_reply()], builder=[build_reply()])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "gated", {
        "description": "sdlc with a person between the plan and the build",
        "stages": [{"plan": {"agent": "planner", "hitl": True}},
                   {"implement": {"agent": "builder"}},
                   {"commit": {"of": "implement"}}],
    })
    commit_all(stamped)
    asked = asf(stamped, "run", "gated", "add app.py",
                env={**gh_says(stamped, "schurik"), "ASF_TRIGGERED_BY": "carol"})
    assert asked.returncode == 75, asked.stdout + asked.stderr
    adw_id = adw_id_of(asked)

    # Answered by somebody else, whose process is told a different trigger:
    # an answer is not a second trigger.
    approved = asf(stamped, "approve", adw_id,
                   env={**gh_says(stamped, "dave"), "ASF_TRIGGERED_BY": "dave"})
    assert approved.returncode == 0, approved.stdout + approved.stderr
    assert run_state(stamped, adw_id)["triggered_by"] == "carol"
    assert started(stamped, adw_id) == ["carol", "carol"]


def test_an_issue_run_says_who_wrote_the_issue_and_whom_it_is_assigned_to(stamped):
    """What a cockpit ranks a viewer's own work first by, besides who triggered it."""
    base = forge(stamped)
    set_config(stamped, issues={"enabled": True, "project": "acme/widgets",
                                "fetch_command": [*base, "view"], "comment_command": [*base, "comment"],
                                "state_command": [*base, "edit"], "route": {"asf:ship": "issue"}})
    forge_data(stamped, "issue.json", issue_json(42, author="bob", assignees=("carol", "dave")))
    # The scout gives up: the record is written before any agent is asked.
    gives_up = [{"envelope": envelope(status="fail", summary="no")}]
    fake_roster(stamped, scout=gives_up, planner=gives_up, builder=gives_up, reviewer=gives_up,
                documenter=gives_up)
    commit_all(stamped)
    result = asf(stamped, "run", "issue", "42", "--hitl", "none", env=gh_says(stamped, "schurik"))
    adw_id = adw_id_of(result)
    learned = [line for line in events.read(session_dir(stamped, adw_id))
               if line.kind == "provenance_recorded" and line.payload.get("issue_number")]
    assert learned and learned[0].v == 2
    assert (learned[0].payload["issue_author"], learned[0].payload["issue_assignees"]) == (
        "bob", ["carol", "dave"])

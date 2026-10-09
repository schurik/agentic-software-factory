"""The two pollers, in-process against the fake forge, with the launch replaced
by a chosen exit code. Everything between listing an item and moving its label
is the code that ships. Three outcomes, not two: exit 75 is a person who has
not answered yet, and reading it as failure tells the reporter the opposite
of what happened."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine import artifacts, factory, watch
from engine.data_types import Launch, RunState, WaitingFor

from .asf_helpers import (asf, fake_roster, forge, forge_calls, forge_data, issue_json,
                          set_config)

CONFIG = "asf/factory.yaml"


@pytest.fixture
def tracked(stamped: Path, monkeypatch):
    """A stamped repo on the fake forge with both watchers enabled. Returns
    (cfg, listing) — `listing(*numbers)` sets what the next poll lists."""
    monkeypatch.chdir(stamped)
    fake_roster(stamped, builder=[{"envelope": {"status": "success"}}])
    base = forge(stamped)
    commands = {"list_command": [*base, "list"], "comment_command": [*base, "comment"],
                "state_command": [*base, "edit"]}
    set_config(stamped,
               issues={"enabled": True, "project": "acme/widgets",
                       "fetch_command": [*base, "view"], "route": {"asf:ship": "issue"},
                       "labeller_command": [*base, "graphql"], **commands},
               pull_requests={"enabled": True, "project": "acme/widgets",
                              "graphql_command": [*base, "graphql"], **commands})
    forge_data(stamped, "listing.json", [])

    def listing(*entries) -> None:
        forge_data(stamped, "listing.json", list(entries))
    return factory.load(CONFIG), listing


def queued(number: int, *labels: str) -> dict:
    entry = issue_json(number, labels=labels or ("asf:queued", "asf:ship"))
    return {k: entry[k] for k in ("number", "title", "labels", "author")}


def open_pr(number: int, branch: str = "asf/1d5e4c0e", *labels: str, draft: bool = False) -> dict:
    return {"number": number, "headRefName": branch, "isDraft": draft,
            "labels": [{"name": name} for name in labels]}


def labels(repo: Path, number: int) -> tuple[list[str], list[str]]:
    """(added, removed) across every edit the watcher made to one item."""
    added, removed = [], []
    for call in forge_calls(repo):
        if call[0] != "edit" or str(number) not in call:
            continue
        for flag, value in zip(call, call[1:]):
            (added if flag == "--add-label" else removed if flag == "--remove-label" else []
             ).append(value)
    return added, removed


@pytest.mark.parametrize("code,expected", [(0, "asf:done"), (1, "asf:failed")])
def test_a_finished_issue_run_moves_the_label_to_its_outcome(tracked, stamped, monkeypatch,
                                                             code, expected):
    cfg, listing = tracked
    listing(queued(42))
    launched = []
    monkeypatch.setattr(watch, "launch",
                        lambda *a: launched.append((a[2].workflow, a[2].number)) or code)
    assert watch.issues_once(cfg, CONFIG) == 0
    assert launched == [("issue", 42)]
    added, removed = labels(stamped, 42)
    assert added == ["asf:running", expected] and removed == ["asf:queued", "asf:running"]


def test_a_run_stopped_at_a_gate_is_left_running_not_failed(tracked, stamped, monkeypatch, capsys):
    cfg, listing = tracked
    listing(queued(42))
    monkeypatch.setattr(watch, "launch", lambda *a: watch.EXIT_WAITING)
    assert watch.issues_once(cfg, CONFIG) == 0
    added, removed = labels(stamped, 42)
    assert added == ["asf:running"] and removed == ["asf:queued"]
    assert "stopped for a human at a gate" in capsys.readouterr().out


def test_the_claim_clears_a_previous_run_s_verdict_but_never_the_routing_label(tracked, stamped,
                                                                              monkeypatch):
    cfg, listing = tracked
    listing(queued(42, "asf:queued", "asf:failed", "asf:ship"))
    monkeypatch.setattr(watch, "launch", lambda *a: 0)
    watch.issues_once(cfg, CONFIG)
    added, removed = labels(stamped, 42)
    assert removed[:2] == ["asf:failed", "asf:queued"] and "asf:ship" not in removed
    assert added == ["asf:running", "asf:done"]


def test_an_issue_without_a_routing_label_is_left_alone(tracked, stamped, monkeypatch):
    cfg, listing = tracked
    listing(queued(42, "asf:queued"))
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a) or 0)
    watch.issues_once(cfg, CONFIG)
    assert launched == [] and forge_calls(stamped) == []


def test_a_failed_review_is_marked_and_a_label_that_will_not_stick_is_held(tracked, stamped,
                                                                          monkeypatch, capsys):
    cfg, listing = tracked
    listing(open_pr(72))
    monkeypatch.setattr(watch, "has_work", lambda *a: True)
    monkeypatch.setattr(watch, "reap", lambda *a: 0)
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2].number) or 1)
    watch._HELD.clear()

    assert watch.prs_once(cfg, CONFIG) == 0
    assert labels(stamped, 72)[0] == ["asf:pr-failed"] and watch._HELD == set()

    forge_data(stamped, "refuse.json", ["edit"])
    watch.prs_once(cfg, CONFIG)
    watch.prs_once(cfg, CONFIG)                 # held: not bought a second time
    assert launched == [72, 72] and watch._HELD == {("acme/widgets", 72)}
    assert "did not stick" in capsys.readouterr().out
    watch._HELD.clear()


def test_a_draft_a_marked_or_a_waiting_pull_request_is_skipped(tracked, stamped, monkeypatch):
    cfg, listing = tracked
    sessions = artifacts.sessions_root(stamped, cfg.data_dir)
    (sessions / "cafed00d").mkdir(parents=True)
    artifacts.write_run(sessions / "cafed00d", RunState(
        adw_id="cafed00d", status="waiting", pr_url="https://forge/acme/widgets/pull/74",
        waiting_for=WaitingFor(gate="plan", round=1)))
    listing(open_pr(72, draft=True), open_pr(73, "asf/x", "asf:pr-failed"), open_pr(74),
            open_pr(75, "feature/by-hand"))
    monkeypatch.setattr(watch, "has_work", lambda *a: True)
    monkeypatch.setattr(watch, "reap", lambda *a: 0)
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2].number) or 0)
    watch.prs_once(cfg, CONFIG)
    assert launched == []
    assert watch.waiting_on(cfg, stamped, 74) == "cafed00d"


def test_the_launcher_tells_the_run_its_terminal_is_not_the_run_s(stamped, monkeypatch):
    seen = {}

    def fake_run(argv, cwd=None, env=None, **kwargs):
        seen["argv"], seen["env"] = argv, env or {}
        return type("Completed", (), {"returncode": 0})()
    monkeypatch.setattr(watch.subprocess, "run", fake_run)
    watch.launch(CONFIG, stamped, Launch(workflow="issue", number=42))
    assert seen["env"].get("ASF_UNATTENDED") == "1"
    assert seen["argv"][1:] == ["asf/asf.py", "--config", CONFIG, "run", "issue", "42"]
    # A launcher that did not ask who triggered it says nothing, and the run decides.
    assert "ASF_TRIGGERED_BY" not in seen["env"]


@pytest.mark.parametrize("labeller", ["carol", ""])
def test_the_launcher_tells_the_run_who_triggered_it_even_when_it_could_not_tell(
        stamped, monkeypatch, labeller):
    seen = {}

    def fake_run(argv, cwd=None, env=None, **kwargs):
        seen["env"] = env or {}
        return type("Completed", (), {"returncode": 0})()
    monkeypatch.setattr(watch.subprocess, "run", fake_run)
    monkeypatch.delenv("ASF_TRIGGERED_BY", raising=False)
    watch.launch(CONFIG, stamped, Launch(workflow="issue", number=42, triggered_by=labeller))
    assert seen["env"]["ASF_TRIGGERED_BY"] == labeller


def timeline(*labelled: tuple[str, str | None]) -> dict:
    """An issue's `labeled` events as the forge's graphql answers them, oldest
    first: (label, actor) — an actor of None is a deleted account."""
    return {"data": {"repository": {"issue": {"timelineItems": {"nodes": [
        {"createdAt": f"2026-01-0{i + 1}T00:00:00Z", "label": {"name": label},
         "actor": None if actor is None else {"login": actor}}
        for i, (label, actor) in enumerate(labelled)]}}}}}


def test_an_issue_run_is_triggered_by_whoever_last_applied_its_route_or_queued_label(
        tracked, stamped, monkeypatch):
    cfg, listing = tracked
    listing(queued(42, "asf:queued", "asf:ship", "bug"))
    # The route label went on long ago; the issue was queued again later, by
    # someone else — and a label nobody routes on says nothing about it.
    forge_data(stamped, "timeline.json", timeline(("asf:ship", "alice"), ("asf:queued", "carol"),
                                                  ("bug", "mallory")))
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or 0)
    assert watch.issues_once(cfg, CONFIG) == 0
    assert [(item.workflow, item.number, item.triggered_by) for item in launched] == [
        ("issue", 42, "carol")]
    asked = [call for call in forge_calls(stamped) if call[0] == "graphql"]
    assert asked and "owner=acme" in asked[0] and "name=widgets" in asked[0]


@pytest.mark.parametrize("answer", [None, timeline(("asf:ship", None))])
def test_a_labeller_the_forge_will_not_name_is_recorded_as_nobody_not_as_the_watcher(
        tracked, stamped, monkeypatch, answer):
    cfg, listing = tracked
    listing(queued(42))
    if answer is None:
        forge_data(stamped, "refuse.json", ["graphql"])
    else:
        forge_data(stamped, "timeline.json", answer)
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or 0)
    assert watch.issues_once(cfg, CONFIG) == 0
    assert [item.triggered_by for item in launched] == [""]


def test_a_review_run_the_watcher_starts_is_triggered_by_nobody_it_can_name(tracked, stamped,
                                                                            monkeypatch):
    """The review watcher has no label to read. A session it re-enters keeps
    who triggered it; one it starts fresh must not record whoever runs it."""
    cfg, listing = tracked
    listing(open_pr(72))
    monkeypatch.setattr(watch, "has_work", lambda *a: True)
    monkeypatch.setattr(watch, "reap", lambda *a: 0)
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or 0)
    watch.prs_once(cfg, CONFIG)
    assert [(item.number, item.triggered_by) for item in launched] == [(72, "")]


def test_a_tracker_without_a_labeller_command_launches_without_asking(tracked, stamped,
                                                                     monkeypatch):
    cfg, listing = tracked
    cfg.issues.labeller_command = []
    listing(queued(42))
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or 0)
    assert watch.issues_once(cfg, CONFIG) == 0
    assert [item.triggered_by for item in launched] == [""]
    assert not [call for call in forge_calls(stamped) if call[0] == "graphql"]


def test_a_watcher_refuses_a_route_to_a_workflow_with_the_wrong_input(stamped):
    fake_roster(stamped, builder=[{"envelope": {"status": "success"}}])
    set_config(stamped, issues={"enabled": True, "project": "acme/widgets",
                                "route": {"asf:quick": "quick"}})
    result = asf(stamped, "issues", "once")
    assert result.returncode != 0
    assert "takes input: prompt" in result.stderr
    status = asf(stamped, "issues", "status")
    assert status.returncode == 0 and "asf:quick" in status.stdout


def test_status_reads_the_heartbeats_and_probes_the_pids(tracked, stamped, monkeypatch):
    cfg, listing = tracked
    monkeypatch.setattr(watch, "launch", lambda *a: 0)
    watch.issues_once(cfg, CONFIG)
    beat = json.loads((stamped / "asf" / "data" / "watchers" / "issues.json").read_text())
    assert beat["status"] == "polling" and beat["kind"] == "issues"
    shown = asf(stamped, "status")
    assert shown.returncode == 0, shown.stdout + shown.stderr
    assert "issues  polling" in shown.stdout           # this process's pid is alive
    assert "prs     never started here" in shown.stdout
    assert "runs in flight: 0" in shown.stdout

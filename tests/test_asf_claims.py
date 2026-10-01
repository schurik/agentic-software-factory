"""Claims: a shared cockpit decides which station starts a work item (ADR 0003).

The forge label is not a lock — two watchers that listed the same queued issue
both flip it — so with a shared cockpit every starter asks it for a claim
before it touches a label, and exactly one is granted. The station ↔ cockpit
wire seam from spec #40: everything here talks to the in-process `FakeCockpit`
through the station's transport, and nothing opens a socket. A run started by
hand is shown in its own process (`fake_cockpit_run.py`), where the claim is
asked before a session exists and the run's own shipper tells the cockpit how
it ended.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from engine import claims, events, factory, station, watch
from engine.data_types import ClaimAsk

from .asf_helpers import (asf, commit_all, envelope, fake_roster, forge, forge_data, issue_json,
                          session_dir, set_config)
from .fake_cockpit import FakeCockpit
from .test_asf_watchers import CONFIG, labels, open_pr, queued, tracked  # noqa: F401 — a fixture

URL = "http://cockpit.test:3211"
TOKEN = "asf_ingest_test"
RUNNER = Path(__file__).resolve().parent / "fake_cockpit_run.py"


@pytest.fixture
def shared(monkeypatch) -> FakeCockpit:
    """A shared cockpit every station in the test reaches, and nothing from the
    developer's shell leaking in."""
    for name in ("ASF_STATION_NAME", "CI", "ASF_TRIGGERED_BY", claims.CLAIMED_ENV):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ASF_COCKPIT_URL", URL)
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", TOKEN)
    cockpit = FakeCockpit(TOKEN)
    monkeypatch.setattr(station, "post", cockpit)
    return cockpit


def second_checkout(stamped: Path, where: Path) -> Path:
    """Another station on the same repository and the same forge: a copy of the
    checkout, before either has minted its station id."""
    other = where / "laptop-two" / stamped.name
    shutil.copytree(stamped, other)
    (other / "asf" / "data" / station.STATION_FILE).unlink(missing_ok=True)
    return other


# ── the watchers ─────────────────────────────────────────────────────────────

def test_two_stations_watchers_racing_for_one_labelled_issue_start_it_once(
        tracked, stamped, tmp_path, shared, monkeypatch, capsys):  # noqa: F811
    _cfg, listing = tracked
    # Both list #42 as queued: the second lists it before the first's flip shows.
    listing(queued(42))
    other = second_checkout(stamped, tmp_path)
    launched = []
    monkeypatch.setattr(watch, "launch",
                        lambda *a: launched.append((Path.cwd(), a[2].number)) or watch.EXIT_WAITING)

    for checkout in (stamped, other):
        monkeypatch.chdir(checkout)
        assert watch.issues_once(factory.load(CONFIG), CONFIG) == 0

    assert launched == [(stamped, 42)]
    assert shared.holder("issue", 42)
    # The loser never touched the label: one edit on #42, the winner's.
    assert labels(stamped, 42) == (["asf:running"], ["asf:queued"])
    out = capsys.readouterr().out
    assert "held by" in out and shared.claims[("acme/widgets", "issue", 42)].name in out


def test_the_winning_watcher_launches_the_session_its_claim_names(tracked, shared, monkeypatch):  # noqa: F811
    _cfg, listing = tracked
    listing(queued(42))
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or watch.EXIT_WAITING)
    watch.issues_once(factory.load(CONFIG), CONFIG)
    [item] = launched
    assert item.claim is not None and item.claim.session == shared.holder("issue", 42)


def test_a_claim_says_how_a_release_puts_the_item_back_in_this_factory_s_label_names(
        tracked, stamped, shared, monkeypatch):  # noqa: F811
    _cfg, listing = tracked
    set_config(stamped, issues={"states": {"queued": "todo", "running": "doing", "done": "done",
                                           "failed": "broken"}})
    listing(queued(42, "todo", "asf:ship"))
    monkeypatch.setattr(watch, "launch", lambda *a: watch.EXIT_WAITING)
    watch.issues_once(factory.load(CONFIG), CONFIG)
    assert shared.claims[("acme/widgets", "issue", 42)].requeue == {
        "add": ["todo"], "remove": ["doing", "broken", "done"]}


def test_a_session_re_entered_for_review_claims_only_what_comes_after_its_last_event(
        tracked, stamped, shared, monkeypatch):  # noqa: F811
    """Its earlier chapter's `session_finished`, shipped late by a station back
    from a weekend offline, is not the end of the run this claim is for."""
    _cfg, listing = tracked
    earlier = session_dir(stamped, "1d5e4c0e")
    earlier.mkdir(parents=True)
    for line in range(3):
        (earlier / events.EVENTS_FILE).open("a").write(json.dumps(
            {"seq": line + 1, "ts": "2026-10-01T00:00:00Z", "kind": "usage", "v": 1,
             "payload": {}}) + "\n")
    listing(open_pr(72, "asf/1d5e4c0e"))
    monkeypatch.setattr(watch, "has_work", lambda *a: True)
    monkeypatch.setattr(watch, "reap", lambda *a: 0)
    monkeypatch.setattr(watch, "launch", lambda *a: watch.EXIT_WAITING)
    watch.prs_once(factory.load(CONFIG), CONFIG)
    held = shared.claims[("acme/widgets", "pr", 72)]
    assert (held.session, held.since) == ("1d5e4c0e", 3)
    assert held.requeue == {"add": [], "remove": ["asf:pr-failed"]}


def test_a_claim_whose_label_would_not_flip_is_given_back(tracked, stamped, shared, monkeypatch):  # noqa: F811
    _cfg, listing = tracked
    listing(queued(42))
    forge_data(stamped, "refuse.json", ["edit"])
    monkeypatch.setattr(watch, "launch", lambda *a: pytest.fail("launched without its label"))
    watch.issues_once(factory.load(CONFIG), CONFIG)
    assert shared.holder("issue", 42) == ""
    assert shared.freed[-1]["why"] == "never started"


def test_a_watcher_that_cannot_reach_the_cockpit_leaves_the_issue_queued(tracked, stamped, shared,  # noqa: F811
                                                                         monkeypatch, capsys):
    _cfg, listing = tracked
    listing(queued(42))
    shared.down = True
    monkeypatch.setattr(watch, "launch", lambda *a: pytest.fail("launched without a claim"))
    watch.issues_once(factory.load(CONFIG), CONFIG)
    assert labels(stamped, 42) == ([], [])
    assert "left as it is" in capsys.readouterr().out


def test_a_cockpit_older_than_claims_is_no_claims_and_says_so_once_not_a_stop(
        tracked, stamped, shared, monkeypatch, capsys):  # noqa: F811
    _cfg, listing = tracked
    listing(queued(42), queued(43))
    shared.grants_claims = False
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or 0)
    watch.issues_once(factory.load(CONFIG), CONFIG)
    assert [item.number for item in launched] == [42, 43]
    assert all(item.claim is None for item in launched)
    assert capsys.readouterr().err.count("grants no claims") == 1


def test_the_pr_watcher_asks_for_the_pull_request_s_session_and_skips_one_held_elsewhere(
        tracked, shared, monkeypatch, capsys):  # noqa: F811
    _cfg, listing = tracked
    listing(open_pr(72, "asf/1d5e4c0e"), open_pr(73, "asf/2e6f5d1f"))
    shared.taken("pr", 73, session="2e6f5d1f", station="st_elsewhere")
    monkeypatch.setattr(watch, "has_work", lambda *a: True)
    monkeypatch.setattr(watch, "reap", lambda *a: 0)
    launched = []
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2]) or watch.EXIT_WAITING)

    watch.prs_once(factory.load(CONFIG), CONFIG)

    # #73's session is the same one, but another station took it: no run here.
    assert [item.number for item in launched] == [72]
    assert launched[0].claim.session == "1d5e4c0e" and shared.holder("pr", 72) == "1d5e4c0e"
    assert "#73" in capsys.readouterr().out


def test_the_launcher_tells_the_run_its_claim_so_the_run_does_not_ask_again(stamped, monkeypatch):
    seen = {}

    def fake_run(argv, cwd=None, env=None, **kwargs):
        seen.update(argv=argv, env=env)
        return subprocess.CompletedProcess(argv, 0)
    monkeypatch.setattr(watch.subprocess, "run", fake_run)
    claim = ClaimAsk(kind="issue", number=42, repo="acme/widgets", session="c1a1m0d1")
    watch.launch(CONFIG, stamped, watch.Launch(workflow="issue", number=42, claim=claim))
    assert seen["argv"][-2:] == ["--adw-id", "c1a1m0d1"]
    assert claims.launched_with(seen["env"], claim)


def test_without_a_shared_cockpit_the_issues_watcher_warns_once_that_one_watcher_is_safe(
        tracked, stamped, monkeypatch):  # noqa: F811
    monkeypatch.delenv("ASF_COCKPIT_URL", raising=False)
    commit_all(stamped)
    result = asf(stamped, "issues", "once")
    assert result.returncode == 0, result.stdout + result.stderr
    said = result.stdout + result.stderr
    assert said.count("one issues watcher per repository") == 1


def test_with_a_shared_cockpit_the_watcher_does_not_warn(tracked, stamped, monkeypatch):  # noqa: F811
    monkeypatch.setenv("ASF_COCKPIT_URL", URL)
    commit_all(stamped)
    result = asf(stamped, "issues", "once")
    assert "one issues watcher per repository" not in result.stdout + result.stderr


# ── a run started by hand ────────────────────────────────────────────────────

def an_issue_that_fails(stamped: Path) -> None:
    """Issue #42 on the fake forge, and a roster that gives up at once — the
    record is written before any agent is asked, and the session ends `fail`."""
    base = forge(stamped)
    set_config(stamped, issues={"enabled": True, "project": "acme/widgets",
                                "fetch_command": [*base, "view"],
                                "comment_command": [*base, "comment"],
                                "state_command": [*base, "edit"], "route": {"asf:ship": "issue"}})
    forge_data(stamped, "issue.json", issue_json(42))
    gives_up = [{"envelope": envelope(status="fail", summary="no")}]
    fake_roster(stamped, scout=gives_up, planner=gives_up, builder=gives_up, reviewer=gives_up,
                documenter=gives_up)
    commit_all(stamped)


def run_by_hand(stamped: Path, tmp_path: Path, *args: str, held: list[dict] = (),
                **cockpit) -> tuple:
    """`asf run issue 42 …` in a process whose cockpit is a FakeCockpit: (result, what it held).
    `cockpit` is the rest of the fake's spec: `abandoned`, `down`."""
    spec = tmp_path / "spec.json"
    out = tmp_path / "out.json"
    out.unlink(missing_ok=True)
    spec.write_text(json.dumps({"out": str(out), "station": "st_unregistered", "hold": list(held),
                                **cockpit}))
    result = subprocess.run([sys.executable, str(RUNNER), str(spec), "run", "issue", "42",
                             "--hitl", "none", *args], cwd=stamped, capture_output=True, text=True)
    return result, json.loads(out.read_text()) if out.exists() else {}


def test_a_run_by_hand_is_refused_an_issue_another_station_holds(stamped, tmp_path, shared):
    an_issue_that_fails(stamped)
    result, told = run_by_hand(stamped, tmp_path, held=[{"kind": "issue", "number": 42,
                                                         "session": "0therrun"}])
    assert result.returncode == 2, result.stdout + result.stderr
    assert "bob@laptop:widgets" in result.stderr and "--force" in result.stderr
    assert told["claims"] == {"issue 42": "0therrun"}
    assert not (stamped / "asf" / "data" / "sessions").is_dir() or not any(
        (stamped / "asf" / "data" / "sessions").iterdir())


def test_force_starts_a_run_by_hand_without_asking_for_a_claim(stamped, tmp_path, shared):
    an_issue_that_fails(stamped)
    result, told = run_by_hand(stamped, tmp_path, "--force",
                               held=[{"kind": "issue", "number": 42, "session": "0therrun"}])
    assert "session" in result.stdout + result.stderr and result.returncode not in (0, 2)
    assert told["claims"] == {"issue 42": "0therrun"}           # untouched: never asked


def test_a_failed_session_keeps_its_claim_so_resume_still_works(stamped, tmp_path, shared):
    an_issue_that_fails(stamped)
    result, told = run_by_hand(stamped, tmp_path)
    assert result.returncode not in (0, 2), result.stdout + result.stderr
    [adw_id] = told["claims"].values()
    finished = [line.payload["status"] for line in events.read(session_dir(stamped, adw_id))
                if line.kind == "session_finished"]
    assert finished == ["fail"]                                  # and the cockpit heard it
    assert told["stored"][adw_id]
    assert told["freed"] == []


def failed_and_held(stamped: Path, tmp_path: Path) -> tuple[str, dict]:
    """Issue #42's run, failed on this station: its session, and its claim as
    the shared cockpit still holds it."""
    an_issue_that_fails(stamped)
    _result, told = run_by_hand(stamped, tmp_path)
    [adw_id] = told["claims"].values()
    here = station.identify(stamped, "asf/data")
    return adw_id, {"kind": "issue", "number": 42, "session": adw_id, "station": here.id,
                    "name": here.name}


def resumed(stamped: Path, tmp_path: Path, adw_id: str, **cockpit) -> tuple:
    return run_by_hand(stamped, tmp_path, "--adw-id", adw_id, "--resume", **cockpit)


def test_a_failed_session_s_resume_is_granted_the_claim_it_kept(stamped, tmp_path, shared):
    adw_id, held = failed_and_held(stamped, tmp_path)
    result, told = resumed(stamped, tmp_path, adw_id, held=[held])
    assert result.returncode != 2, result.stdout + result.stderr
    assert told["claims"] == {"issue 42": adw_id}
    assert len([line for line in events.read(session_dir(stamped, adw_id))
                if line.kind == "session_finished"]) == 2         # it ran again


def test_a_session_a_writer_abandoned_is_not_resumed_beside_the_run_that_took_its_item(
        stamped, tmp_path, shared):
    adw_id, _held = failed_and_held(stamped, tmp_path)
    result, _told = resumed(stamped, tmp_path, adw_id,
                            abandoned=[{"session": adw_id, "by": "alex"}])
    assert result.returncode == 2, result.stdout + result.stderr
    assert "abandoned" in result.stderr and "alex" in result.stderr
    assert len([line for line in events.read(session_dir(stamped, adw_id))
                if line.kind == "session_finished"]) == 1         # it did not run again


def test_a_resume_goes_on_while_the_cockpit_does_not_answer(stamped, tmp_path, shared):
    """The session already holds its claim: an outage is no reason to stop it
    continuing — unlike a start, which an unanswered ask never begins."""
    adw_id, _held = failed_and_held(stamped, tmp_path)
    result, _told = resumed(stamped, tmp_path, adw_id, down=True)
    assert result.returncode != 2, result.stdout + result.stderr
    assert len([line for line in events.read(session_dir(stamped, adw_id))
                if line.kind == "session_finished"]) == 2


def test_a_review_run_that_died_before_its_session_started_gives_its_claim_back(
        tracked, shared, monkeypatch):  # noqa: F811
    _cfg, listing = tracked
    listing(open_pr(72, "asf/1d5e4c0e"))
    monkeypatch.setattr(watch, "has_work", lambda *a: True)
    monkeypatch.setattr(watch, "reap", lambda *a: 0)
    monkeypatch.setattr(watch, "launch", lambda *a: 1)
    watch.prs_once(factory.load(CONFIG), CONFIG)
    assert shared.holder("pr", 72) == "" and shared.freed[-1]["why"] == "never started"

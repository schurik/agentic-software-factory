"""Stations a cockpit can steer: registering, the command poll, and kill.

The station ↔ cockpit wire seam from spec #40: everything here talks to the
in-process `FakeCockpit` through the station's injected transport and never
opens a socket. A kill is shown both ways it can arrive — through the station
loop, which signals a run in another process, and through the run's own
shipper, which stops the run from inside (`fake_cockpit_run.py`).
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from engine import commands, events, factory, station
from engine.data_types import Cockpit, Command, StationCredential

from .asf_helpers import (PY_CHECK, commit_all, fake_roster, git, run_state, session_dir,
                          set_config, wire)
from .fake_cockpit import FakeCockpit
from .test_asf_events import build_reply, plan_reply

DATA_DIR = "asf/data"
URL = "http://cockpit.test:3211"
COCKPIT = Cockpit(url=URL, token="asf_ingest_test")
RUNNER = Path(__file__).resolve().parent / "fake_cockpit_run.py"


@pytest.fixture(autouse=True)
def a_shared_cockpit(monkeypatch):
    """Every test here has a shared cockpit configured, and nothing from the
    developer's shell leaks in (nor into the `asf` subprocesses, which inherit
    os.environ)."""
    for name in ("ASF_STATION_NAME", "CI", "ASF_TRIGGERED_BY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ASF_COCKPIT_URL", URL)
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", COCKPIT.token)


def loaded(repo: Path, monkeypatch) -> factory.FactoryConfig:
    monkeypatch.chdir(repo)
    return factory.load("asf/factory.yaml")


def registered(repo: Path, cockpit: FakeCockpit) -> StationCredential:
    """This checkout, approved earlier: the token kept where `register` keeps it."""
    here = station.identify(repo, DATA_DIR)
    held = StationCredential(cockpit=URL, station=here.id, token=cockpit.admit(here.id),
                             owner="alex")
    station.keep(repo, DATA_DIR, held)
    return held


def a_session(repo: Path, adw_id: str = "5e55i0n1") -> Path:
    """A session this station holds, with nothing running."""
    directory = session_dir(repo, adw_id)
    directory.mkdir(parents=True)
    (directory / "run.json").write_text(json.dumps({"adw_id": adw_id, "status": "success"}))
    return directory


# ── registering ──────────────────────────────────────────────────────────────

def test_register_prints_a_code_and_keeps_the_token_the_person_s_approval_issues(
        stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    said: list[str] = []

    def a_person_approves(_seconds: float) -> None:
        cockpit.approve(cockpit.registrations[0].code, owner="alex")

    assert commands.register(cfg, cockpit, wait=a_person_approves, say=said.append) == 0

    here = station.identify(stamped, DATA_DIR)
    held = station.credential(stamped, DATA_DIR)
    assert held is not None and held.station == here.id and held.owner == "alex"
    assert held.cockpit == URL and cockpit.stations[held.token] == here.id
    shown = "\n".join(said)
    assert "ABCD-0001" in shown and "http://cockpit.test/stations/approve?code=ABCD-0001" in shown
    assert "kill" in shown                               # what it now obeys, from factory.yaml
    assert "station-token.json" not in git(stamped, "status", "--porcelain")


def test_register_waits_while_nobody_has_approved_and_gives_up_when_the_code_expires(
        stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    waits: list[float] = []

    assert commands.register(cfg, cockpit, wait=waits.append, say=lambda _: None) == 1
    assert len(waits) == 5                               # expires_in / interval
    assert station.credential(stamped, DATA_DIR) is None


def test_a_ci_station_takes_no_commands_and_so_never_registers(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    monkeypatch.setenv("CI", "true")
    cockpit = FakeCockpit()
    said: list[str] = []

    assert commands.register(cfg, cockpit, wait=lambda _: None, say=said.append) == 1
    assert cockpit.registrations == [] and "CI station" in said[0]


def test_register_without_a_shared_cockpit_says_a_local_one_needs_none(stamped: Path,
                                                                        monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    monkeypatch.delenv("ASF_COCKPIT_URL")
    said: list[str] = []

    assert commands.register(cfg, FakeCockpit(), wait=lambda _: None, say=said.append) == 1
    assert "local cockpit" in said[0]


# ── the poll and its report ──────────────────────────────────────────────────

def test_every_poll_reports_the_verbs_it_obeys_its_commit_its_config_and_its_watchers(
        stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    held = registered(stamped, cockpit)
    loop_side = commands.Steering(cfg, stamped, lambda: held, watchers=lambda: ["issues"])
    run_side = commands.Steering(cfg, stamped, lambda: held, session="5e55i0n1")

    loop_side.poll(COCKPIT, cockpit)
    run_side.poll(COCKPIT, cockpit)

    station_poll, session_poll = cockpit.polls
    assert station_poll.station == held.station and station_poll.session == ""
    report = station_poll.report
    assert report["verbs"] == ["kill"]                   # the stamped default
    assert report["head"] == git(stamped, "rev-parse", "HEAD")
    assert len(report["config_hash"]) == 64 and report["watchers"] == ["issues"]
    assert session_poll.session == "5e55i0n1" and session_poll.report["watchers"] is None


def test_the_config_hash_moves_with_a_local_edit_under_asf_and_not_with_runtime(
        stamped: Path):
    before = commands.config_hash(stamped, DATA_DIR)
    a_session(stamped)                                   # runtime, gitignored
    assert commands.config_hash(stamped, DATA_DIR) == before

    set_config(stamped, cockpit={"commands": []})
    assert commands.config_hash(stamped, DATA_DIR) != before


def test_a_verb_opted_in_that_this_release_cannot_carry_out_is_not_reported(
        stamped: Path, monkeypatch):
    set_config(stamped, cockpit={"commands": ["kill", "resume", "run"]})
    cfg = loaded(stamped, monkeypatch)

    assert commands.obeyed(cfg) == ["kill"]


def test_an_unknown_verb_in_factory_yaml_is_refused_at_load(stamped: Path, monkeypatch):
    set_config(stamped, cockpit={"commands": ["kill", "reboot"]})
    monkeypatch.chdir(stamped)

    with pytest.raises((SystemExit, ValueError)):
        factory.load("asf/factory.yaml")


def test_a_station_that_is_not_registered_polls_nothing(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()

    commands.Steering(cfg, stamped, lambda: None).poll(COCKPIT, cockpit)

    assert cockpit.polls == []


def test_a_revoked_token_stops_commands_reaching_the_station_and_shipping_goes_on(
        stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    held = registered(stamped, cockpit)
    session = a_session(stamped)
    steering = commands.Steering(cfg, stamped, lambda: held, interval=0)
    said: list[str] = []
    steering.say = said.append

    cockpit.revoke(held.station)
    cockpit.queue("kill", session.name)
    steering.poll(COCKPIT, cockpit)
    steering.poll(COCKPIT, cockpit)

    assert steering.revoked and cockpit.polls == [] and cockpit.queued[0].delivered == 0
    assert len(said) == 1 and "refused this station's command token" in said[0]
    events.emit(session, events.EVENT_KINDS["process_ended"](pid=1))
    assert station.ship(session, COCKPIT, cockpit).outcome == "shipped"


# ── what a station refuses, and says it refused ──────────────────────────────

def refused_with(repo: Path, monkeypatch, by: str = "alex", expires_at: int = 0,
                 **config) -> tuple[bool, str]:
    """Queue a kill of the session `a_session` made, let the station loop take
    it, ship the session, and say what the cockpit heard back."""
    if config:
        set_config(repo, **config)
    cfg = loaded(repo, monkeypatch)
    cockpit = FakeCockpit()
    held = registered(repo, cockpit)
    session = a_session(repo)
    command = cockpit.queue("kill", session.name, by=by, expires_at=expires_at)
    commands.Steering(cfg, repo, lambda: held).poll(COCKPIT, cockpit)
    station.ship(session, COCKPIT, cockpit)              # the result goes back with the session
    return cockpit.results[command]["ok"], cockpit.results[command]["detail"]


def test_a_kill_that_is_not_opted_in_is_refused_and_the_refusal_reaches_the_cockpit(
        stamped: Path, monkeypatch):
    ok, detail = refused_with(stamped, monkeypatch, cockpit={"commands": []})

    assert not ok and "not opted in" in detail and "cockpit.commands" in detail


def test_a_command_from_someone_outside_trusted_authors_is_refused_and_reported(
        stamped: Path, monkeypatch):
    ok, detail = refused_with(stamped, monkeypatch, by="mallory",
                              issues={"trusted_authors": ["Alex", "sam"]})

    assert not ok and "mallory is not in issues.trusted_authors" in detail


def test_a_trusted_author_is_matched_as_the_forge_matches_logins(stamped: Path, monkeypatch):
    set_config(stamped, issues={"trusted_authors": ["Alex"]})
    cfg = loaded(stamped, monkeypatch)
    a_session(stamped)

    assert commands.refusal(cfg, stamped, Command(id="c", verb="kill", session="5e55i0n1",
                                                  by="alex")) == ""


def test_a_command_past_its_expiry_is_refused_however_late_it_arrives(stamped: Path,
                                                                     monkeypatch):
    ok, detail = refused_with(stamped, monkeypatch,
                              expires_at=int(time.time() * 1000) - 60_000)

    assert not ok and "expired" in detail


def test_a_command_with_no_author_or_no_such_session_is_refused(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    a_session(stamped)

    nobody = commands.refusal(cfg, stamped, Command(id="c", verb="kill", session="5e55i0n1"))
    elsewhere = commands.refusal(cfg, stamped, Command(id="c", verb="kill", session="0ther000",
                                                       by="alex"))
    unknown = commands.refusal(cfg, stamped, Command(id="c", verb="reboot", session="5e55i0n1",
                                                     by="alex"))

    assert "who asked" in nobody
    assert "no session 0ther000" in elsewhere
    assert "not a command" in unknown


def test_a_command_delivered_twice_is_carried_out_once(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    session = a_session(stamped)
    command = Command(id="cmd1", verb="kill", session=session.name, by="alex")

    first = commands.carry_out(cfg, stamped, command)
    again = commands.carry_out(cfg, stamped, command)

    assert first == again and first.ok                   # nothing was running: nothing to do
    results = [line for line in events.read(session) if line.kind == "command_result"]
    assert len(results) == 1 and results[0].payload["command_id"] == "cmd1"
    assert commands.recorded(stamped, DATA_DIR, "cmd1") == first


# ── kill, end to end on the fake harness ─────────────────────────────────────

def a_slow_run(repo: Path, **config) -> None:
    """An sdlc run whose planner takes half a minute: long enough to be killed."""
    fake_roster(repo, planner=[{**plan_reply(), "sleep": 30}],
                builder=[build_reply("ok = 1\n", "feat: app")])
    wire(repo, "test", PY_CHECK)
    if config:
        set_config(repo, **config)
    commit_all(repo)


def ended(repo: Path, adw_id: str) -> list[str]:
    """Why the session says it ended: the reason on each `session_finished` —
    the signal handler's, then the failed phase's on the way out."""
    assert run_state(repo, adw_id)["status"] == "fail"
    return [line.payload["reason"] for line in events.read(session_dir(repo, adw_id))
            if line.kind == "session_finished"]


def eventually(check, within: float = 20.0) -> bool:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.1)
    return check()


def test_a_kill_from_the_cockpit_stops_a_live_run_from_inside_it_gracefully(stamped: Path,
                                                                           tmp_path: Path):
    a_slow_run(stamped)
    here = station.identify(stamped, DATA_DIR)
    station.keep(stamped, DATA_DIR, StationCredential(cockpit=URL, station=here.id,
                                                      token="asf_station_test", owner="alex"))
    spec = tmp_path / "spec.json"
    told = tmp_path / "told.json"
    spec.write_text(json.dumps({"out": str(told), "station": here.id,
                                "queue": [{"verb": "kill", "session": "k1ll0000", "by": "alex"}]}))

    began = time.monotonic()
    result = subprocess.run([sys.executable, str(RUNNER), str(spec), "run", "sdlc", "add app.py",
                             "--adw-id", "k1ll0000"],
                            cwd=stamped, capture_output=True, text=True, stdin=subprocess.DEVNULL)

    assert result.returncode == 128 + 15, result.stdout + result.stderr
    assert time.monotonic() - began < 25                 # not the planner's 30 seconds
    assert "stopped by signal 15" in ended(stamped, "k1ll0000")
    seen = json.loads(told.read_text())
    assert seen["results"]["cmd1"]["ok"] is True
    kinds = [event["kind"] for _, event in sorted(seen["stored"]["k1ll0000"].items(),
                                                  key=lambda item: int(item[0]))]
    assert "command_result" in kinds and kinds[-1] == "session_finished"
    assert any(poll["session"] == "k1ll0000" for poll in seen["polls"])   # attended
    assert commands.recorded(stamped, DATA_DIR, "cmd1").ok


def test_a_kill_through_the_station_loop_stops_a_run_in_another_process(stamped: Path,
                                                                        monkeypatch):
    a_slow_run(stamped)
    cfg = loaded(stamped, monkeypatch)
    monkeypatch.delenv("ASF_COCKPIT_URL")                 # the run ships nothing of its own
    run = subprocess.Popen([sys.executable, "asf/asf.py", "run", "sdlc", "add app.py",
                            "--adw-id", "l00pk111"], cwd=stamped, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Reaped as soon as it exits: this test is the run's parent, and a zombie
    # answers a signal-0 probe as if it were alive. A station loop never is.
    threading.Thread(target=run.wait, daemon=True).start()
    try:
        assert eventually(lambda: any(line.kind == "phase_started"
                                      for line in events.read(session_dir(stamped, "l00pk111"))))
        cockpit = FakeCockpit()
        held = registered(stamped, cockpit)
        cockpit.queue("kill", "l00pk111")
        commands.Steering(cfg, stamped, lambda: held).poll(COCKPIT, cockpit)

        assert run.wait(timeout=20) == 128 + 15
    finally:
        if run.poll() is None:
            run.kill()
    assert "stopped by signal 15" in ended(stamped, "l00pk111")
    record = commands.recorded(stamped, DATA_DIR, "cmd1")
    assert record.ok and "stopped" in record.detail

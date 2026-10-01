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

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster, git,
                          run_state, session_dir, set_config, wire, write_workflow)
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
    loop_side = commands.Steering(commands.Here(cfg, stamped), lambda: held, watchers=lambda: ["issues"])
    run_side = commands.Steering(commands.Here(cfg, stamped), lambda: held, session="5e55i0n1")

    loop_side.poll(COCKPIT, cockpit)
    run_side.poll(COCKPIT, cockpit)

    station_poll, session_poll = cockpit.polls
    assert station_poll.station == held.station and station_poll.session == ""
    report = station_poll.report
    assert report["verbs"] == ["answer", "abort", "kill", "resume"]   # the stamped default
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


def test_every_verb_of_the_vocabulary_is_carried_out_once_opted_in_and_run_is_not_by_default(
        stamped: Path, monkeypatch):
    assert "run" not in commands.obeyed(loaded(stamped, monkeypatch))

    set_config(stamped, cockpit={"commands": ["kill", "resume", "run", "answer", "abort"]})
    cfg = loaded(stamped, monkeypatch)

    assert commands.obeyed(cfg) == ["kill", "resume", "run", "answer", "abort"]


def test_an_unknown_verb_in_factory_yaml_is_refused_at_load(stamped: Path, monkeypatch):
    set_config(stamped, cockpit={"commands": ["kill", "reboot"]})
    monkeypatch.chdir(stamped)

    with pytest.raises((SystemExit, ValueError)):
        factory.load("asf/factory.yaml")


def test_a_station_that_is_not_registered_polls_nothing(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()

    commands.Steering(commands.Here(cfg, stamped), lambda: None).poll(COCKPIT, cockpit)

    assert cockpit.polls == []


def test_a_revoked_token_stops_commands_reaching_the_station_and_shipping_goes_on(
        stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    held = registered(stamped, cockpit)
    session = a_session(stamped)
    steering = commands.Steering(commands.Here(cfg, stamped), lambda: held)
    steering.interval = 0
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
    commands.Steering(commands.Here(cfg, repo), lambda: held).poll(COCKPIT, cockpit)
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

    assert commands.refusal(commands.Here(cfg, stamped),
                            Command(id="c", verb="kill", session="5e55i0n1", by="alex")) == ""


def test_a_command_past_its_expiry_is_refused_however_late_it_arrives(stamped: Path,
                                                                     monkeypatch):
    ok, detail = refused_with(stamped, monkeypatch,
                              expires_at=int(time.time() * 1000) - 60_000)

    assert not ok and "expired" in detail


def test_a_command_with_no_author_or_no_such_session_is_refused(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    a_session(stamped)

    here = commands.Here(cfg, stamped)
    nobody = commands.refusal(here, Command(id="c", verb="kill", session="5e55i0n1"))
    elsewhere = commands.refusal(here, Command(id="c", verb="kill", session="0ther000", by="alex"))
    unknown = commands.refusal(here, Command(id="c", verb="reboot", session="5e55i0n1", by="alex"))

    assert "who asked" in nobody
    assert "no session 0ther000" in elsewhere
    assert "not a command" in unknown


def test_a_command_delivered_twice_is_carried_out_once(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    session = a_session(stamped)
    command = Command(id="cmd1", verb="kill", session=session.name, by="alex")

    first = commands.carry_out(commands.Here(cfg, stamped), command)
    again = commands.carry_out(commands.Here(cfg, stamped), command)

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
        commands.Steering(commands.Here(cfg, stamped), lambda: held).poll(COCKPIT, cockpit)

        assert run.wait(timeout=20) == 128 + 15
    finally:
        if run.poll() is None:
            run.kill()
    assert "stopped by signal 15" in ended(stamped, "l00pk111")
    record = commands.recorded(stamped, DATA_DIR, "cmd1")
    assert record.ok and "stopped" in record.detail


# ── resume, the answers a terminal waits for, and run ────────────────────────
#
# Each of these acts on a session in ANOTHER process, so the station launches
# it — `asf resume`, `asf run` — detached, and the station loop goes on
# polling. The tests that prove a run actually continues use that real
# launcher and wait for the session to say so; the rest record what would have
# been launched (`recording`), because what they assert is the decision.


@pytest.fixture
def runs_ship_nowhere(monkeypatch):
    """The runs these tests start ship nothing of their own: the station's
    polls are what is under test, and they are handed the fake directly."""
    monkeypatch.delenv("ASF_COCKPIT_URL")


def recording(launched: list) -> commands.Launcher:
    def launch(argv: list[str], env: dict[str, str], cwd: Path, log: Path) -> int:
        launched.append((argv, env))
        return 4242
    return launch


def a_station_loop(repo: Path, cfg: factory.FactoryConfig, cockpit: FakeCockpit,
                   **here) -> commands.Steering:
    held = registered(repo, cockpit)
    steering = commands.Steering(commands.Here(cfg, repo, **here), lambda: held)
    steering.interval = 0
    return steering


def a_failed_session(repo: Path) -> str:
    """A chain whose builder claims a file it never writes: it fails at
    implement with the plan on the record. Then the builder is scripted right
    — somebody fixed what made it fail — and the session is left to resume."""
    fake_roster(repo, planner=[plan_reply()],
                builder=[{"envelope": envelope(changed_files=["app.py"], commit_message="feat: app")}])
    wire(repo, "test", PY_CHECK)
    write_workflow(repo, "recoverable", {
        "description": "a chain whose builder gets it wrong the first time",
        "stages": [{"plan": {}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(repo)
    failed = asf(repo, "run", "recoverable", "add app.py")
    assert failed.returncode == 1, failed.stdout + failed.stderr
    fake_roster(repo, builder=[build_reply("ok = 1\n", "feat: app")])
    return adw_id_of(failed)


def a_gated_run(repo: Path) -> str:
    """A prompt run — no work item, so its plan gate waits on the terminal channel."""
    fake_roster(repo, planner=[plan_reply()], builder=[build_reply("ok = 1\n", "feat: app")])
    wire(repo, "test", PY_CHECK)
    write_workflow(repo, "gated", {
        "description": "a plan a person approves before anything is built",
        "stages": [{"plan": {"hitl": True}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(repo)
    adw_id = adw_id_of(asf(repo, "run", "gated", "add app.py"))
    assert run_state(repo, adw_id)["waiting_for"]["channel"] == "terminal"
    return adw_id


def answering(repo: Path, adw_id: str, **fields) -> dict:
    """The wait a person was shown, as an answer command names it."""
    waiting = run_state(repo, adw_id)["waiting_for"]
    return {"gate": waiting["gate"], "round": waiting["round"],
            "digest": waiting["subject_digest"], **fields}


def a_session_that(repo: Path, adw_id: str = "5e55i0n1", **run) -> Path:
    directory = session_dir(repo, adw_id)
    directory.mkdir(parents=True)
    (directory / "run.json").write_text(json.dumps({"adw_id": adw_id, **run}))
    return directory


def test_resume_relaunches_a_failed_session_on_its_station_and_the_run_finishes(
        stamped: Path, monkeypatch, runs_ship_nowhere):
    adw_id = a_failed_session(stamped)
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    command = cockpit.queue("resume", adw_id)

    a_station_loop(stamped, cfg, cockpit).poll(COCKPIT, cockpit)

    record = commands.recorded(stamped, DATA_DIR, command)
    assert record.ok and "relaunched" in record.detail
    assert eventually(lambda: run_state(stamped, adw_id)["status"] == "success", within=60)
    kinds = [line.kind for line in events.read(session_dir(stamped, adw_id))]
    assert "session_resumed" in kinds and "command_result" in kinds
    station.ship(session_dir(stamped, adw_id), COCKPIT, cockpit)
    assert cockpit.results[command]["ok"] is True


def test_a_resume_delivered_twice_relaunches_once(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    session = a_session_that(stamped, status="fail", workflow="quick",
                             command=["asf.py", "run", "quick", "add app.py"])
    launched: list = []
    here = commands.Here(cfg, stamped, launch=recording(launched))
    command = Command(id="r1", verb="resume", session=session.name, by="alex")

    first = commands.carry_out(here, command)
    again = commands.carry_out(here, command)

    assert first == again and first.ok and len(launched) == 1
    argv, env = launched[0]
    assert argv[-2:] == ["resume", session.name] and "--config" in argv
    assert env[commands.hitl.UNATTENDED_ENV] == "1"


def test_resume_is_refused_for_a_session_still_waiting_on_its_gate_and_nothing_is_launched(
        stamped: Path, monkeypatch, runs_ship_nowhere):
    adw_id = a_gated_run(stamped)
    cfg = loaded(stamped, monkeypatch)
    launched: list = []

    record = commands.carry_out(commands.Here(cfg, stamped, launch=recording(launched)),
                                Command(id="r1", verb="resume", session=adw_id, by="alex"))

    assert not record.ok and "no decision recorded" in record.detail and launched == []


def test_an_expired_resume_or_run_never_launches(stamped: Path, monkeypatch):
    set_config(stamped, cockpit={"commands": ["resume", "run"]})
    cfg = loaded(stamped, monkeypatch)
    session = a_session_that(stamped, status="fail", command=["asf.py", "run", "quick", "x"])
    launched: list = []
    here = commands.Here(cfg, stamped, owner="alex", launch=recording(launched))
    past = int(time.time() * 1000) - 1

    resumed = commands.carry_out(here, Command(id="r1", verb="resume", session=session.name,
                                               by="alex", expires_at=past))
    ran = commands.carry_out(here, Command(id="r2", verb="run", workflow="quick", prompt="x",
                                           by="alex", expires_at=past))

    assert not resumed.ok and not ran.ok and "expired" in resumed.detail + ran.detail
    assert launched == []


def test_a_terminal_channel_gate_answered_by_command_is_the_person_s_decision_and_the_run_goes_on(
        stamped: Path, monkeypatch, runs_ship_nowhere):
    adw_id = a_gated_run(stamped)
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    command = cockpit.queue("answer", adw_id,
                            **answering(stamped, adw_id, verdict="approve", notes="keep it small"))

    a_station_loop(stamped, cfg, cockpit).poll(COCKPIT, cockpit)

    assert commands.recorded(stamped, DATA_DIR, command).ok
    decision = json.loads((session_dir(stamped, adw_id) / "decisions" / "plan_1.json").read_text())
    assert decision["verdict"] == "approve" and decision["notes"] == "keep it small"
    assert decision["by"] == "alex" and decision["channel"] == "cockpit"
    assert eventually(lambda: run_state(stamped, adw_id)["status"] == "success", within=60)
    assert git(stamped, "log", "-1", "--format=%s", f"asf/{adw_id}") == "feat: app"


def test_an_answer_to_a_subject_that_changed_or_a_round_already_decided_is_refused(
        stamped: Path, monkeypatch, runs_ship_nowhere):
    adw_id = a_gated_run(stamped)
    cfg = loaded(stamped, monkeypatch)
    launched: list = []
    here = commands.Here(cfg, stamped, launch=recording(launched))

    def answer(command_id: str, **fields) -> str:
        record = commands.carry_out(here, Command(
            id=command_id, verb="answer", session=adw_id, by="alex",
            **answering(stamped, adw_id, **{"verdict": "approve", **fields})))
        assert not record.ok
        return record.detail

    assert "changed" in answer("a1", digest="0" * 64)
    assert "no longer waiting at plan round 2" in answer("a2", round=2)
    assert "needs notes" in answer("a3", verdict="reject")
    asf(stamped, "approve", adw_id, "--no-resume")
    assert "already recorded" in answer("a4")
    assert launched == []
    assert json.loads((session_dir(stamped, adw_id) / "decisions" / "plan_1.json")
                      .read_text())["channel"] == "cli"


def test_a_gate_on_a_work_item_is_answered_on_the_forge_never_by_command(stamped: Path,
                                                                        monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    session = a_session_that(stamped, status="waiting", waiting_for={
        "gate": "plan", "round": 1, "channel": "issue", "issue_number": 42,
        "subject_digest": "d1"})

    refused = commands.refusal(commands.Here(cfg, stamped), Command(
        id="a1", verb="answer", verdict="approve", session=session.name, by="alex",
        gate="plan", round=1, digest="d1"))

    assert "issue #42" in refused


def test_a_gate_on_a_pull_request_is_not_answered_by_command_either(stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    session = a_session_that(stamped, status="waiting", waiting_for={
        "gate": "plan", "round": 1, "channel": "pr", "subject_digest": "d1"})

    refused = commands.refusal(commands.Here(cfg, stamped), Command(
        id="a1", verb="answer", verdict="approve", session=session.name, by="alex",
        gate="plan", round=1, digest="d1"))

    assert "pr channel" in refused


def test_an_answer_to_a_run_whose_process_is_gone_relaunches_it_rather_than_wait_on_nobody(
        stamped: Path, monkeypatch):
    cfg = loaded(stamped, monkeypatch)
    session = a_session_that(stamped, status="running", pid=2 ** 22 + 7, command=["asf.py", "run"],
                             waiting_for={"gate": "plan", "round": 1, "channel": "terminal",
                                          "subject_digest": "d1"})
    launched: list = []

    record = commands.carry_out(commands.Here(cfg, stamped, launch=recording(launched)), Command(
        id="a1", verb="answer", verdict="approve", session=session.name, by="alex",
        gate="plan", round=1, digest="d1"))

    assert record.ok and "relaunched" in record.detail
    assert launched[0][0][-2:] == ["resume", session.name]


def test_abort_by_command_ends_a_run_waiting_at_its_gate(stamped: Path, monkeypatch,
                                                        runs_ship_nowhere):
    adw_id = a_gated_run(stamped)
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    command = cockpit.queue("abort", adw_id, **answering(stamped, adw_id, notes="not now"))

    a_station_loop(stamped, cfg, cockpit).poll(COCKPIT, cockpit)

    assert commands.recorded(stamped, DATA_DIR, command).ok
    decision = json.loads((session_dir(stamped, adw_id) / "decisions" / "plan_1.json").read_text())
    assert decision["verdict"] == "abort" and decision["by"] == "alex"
    assert eventually(lambda: run_state(stamped, adw_id)["status"] == "fail", within=60)


def a_prompt_workflow(repo: Path, verbs: tuple[str, ...] = ("kill", "run")) -> None:
    fake_roster(repo, planner=[plan_reply()])
    write_workflow(repo, "planned", {"description": "a plan, and nothing after it",
                                     "stages": [{"plan": {}}]})
    set_config(repo, cockpit={"commands": list(verbs)})
    commit_all(repo)


def run_refused(repo: Path, monkeypatch, by: str = "alex", **fields) -> str:
    """Queue a run, let the station loop take it, and say what the cockpit heard
    back — with the poll after it, since a run that started nothing has no
    session for its result to travel in."""
    cfg = loaded(repo, monkeypatch)
    cockpit = FakeCockpit()
    launched: list = []
    steering = a_station_loop(repo, cfg, cockpit, launch=recording(launched))
    fields = {"workflow": "planned", "prompt": "plan it", **fields}
    # An id of its own per ask: the same id twice is one command, carried out once.
    command = cockpit.queue("run", "", by=by, id=f"run-{abs(hash((by, *fields.values())))}",
                            **fields)
    steering.poll(COCKPIT, cockpit)
    steering.poll(COCKPIT, cockpit)
    assert launched == [] and cockpit.results[command]["ok"] is False
    return cockpit.results[command]["detail"]


def test_run_is_refused_unless_the_repository_opted_it_in(stamped: Path, monkeypatch):
    a_prompt_workflow(stamped, verbs=("kill",))

    assert "run is not opted in" in run_refused(stamped, monkeypatch)


def test_run_is_refused_from_anyone_but_the_station_s_own_person(stamped: Path, monkeypatch):
    a_prompt_workflow(stamped)

    detail = run_refused(stamped, monkeypatch, by="sam")

    assert "sam" in detail and "alex's station" in detail


def test_run_names_a_workflow_that_takes_a_prompt_or_is_refused(stamped: Path, monkeypatch):
    a_prompt_workflow(stamped)

    assert "no workflow 'nope'" in run_refused(stamped, monkeypatch, workflow="nope")
    assert "takes input: issue" in run_refused(stamped, monkeypatch, workflow="issue")
    assert "no prompt" in run_refused(stamped, monkeypatch, prompt="  ")


def test_run_starts_a_prompt_workflow_on_its_owner_s_station_as_them_and_only_once(
        stamped: Path, monkeypatch, runs_ship_nowhere):
    a_prompt_workflow(stamped)
    cfg = loaded(stamped, monkeypatch)
    cockpit = FakeCockpit()
    steering = a_station_loop(stamped, cfg, cockpit)
    command = cockpit.queue("run", "", workflow="planned", prompt="plan the health check")

    steering.poll(COCKPIT, cockpit)

    record = commands.recorded(stamped, DATA_DIR, command)
    assert record.ok and record.started and record.started in record.detail
    adw_id = record.started
    assert eventually(lambda: (session_dir(stamped, adw_id) / "run.json").is_file()
                      and run_state(stamped, adw_id)["status"] == "success", within=60)
    state = run_state(stamped, adw_id)
    assert state["workflows"] == ["planned"] and state["triggered_by"] == "alex"
    started = next(line for line in events.read(session_dir(stamped, adw_id))
                   if line.kind == "session_started")
    assert started.payload["request"] == "plan the health check"

    steering.poll(COCKPIT, cockpit)                      # the result rides the next poll
    assert cockpit.results[command] == {"command_id": command, "verb": "run", "adw_id": adw_id,
                                        "by": "alex", "ok": True, "detail": record.detail}
    again = commands.carry_out(commands.Here(cfg, stamped, owner="alex"),
                               Command(id=command, verb="run", workflow="planned",
                                       prompt="plan the health check", by="alex"))
    assert again == record
    assert len(list((stamped / DATA_DIR / "sessions").iterdir())) == 1

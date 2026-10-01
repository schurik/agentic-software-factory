"""A checkout as a station: who it is, and how its sessions reach a cockpit.

Two seams from the cockpit spec (#40): the station's HTTP client sits behind an
injected transport, so these tests drive it against an in-process fake cockpit
(`fake_cockpit.py`) and never open a socket; and a fake-harness run in a real
stamped repo shows what a session carries and leaves behind.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from engine import events, factory, station
from engine.data_types import EVENT_KINDS, Cockpit

from .fake_cockpit import FakeCockpit
from .asf_helpers import PY_CHECK, adw_id_of, asf, commit_all, fake_roster, git, session_dir, wire
from .test_asf_events import build_reply, plan_reply

DATA_DIR = "asf/data"


@pytest.fixture(autouse=True)
def no_cockpit_from_the_shell(monkeypatch):
    """A developer's own cockpit settings must not leak into a test, nor into
    the `asf` subprocesses a test starts (they inherit os.environ)."""
    for name in ("ASF_COCKPIT_URL", "ASF_COCKPIT_TOKEN", "ASF_STATION_NAME", "CI"):
        monkeypatch.delenv(name, raising=False)


# ── identity ─────────────────────────────────────────────────────────────────

def test_a_station_gets_an_id_once_and_keeps_it(tmp_path: Path):
    first = station.identify(tmp_path, DATA_DIR)
    again = station.identify(tmp_path, DATA_DIR)

    assert first.id.startswith("st_") and len(first.id) > len("st_")
    assert again.id == first.id
    recorded = json.loads((tmp_path / DATA_DIR / "station.json").read_text())
    assert recorded["id"] == first.id
    assert station.identify(tmp_path / "elsewhere", DATA_DIR).id != first.id


def test_a_filesystem_without_hard_links_still_gets_a_station(tmp_path: Path, monkeypatch):
    def refused(*_):
        raise PermissionError("hard links are not supported here")
    monkeypatch.setattr(station.os, "link", refused)

    first = station.identify(tmp_path, DATA_DIR)

    assert station.identify(tmp_path, DATA_DIR).id == first.id


def test_a_station_s_name_is_login_at_host_colon_directory_unless_env_names_it(
        tmp_path: Path, monkeypatch):
    root = tmp_path / "widgets"
    root.mkdir()
    monkeypatch.setattr(station, "_login", lambda: "alex")
    monkeypatch.setattr(station, "_host", lambda: "mbp")

    assert station.identify(root, DATA_DIR).name == "alex@mbp:widgets"

    monkeypatch.setenv("ASF_STATION_NAME", "build box")
    assert station.identify(root, DATA_DIR).name == "build box"


def test_a_station_is_ci_under_a_ci_job_and_local_otherwise(tmp_path: Path, monkeypatch):
    assert station.identify(tmp_path, DATA_DIR).kind == "local"
    monkeypatch.setenv("CI", "true")
    assert station.identify(tmp_path, DATA_DIR).kind == "ci"


# ── what a run carries ───────────────────────────────────────────────────────

def a_run(repo: Path) -> str:
    """One fake-harness sdlc run, finished and accepted. Its adw_id."""
    fake_roster(repo, planner=[plan_reply()], builder=[build_reply("ok = 1\n", "feat: app")])
    wire(repo, "test", PY_CHECK)
    commit_all(repo)
    result = asf(repo, "run", "sdlc", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    return adw_id_of(result)


def test_a_session_names_the_station_it_started_on_and_the_station_stays_out_of_git(
        stamped: Path):
    adw_id = a_run(stamped)

    started = events.read(session_dir(stamped, adw_id))[0]
    recorded = json.loads((stamped / DATA_DIR / "station.json").read_text())
    assert started.kind == "session_started"
    assert started.payload["station_id"] == recorded["id"]
    assert started.payload["station_name"].endswith(f":{stamped.name}")
    assert started.payload["station_kind"] == "local"     # a cockpit resumes it; CI's it would not
    assert not (session_dir(stamped, adw_id) / station.SHIPPED_FILE).exists()   # no cockpit
    assert "station.json" not in git(stamped, "status", "--porcelain", "--ignored=no")
    git(stamped, "check-ignore", "-q", f"{DATA_DIR}/station.json")    # raises when not ignored


# ── shipping ─────────────────────────────────────────────────────────────────

COCKPIT = Cockpit(url="http://cockpit.test:3211", token="asf_ingest_test")


def test_a_session_ships_whole_and_a_second_ship_sends_nothing(stamped: Path):
    adw_id = a_run(stamped)
    session = session_dir(stamped, adw_id)
    written = [line.seq for line in events.read(session)]
    cockpit = FakeCockpit()

    shipped = station.ship(session, COCKPIT, cockpit)

    assert shipped.outcome == "shipped" and shipped.acked == written[-1] and shipped.pending == 0
    assert sorted(cockpit.stored[adw_id]) == written
    assert cockpit.kinds(adw_id)[0] == "session_started"
    assert cockpit.kinds(adw_id)[-1] == "session_finished"

    again = station.ship(session, COCKPIT, cockpit)
    assert again.outcome == "shipped" and again.sent == 0 and len(cockpit.batches) == 1


def a_session(tmp_path: Path, count: int) -> Path:
    """A session directory holding `count` events and nothing else."""
    session = tmp_path / "sessions" / "a1b2c3d4"
    ended = EVENT_KINDS["process_ended"]
    for pid in range(1, count + 1):
        events.emit(session, ended(pid=pid))
    return session


def test_a_cockpit_that_is_down_loses_nothing_and_gets_it_all_from_the_acked_seq(
        tmp_path: Path):
    session = a_session(tmp_path, 3)
    cockpit = FakeCockpit()
    assert station.ship(session, COCKPIT, cockpit).acked == 3

    cockpit.down = True
    events.emit(session, EVENT_KINDS["process_ended"](pid=4))
    events.emit(session, EVENT_KINDS["process_ended"](pid=5))
    down = station.ship(session, COCKPIT, cockpit)
    assert down.outcome == "unreachable" and down.acked == 3 and down.pending == 2

    cockpit.down = False
    back = station.ship(session, COCKPIT, cockpit)
    assert back.outcome == "shipped" and back.acked == 5 and back.pending == 0
    assert [event["seq"] for event in cockpit.batches[-1]["events"]] == [4, 5]


def test_a_cockpit_that_forgot_a_session_is_sent_it_again_from_the_top(tmp_path: Path):
    session = a_session(tmp_path, 4)
    cockpit = FakeCockpit()
    station.ship(session, COCKPIT, cockpit)

    cockpit.forget()
    events.emit(session, EVENT_KINDS["process_ended"](pid=5))
    station.ship(session, COCKPIT, cockpit)     # 5 alone: it answers 0
    station.ship(session, COCKPIT, cockpit)     # so 1..4 again

    assert cockpit.acked("a1b2c3d4") == 5


def test_a_long_backlog_goes_in_batches_the_cockpit_accepts(tmp_path: Path):
    session = a_session(tmp_path, 1200)
    cockpit = FakeCockpit()

    shipped = station.ship(session, COCKPIT, cockpit)

    assert shipped.acked == 1200 and shipped.sent == 1200
    assert [len(batch["events"]) for batch in cockpit.batches] == [500, 500, 200]


def test_another_cockpit_gets_every_session_from_the_top(tmp_path: Path):
    session = a_session(tmp_path, 2)
    station.ship(session, COCKPIT, FakeCockpit())

    elsewhere = FakeCockpit()
    other = Cockpit(url="http://other.test:3211", token="asf_ingest_test")
    assert station.ship(session, other, elsewhere).sent == 2


def test_a_wrong_token_is_unauthorized_and_moves_nothing(tmp_path: Path):
    session = a_session(tmp_path, 2)
    wrong = Cockpit(url=COCKPIT.url, token="asf_ingest_wrong")

    shipped = station.ship(session, wrong, FakeCockpit())

    assert shipped.outcome == "unauthorized" and shipped.acked == 0 and shipped.pending == 2
    assert "401" in shipped.error


# ── asf station sync (a CI job's last step) ──────────────────────────────────

def test_station_sync_ships_every_unshipped_session_and_fails_only_on_auth(
        stamped: Path, monkeypatch, capsys):
    ran = a_run(stamped)
    older = stamped / DATA_DIR / "sessions" / "0ld5e55n"
    events.emit(older, EVENT_KINDS["process_ended"](pid=1))
    monkeypatch.chdir(stamped)
    monkeypatch.setenv("ASF_COCKPIT_URL", COCKPIT.url)
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", COCKPIT.token)
    cfg = factory.load("asf/factory.yaml")
    cockpit = FakeCockpit()

    cockpit.down = True
    assert station.sync(cfg, cockpit) == 0                    # down is not a failed job
    assert "unreachable" in capsys.readouterr().out

    cockpit.down = False
    assert station.sync(cfg, cockpit) == 0
    assert cockpit.acked("0ld5e55n") == 1
    assert cockpit.acked(ran) == len(events.read(session_dir(stamped, ran)))
    shipped = len(cockpit.batches)
    assert station.sync(cfg, cockpit) == 0 and len(cockpit.batches) == shipped

    monkeypatch.setenv("ASF_COCKPIT_TOKEN", "asf_ingest_revoked")
    events.emit(older, EVENT_KINDS["process_ended"](pid=2))
    assert station.sync(cfg, cockpit) == 1
    assert "401" in capsys.readouterr().out


def test_station_sync_with_no_cockpit_configured_says_so_and_succeeds(stamped: Path):
    result = asf(stamped, "station", "sync")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "ASF_COCKPIT_URL" in result.stdout


# ── the shipper: a thread in the process that owns the session ───────────────

def eventually(check, within: float = 5.0) -> bool:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return check()


def test_a_live_session_reaches_the_cockpit_while_it_runs(tmp_path: Path):
    session = a_session(tmp_path, 1)
    cockpit = FakeCockpit()
    shipper = station.Shipper(session, COCKPIT, cockpit, interval=0.02).start()
    try:
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 1)
        events.emit(session, EVENT_KINDS["process_ended"](pid=2))
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 2)
    finally:
        shipper.stop()


def test_the_last_events_of_a_run_go_out_with_its_final_flush(tmp_path: Path):
    session = a_session(tmp_path, 1)
    cockpit = FakeCockpit()
    shipper = station.Shipper(session, COCKPIT, cockpit, interval=60).start()
    events.emit(session, EVENT_KINDS["process_ended"](pid=2))

    shipper.stop()

    assert cockpit.acked("a1b2c3d4") == 2


def test_a_cockpit_that_is_down_never_delays_the_run_and_gets_it_all_when_it_is_back(
        tmp_path: Path):
    session = a_session(tmp_path, 1)
    cockpit = FakeCockpit()
    cockpit.down = True
    shipper = station.Shipper(session, COCKPIT, cockpit, interval=0.02).start()
    try:
        began = time.monotonic()
        for pid in range(2, 52):
            events.emit(session, EVENT_KINDS["process_ended"](pid=pid))
        assert time.monotonic() - began < 2.0
        assert cockpit.acked("a1b2c3d4") == 0

        cockpit.down = False
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 51)
    finally:
        shipper.stop()


def test_a_cockpit_that_hangs_holds_the_end_of_a_run_no_longer_than_the_flush_budget(
        tmp_path: Path):
    session = a_session(tmp_path, 1)
    cockpit = FakeCockpit()
    cockpit.hold = threading.Event()                     # every request blocks
    shipper = station.Shipper(session, COCKPIT, cockpit, interval=0.02).start()
    try:
        events.emit(session, EVENT_KINDS["process_ended"](pid=2))
        began = time.monotonic()
        shipper.stop(budget=0.2)
        assert time.monotonic() - began < 1.0
    finally:
        cockpit.hold.set()                                # let the thread go


def test_with_no_cockpit_configured_nothing_ships_and_nothing_is_recorded(tmp_path: Path):
    session = a_session(tmp_path, 1)

    assert station.start(session) is None
    assert not (session / station.SHIPPED_FILE).exists()


def test_a_request_that_cannot_even_be_sent_is_reported_never_raised(tmp_path: Path):
    session = a_session(tmp_path, 1)

    def unsendable(url: str, token: str, body: dict) -> tuple[int, dict]:
        "Bearer ü".encode("latin-1", errors="strict").decode("ascii")   # what http.client does
        return 200, {}

    shipped = station.ship(session, COCKPIT, unsendable)

    assert shipped.outcome == "refused" and shipped.acked == 0 and shipped.error


def test_a_trailing_slash_in_the_url_is_the_same_cockpit(tmp_path: Path):
    session = a_session(tmp_path, 2)
    cockpit = FakeCockpit()
    station.ship(session, Cockpit(url=COCKPIT.url + "/", token=COCKPIT.token), cockpit)

    assert station.ship(session, COCKPIT, cockpit).sent == 0


def test_a_process_that_only_touches_a_session_flushes_it_before_moving_on(
        tmp_path: Path, monkeypatch):
    session = a_session(tmp_path, 3)
    cockpit = FakeCockpit()
    station.flush(session, cockpit)                       # no cockpit configured: nothing
    assert cockpit.batches == []

    monkeypatch.setenv("ASF_COCKPIT_URL", COCKPIT.url)
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", COCKPIT.token)
    station.flush(session, cockpit)

    assert cockpit.acked("a1b2c3d4") == 3

"""Nudges: a shared cockpit's webhook wakes a station's watcher, and the poll stays the record.

ADR 0008, the station's end; the cockpit's is apps/cockpit/tests/nudges.test.ts.
The seams: the command poll goes through the station's transport to the
in-process `FakeCockpit`, the watcher's wait runs on an injected clock where
time is the point and on the real one, briefly, where the whole path is, and
a pass is the shipping `issues_once` against the fake forge with the launch
replaced — so "started" means the watcher got as far as launching a run.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import pytest

from engine import artifacts, commands, factory, nudge, watch
from engine.data_types import Cockpit, StationCredential

from .fake_cockpit import FakeCockpit
from .test_asf_claims import second_checkout, shared  # noqa: F401 — a fixture
from .test_asf_station import eventually
from .test_asf_watchers import CONFIG, queued, tracked  # noqa: F401 — a fixture

COCKPIT = Cockpit(url="http://cockpit.test:3211", token="asf_ingest_test")
ME = os.getpid()                 # the `asf up` a test's watchers answer to


class Clock:
    """Time that passes only when the watcher sleeps; `at` runs a thing once it is that late."""

    def __init__(self):
        self.now = 0.0
        self.due: list[tuple[float, object]] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        for when, thing in list(self.due):
            if self.now >= when:
                self.due.remove((when, thing))
                thing()

    def at(self, when: float, thing) -> None:
        self.due.append((when, thing))


def paced(tmp_path: Path, clock: Clock, interval: float = 120, parent: int = ME) -> nudge.Pace:
    return nudge.Pace(tmp_path, "issues", interval, parent=parent, clock=clock, sleep=clock.sleep)


def waker(tmp_path: Path, running=("issues", "answers", "prs"), said: list | None = None):
    return nudge.Waker(tmp_path, lambda: list(running),
                       said.append if said is not None else (lambda _text: None))


# ── the watcher's wait ───────────────────────────────────────────────────────

def test_a_nudge_cuts_the_wait_short_but_never_inside_the_minimum_gap(tmp_path: Path):
    clock = Clock()
    pace = paced(tmp_path, clock)
    pace.begin()
    clock.at(2, lambda: waker(tmp_path)([{"kind": "issues", "number": 42}], False))

    pace.wait()

    assert clock.now == pytest.approx(nudge.MIN_GAP)


def test_nudges_while_a_pass_is_due_or_running_cause_exactly_one_more_pass(tmp_path: Path):
    clock = Clock()
    pace = paced(tmp_path, clock)
    wake = waker(tmp_path)
    pace.begin()
    for number in (42, 43, 44):                  # a burst while the pass runs, minutes long
        clock.sleep(60)
        wake([{"kind": "issues", "number": number}], False)

    pace.wait()                                  # due at once: the gap is long out
    assert clock.now == pytest.approx(180)
    pace.begin()                                 # the one more pass: it answers all three
    pace.wait()
    assert clock.now == pytest.approx(180 + 120)  # and the next is the interval's


def test_while_nudges_are_live_the_poll_slows_down_and_still_finds_a_lost_delivery(
        tmp_path: Path):
    clock = Clock()
    pace = paced(tmp_path, clock)
    waker(tmp_path)([], True)
    pace.begin()

    pace.wait()                                  # nothing was delivered: the poll is the record

    assert clock.now == pytest.approx(nudge.NUDGED_INTERVAL)


def test_a_watcher_no_station_loop_of_its_own_wakes_keeps_its_interval(tmp_path: Path):
    """`asf issues loop` on its own, or beside another `asf up`: neither file is its parent's."""
    clock = Clock()
    pace = paced(tmp_path, clock, parent=ME + 1)
    pace.begin()
    clock.at(2, lambda: waker(tmp_path)([{"kind": "issues", "number": 42}], True))

    pace.wait()

    assert clock.now == pytest.approx(120)


def test_a_watcher_that_starts_takes_down_a_wake_left_from_before(tmp_path: Path):
    """Its first pass reads the forge anyway; a stale flag is not a second one."""
    waker(tmp_path)([{"kind": "issues", "number": 42}], False)
    clock = Clock()
    pace = paced(tmp_path, clock)

    pace.begin()
    pace.wait()

    assert clock.now == pytest.approx(120)


# ── the station loop ─────────────────────────────────────────────────────────

def steered(stamped: Path, cockpit: FakeCockpit, heard: list, station_id: str = "st_0a1b2c",
            session: str = "", watchers=("issues", "answers", "prs")) -> commands.Steering:
    cfg = factory.load(stamped / CONFIG)
    held = StationCredential(cockpit=COCKPIT.url, station=station_id,
                             token=cockpit.admit(station_id, token=f"asf_station_{station_id}"))
    steering = commands.Steering(commands.Here(cfg, stamped), lambda: held, session=session,
                                 watchers=lambda: list(watchers))
    steering.interval = 0
    steering.nudged = lambda items, live: heard.append((items, live))
    return steering


def test_the_station_loop_asks_with_its_cursor_and_hears_each_nudge_once(stamped: Path):
    cockpit, heard, bodies = FakeCockpit(), [], []
    steering = steered(stamped, cockpit, heard)

    def transport(url, token, body):
        bodies.append(dict(body))
        return cockpit(url, token, body)

    steering.poll(COCKPIT, transport)
    cockpit.nudge("issues", 42)
    cockpit.nudge("prs", 7)
    steering.poll(COCKPIT, transport)
    steering.poll(COCKPIT, transport)

    assert heard == [([], True),
                     ([{"kind": "issues", "number": 42}, {"kind": "prs", "number": 7}], True),
                     ([], True)]
    assert [body["nudged_after"] for body in bodies] == [0, 0, 2]


def test_only_the_watchers_a_station_runs_are_nudged(stamped: Path):
    cockpit, heard = FakeCockpit(), []
    steering = steered(stamped, cockpit, heard, watchers=("prs",))
    cockpit.nudge("issues", 42)
    cockpit.nudge("prs", 7)

    steering.poll(COCKPIT, cockpit)

    assert heard == [([{"kind": "prs", "number": 7}], True)]


def test_a_run_s_own_poll_never_asks_for_nudges(stamped: Path):
    cockpit, heard, bodies = FakeCockpit(), [], []
    steering = steered(stamped, cockpit, heard, session="5c0075aa")

    steering.poll(COCKPIT, lambda url, token, body: bodies.append(body) or cockpit(url, token, body))

    assert "nudged_after" not in bodies[0] and heard == []


@pytest.mark.parametrize("cockpit_is", ["down", "older", "refusing"])
def test_without_an_answer_that_says_so_nudges_are_not_live(stamped: Path, cockpit_is: str):
    """A cockpit that went away, or one from before nudges, leaves the watchers
    on their own interval."""
    cockpit, heard = FakeCockpit(), []
    steering = steered(stamped, cockpit, heard)
    if cockpit_is == "down":
        cockpit.down = True
    transport = cockpit
    if cockpit_is == "older":
        def transport(url, token, body):
            status, answer = cockpit(url, token, body)
            return status, {"commands": answer["commands"]}
    if cockpit_is == "refusing":
        cockpit.revoke("st_0a1b2c")

    steering.poll(COCKPIT, transport)

    assert heard == [([], False)]


def test_the_station_loop_wakes_only_what_it_runs_and_says_what_and_when_live_changes(
        tmp_path: Path):
    said: list[str] = []
    wake = waker(tmp_path, running=("issues",), said=said)

    wake([], False)
    wake([{"kind": "issues", "number": 42}, {"kind": "prs", "number": 7},
          {"kind": "issues", "number": 43}], True)
    wake([], True)

    assert (tmp_path / "issues.wake").is_file() and not (tmp_path / "prs.wake").exists()
    assert json.loads((tmp_path / nudge.LIVE_FILE).read_text()) == {"pid": ME, "live": True}
    assert said == [said[0], "nudged issues about #42, #43"] and "webhooks reach" in said[0]
    assert artifacts.watcher_states(tmp_path) == {}       # neither file is a watcher's heartbeat
    wake.close()
    assert list(tmp_path.iterdir()) == []


# ── the whole path ───────────────────────────────────────────────────────────

def test_a_nudged_issue_starts_without_waiting_out_the_interval(tracked, stamped, monkeypatch):  # noqa: F811
    cfg, listing = tracked
    monkeypatch.setattr(nudge, "MIN_GAP", 0.05)
    monkeypatch.setattr(nudge, "TICK", 0.01)
    launched, passes, stop = [], [], threading.Event()
    monkeypatch.setattr(watch, "launch", lambda *a: launched.append(a[2].number) or 0)
    watchers = artifacts.watchers_dir(stamped, cfg.data_dir)
    cockpit, heard = FakeCockpit(), []
    steering = steered(stamped, cockpit, heard)
    steering.nudged = nudge.Waker(watchers, lambda: ["issues"], lambda _text: None)

    def once() -> int:
        if stop.is_set():
            return 3                             # what ends a loop: a pinned item finished
        code = watch.issues_once(cfg, CONFIG)
        passes.append(1)                         # counted once it has read the forge
        return code

    loop = threading.Thread(target=watch._loop, daemon=True, args=(
        once, cfg, stamped, nudge.Pace(watchers, "issues", 120, parent=ME)))
    loop.start()
    try:
        assert eventually(lambda: passes == [1])          # the pass every watcher starts with
        listing(queued(42))                               # labelled after it...
        cockpit.nudge("issues", 42)                       # ...and delivered to the cockpit
        steering.poll(COCKPIT, cockpit)
        assert eventually(lambda: launched == [42], within=5.0)
    finally:
        stop.set()
        nudge.Waker(watchers, lambda: ["issues"], lambda _text: None)(
            [{"kind": "issues", "number": 0}], False)
        loop.join(timeout=5)
    assert not loop.is_alive() and len(passes) == 2


def test_what_no_nudge_announced_is_started_by_the_poll_and_what_queued_by_the_first_pass(
        tracked, stamped, monkeypatch):  # noqa: F811
    """A delivery GitHub never retried, and a station that was away: the forge is the queue."""
    cfg, listing = tracked
    listing(queued(41))                                   # queued while nobody watched
    started: list[tuple[int, float]] = []
    clock = Clock()
    monkeypatch.setattr(watch, "launch", lambda *a: started.append((a[2].number, clock.now)) or 0)
    pace = paced(artifacts.watchers_dir(stamped, cfg.data_dir), clock)
    nudge.Waker(pace.wake.parent, lambda: ["issues"], lambda _text: None)([], True)
    passes = []

    def once() -> int:
        passes.append(clock.now)
        if len(passes) == 3:
            return 3
        code = watch.issues_once(cfg, CONFIG)
        listing(queued(42))                               # labelled; its delivery was lost
        return code

    watch._loop(once, cfg, stamped, pace)

    assert started == [(41, 0), (42, nudge.NUDGED_INTERVAL)]


def test_two_stations_nudged_about_one_issue_start_it_once(tracked, stamped, tmp_path,  # noqa: F811
                                                         shared, monkeypatch):  # noqa: F811
    _cfg, listing = tracked
    listing(queued(42))
    other = second_checkout(stamped, tmp_path)
    shared.nudge("issues", 42)
    launched = []
    monkeypatch.setattr(watch, "launch",
                        lambda *a: launched.append((Path.cwd(), a[2].number)) or watch.EXIT_WAITING)

    for checkout, station_id in ((stamped, "st_0a1b2c"), (other, "st_0b1e55")):
        cfg = factory.load(checkout / CONFIG)
        watchers = artifacts.watchers_dir(checkout, cfg.data_dir)
        steering = steered(checkout, shared, [], station_id=station_id)
        steering.nudged = nudge.Waker(watchers, lambda: ["issues"], lambda _text: None)
        steering.poll(COCKPIT, shared)
        assert nudge.Pace(watchers, "issues", 120, parent=ME).woken()     # both were nudged

    for checkout in (stamped, other):
        monkeypatch.chdir(checkout)
        watch.issues_once(factory.load(CONFIG), CONFIG)

    assert launched == [(stamped, 42)]                  # the claim, not the nudge, picked one

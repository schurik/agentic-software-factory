"""Nudges: a shared cockpit's word that a watcher would find work sooner than its interval.

A station cannot receive a webhook — a laptop behind NAT, a CI job — but a
shared cockpit can, and the station loop already asks it for commands every
few seconds. So a delivery about a work item becomes a NUDGE (ADR 0008): the
cockpit hands `(watcher, number)` to every online station that runs that
watcher, in the answer to its command poll (`commands.Steering`), and the
station loop wakes the watcher, which runs an ordinary pass now instead of at
its next interval. The pass reads the forge, holds the item to its route label
and `trusted_authors`, and asks for a claim, exactly as a poll would: a nudge
names no session and authorizes nothing, so it is not a command.

THE POLL STAYS THE RECORD. GitHub sends a delivery once and never retries, so
a watcher that is nudged still polls — only less often (`NUDGED_INTERVAL`)
while the cockpit says nudges are live, and at its own interval otherwise.

Two files in the watchers directory carry it from the station loop (`Waker`,
in `asf up`) to the watchers it supervises (`Pace`), each naming the pid of
the `asf up` that wrote it, so only that process's own children act on it — a
watcher started on its own (`asf issues loop`) has no station loop above it
and keeps its interval:

  * `<kind>.wake` — a pass is due. A flag, not a queue: a nudge while one is
    due changes nothing, and the watcher takes the flag down as a pass
    STARTS, so the nudges that arrive while it runs become one more pass after.
  * `nudges.live` — whether the cockpit says nudges are live. Not `.json`:
    every `.json` there is a watcher's heartbeat (`artifacts.watcher_states`).

However many nudges arrive, two passes start at least `MIN_GAP` apart, so a
burst costs the forge's rate limit what a poll at that interval would, and
only while it lasts.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable

from .utils import ensure_dir, write_atomic

NUDGED_INTERVAL = 600       # seconds between passes while nudges are live (or the watcher's own, if longer)
MIN_GAP = 10.0              # seconds between the starts of two passes, however many nudges
TICK = 0.5                  # how often a waiting watcher looks for a wake
LIVE_FILE = "nudges.live"
WAKE_SUFFIX = ".wake"


def wake_file(watchers: Path, kind: str) -> Path:
    return Path(watchers) / f"{kind}{WAKE_SUFFIX}"


def _written_by(parent: int, path: Path) -> dict | None:
    """The file's fields when `parent` wrote it, else None. Never raises."""
    try:
        fields = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return fields if isinstance(fields, dict) and fields.get("pid") == parent else None


class Waker:
    """The station loop's side: what a poll's nudges mean for this station's watchers.

    Called with every answer to the station loop's command poll — the items
    the cockpit nudged since the last, and whether nudges are live — and with
    `([], False)` whenever a poll got no such answer, so a cockpit that went
    away puts the watchers back on their own interval.
    """

    def __init__(self, watchers: Path, running: Callable[[], list[str]],
                 say: Callable[[str], None] = print):
        self.watchers = Path(watchers)
        self.running = running
        self.say = say
        self.pid = os.getpid()
        self._live: bool | None = None

    def __call__(self, items: list[dict], live: bool) -> None:
        if live != self._live:
            write_atomic(ensure_dir(self.watchers) / LIVE_FILE,
                         json.dumps({"pid": self.pid, "live": live}))
            if self._live is not None or live:
                self.say("webhooks reach the cockpit: the watchers poll every "
                         f"{NUDGED_INTERVAL}s and look sooner when nudged" if live else
                         "no nudges from the cockpit: the watchers poll at their own interval")
            self._live = live
        running = set(self.running())
        woken: dict[str, list[str]] = {}
        for item in items:
            kind, number = item.get("kind"), item.get("number")
            if kind in running:
                woken.setdefault(kind, []).append(f"#{number}")
        for kind, numbers in sorted(woken.items()):
            ensure_dir(self.watchers)
            write_atomic(wake_file(self.watchers, kind), json.dumps({"pid": self.pid}))
            self.say(f"nudged {kind} about {', '.join(numbers)}")

    def close(self) -> None:
        """The station loop is stopping: nothing it wrote speaks for it any more."""
        for path in [self.watchers / LIVE_FILE, *self.watchers.glob(f"*{WAKE_SUFFIX}")]:
            if _written_by(self.pid, path) is not None:
                path.unlink(missing_ok=True)


class Pace:
    """A watcher's side: when its next pass is due.

    `begin()` as a pass starts, `wait()` after it ends. Without a station loop
    above this process writing to it, `wait()` is the interval, as it always was.
    """

    def __init__(self, watchers: Path, kind: str, interval: float, *,
                 parent: int | None = None, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.kind = kind
        self.wake = wake_file(watchers, kind)
        self.live_file = Path(watchers) / LIVE_FILE
        self.interval = interval
        self.parent = os.getppid() if parent is None else parent
        self.clock = clock
        self.sleep = sleep
        self._started = clock()

    def begin(self) -> None:
        """A pass starts: whatever woke it is answered by this pass, and a nudge from now on is the next."""
        self._started = self.clock()
        self.wake.unlink(missing_ok=True)

    def live(self) -> bool:
        fields = _written_by(self.parent, self.live_file)
        return bool(fields and fields.get("live"))

    def woken(self) -> bool:
        return _written_by(self.parent, self.wake) is not None

    def period(self) -> float:
        """How long after a pass started the next is due when nothing wakes it."""
        return max(self.interval, NUDGED_INTERVAL) if self.live() else self.interval

    def wait(self) -> None:
        """Until the period is out, or a nudge woke this watcher at least `MIN_GAP` after the last pass began."""
        while True:
            elapsed = self.clock() - self._started
            period = self.period()
            if elapsed >= period or (elapsed >= MIN_GAP and self.woken()):
                return
            self.sleep(max(0.0, min(TICK, period - elapsed)))

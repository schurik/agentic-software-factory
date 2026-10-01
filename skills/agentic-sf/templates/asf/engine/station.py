"""A checkout as a station: who it is, and how its sessions reach a cockpit.

A station is one checkout of a repository, on a machine or in a CI job
(`CONTEXT.md`). It gets a random id the first time anything asks, kept in the
gitignored `<data_dir>/station.json`, and that id is the only thing about it
that is stored: its display name (`<login>@<host>:<dir>`, or ASF_STATION_NAME)
and its kind (`ci` under a CI job, else `local`) are worked out afresh by every
process, so renaming a station is an edit to `.env` and nothing else.

SHIPPING is one code path, `ship()`: a session's `events.jsonl` lines past the
seq a cockpit last acknowledged, POSTed as they are to its `/ingest`
(`apps/cockpit/convex/model/wire.ts` is the other end), over plain HTTP with
the standard library, so a stamp's dependency list does not grow a cockpit
client. The acknowledged seq is kept in the session's own `shipped.json`, and
the events past it are the buffer: nothing is queued in memory, so a cockpit
that is down for a day costs a longer first batch when it returns, and a
process that dies loses nothing its successor or `asf station sync` will not
send. The cockpit's answer is the truth about what it holds — one whose
database was wiped says `acked: 0`, and the station starts again from 1.

The factory never waits on the cockpit. `emit` is a file append and knows
nothing of any of this; a `Shipper` thread in the process that owns a session
does the sending, and its last flush on the way out is bounded (`FLUSH_BUDGET`).
The station loop behind `asf up` is the same `Loop` over every session on the
station.
Without ASF_COCKPIT_URL there is no cockpit, no thread and no `shipped.json`:
the run is the run it was before stations existed.
"""

from __future__ import annotations

import atexit
import getpass
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import artifacts, events, git_helper
from .data_types import (Cockpit, EventLine, FactoryConfig, ShipAck, ShipResult, Station,
                         StationRecord)
from .cockpit import forge_host
from .utils import anchor, engineer_name, ensure_dir, new_id, now_iso, operator_env, write_atomic

STATION_FILE = "station.json"
SHIPPED_FILE = "shipped.json"

# What one batch may hold, from the cockpit's wire.ts (MAX_EVENTS,
# MAX_BATCH_BYTES). Measured here on Python's ASCII-escaped JSON, which is never
# shorter than the cockpit's own count, so a batch cut here always fits there.
MAX_EVENTS = 500
MAX_BATCH_BYTES = 4_000_000
REQUEST_TIMEOUT = 10.0
SHIP_INTERVAL = 1.0             # seconds between looks at a live session's events
RETRY_CEILING = 30.0            # the longest wait between attempts on a cockpit that is down
FLUSH_BUDGET = 3.0              # the most a run's exit waits for its last events to go


# ── who this station is ──────────────────────────────────────────────────────

def identify(main_root: str | Path, data_dir: str) -> Station:
    """This checkout's station, minting its id on the first call."""
    root = Path(main_root)
    record = _station_record(anchor(root, data_dir) / STATION_FILE)
    name = os.environ.get("ASF_STATION_NAME", "").strip()
    return Station(id=record.id, name=name or f"{_login()}@{_host()}:{root.resolve().name}",
                   kind="ci" if os.environ.get("CI", "").strip() else "local")


def _station_record(path: Path) -> StationRecord:
    """The recorded id, or a new one that no racing process can overwrite.

    Two processes starting on a fresh checkout would otherwise mint two ids and
    the second write would silently rename the station under the first. So the
    record is written whole to a temp file and hard-linked into place, which
    fails when the name is taken: the loser reads the winner's id instead.

    A filesystem without hard links (some container and network mounts) gets
    the plain atomic write instead, and with it the race — every run calls
    this, cockpit or not, so it must never be the reason one cannot start.
    """
    try:
        return StationRecord.model_validate_json(path.read_text())
    except FileNotFoundError:
        pass
    except ValueError:
        path.unlink(missing_ok=True)       # unreadable is missing: nothing can use it
    ensure_dir(path.parent)
    fresh = StationRecord(id=f"st_{new_id(12)}", created_at=now_iso())
    temp = path.with_name(f".{path.name}.{new_id(8)}.tmp")
    temp.write_text(fresh.model_dump_json(indent=2))
    try:
        os.link(temp, path)
    except FileExistsError:
        return StationRecord.model_validate_json(path.read_text())
    except OSError:
        write_atomic(path, fresh.model_dump_json(indent=2))
    finally:
        temp.unlink(missing_ok=True)
    return fresh


def _login() -> str:
    try:
        return getpass.getuser()
    except (KeyError, OSError):
        return os.environ.get("USER", "someone")


def operator() -> str:
    """The person running this process, by forge login: the account `gh` acts
    as on the host it is aimed at, read from `gh`'s own config — no network —
    else, in a GitHub Actions job, the actor the forge ran it for
    (`GITHUB_ACTOR`), else the name the factory already calls them
    (`ENGINEER_NAME`, git's `user.name`), which a cockpit then cannot match to
    a login. What a run started by hand records as who triggered it
    (`session.triggered_by`)."""
    try:
        done = subprocess.run(["gh", "config", "get", "-h", forge_host(), "user"],
                              capture_output=True, text=True, timeout=10, env=operator_env())
    except (OSError, subprocess.SubprocessError):
        done = None
    login = done.stdout.strip() if done is not None and done.returncode == 0 else ""
    if len(login.split()) == 1:
        return login
    return os.environ.get("GITHUB_ACTOR", "").strip() or engineer_name()


def _host() -> str:
    return socket.gethostname().split(".")[0] or "localhost"


# ── where it ships ───────────────────────────────────────────────────────────

def configured() -> Cockpit | None:
    """The cockpit ASF_COCKPIT_URL names, or None — and None changes nothing.

    The token may be empty: the cockpit refuses that as it refuses a wrong one,
    with a 401, and a 401 is the one failure `asf station sync` reports.
    """
    url = os.environ.get("ASF_COCKPIT_URL", "").strip()
    if not url:
        return None
    if not url.startswith(("http://", "https://")):
        print(f"station: ASF_COCKPIT_URL={url!r} is not an http(s) URL — nothing is shipped "
              f"until it is the cockpit backend's site origin, e.g. http://127.0.0.1:3211",
              file=sys.stderr, flush=True)
        return None
    return Cockpit(url=url, token=os.environ.get("ASF_COCKPIT_TOKEN", "").strip())


# (url, token, body) -> (status, body). Raises OSError when nothing answered.
# Injected everywhere a cockpit is spoken to, so the suite drives a fake one
# in-process and never opens a socket.
Transport = Callable[[str, str, dict], "tuple[int, dict]"]


def post(url: str, token: str, body: dict) -> tuple[int, dict]:
    """The real transport: one JSON POST with a bearer token."""
    request = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            return response.status, _json(response.read())
    except urllib.error.HTTPError as error:        # an answer, just not a 2xx one
        return error.code, _json(error.read())
    except http.client.HTTPException as error:     # a connection that broke mid-answer
        raise ConnectionError(f"{url}: {error!r}") from error


def _json(raw: bytes) -> dict:
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


# ── shipping one session ─────────────────────────────────────────────────────

def ship(session_dir: str | Path, cockpit: Cockpit, transport: Transport = post) -> ShipResult:
    """Send the session's events past the cockpit's acknowledged seq. Never raises.

    The session is its directory, named by its adw_id (`<data_dir>/sessions/
    <adw_id>`), which is also what the cockpit files it under.

    Batch after batch while the cockpit's `acked` keeps climbing; a batch that
    does not move it (a cockpit that lost what it had, and answers lower than
    the station thought) ends this attempt with its answer recorded, and the
    next attempt resends from there.
    """
    directory = Path(session_dir)
    adw_id = directory.name
    acked = _acked(directory, cockpit)
    lines = events.read(directory)
    sent = 0

    def result(**fields) -> ShipResult:
        pending = sum(1 for line in lines if line.seq > acked)
        return ShipResult(adw_id=adw_id, sent=sent, acked=acked, pending=pending, **fields)

    while True:
        batch = _batch([line for line in lines if line.seq > acked])
        if not batch:
            return result()
        body = {"session": adw_id, "events": [line.model_dump(mode="json") for line in batch]}
        try:
            status, answer = transport(f"{cockpit.url}/ingest", cockpit.token, body)
        except OSError as error:
            return result(outcome="unreachable", error=str(error))
        except ValueError as error:        # e.g. a token no HTTP header can carry
            return result(outcome="refused", error=f"not sendable: {error}")
        if status == 401:
            return result(outcome="unauthorized", error=_said(answer, status))
        answered = answer.get("acked")
        if status != 200 or not isinstance(answered, int):
            return result(outcome="refused", error=_said(answer, status))
        sent += len(batch)
        climbed = answered > acked
        acked = answered
        _record(directory, ShipAck(cockpit=cockpit.url, acked=acked))
        if not climbed:
            return result()


def _batch(pending: list[EventLine]) -> list[EventLine]:
    """The longest run from the front that fits one batch — never empty when
    `pending` is not, so one oversized event is sent and refused rather than
    skipped and never mentioned."""
    batch, size = [], 0
    for line in pending[:MAX_EVENTS]:
        size += len(json.dumps(line.payload))
        if batch and size > MAX_BATCH_BYTES:
            break
        batch.append(line)
    return batch


def _said(answer: dict, status: int) -> str:
    return f"HTTP {status}: {answer.get('error') or 'no reason given'}"


def _acked(session_dir: Path, cockpit: Cockpit) -> int:
    """How far THIS cockpit has acknowledged the session; 0 for any other."""
    try:
        ack = ShipAck.model_validate_json((session_dir / SHIPPED_FILE).read_text())
    except (OSError, ValueError):
        return 0
    return ack.acked if ack.cockpit == cockpit.url else 0


def _record(session_dir: Path, ack: ShipAck) -> None:
    write_atomic(session_dir / SHIPPED_FILE, ack.model_dump_json(indent=2))


# ── every session at once: `asf station sync` ────────────────────────────────

def sync(cfg: FactoryConfig, transport: Transport = post) -> int:
    """Ship every session under `data_dir` that the cockpit has not acknowledged.

    A CI job's last step, and the catch-up for a session whose own process
    died before its shipper could flush. Exits non-zero ONLY on a 401: a
    cockpit that is down loses nothing (the next sync sends it), and a job that
    fails because the cockpit was restarting teaches people to delete the
    step. A token that is wrong stays wrong until a person fixes it, which is
    what a red job is for.
    """
    cockpit = configured()
    if cockpit is None:
        print("no cockpit configured — set ASF_COCKPIT_URL (and ASF_COCKPIT_TOKEN) in .env "
              "or the job's environment to ship sessions to one")
        return 0
    main_root = git_helper.main_root()
    here = identify(main_root, cfg.defaults.data_dir)
    print(f"station {here.name} ({here.kind}, {here.id}) -> {cockpit.url}")
    root = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
    sessions = every_session(root)
    sent = 0
    for directory in sessions:
        shipped = ship(directory, cockpit, transport)
        sent += shipped.sent
        if shipped.outcome == "shipped":
            if shipped.sent:
                print(f"  {shipped.adw_id}: sent {shipped.sent}, acknowledged through "
                      f"seq {shipped.acked}")
            continue
        print(f"  {shipped.adw_id}: {shipped.outcome} — {shipped.error}")
        if shipped.outcome == "unauthorized":
            print("  the cockpit refused ASF_COCKPIT_TOKEN; nothing more is sent until it "
                  "is a token that cockpit issued for this repository")
            return 1
        if shipped.outcome == "unreachable":
            print("  nothing is lost: every session is kept from its acknowledged seq, "
                  "and the next sync sends it")
            return 0
    print(f"  {len(sessions)} session(s), {sent} event(s) sent")
    return 0


# ── shipping on a timer: a live session, or every session on the station ─────

def every_session(root: Path) -> list[Path]:
    """Every session directory under `root` that has events to ship."""
    if not root.is_dir():
        return []
    return sorted(d for d in root.iterdir() if (d / events.EVENTS_FILE).is_file())


def start(session_dir: str | Path, transport: Transport = post) -> Loop | None:
    """Ship this session from a background thread for as long as this process
    lives, flushing on the way out — or None, and nothing at all, when no
    cockpit is configured. Called by every process that owns a session."""
    cockpit = configured()
    if cockpit is None:
        return None
    shipper = Shipper(session_dir, cockpit, transport).start()
    atexit.register(shipper.stop)
    return shipper


def flush(session_dir: str | Path, transport: Transport = post) -> None:
    """One bounded round, for a process that writes to a session it does not
    run — a watcher aborting a run at its gate — and outlives the write by
    hours, so an exit-time flush would come far too late."""
    cockpit = configured()
    if cockpit is not None:
        Shipper(session_dir, cockpit, transport).start().stop()


@dataclass
class Destination:
    """Where a `Loop` ships. `get` is asked every round, and None ships nothing
    — a local cockpit has no token until its container is up and has issued
    one. `refused` is asked on a 401 whether a fresh token is coming (a local
    cockpit whose volume was wiped issues another); `label` is how `up` names
    it."""

    get: Callable[[], Cockpit | None]
    refused: Callable[[Cockpit], bool] = lambda _cockpit: False
    label: str = ""


class Loop:
    """`ship()` for every session `sessions` lists, on a timer, until `stop()`.

    Two callers. A `Shipper` is one session's loop, in a daemon thread of the
    process that owns that session. The station loop (`asf up`, `asf station`)
    lists every session on the station, whichever process wrote it: one a
    watcher started, one somebody typed, one whose process died before its own
    shipper flushed. Resending is harmless (the cockpit stores each seq once),
    so a session shipped by both costs a request, never a duplicate.

    Nothing a session does waits on this: events are appended to the file
    whether or not the thread is alive, and the file is the buffer. A session
    is shipped only when its file grew. A cockpit that is down is retried with
    a doubling wait up to `RETRY_CEILING`; one that refuses the token, with no
    fresh one coming, is given up on for the life of the process (a token does
    not fix itself, and `asf station sync` catches up once it is). Each of
    those is said once through `say`, never per attempt.

    `stop()` asks for one last round, for the events a session writes as it
    ends (`session_finished`, `suspended`), and waits at most `budget` for it.
    A cockpit that answers takes milliseconds; one that hangs is left behind —
    the thread is a daemon — and those events go with the next process or sync.
    """

    def __init__(self, sessions: Callable[[], list[Path]], destination: Destination,
                 transport: Transport = post, interval: float = SHIP_INTERVAL):
        self.sessions = sessions
        self.destination = destination
        self.transport = transport
        self.interval = interval
        self.say: Callable[[str], None] = lambda text: print(f"station: {text}",
                                                             file=sys.stderr, flush=True)
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="station-loop", daemon=True)
        self._shipped_to: Cockpit | None = None
        self._shipped_size: dict[str, int] = {}     # adw_id -> size when all of it was acked
        self._wait = interval
        self._gave_up = False
        self._said: set[str] = set()

    def start(self) -> Loop:
        self._thread.start()
        return self

    def stop(self, budget: float = FLUSH_BUDGET) -> None:
        self._stopping.set()
        if self._thread.is_alive():
            self._thread.join(budget)

    def _loop(self) -> None:
        while not self._stopping.wait(self._wait):
            self._round()
        self._round()

    def _round(self) -> None:
        if self._gave_up:
            return
        try:
            cockpit = self.destination.get()
        except Exception as error:     # noqa: BLE001 — shipping never takes its host down
            self._say("no cockpit", f"could not reach the cockpit to ship to: {error!r}")
            return
        if cockpit is None:
            return
        if cockpit != self._shipped_to:
            self._shipped_to, self._shipped_size = cockpit, {}
        for directory in self.sessions():
            if not self._ship(directory, cockpit):
                return
        self._wait = self.interval

    def _ship(self, directory: Path, cockpit: Cockpit) -> bool:
        """One session; False when the rest of this round is pointless."""
        try:
            size = events.path(directory).stat().st_size
        except OSError:
            return True                # nothing written yet
        if self._shipped_size.get(directory.name) == size:
            return True
        try:
            result = ship(directory, cockpit, self.transport)
        except Exception as error:     # noqa: BLE001
            self._say(f"crashed {directory.name}", f"could not ship {directory.name}: "
                                                   f"{error!r}")
            self._shipped_size[directory.name] = size
            return True
        if result.outcome == "shipped":
            if result.pending == 0:
                self._shipped_size[directory.name] = size
            return True
        if result.outcome == "unauthorized":
            if self.destination.refused(cockpit):
                self._shipped_to = None
                return False
            self._say("unauthorized", f"the cockpit refused ASF_COCKPIT_TOKEN ({result.error}); "
                                      f"nothing more is shipped from this process")
            self._gave_up = True
            return False
        if result.outcome == "refused":
            # This session's batch, not the cockpit: the others still go, and
            # this one is tried again when it grows.
            self._say(f"refused {directory.name}", f"the cockpit refused {directory.name} "
                                                   f"({result.error})")
            self._shipped_size[directory.name] = size
            return True
        self._wait = min(RETRY_CEILING, max(self._wait * 2, self.interval))
        self._say("unreachable", f"cockpit unreachable ({result.error}); every session is "
                                 f"kept from its acknowledged seq and retried")
        return False

    def _say(self, key: str, text: str) -> None:
        if key not in self._said:
            self._said.add(key)
            self.say(text)


class Shipper(Loop):
    """One live session's loop, shipping to the configured cockpit."""

    def __init__(self, session_dir: str | Path, cockpit: Cockpit,
                 transport: Transport = post, interval: float = SHIP_INTERVAL):
        directory = Path(session_dir)
        super().__init__(lambda: [directory], Destination(lambda: cockpit), transport, interval)
        self.adw_id = directory.name

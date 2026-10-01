"""An in-process cockpit: the station wire's semantics, and no socket.

What `apps/cockpit/convex/http.ts` promises a station, kept to the part a
station can observe. INGEST (`ingest.ts`): a bearer token or 401, a batch of
at most `MAX_EVENTS` or 413, each (session, seq) stored once and never
overwritten, and an answer naming the highest seq with every seq below it
stored. REGISTERING (`stations.ts`): a code asked for with the ingest token,
approved by a person (`approve`), and a command token handed to whoever polls
with the device secret. COMMANDS (`commands.ts`): a poll with the command
token or 401 (`revoke`), recording the station's report and who polled, and
answering with the queued commands for it — a run's own poll gets the ones
naming its session, the station loop's the rest. A command is done when a
`command_result` naming it is ingested, never when it was sent.

It is called exactly as `engine.station`'s transport is — `(url, token, body)
-> (status, body)` — and raises `ConnectionRefusedError` while it is `down`,
which is what a real one does from the station's side.

`forget()` is the cockpit whose database was wiped: it answers `acked: 0` for a
session the station believes shipped, and the station has to believe it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

MAX_EVENTS = 500          # apps/cockpit/convex/model/wire.ts


@dataclass
class Registration:
    device: str
    code: str
    station: dict
    owner: str = ""                     # set by `approve`
    expired: bool = False


@dataclass
class Queued:
    id: str
    verb: str
    session: str
    by: str
    notes: str = ""
    expires_at: int = 0
    delivered: int = 0                  # how many polls it went out on


@dataclass
class Poll:
    station: str
    session: str
    report: dict = field(default_factory=dict)


class FakeCockpit:
    def __init__(self, token: str = "asf_ingest_test"):
        self.token = token
        self.down = False
        self.stored: dict[str, dict[int, dict]] = {}
        self.batches: list[dict] = []
        self.hold: threading.Event | None = None     # set: requests block until it is set
        self.registrations: list[Registration] = []
        self.stations: dict[str, str] = {}           # command token -> station id
        self.queued: list[Queued] = []
        self.polls: list[Poll] = []
        self.results: dict[str, dict] = {}           # command id -> the command_result payload
        self.redeliver = False                       # a station that never answered gets it again

    def __call__(self, url: str, token: str, body: dict) -> tuple[int, dict]:
        if self.hold is not None:
            self.hold.wait()
        if self.down:
            raise ConnectionRefusedError(f"{url}: connection refused")
        for path, route in (("/ingest", self._ingest), ("/station/register/poll", self._handed),
                            ("/station/register", self._register), ("/commands", self._poll)):
            if url.endswith(path):
                return route(token, body)
        raise AssertionError(f"no such route on the fake cockpit: {url}")

    # ── ingest ───────────────────────────────────────────────────────────────

    def _ingest(self, token: str, body: dict) -> tuple[int, dict]:
        if token != self.token:
            return 401, {"error": "this ingest token is not one the cockpit issued"}
        events = body["events"]
        if len(events) > MAX_EVENTS:
            return 413, {"error": f"a batch holds at most {MAX_EVENTS} events"}
        self.batches.append(body)
        session = self.stored.setdefault(body["session"], {})
        for event in events:
            if event["seq"] not in session and event["kind"] == "command_result":
                self.results[event["payload"]["command_id"]] = event["payload"]
            session.setdefault(event["seq"], event)
        return 200, {"acked": self.acked(body["session"])}

    def acked(self, session: str) -> int:
        stored = self.stored.get(session, {})
        seq = 0
        while seq + 1 in stored:
            seq += 1
        return seq

    def kinds(self, session: str) -> list[str]:
        stored = self.stored.get(session, {})
        return [stored[seq]["kind"] for seq in sorted(stored)]

    def forget(self) -> None:
        self.stored.clear()

    # ── registering ──────────────────────────────────────────────────────────

    def _register(self, token: str, body: dict) -> tuple[int, dict]:
        if token != self.token:
            return 401, {"error": "this ingest token is not one the cockpit issued"}
        if body["station"].get("kind") == "ci":
            return 400, {"error": "a CI station takes no commands"}
        number = len(self.registrations) + 1
        asked = Registration(device=f"device_{number}", code=f"ABCD-{number:04d}",
                             station=body["station"])
        self.registrations.append(asked)
        return 200, {"device": asked.device, "code": asked.code, "interval": 1,
                     "expires_in": 5, "url": f"http://cockpit.test/stations/approve?code={asked.code}"}

    def approve(self, code: str, owner: str = "alex") -> None:
        next(asked for asked in self.registrations if asked.code == code).owner = owner

    def _handed(self, _token: str, body: dict) -> tuple[int, dict]:
        asked = next((r for r in self.registrations if r.device == body.get("device")), None)
        if asked is None or asked.expired:
            return 410, {"status": "expired", "error": "this code expired"}
        if not asked.owner:
            return 200, {"status": "pending"}
        self.registrations.remove(asked)
        token = f"asf_station_{asked.station['id']}"
        self.stations[token] = asked.station["id"]
        return 200, {"status": "approved", "token": token, "owner": asked.owner,
                     "station": asked.station["id"]}

    def admit(self, station: str, token: str = "asf_station_test") -> str:
        """A station somebody approved earlier: its command token."""
        self.stations[token] = station
        return token

    def revoke(self, station: str) -> None:
        self.stations = {token: held for token, held in self.stations.items() if held != station}

    # ── commands ─────────────────────────────────────────────────────────────

    def queue(self, verb: str, session: str, by: str = "alex", expires_at: int = 0) -> str:
        command = Queued(id=f"cmd{len(self.queued) + 1}", verb=verb, session=session, by=by,
                         expires_at=expires_at)
        self.queued.append(command)
        return command.id

    def _poll(self, token: str, body: dict) -> tuple[int, dict]:
        station = self.stations.get(token)
        if station is None or station != body.get("station"):
            return 401, {"error": "this command token is not one the cockpit issued, or it was revoked"}
        session = body.get("session", "")
        self.polls.append(Poll(station=station, session=session, report=body.get("report", {})))
        attended = {poll.session for poll in self.polls if poll.session}
        due = [command for command in self.queued if command.id not in self.results
               and (self.redeliver or not command.delivered)
               and (command.session == session if session else command.session not in attended)]
        for command in due:
            command.delivered += 1
        return 200, {"commands": [{"id": c.id, "verb": c.verb, "session": c.session,
                                   "notes": c.notes, "by": c.by, "expires_at": c.expires_at}
                                  for c in due]}

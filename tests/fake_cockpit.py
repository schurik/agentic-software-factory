"""An in-process cockpit: the station wire's semantics, and no socket.

What `apps/cockpit/convex/http.ts` promises a station, kept to the part a
station can observe. INGEST (`ingest.ts`): a bearer token or 401, a batch of
at most `MAX_EVENTS` or 413, each (session, seq) stored once and never
overwritten, and an answer naming the highest seq with every seq below it
stored. REGISTERING (`stations.ts`): a code asked for with the ingest token —
or without one, naming the factory, which hands an ingest token of the
station's own over with the command token (#175) — approved by a person
(`approve`), and a command token handed to whoever polls with the device
secret. COMMANDS (`commands.ts`): a poll with the command
token or 401 (`revoke`), recording the station's report and who polled, and
answering with the queued commands for it — a run's own poll gets the ones
naming its session, the station loop's the rest. A command is done when a
`command_result` naming it is ingested, never when it was sent — or, for one
that names no session the station holds (a `run`), when a poll carries it.
CLAIMS (`claims.ts`): asked with the ingest token, keyed on (repo, kind,
number), granted to the first session that asks and to that session on that
station again, refused (409) to any other and to a session a writer abandoned; held until that session's events say it finished
or was aborted — a failure keeps it — and given back by its station only for a
session that never started. `release` is a writer freeing one in the cockpit.
DESCRIBING (`/describe`): a factory's self-description, sent with the ingest
token or 401, kept as it arrived beside the station that sent it — from a
local station only while nothing has described the factory (403 after), and
only for the default branch when the forge named one (409). A registration's
hand-over says whether anything has (`described`), unless `says_described` is
off: a cockpit from before that, which never says.

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
NOT_ISSUED = "this ingest token is not one the cockpit issued, or it was revoked"


@dataclass
class Registration:
    device: str
    code: str
    station: dict
    owner: str = ""                     # set by `approve`
    expired: bool = False
    factory: str = ""                   # what a request holding no token named
    host: str = ""


@dataclass
class Queued:
    id: str
    verb: str
    session: str
    by: str
    notes: str = ""
    expires_at: int = 0
    fields: dict = field(default_factory=dict)   # verdict, gate, round, digest, workflow, prompt
    delivered: int = 0                  # how many polls it went out on


@dataclass
class Claim:
    station: str
    name: str
    session: str
    since: int = 0
    aborted: bool = False
    requeue: dict = field(default_factory=dict)


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
        self.claims: dict[tuple[str, str, int], Claim] = {}   # (repo, kind, number) -> held
        self.freed: list[dict] = []                  # every claim let go: which, why, by whom
        self.grants_claims = True                    # False: a cockpit older than claims (404)
        self.abandoned: dict[str, str] = {}          # session -> the writer who released its claim
        self.descriptions: list[dict] = []           # every /describe body, as sent
        self.issued: dict[str, str] = {}             # ingest token handed over -> station id
        self.tokenless = True                        # False: a cockpit older than #175 (401)
        self.says_described = True                   # False: a hand-over that never says
        self.default_branch = ""                     # what the forge says it is, when it does
        self.asked = 0                               # registrations ever asked: no code reused

    def __call__(self, url: str, token: str, body: dict) -> tuple[int, dict]:
        if self.hold is not None:
            self.hold.wait()
        if self.down:
            raise ConnectionRefusedError(f"{url}: connection refused")
        for path, route in (("/ingest", self._ingest), ("/station/register/poll", self._handed),
                            ("/station/register", self._register), ("/commands", self._poll),
                            ("/claims", self._claim), ("/describe", self._describe)):
            if url.endswith(path):
                return route(token, body)
        raise AssertionError(f"no such route on the fake cockpit: {url}")

    def ingests(self, token: str) -> bool:
        """The factory's own token, or one a registration handed a station."""
        return token == self.token or token in self.issued

    # ── describing ───────────────────────────────────────────────────────────

    def _describe(self, token: str, body: dict) -> tuple[int, dict]:
        if not self.ingests(token):
            return 401, {"error": NOT_ISSUED}
        if not (isinstance(body.get("description"), dict) and isinstance(body.get("station"), dict)):
            return 400, {"error": "a description names its station and carries the description"}
        if body["station"].get("kind") != "ci":
            if self.descriptions:
                return 403, {"error": "this factory is described already: its CI workflow keeps "
                                      "the description current, never a local checkout"}
            ref = body["description"].get("checked", {}).get("ref", "")
            if self.default_branch and ref != self.default_branch:
                return 409, {"error": f"a factory is first described from its default branch, "
                                      f"{self.default_branch}, and this checkout is on {ref}"}
        self.descriptions.append(body)
        return 200, {}

    # ── ingest ───────────────────────────────────────────────────────────────

    def _ingest(self, token: str, body: dict) -> tuple[int, dict]:
        if not self.ingests(token):
            return 401, {"error": NOT_ISSUED}
        events = body["events"]
        if len(events) > MAX_EVENTS:
            return 413, {"error": f"a batch holds at most {MAX_EVENTS} events"}
        self.batches.append(body)
        session = self.stored.setdefault(body["session"], {})
        for event in events:
            if event["seq"] not in session and event["kind"] == "command_result":
                self.results[event["payload"]["command_id"]] = event["payload"]
            session.setdefault(event["seq"], event)
        self._settle_claims(body["session"])
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
        if token and not self.ingests(token):
            return 401, {"error": NOT_ISSUED}
        if not token and (not self.tokenless or not body.get("factory")):
            return 401, {"error": "registering needs the factory's ingest token"}
        if body["station"].get("kind") == "ci":
            return 400, {"error": "a CI station takes no commands"}
        self.asked += 1
        number = self.asked
        asked = Registration(device=f"device_{number}", code=f"ABCD-{number:04d}",
                             station=body["station"], factory="" if token else body["factory"],
                             host=body.get("host", ""))
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
        answer = {"status": "approved", "token": token, "owner": asked.owner,
                  "station": asked.station["id"]}
        if self.says_described:
            answer["described"] = bool(self.descriptions)
        if asked.factory:
            self.revoke_ingest(asked.station["id"])
            answer["ingest_token"] = f"asf_ingest_{asked.device}"
            self.issued[answer["ingest_token"]] = asked.station["id"]
        return 200, answer

    def admit(self, station: str, token: str = "asf_station_test") -> str:
        """A station somebody approved earlier: its command token."""
        self.stations[token] = station
        return token

    def revoke(self, station: str) -> None:
        """The station's Revoke: its command token, and any ingest token it was handed."""
        self.stations = {token: held for token, held in self.stations.items() if held != station}
        self.revoke_ingest(station)

    def revoke_ingest(self, station: str) -> None:
        self.issued = {token: held for token, held in self.issued.items() if held != station}

    # ── commands ─────────────────────────────────────────────────────────────

    def queue(self, verb: str, session: str, by: str = "alex", expires_at: int = 0,
              notes: str = "", id: str = "", **fields) -> str:
        command = Queued(id=id or f"cmd{len(self.queued) + 1}", verb=verb, session=session,
                         by=by, notes=notes, expires_at=expires_at, fields=fields)
        self.queued.append(command)
        return command.id

    def _poll(self, token: str, body: dict) -> tuple[int, dict]:
        station = self.stations.get(token)
        if station is None or station != body.get("station"):
            return 401, {"error": "this command token is not one the cockpit issued, or it was revoked"}
        session = body.get("session", "")
        self.polls.append(Poll(station=station, session=session, report=body.get("report", {})))
        for result in body.get("results") or []:
            self.results.setdefault(result["command_id"], result)
        attended = {poll.session for poll in self.polls if poll.session}
        due = [command for command in self.queued if command.id not in self.results
               and (self.redeliver or not command.delivered)
               and (command.session == session if session else command.session not in attended)]
        for command in due:
            command.delivered += 1
        return 200, {"commands": [{"id": c.id, "verb": c.verb, "session": c.session,
                                   "notes": c.notes, "by": c.by, "expires_at": c.expires_at,
                                   **c.fields} for c in due]}

    # ── claims ───────────────────────────────────────────────────────────────

    def _claim(self, token: str, body: dict) -> tuple[int, dict]:
        if not self.grants_claims:
            return 404, {}
        if not self.ingests(token):
            return 401, {"error": NOT_ISSUED}
        key = (body.get("repo") or "acme/widgets").lower(), body["kind"], int(body["number"])
        station = body["station"]
        held = self.claims.get(key)
        if body.get("op") == "drop":
            mine = held is not None and (held.station, held.session) == (station["id"],
                                                                         body["session"])
            if mine:
                self._free(key, "never started")
            return 200, {"dropped": mine}
        if body["session"] in self.abandoned:
            return 409, {"granted": False, "abandoned": {"session": body["session"],
                                                         "by": self.abandoned[body["session"]]}}
        if held is None:
            self.claims[key] = Claim(station=station["id"], name=station["name"],
                                     session=body["session"], since=int(body.get("since") or 0),
                                     requeue=body.get("requeue") or {})
        elif (held.station, held.session) != (station["id"], body["session"]):
            return 409, {"granted": False, "held": {"station": held.station, "name": held.name,
                                                    "session": held.session}}
        return 200, {"granted": True}

    def _settle_claims(self, session: str) -> None:
        """What a session's events say about the claims it holds, in seq order."""
        stored = self.stored.get(session, {})
        for key, claim in list(self.claims.items()):
            if claim.session != session:
                continue
            for seq in range(claim.since + 1, self.acked(session) + 1):
                event = stored[seq]
                payload = event["payload"]
                if (event["kind"] == "decision_recorded"
                        and (payload.get("decision") or {}).get("verdict") == "abort"):
                    claim.aborted = True
                if event["kind"] == "session_finished" and (payload.get("status") == "success"
                                                            or claim.aborted):
                    self._free(key, "aborted" if claim.aborted else "finished")
                    break

    def _free(self, key: tuple[str, str, int], why: str, by: str = "") -> None:
        claim = self.claims.pop(key)
        self.freed.append({"repo": key[0], "kind": key[1], "number": key[2],
                           "session": claim.session, "why": why, "by": by})

    def taken(self, kind: str, number: int, session: str, station: str = "st_elsewhere",
             name: str = "bob@laptop:widgets", repo: str = "acme/widgets") -> None:
        """A claim another station took earlier."""
        self.claims[(repo, kind, number)] = Claim(station=station, name=name, session=session)

    def release(self, kind: str, number: int, by: str, repo: str = "acme/widgets") -> None:
        """A writer's Release claim, in the cockpit: the session is abandoned."""
        self.abandoned[self.claims[(repo, kind, number)].session] = by
        self._free((repo, kind, number), "released", by)

    def holder(self, kind: str, number: int, repo: str = "acme/widgets") -> str:
        """The session holding a claim, or ""."""
        held = self.claims.get((repo, kind, number))
        return held.session if held else ""

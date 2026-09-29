"""An in-process cockpit: the ingest wire's semantics, and no socket.

What `apps/cockpit/convex/http.ts` and `ingest.ts` promise a station, kept to
the part a station can observe: a bearer token or 401, a batch of at most
`MAX_EVENTS` or 413, each (session, seq) stored once and never overwritten, and
an answer naming the highest seq with every seq below it stored. It is called
exactly as `engine.station`'s transport is — `(url, token, body) -> (status,
body)` — and raises `ConnectionRefusedError` while it is `down`, which is what
a real one does from the station's side.

`forget()` is the cockpit whose database was wiped: it answers `acked: 0` for a
session the station believes shipped, and the station has to believe it.
"""

from __future__ import annotations

import threading

MAX_EVENTS = 500          # apps/cockpit/convex/model/wire.ts


class FakeCockpit:
    def __init__(self, token: str = "asf_ingest_test"):
        self.token = token
        self.down = False
        self.stored: dict[str, dict[int, dict]] = {}
        self.batches: list[dict] = []
        self.hold: threading.Event | None = None     # set: requests block until it is set

    def __call__(self, url: str, token: str, body: dict) -> tuple[int, dict]:
        if self.hold is not None:
            self.hold.wait()
        if self.down:
            raise ConnectionRefusedError(f"{url}: connection refused")
        assert url.endswith("/ingest"), url
        if token != self.token:
            return 401, {"error": "this ingest token is not one the cockpit issued"}
        events = body["events"]
        if len(events) > MAX_EVENTS:
            return 413, {"error": f"a batch holds at most {MAX_EVENTS} events"}
        self.batches.append(body)
        session = self.stored.setdefault(body["session"], {})
        for event in events:
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

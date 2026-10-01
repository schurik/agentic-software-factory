"""`asf …` in a process whose cockpit is a `FakeCockpit` in that same process.

A kill from the cockpit reaches a live run through the run's OWN shipper
thread, and the run stops itself — so the test has to be that process, not a
neighbour of it, and nothing in the suite may open a socket. This script is
that process: it puts the stamped `asf/` on the path, makes the fake the
transport `engine.station` falls back to, queues what the test asked for, and
runs `asf/asf.py` as a user would. On its way out — after the run's own
shipper has flushed, which is why its hook is registered first — it writes
what the fake was sent to the file the test named.

    python fake_cockpit_run.py <spec.json> <asf args…>

with `spec.json` holding `out` (where to write the fake's state), `station`
(the id whose command token the fake knows: `asf_station_test`) and `queue`
(`[{verb, session, by}]`), `hold` (`[{kind, number, session, station?}]`, claims
taken earlier), `abandoned` (`[{session, by}]`, sessions a writer released) and
`down` (a cockpit that does not answer).
"""

from __future__ import annotations

import atexit
import json
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY = Path.cwd() / "asf" / "asf.py"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ENTRY.resolve().parent))      # what asf.py puts first itself

from fake_cockpit import FakeCockpit  # noqa: E402
from engine import station  # noqa: E402

spec = json.loads(Path(sys.argv[1]).read_text())
cockpit = FakeCockpit()
cockpit.admit(spec.get("station", "st_test"))
for command in spec.get("queue", []):
    cockpit.queue(**command)
for held in spec.get("hold", []):
    cockpit.taken(**held)
for gone in spec.get("abandoned", []):
    cockpit.abandoned[gone["session"]] = gone["by"]
cockpit.down = spec.get("down", False)
station.post = cockpit


def told() -> None:
    Path(spec["out"]).write_text(json.dumps({
        "stored": cockpit.stored, "results": cockpit.results,
        "polls": [poll.__dict__ for poll in cockpit.polls],
        "claims": {f"{kind} {number}": claim.session
                   for (_repo, kind, number), claim in cockpit.claims.items()},
        "freed": cockpit.freed,
        "descriptions": cockpit.descriptions,
    }))


atexit.register(told)
sys.argv = [str(ENTRY), *sys.argv[2:]]
runpy.run_path(str(ENTRY), run_name="__main__")

"""The local cockpit: the team deployment's own images, on this machine.

A cockpit is optional and usually shared (ASF_COCKPIT_URL names it). Without
one, `asf up` starts one here — the SAME published `ghcr.io` images a team
runs, through the stamped `asf/cockpit/compose.yaml` (ADR 0004), so there is
one artifact to build, version and test, and local mode is the team deployment
on localhost. The cockpit lives outside the skill (ADR 0001); what a stamp
carries is the compose file and `asf/cockpit/min-version`, the oldest cockpit
this release of the skill ships to. `asf up` runs that version or the newer
one ASF_COCKPIT_VERSION names, never an older one, because the cockpit reads
every event a factory has ever written and a factory only ever adds to them:
the cockpit upgrades first.

IT RUNS DETACHED (ADR 0009). The cockpit is one per machine, shared by every
factory on it, so no factory's process owns it: `asf up` makes sure one is
running (`compose up --detach`, which returns once its containers are
started) and ships to it, and ctrl-c on that `up` stops the station and its
watchers, never the cockpit another factory is shipping to. Docker restarts
it with the machine (`restart: unless-stopped`); `asf cockpit down` is the
one thing that stops it. A cockpit already running at this stamp's version
or newer is joined and never recreated, so an `up` does not bounce the
cockpit under everyone else; only an older one is replaced.

Docker is the price. Without it — no CLI, no compose plugin, no daemon —
`docker_problem()` says which, `asf up` drops the cockpit with a warning and
the watchers run anyway, and `doctor` says the same thing before anyone asks.

The station ships to the local cockpit exactly as to a shared one, with an
ingest token the cockpit issued this factory (`Local`). Issuing one is an
admin call into the running app container, so the token is minted once the
cockpit is up, kept in the gitignored `<data_dir>/cockpit.json`, and replaced
when the cockpit refuses it — a wiped volume forgets every token it issued.
The station's command token comes the same way and is kept beside it: a
local cockpit is its one person's, so the station is theirs without anyone
approving it (`asf station register` is for a shared cockpit).

A team's cockpit reaches the forge through a GitHub App and signs people in
with it. A local one has neither: GitHub cannot reach localhost, and the one
person in front of it is whoever ran `asf up`. So it asks the forge AS them,
with their own token for it (`forge_credential`, through `Forge.token`), handed
to the app container in its environment — never on a command line, never in a file of
this repository. The cockpit keeps it where it keeps everything: in its
backend, in the `data` volume on this machine, until the `asf up` that next
starts it hands it another or none. Without one the cockpit still shows every session this
station ships; it just cannot ask the forge which other repositories hold a
factory.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import forge
from .data_types import Cockpit, FactoryConfig, LocalCockpitRecord, Station, StationCredential
from .utils import ensure_dir, now_iso, write_atomic

HOME = Path(__file__).resolve().parent.parent / "cockpit"     # asf/cockpit, stamped
COMPOSE = HOME / "compose.yaml"
MIN_VERSION = HOME / "min-version"
RECORD = "cockpit.json"
PROJECT = "asf-cockpit"            # compose.yaml's `name:`

# Where a release publishes the images (`.github/workflows/release.yml` in the
# skill's repository); ASF_COCKPIT_REGISTRY points a fork at its own.
REGISTRY = "ghcr.io/schurik"
IMAGES = ("asf-cockpit-backend", "asf-cockpit")
APP_PORT, BACKEND_PORT, SITE_PORT = 3000, 3210, 3211
MINT_RETRY = 5.0               # seconds between asking a cockpit still starting for a token

_TOKEN = re.compile(r"asf_ingest_[0-9a-f]+")
_STATION_TOKEN = re.compile(r"asf_station_[0-9a-f]+")
_OWNER = re.compile(r'"owner"\s*:\s*"([^"]*)"')
_SEMVER = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


# ── which cockpit ────────────────────────────────────────────────────────────

def minimum() -> str:
    """The oldest cockpit this stamp ships to."""
    return MIN_VERSION.read_text().strip()


def _semver(text: str) -> tuple[int, int, int] | None:
    found = _SEMVER.fullmatch(text.strip())
    return tuple(int(part) for part in found.groups()) if found else None


def version() -> str:
    """ASF_COCKPIT_VERSION when it is at least the minimum, else the minimum.

    Never older: an operator who pinned last year's cockpit gets this year's
    rather than one that stores this release's events as unknown rows. An
    unreadable pin is ignored the same way — the minimum is always runnable.
    """
    floor = minimum()
    asked = os.environ.get("ASF_COCKPIT_VERSION", "").strip()
    wanted = _semver(asked) if asked else None
    if wanted is None or wanted < _semver(floor):
        return floor
    return ".".join(str(part) for part in wanted)


def ignored_pin() -> str:
    """ASF_COCKPIT_VERSION as written, when `version()` does not honour it."""
    asked = os.environ.get("ASF_COCKPIT_VERSION", "").strip()
    return asked if asked and _semver(asked) != _semver(version()) else ""


def current(running: str) -> bool:
    """Whether a cockpit running at `running` is at least `version()` — one
    this stamp joins as it is. The same version is joined too, never
    recreated: `compose up` with another factory's token or compose file
    would replace the containers every other factory is shipping to."""
    found = _semver(running)
    return found is not None and found >= _semver(version())


def registry() -> str:
    return os.environ.get("ASF_COCKPIT_REGISTRY", "").strip().rstrip("/") or REGISTRY


def images(at: str | None = None) -> list[str]:
    tag = at or version()
    return [f"{registry()}/{name}:{tag}" for name in IMAGES]


def _port(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw.isdigit() else default


def app_url() -> str:
    return f"http://localhost:{_port('ASF_COCKPIT_APP_PORT', APP_PORT)}"


def site_url() -> str:
    """Where the station ships: the backend's site origin."""
    return f"http://127.0.0.1:{_port('ASF_COCKPIT_SITE_PORT', SITE_PORT)}"


def shared() -> str:
    """The shared cockpit ASF_COCKPIT_URL names, or "" — and "" means local."""
    return os.environ.get("ASF_COCKPIT_URL", "").strip()


def has_issued_token(data_dir: Path) -> bool:
    """Whether the machine's local cockpit has issued this factory a token —
    which is what "this factory ships to a local cockpit" comes down to: `asf
    up` started one here, and the station has been sending to it (`Local`)."""
    try:
        LocalCockpitRecord.model_validate_json((data_dir / RECORD).read_text())
    except (OSError, ValueError):
        return False
    return True


# (argv) -> (exit code, output). Injected so tests never run docker.
Run = Callable[[list[str]], "tuple[int, str]"]


def _run(argv: list[str]) -> tuple[int, str]:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=60,
                              env={**os.environ, **compose_env()})
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


# ── the forge, as the local cockpit asks it ──────────────────────────────────

@dataclass(frozen=True)
class ForgeCredential:
    """What the local cockpit asks the forge with: the host, and the person's
    own token for it — "" when the forge's CLI is missing or not signed in —
    and how they sign in, for when it is."""
    host: str
    token: str
    sign_in: str = ""

    def env(self) -> dict[str, str]:
        """For the `cockpit` child: what the stamped compose file hands the app container."""
        return {"ASF_COCKPIT_FORGE_HOST": self.host, "ASF_COCKPIT_FORGE_TOKEN": self.token}

    @property
    def line(self) -> str:
        """One line on what was found, naming the host and never the token."""
        if self.token:
            return f"{self.host}, as you (your own token)"
        return (f"no token for {self.host} — the local cockpit lists only the factories its "
                f"stations ship: {self.sign_in}, then start again")


def forge_credential(cfg: FactoryConfig) -> ForgeCredential:
    """The person's own token for the host `forge:` is reached at, so the
    local cockpit can ask the forge as the person who ran `asf up`.

    Asked once, as the cockpit starts. A token changed later — signing in
    again — reaches it the next time it starts: `asf cockpit down`, then
    `asf up`. An `up` that joins a running cockpit hands over nothing.
    """
    forge_ = forge.forge_of(cfg)
    return ForgeCredential(host=forge_.host(), token=forge_.token(), sign_in=forge_.sign_in)


# ── docker ───────────────────────────────────────────────────────────────────

def docker_problem() -> str | None:
    """Why this machine cannot run the local cockpit, or None when it can.

    Three questions, cheapest first, because each answer needs a different fix:
    no CLI, a CLI without the compose plugin, and a daemon that is not running
    (Docker Desktop installed and closed is the everyday one).
    """
    if not shutil.which("docker"):
        return "Docker is not installed (no `docker` on PATH)"
    if _quiet(["docker", "compose", "version"]) != 0:
        return "Docker has no compose plugin (`docker compose version` fails)"
    if _quiet(["docker", "info"]) != 0:
        return "the Docker daemon is not running (`docker info` fails)"
    return None


def missing_images(at: str | None = None) -> list[str]:
    """The cockpit images not pulled to this machine yet. Asks Docker."""
    return [image for image in images(at)
            if _quiet(["docker", "image", "inspect", image]) != 0]


def _quiet(argv: list[str]) -> int:
    try:
        return subprocess.run(argv, capture_output=True, timeout=20).returncode
    except (OSError, subprocess.SubprocessError):
        return 1


def running(run: Run | None = None) -> str:
    """The version of the local cockpit already running on this machine, or "".

    Read from the tag of its app container, which is what `compose up` was
    given. Asked before starting one, because the cockpit is one per machine:
    a second `asf up` joins one at least as new rather than recreating it,
    so an older stamp never downgrades a cockpit a newer one is using.
    """
    code, output = (run or _run)(["docker", "ps", "--format", "{{.Image}}",
                                  "--filter", f"label=com.docker.compose.project={PROJECT}",
                                  "--filter", "label=com.docker.compose.service=app"])
    lines = output.strip().splitlines() if code == 0 else []
    tag = lines[0].rpartition(":")[2] if lines else ""
    return tag if _semver(tag) else ""


def compose_env() -> dict[str, str]:
    return {"ASF_COCKPIT_REGISTRY": registry(), "ASF_COCKPIT_VERSION": version()}


def compose(*args: str) -> list[str]:
    return ["docker", "compose", "--file", str(COMPOSE), *args]


def up_argv() -> list[str]:
    """The supervisor's `cockpit` child: a one-shot that starts the cockpit
    DETACHED and exits once its containers are up, so ctrl-c on the `up`
    that ran it leaves it running for every other factory. Its pull and start
    are prefixed like any child's output; what the cockpit logs after that is
    `asf cockpit logs`. `--pull missing`: a release's tag is never
    republished, so an image already here is the right one."""
    return compose("up", "--detach", "--pull", "missing")


def down_argv() -> list[str]:
    """`asf cockpit down`: stops it for every factory on this machine and
    keeps its `data` volume, so each one's sessions are there when it is
    back. The project name is fixed, so any stamp's compose file stops the
    cockpit whichever stamp started it."""
    return compose("down")


def logs_argv(follow: bool) -> list[str]:
    return compose("logs", "--tail", "100", *(["--follow"] if follow else []))


# ── `asf cockpit` ────────────────────────────────────────────────────────────

def manage(action: str, follow: bool = False) -> int:
    """`asf cockpit status | logs | down`: the machine's local cockpit, which
    no `asf up` owns, asked after, read and stopped by name. `status` exits 1
    when none is running, so a script can ask."""
    problem = docker_problem()
    if problem:
        print(f"no local cockpit: {problem}", file=sys.stderr)
        return 2
    already = running()
    if action == "status":
        if shared():
            print(f"ASF_COCKPIT_URL names a shared cockpit ({shared()}) — this factory ships "
                  f"there, whatever runs here")
        if not already:
            print("the local cockpit is not running — `asf up` starts it")
            return 1
        print(f"the local cockpit {already} is running at {app_url()}, for every factory on "
              f"this machine — `asf cockpit down` stops it")
        return 0
    if action == "down":
        if not already:
            print("the local cockpit is not running — nothing to stop")
        else:
            print(f"stopping the local cockpit {already} for every factory on this machine — "
                  f"their stations keep every event and ship it when it is back")
    return _attached(down_argv() if action == "down" else logs_argv(follow))


def _attached(argv: list[str]) -> int:
    """compose with this terminal: its output as it comes, ctrl-c to it."""
    try:
        return subprocess.call(argv, env={**os.environ, **compose_env()})
    except KeyboardInterrupt:
        return 0


# ── the token the station ships with ─────────────────────────────────────────

class Local:
    """The local cockpit as the station loop asks for it: `get()` is the
    Cockpit to ship to, or None while it is still starting; `refused()` drops
    a token it would not take and says a fresh one is coming.

    `data_dir` is where the token is kept; `repository` is what the cockpit
    files this factory's sessions under (CONTEXT.md: a factory is known to a
    cockpit through its repository) — the wire calls it `factory`."""

    def __init__(self, data_dir: Path, repository: str, run: Run = _run,
                 retry: float = MINT_RETRY, here: Station | None = None):
        self.path = data_dir / RECORD
        self.repository = repository
        self.run = run
        self.retry = retry
        self.here = here
        self._asked_at: float | None = None
        self._credential_asked_at: float | None = None

    def get(self) -> Cockpit | None:
        record = self._recorded()
        if record is None:
            record = self._issue()
        return Cockpit(url=site_url(), token=record.token) if record else None

    def refused(self, cockpit: Cockpit) -> bool:
        record = self._recorded()
        if record is not None and record.token == cockpit.token:
            self.path.unlink(missing_ok=True)
        self._asked_at = None
        return True

    def credential(self) -> StationCredential | None:
        """The command token this station polls the local cockpit with —
        issued to whoever the cockpit holds a forge token for, without
        anybody approving it, because the machine is theirs. None until the
        cockpit has issued an ingest token, and while it is still starting."""
        record = self._recorded()
        if record is None or self.here is None:
            return None
        if record.station != self.here.id or not record.command_token:
            record = self._issue_command_token(record)
            if record is None:
                return None
        return StationCredential(cockpit=site_url(), station=record.station,
                                 token=record.command_token, owner=record.owner,
                                 issued_at=record.command_issued_at)

    def _issue_command_token(self, record: LocalCockpitRecord) -> LocalCockpitRecord | None:
        now = time.monotonic()
        if self._credential_asked_at is not None and now - self._credential_asked_at < self.retry:
            return None
        self._credential_asked_at = now
        asked = {"factory": self.repository, "station": self.here.model_dump(mode="json")}
        code, output = self.run(compose("exec", "-T", "app", "./convex.sh", "run",
                                        "stations:local", json.dumps(asked)))
        found = _STATION_TOKEN.search(output) if code == 0 else None
        if not found:
            return None
        owner = _OWNER.search(output)
        record = record.model_copy(update={"station": self.here.id,
                                           "command_token": found.group(0),
                                           "owner": owner.group(1) if owner else "",
                                           "command_issued_at": now_iso()})
        write_atomic(self.path, record.model_dump_json(indent=2))
        return record

    def _recorded(self) -> LocalCockpitRecord | None:
        try:
            record = LocalCockpitRecord.model_validate_json(self.path.read_text())
        except (OSError, ValueError):
            return None
        return record if record.repository == self.repository else None

    def _issue(self) -> LocalCockpitRecord | None:
        now = time.monotonic()
        if self._asked_at is not None and now - self._asked_at < self.retry:
            return None
        self._asked_at = now
        code, output = self.run(compose("exec", "-T", "app", "./convex.sh", "run",
                                        "tokens:issue", json.dumps({"factory": self.repository})))
        found = _TOKEN.search(output) if code == 0 else None
        if not found:
            return None                # still starting: asked again after `retry`
        record = LocalCockpitRecord(repository=self.repository, token=found.group(0),
                                    issued_at=now_iso())
        ensure_dir(self.path.parent)
        write_atomic(self.path, record.model_dump_json(indent=2))
        return record

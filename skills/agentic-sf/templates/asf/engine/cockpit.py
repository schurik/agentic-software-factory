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
with the token `gh auth token` prints (`forge_credential`), handed to the app
container in its environment — never on a command line, never in a file of
this repository. The cockpit keeps it where it keeps everything: in its
backend, in the `data` volume on this machine, until the next `asf up` hands
it another or none. Without one the cockpit still shows every session this
station ships; it just cannot ask the forge which other repositories hold a
factory.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .data_types import Cockpit, LocalCockpitRecord, Station, StationCredential
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
FORGE_HOST = "github.com"
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


def newer(than: str) -> bool:
    """Whether `than` is newer than `version()` — a cockpit this stamp joins
    rather than replaces. The same version is started (compose attaches to
    the containers already there), so an `up` whose predecessor was killed
    owns its cockpit again."""
    found = _semver(than)
    return found is not None and found > _semver(version())


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

def _gh(argv: list[str]) -> tuple[int, str]:
    """stdout only: a token, or nothing. stderr is `gh` explaining itself."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return done.returncode, done.stdout or ""


def forge_host() -> str:
    """The forge `gh` is aimed at: GH_HOST, as `gh` itself reads it, else
    github.com. An Enterprise Server is named there; nothing assumes one host."""
    return os.environ.get("GH_HOST", "").strip() or FORGE_HOST


@dataclass(frozen=True)
class ForgeCredential:
    """What the local cockpit asks the forge with: the host, and the person's
    own token for it — "" when `gh` is missing or not logged in."""
    host: str
    token: str

    def env(self) -> dict[str, str]:
        """For the `cockpit` child: what the stamped compose file hands the app container."""
        return {"ASF_COCKPIT_FORGE_HOST": self.host, "ASF_COCKPIT_FORGE_TOKEN": self.token}

    @property
    def line(self) -> str:
        """One line on what was found, naming the host and never the token."""
        if self.token:
            return f"{self.host}, as you (`gh auth token`)"
        return (f"no token for {self.host} — the local cockpit lists only the factories its "
                f"stations ship: `gh auth login`, then start again")


def forge_credential() -> ForgeCredential:
    """The token `gh auth token` prints for the host `gh` is aimed at, so the
    local cockpit can ask the forge as the person who ran `asf up`.

    Asked once, as the cockpit starts. A token changed later (`gh auth
    login`, `gh auth refresh`) reaches the cockpit with the next `asf up`.
    """
    host = forge_host()
    code, output = _gh(["gh", "auth", "token", "--hostname", host])
    token = output.strip() if code == 0 else ""
    return ForgeCredential(host=host, token=token if len(token.split()) == 1 else "")


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
    a second `asf up` joins a newer one rather than recreating it, so
    an older stamp never downgrades a cockpit a newer one is using.
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
    """The supervisor's `cockpit` child: in the foreground, so its output is
    prefixed like every other child's and ctrl-c takes it down with the rest.
    `--pull missing`: a release's tag is never republished, so an image
    already here is the right one."""
    return compose("up", "--pull", "missing")


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
                                 issued_at=record.issued_at)

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
                                           "owner": owner.group(1) if owner else ""})
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

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
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable

from .data_types import Cockpit, LocalCockpitRecord
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


# (argv) -> (exit code, output). Injected so tests never run docker.
Run = Callable[[list[str]], "tuple[int, str]"]


def _run(argv: list[str]) -> tuple[int, str]:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=60,
                              env={**os.environ, **compose_env()})
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


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
                 retry: float = MINT_RETRY):
        self.path = data_dir / RECORD
        self.repository = repository
        self.run = run
        self.retry = retry
        self._asked_at: float | None = None

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

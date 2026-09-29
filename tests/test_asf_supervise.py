"""`asf up` and `asf station`: the station loop, and the children it supervises.

Seams from the cockpit spec (#40) and #46: the station loop ships through the
injected transport to the in-process fake cockpit (`fake_cockpit.py`), never a
socket; the local cockpit mints its token through an injected command runner,
never a real `docker`; and the child set is asked of the supervisor's plan,
with Docker genuinely absent from PATH where the test is about its absence.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest
import yaml

from engine import cockpit as local_cockpit
from engine import events, factory, station, supervise
from engine.data_types import EVENT_KINDS, Cockpit

from .asf_helpers import asf, fake_roster
from .fake_cockpit import FakeCockpit
from .test_asf_station import eventually

COCKPIT = Cockpit(url="http://cockpit.test:3211", token="asf_ingest_test")


@pytest.fixture(autouse=True)
def no_cockpit_from_the_shell(monkeypatch):
    for name in ("ASF_COCKPIT_URL", "ASF_COCKPIT_TOKEN", "ASF_COCKPIT_VERSION",
                 "ASF_STATION_NAME", "CI"):
        monkeypatch.delenv(name, raising=False)


def a_session(root: Path, adw_id: str, count: int) -> Path:
    session = root / adw_id
    for pid in range(1, count + 1):
        events.emit(session, EVENT_KINDS["process_ended"](pid=pid))
    return session


# ── the station loop ─────────────────────────────────────────────────────────

def test_the_loop_ships_every_session_on_the_station_and_those_that_start_later(
        tmp_path: Path):
    sessions = tmp_path / "sessions"
    a_session(sessions, "0ld5e55n", 3)
    cockpit = FakeCockpit()
    loop = station.Loop(sessions, lambda: COCKPIT, cockpit, interval=0.02).start()
    try:
        assert eventually(lambda: cockpit.acked("0ld5e55n") == 3)
        later = a_session(sessions, "n3w5e55n", 1)
        assert eventually(lambda: cockpit.acked("n3w5e55n") == 1)
        events.emit(later, EVENT_KINDS["process_ended"](pid=2))
        assert eventually(lambda: cockpit.acked("n3w5e55n") == 2)
    finally:
        loop.stop()


def test_nothing_ships_until_there_is_a_cockpit_and_then_everything_does(tmp_path: Path):
    sessions = tmp_path / "sessions"
    a_session(sessions, "a1b2c3d4", 2)
    cockpit = FakeCockpit()
    ready: list[Cockpit] = []
    loop = station.Loop(sessions, lambda: ready[0] if ready else None, cockpit,
                        interval=0.02).start()
    try:
        assert not eventually(lambda: cockpit.batches, within=0.2)
        ready.append(COCKPIT)
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 2)
    finally:
        loop.stop()


def test_a_refused_token_is_swapped_for_a_fresh_one_when_one_is_coming(tmp_path: Path):
    sessions = tmp_path / "sessions"
    a_session(sessions, "a1b2c3d4", 2)
    cockpit = FakeCockpit(token="asf_ingest_fresh")
    tokens = ["asf_ingest_wiped"]

    def reissue(refused: Cockpit) -> bool:
        tokens.append("asf_ingest_fresh")
        return True

    loop = station.Loop(sessions, lambda: Cockpit(url=COCKPIT.url, token=tokens[-1]), cockpit,
                        interval=0.02, refused=reissue).start()
    try:
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 2)
    finally:
        loop.stop()


def test_a_refused_token_with_none_coming_stops_shipping_and_says_so_once(tmp_path: Path):
    sessions = tmp_path / "sessions"
    session = a_session(sessions, "a1b2c3d4", 2)
    cockpit = FakeCockpit(token="asf_ingest_other")
    said: list[str] = []
    loop = station.Loop(sessions, lambda: COCKPIT, cockpit, interval=0.02,
                        say=said.append).start()
    try:
        assert eventually(lambda: any("refused" in line for line in said))
        events.emit(session, EVENT_KINDS["process_ended"](pid=3))
        assert not eventually(lambda: len(cockpit.batches) > 0, within=0.2)
    finally:
        loop.stop()
    assert sum("refused" in line for line in said) == 1


def test_a_cockpit_that_is_down_gets_every_session_when_it_is_back(tmp_path: Path):
    sessions = tmp_path / "sessions"
    a_session(sessions, "a1b2c3d4", 2)
    a_session(sessions, "e5f6a7b8", 3)
    cockpit = FakeCockpit()
    cockpit.down = True
    loop = station.Loop(sessions, lambda: COCKPIT, cockpit, interval=0.02).start()
    try:
        assert not eventually(lambda: cockpit.stored, within=0.2)
        cockpit.down = False
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 2
                          and cockpit.acked("e5f6a7b8") == 3)
    finally:
        loop.stop()


# ── the local cockpit ────────────────────────────────────────────────────────

def test_the_stamp_names_a_minimum_cockpit_version_and_up_runs_nothing_older(monkeypatch):
    minimum = local_cockpit.minimum()
    assert re.fullmatch(r"\d+\.\d+\.\d+", minimum)
    assert local_cockpit.version() == minimum

    monkeypatch.setenv("ASF_COCKPIT_VERSION", "0.0.1")
    assert local_cockpit.version() == minimum                        # older: the minimum wins
    monkeypatch.setenv("ASF_COCKPIT_VERSION", "99.0.0")
    assert local_cockpit.version() == "99.0.0"                       # newer: at least that new
    monkeypatch.setenv("ASF_COCKPIT_VERSION", "v99.1.0")
    assert local_cockpit.version() == "99.1.0"


def without_docker(monkeypatch, tmp_path: Path) -> None:
    """PATH as a machine with git and nothing else: Docker genuinely absent."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").symlink_to(shutil.which("git"))
    monkeypatch.setenv("PATH", str(bin_dir))


def test_a_machine_without_docker_is_told_so(monkeypatch, tmp_path: Path):
    without_docker(monkeypatch, tmp_path)

    problem = local_cockpit.docker_problem()

    assert problem and "Docker" in problem


def minting(*answers: tuple[int, str]):
    """A `docker compose exec` stand-in: each call takes the next answer."""
    calls: list[list[str]] = []
    queue = list(answers)

    def run(argv: list[str]) -> tuple[int, str]:
        calls.append(argv)
        return queue.pop(0) if queue else (1, "no container")
    run.calls = calls
    return run


def test_the_local_cockpit_issues_this_factory_a_token_once_and_keeps_it(tmp_path: Path):
    run = minting((0, '"asf_ingest_0a1b"\n'))
    local = local_cockpit.Local(tmp_path, "asf/data", "acme/widgets", run=run)

    first = local.get()

    assert first == Cockpit(url="http://127.0.0.1:3211", token="asf_ingest_0a1b")
    assert "tokens:issue" in run.calls[0] and '{"factory": "acme/widgets"}' in run.calls[0]
    again = local_cockpit.Local(tmp_path, "asf/data", "acme/widgets", run=minting())
    assert again.get() == first                                 # kept, not issued again


def test_a_cockpit_still_starting_is_asked_again_later_not_every_round(tmp_path: Path):
    run = minting((1, "service \"app\" is not running"), (0, "asf_ingest_ff00\n"))
    local = local_cockpit.Local(tmp_path, "asf/data", "acme/widgets", run=run, retry=0.05)

    assert local.get() is None
    assert local.get() is None and len(run.calls) == 1          # too soon to ask again
    assert eventually(lambda: local.get() is not None)
    assert local.get().token == "asf_ingest_ff00"


def test_a_token_the_local_cockpit_refuses_is_replaced_by_a_fresh_one(tmp_path: Path):
    run = minting((0, "asf_ingest_01d0\n"), (0, "asf_ingest_0e50\n"))
    local = local_cockpit.Local(tmp_path, "asf/data", "acme/widgets", run=run, retry=0)
    refused = local.get()

    assert local.refused(refused) is True
    assert local.get().token == "asf_ingest_0e50"


# ── the children of `asf up` and `asf station` ───────────────────────────────

@pytest.fixture
def cfg(stamped: Path, monkeypatch):
    monkeypatch.chdir(stamped)
    return factory.load("asf/factory.yaml")


def names(services) -> list[str]:
    return [service.name for service in services]


def test_up_with_no_shared_cockpit_starts_the_local_one_beside_the_watchers(cfg, stamped):
    want = supervise.wanted(cfg, only="", extra="")

    assert want == {"cockpit", "issues", "answers", "prs"}
    started = supervise.services(want, "asf/factory.yaml", 120, stamped, stamped / "db")
    assert names(started) == ["cockpit", "issues", "answers", "prs"]
    cockpit = started[0]
    assert cockpit.argv[:2] == ["docker", "compose"]
    assert any(arg.endswith("asf/cockpit/compose.yaml") for arg in cockpit.argv)
    assert cockpit.env["ASF_COCKPIT_VERSION"] == local_cockpit.minimum()


def test_up_with_a_shared_cockpit_starts_no_cockpit_child(cfg, monkeypatch):
    monkeypatch.setenv("ASF_COCKPIT_URL", "https://cockpit.example.com:3211")

    assert supervise.wanted(cfg, only="", extra="") == {"issues", "answers", "prs"}
    assert supervise.wanted(cfg, only="cockpit,issues", extra="") == {"issues"}


def test_the_legacy_trace_ui_starts_only_when_asked_for(cfg):
    assert "obs" not in supervise.wanted(cfg, only="", extra="")
    assert "obs" in supervise.wanted(cfg, only="", extra="obs")
    assert supervise.wanted(cfg, only="issues,obs", extra="") == {"issues", "obs"}
    with pytest.raises(SystemExit):
        supervise.wanted(cfg, only="", extra="ui")


def test_asf_station_is_the_same_loop_without_watchers(cfg, monkeypatch):
    assert supervise.wanted(cfg, only="", extra="", watchers=False) == {"cockpit"}
    monkeypatch.setenv("ASF_COCKPIT_URL", "https://cockpit.example.com:3211")
    assert supervise.wanted(cfg, only="", extra="", watchers=False) == set()


def test_without_docker_up_warns_drops_the_cockpit_and_runs_the_watchers(
        cfg, monkeypatch, tmp_path, capsys):
    without_docker(monkeypatch, tmp_path)
    want = supervise.wanted(cfg, only="", extra="")

    supervise.check(cfg, want)

    assert want == {"issues", "answers", "prs"}
    out = capsys.readouterr().out
    assert "Docker is not installed" in out and "watchers" in out


# ── doctor ───────────────────────────────────────────────────────────────────

def test_doctor_reports_docker_missing_and_names_the_cockpit_it_would_run(
        stamped: Path, tmp_path: Path):
    fake_roster(stamped)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").symlink_to(shutil.which("git"))

    result = asf(stamped, "doctor", env={"PATH": str(bin_dir)})

    assert result.returncode == 0, result.stdout + result.stderr     # a warning, never fatal
    line = next(line for line in result.stdout.splitlines() if "cockpit" in line)
    assert "Docker is not installed" in line
    assert local_cockpit.minimum() in result.stdout


def test_doctor_with_a_shared_cockpit_asks_nothing_of_docker(stamped: Path, tmp_path: Path):
    fake_roster(stamped)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").symlink_to(shutil.which("git"))

    result = asf(stamped, "doctor", env={"PATH": str(bin_dir),
                                         "ASF_COCKPIT_URL": "https://cockpit.example.com:3211"})

    line = next(line for line in result.stdout.splitlines() if "cockpit" in line)
    assert "https://cockpit.example.com:3211" in line and "Docker" not in line


# ── what a release publishes, and what a stamp pulls ─────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
RELEASE = REPO_ROOT / ".github" / "workflows" / "release.yml"


def test_a_release_publishes_every_image_the_stamp_pulls_tagged_with_its_version():
    release = yaml.safe_load(RELEASE.read_text())
    triggers = release.get("on", release.get(True))           # YAML 1.1 reads `on` as True
    assert triggers["push"]["tags"] == ["v*.*.*"]
    assert release["permissions"]["packages"] == "write"
    steps = "\n".join(str(step.get("run", "")) + str(step.get("with", ""))
                      for job in release["jobs"].values() for step in job["steps"])
    assert ".claude-plugin/plugin.json" in steps               # the tag must be its version
    for name in local_cockpit.IMAGES:
        assert f'"$IMAGES/{name}:$VERSION"' in steps, name

    compose = yaml.safe_load(local_cockpit.COMPOSE.read_text())
    pulled = {service["image"] for service in compose["services"].values()}
    assert pulled == {f"${{ASF_COCKPIT_REGISTRY:?}}/{name}:${{ASF_COCKPIT_VERSION:?}}"
                      for name in local_cockpit.IMAGES}


def test_the_backend_a_release_publishes_is_the_one_the_team_compose_pins():
    team = (REPO_ROOT / "apps" / "cockpit" / "docker-compose.yml").read_text()
    assert "CONVEX_BACKEND_VERSION:-" in team
    assert "apps/cockpit/docker-compose.yml" in RELEASE.read_text()

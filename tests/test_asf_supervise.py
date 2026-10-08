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
import sys
import threading
import time
from pathlib import Path

import pytest
import yaml

from engine import cockpit as local_cockpit
from engine import commands, events, factory, preflight, station, supervise
from engine.data_types import EVENT_KINDS, Cockpit, Station, StationCredential

from .asf_helpers import asf, fake_roster
from .fake_cockpit import FakeCockpit
from .test_asf_station import eventually

COCKPIT = Cockpit(url="http://cockpit.test:3211", token="asf_ingest_test")


@pytest.fixture(autouse=True)
def no_cockpit_from_the_shell(monkeypatch):
    for name in ("ASF_COCKPIT_URL", "ASF_COCKPIT_TOKEN", "ASF_COCKPIT_VERSION",
                 "ASF_STATION_NAME", "CI", "GH_HOST"):
        monkeypatch.delenv(name, raising=False)
    # Nor a forge token from whoever runs the suite: `gh` is asked through
    # this, and here it is a machine where nobody is logged in.
    monkeypatch.setattr(local_cockpit, "_gh", minting())


def a_session(root: Path, adw_id: str, count: int) -> Path:
    session = root / adw_id
    for pid in range(1, count + 1):
        events.emit(session, EVENT_KINDS["process_ended"](pid=pid))
    return session


# ── the station loop ─────────────────────────────────────────────────────────

def on_station(root: Path):
    return lambda: station.every_session(root)


def test_the_loop_ships_every_session_on_the_station_and_those_that_start_later(
        tmp_path: Path):
    sessions = tmp_path / "sessions"
    a_session(sessions, "0ld5e55n", 3)
    cockpit = FakeCockpit()
    loop = station.Loop(on_station(sessions), station.Destination(lambda: COCKPIT), cockpit,
                        interval=0.02).start()
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
    loop = station.Loop(on_station(sessions),
                        station.Destination(lambda: ready[0] if ready else None), cockpit,
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

    destination = station.Destination(lambda: Cockpit(url=COCKPIT.url, token=tokens[-1]),
                                      refused=reissue)
    loop = station.Loop(on_station(sessions), destination, cockpit, interval=0.02).start()
    try:
        assert eventually(lambda: cockpit.acked("a1b2c3d4") == 2)
    finally:
        loop.stop()


def test_a_refused_token_with_none_coming_stops_shipping_and_says_so_once(tmp_path: Path):
    sessions = tmp_path / "sessions"
    session = a_session(sessions, "a1b2c3d4", 2)
    cockpit = FakeCockpit(token="asf_ingest_other")
    said: list[str] = []
    loop = station.Loop(on_station(sessions), station.Destination(lambda: COCKPIT), cockpit,
                        interval=0.02)
    loop.say = said.append
    loop.start()
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
    loop = station.Loop(on_station(sessions), station.Destination(lambda: COCKPIT), cockpit,
                        interval=0.02).start()
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
    local = local_cockpit.Local(tmp_path / "asf/data", "acme/widgets", run=run)

    first = local.get()

    assert first == Cockpit(url="http://127.0.0.1:3211", token="asf_ingest_0a1b")
    assert "tokens:issue" in run.calls[0] and '{"factory": "acme/widgets"}' in run.calls[0]
    again = local_cockpit.Local(tmp_path / "asf/data", "acme/widgets", run=minting())
    assert again.get() == first                                 # kept, not issued again


def test_a_cockpit_still_starting_is_asked_again_later_not_every_round(tmp_path: Path):
    run = minting((1, "service \"app\" is not running"), (0, "asf_ingest_ff00\n"))
    local = local_cockpit.Local(tmp_path / "asf/data", "acme/widgets", run=run, retry=0.05)

    assert local.get() is None
    assert local.get() is None and len(run.calls) == 1          # too soon to ask again
    assert eventually(lambda: local.get() is not None)
    assert local.get().token == "asf_ingest_ff00"


def test_a_token_the_local_cockpit_refuses_is_replaced_by_a_fresh_one(tmp_path: Path):
    run = minting((0, "asf_ingest_01d0\n"), (0, "asf_ingest_0e50\n"))
    local = local_cockpit.Local(tmp_path / "asf/data", "acme/widgets", run=run, retry=0)
    refused = local.get()

    assert local.refused(refused) is True
    assert local.get().token == "asf_ingest_0e50"


def test_the_local_cockpit_s_station_is_its_owner_s_without_anyone_approving_it(
        tmp_path: Path):
    here = Station(id="st_0a1b2c", name="alex@mbp:widgets")
    run = minting((0, "asf_ingest_0a1b\n"), (0, '{"owner": "alex", "token": "asf_station_c0de"}\n'))
    local = local_cockpit.Local(tmp_path / "asf/data", "acme/widgets", run=run, here=here)

    assert local.credential() is None                           # nothing issued: not up yet
    local.get()
    held = local.credential()

    assert held is not None and held.cockpit == local_cockpit.site_url()
    assert (held.station, held.token, held.owner) == ("st_0a1b2c", "asf_station_c0de", "alex")
    assert "stations:local" in run.calls[1] and any('"st_0a1b2c"' in arg for arg in run.calls[1])
    again = local_cockpit.Local(tmp_path / "asf/data", "acme/widgets", run=minting(), here=here)
    assert again.credential() == held                           # kept, not issued again


def test_the_station_loop_polls_for_commands_between_shipping_rounds(stamped: Path,
                                                                     monkeypatch):
    monkeypatch.chdir(stamped)
    cfg = factory.load("asf/factory.yaml")
    cockpit = FakeCockpit()
    held = StationCredential(cockpit=COCKPIT.url, station="st_0a1b2c",
                             token=cockpit.admit("st_0a1b2c"))
    steering = commands.Steering(commands.Here(cfg, stamped), lambda: held,
                                 watchers=lambda: ["answers"])
    steering.interval = 0.02
    loop = station.Loop(on_station(stamped / "asf/data/sessions"),
                        station.Destination(lambda: COCKPIT), cockpit, interval=0.02,
                        steering=steering).start()
    try:
        assert eventually(lambda: len(cockpit.polls) >= 2)
    finally:
        loop.stop()
    assert {poll.session for poll in cockpit.polls} == {""}     # the loop asks as the station
    assert cockpit.polls[0].report["watchers"] == ["answers"]


# ── the forge credential the local cockpit asks with ─────────────────────────

def test_the_local_cockpit_is_started_with_the_persons_own_gh_token(stamped, monkeypatch):
    gh = minting((0, "gho_0a1b2c\n"))
    monkeypatch.setattr(local_cockpit, "_gh", gh)

    [cockpit] = supervise.services({"cockpit"}, "asf/factory.yaml", 120, stamped)

    assert gh.calls == [["gh", "auth", "token", "--hostname", "github.com"]]
    assert cockpit.env["ASF_COCKPIT_FORGE_TOKEN"] == "gho_0a1b2c"
    assert cockpit.env["ASF_COCKPIT_FORGE_HOST"] == "github.com"
    assert not any("gho_0a1b2c" in arg for arg in cockpit.argv)      # in the environment, never on argv


def test_the_token_is_the_one_for_the_host_gh_is_aimed_at(stamped, monkeypatch):
    gh = minting((0, "ghp_enterprise\n"))
    monkeypatch.setattr(local_cockpit, "_gh", gh)
    monkeypatch.setenv("GH_HOST", "ghe.acme.test")

    [cockpit] = supervise.services({"cockpit"}, "asf/factory.yaml", 120, stamped)

    assert gh.calls == [["gh", "auth", "token", "--hostname", "ghe.acme.test"]]
    assert cockpit.env["ASF_COCKPIT_FORGE_HOST"] == "ghe.acme.test"
    assert cockpit.env["ASF_COCKPIT_FORGE_TOKEN"] == "ghp_enterprise"


def test_without_a_gh_login_the_local_cockpit_starts_with_no_token_and_says_what_that_costs(
        stamped, monkeypatch):
    monkeypatch.setattr(local_cockpit, "_gh", minting((1, "")))

    [cockpit] = supervise.services({"cockpit"}, "asf/factory.yaml", 120, stamped)

    assert cockpit.env["ASF_COCKPIT_FORGE_TOKEN"] == ""
    assert cockpit.summary[0] == "forge" and "gh auth login" in cockpit.summary[1]
    monkeypatch.setattr(local_cockpit, "_gh", minting((0, "gho_0a1b2c\n")))
    [cockpit] = supervise.services({"cockpit"}, "asf/factory.yaml", 120, stamped)
    said = cockpit.summary[1]
    assert "github.com" in said and "gho_0a1b2c" not in said         # named, never shown


def test_the_stamped_compose_file_runs_a_local_cockpit_that_asks_with_that_token():
    compose = yaml.safe_load(local_cockpit.COMPOSE.read_text())
    environment = compose["services"]["app"]["environment"]

    assert "COCKPIT_MODE=local" in environment
    assert "COCKPIT_FORGE_TOKEN=${ASF_COCKPIT_FORGE_TOKEN:-}" in environment
    assert "COCKPIT_FORGE_HOST=${ASF_COCKPIT_FORGE_HOST:-github.com}" in environment
    # no sign-in, so nothing off this machine may reach it
    ports = [port for service in compose["services"].values() for port in service.get("ports", [])]
    assert ports and all(port.startswith("127.0.0.1:") for port in ports)


def test_doctor_says_whether_the_local_cockpit_will_have_a_forge_token(docker_here, monkeypatch):
    monkeypatch.setattr(local_cockpit, "missing_images", lambda *_: [])

    without = [finding for finding in preflight.cockpit() if "forge" in finding.check]
    assert [finding.level for finding in without] == ["warn"] and "gh auth login" in without[0].fix

    monkeypatch.setattr(local_cockpit, "_gh", minting((0, "gho_0a1b2c\n")))
    with_one = [finding for finding in preflight.cockpit() if "forge" in finding.check]
    assert [finding.level for finding in with_one] == ["ok"]
    assert "gho_0a1b2c" not in with_one[0].line


# ── the children of `asf up` and `asf station` ───────────────────────────────

@pytest.fixture
def cfg(stamped: Path, monkeypatch):
    monkeypatch.chdir(stamped)
    return factory.load("asf/factory.yaml")


def names(services) -> list[str]:
    return [service.name for service in services]


def test_up_with_no_shared_cockpit_starts_the_local_one_beside_the_watchers(cfg, stamped):
    want = supervise.wanted(cfg, supervise.Children())

    assert want == {"cockpit", "issues", "answers", "prs"}
    started = supervise.services(want, "asf/factory.yaml", 120, stamped)
    assert names(started) == ["cockpit", "issues", "answers", "prs"]
    cockpit = started[0]
    assert cockpit.argv[:2] == ["docker", "compose"]
    assert any(arg.endswith("asf/cockpit/compose.yaml") for arg in cockpit.argv)
    assert cockpit.env["ASF_COCKPIT_VERSION"] == local_cockpit.minimum()


def test_up_with_a_shared_cockpit_starts_no_cockpit_child(cfg, monkeypatch):
    monkeypatch.setenv("ASF_COCKPIT_URL", "https://cockpit.example.com:3211")

    assert supervise.wanted(cfg, supervise.Children()) == {"issues", "answers", "prs"}
    assert supervise.wanted(cfg, supervise.Children(only="cockpit,issues")) == {"issues"}


def test_up_names_the_services_there_are_when_asked_for_one_there_is_not(cfg):
    """`obs`, the legacy trace UI, is no longer one: an old justfile's `just
    obs` is told what `up` can start instead."""
    with pytest.raises(SystemExit, match="obs.*cockpit, issues, answers, prs"):
        supervise.wanted(cfg, supervise.Children(only="issues,obs"))


def test_asf_station_is_the_same_loop_without_watchers(cfg, monkeypatch):
    assert supervise.wanted(cfg, supervise.Children(watchers=False)) == {"cockpit"}
    monkeypatch.setenv("ASF_COCKPIT_URL", "https://cockpit.example.com:3211")
    assert supervise.wanted(cfg, supervise.Children(watchers=False)) == set()


def test_without_docker_up_warns_drops_the_cockpit_and_runs_the_watchers(
        cfg, monkeypatch, tmp_path, capsys):
    without_docker(monkeypatch, tmp_path)
    want = supervise.wanted(cfg, supervise.Children())

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


def test_doctor_says_what_a_shared_cockpit_is_shipped_with_and_how_to_get_a_token(
        tmp_path: Path, monkeypatch):
    url = "https://happy-otter-123.convex.site"
    monkeypatch.setenv("ASF_COCKPIT_URL", url)
    monkeypatch.delenv("ASF_COCKPIT_TOKEN", raising=False)
    data = tmp_path / "data"

    [finding] = preflight.cockpit(data)
    assert finding.level == "warn" and "no ingest token" in finding.detail
    assert "station-register" in finding.fix and "connect_cockpit" in finding.fix

    station.keep(tmp_path, "data", StationCredential(cockpit=url, station="st_1", token="asf_station_1",
                                                     owner="alex", ingest_token="asf_ingest_1"))
    [finding] = preflight.cockpit(data)
    assert finding.level != "warn" and "alex" in finding.detail and url in finding.detail

    monkeypatch.setenv("ASF_COCKPIT_TOKEN", "asf_ingest_env")
    [finding] = preflight.cockpit(data)
    assert "ASF_COCKPIT_TOKEN" in finding.detail


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
    # and a stamp never asks for a cockpit newer than the release it came with
    assert "skills/agentic-sf/templates/asf/cockpit/min-version" in steps
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


# ── one local cockpit per machine: joined, never downgraded ──────────────────

def test_a_pin_the_minimum_overrides_is_named_as_ignored(monkeypatch):
    assert local_cockpit.ignored_pin() == ""
    monkeypatch.setenv("ASF_COCKPIT_VERSION", "0.0.1")
    assert local_cockpit.ignored_pin() == "0.0.1"
    monkeypatch.setenv("ASF_COCKPIT_VERSION", "latest")
    assert local_cockpit.ignored_pin() == "latest"
    monkeypatch.setenv("ASF_COCKPIT_VERSION", "v99.0.0")
    assert local_cockpit.ignored_pin() == ""


def test_the_running_local_cockpit_is_read_from_its_app_container():
    asked = minting((0, "ghcr.io/schurik/asf-cockpit:1.4.2\n"))
    assert local_cockpit.running(asked) == "1.4.2"
    assert "com.docker.compose.project=asf-cockpit" in " ".join(asked.calls[0])
    assert local_cockpit.running(minting((0, ""))) == ""
    assert local_cockpit.running(minting((1, "Cannot connect to the Docker daemon"))) == ""


@pytest.fixture
def docker_here(monkeypatch):
    """Docker's answers, at the boundary this module asks them through."""
    monkeypatch.setattr(local_cockpit, "docker_problem", lambda: None)
    running = {"version": ""}
    monkeypatch.setattr(local_cockpit, "running", lambda *_: running["version"])
    return running


def test_up_joins_a_newer_local_cockpit_instead_of_starting_one(
        cfg, stamped, docker_here, capsys):
    docker_here["version"] = "99.0.0"
    want = supervise.wanted(cfg, supervise.Children())

    local = supervise.check(cfg, want)

    assert local == "join" and "cockpit" not in want
    assert "99.0.0" in capsys.readouterr().out
    assert supervise.destination(cfg, stamped, local) is not None     # still ships to it


def test_up_replaces_an_older_local_cockpit_and_owns_one_of_its_own_version(cfg, docker_here):
    docker_here["version"] = "0.0.1"
    want = supervise.wanted(cfg, supervise.Children())
    assert supervise.check(cfg, want) == "start" and "cockpit" in want

    docker_here["version"] = local_cockpit.version()       # left behind by a killed `up`
    want = supervise.wanted(cfg, supervise.Children())
    assert supervise.check(cfg, want) == "start" and "cockpit" in want


def test_a_child_whose_place_was_taken_retires_instead_of_restarting(tmp_path: Path):
    """Another `up` upgraded the shared cockpit under this one's `compose up`,
    which exits. Restarting it at this stamp's version would downgrade it."""
    lines: list[tuple[str, str]] = []
    exits = supervise.Service("cockpit", [sys.executable, "-c", "pass"], tmp_path,
                              retire_if=lambda: "joined the local cockpit 99.0.0")
    stopping = threading.Event()
    supervise._spawn(exits, lambda name, line: lines.append((name, line)))
    supervisor = threading.Thread(
        target=lambda: lines.append(("result", supervise._supervise(
            [exits], stopping, lambda name, line: lines.append((name, line))))))
    supervisor.start()
    try:
        assert eventually(lambda: exits.retired)
        assert ("cockpit", "joined the local cockpit 99.0.0") in lines
        time.sleep(0.6)
        assert ("result", True) not in lines          # not "every service has given up"
    finally:
        stopping.set()
        supervisor.join(5)
    assert exits.restarts == 0


def test_doctor_names_a_running_local_cockpit_and_what_up_will_do_with_it(
        docker_here, monkeypatch):
    monkeypatch.setattr(local_cockpit, "missing_images", lambda *_: [])
    ours = local_cockpit.version()

    docker_here["version"] = "99.0.0"
    joined = " ".join(finding.line for finding in preflight.cockpit())
    assert "99.0.0" in joined and "joins" in joined

    docker_here["version"] = "0.0.1"
    older = preflight.cockpit()
    assert any(finding.level == "warn" and "0.0.1" in finding.detail and ours in finding.detail
               for finding in older)

    monkeypatch.setenv("ASF_COCKPIT_VERSION", "0.0.1")
    assert any("ASF_COCKPIT_VERSION" in finding.detail and finding.level == "warn"
               for finding in preflight.cockpit())

"""`asf up --pull`: a station nobody sits at keeps its checkout at the remote's.

Every case against a real bare remote in tmp_path, a checkout cloned from it,
and another clone that plays whoever merges to the default branch. The lock a
run holds is asked of the real `flock`; a run holding it is a real run on the
fake harness, whose one check reports whether it could have been pulled from
under.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from engine import factory, pull, supervise

from .asf_helpers import (adw_id_of, asf, commit_all, defaults, envelope, fake_roster, git,
                          install, new_repo, run_state, stamp, wire, write_workflow)

CFG = defaults()


@pytest.fixture(autouse=True)
def let_go():
    """Each test's locks are its own: what this process held is dropped after it."""
    yield
    for stream in [*pull._held.values(), *pull._barred]:
        stream.close()
    pull._held.clear()
    pull._barred.clear()


def clone(origin: Path, where: Path) -> Path:
    subprocess.run(["git", "clone", "-q", str(origin), str(where)], check=True)
    git(where, "config", "user.email", "tests@example.invalid")
    git(where, "config", "user.name", "asf tests")
    git(where, "config", "commit.gpgsign", "false")
    return where


@pytest.fixture
def three(tmp_path: Path) -> tuple[Path, Path]:
    """(upstream, station): a person's clone that pushes, and the station's."""
    upstream = new_repo(tmp_path / "upstream")
    (upstream / ".gitignore").write_text("asf/data/\n")
    commit_all(upstream, "ignore the runtime")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    git(upstream, "remote", "add", "origin", str(origin))
    git(upstream, "push", "-q", "-u", "origin", "main")
    return upstream, clone(origin, tmp_path / "station")


def merged(upstream: Path, path: str, text: str = "x\n") -> str:
    """Somebody merges a change to the default branch."""
    target = upstream / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    commit_all(upstream, f"change {path}")
    git(upstream, "push", "-q", "origin", "main")
    return git(upstream, "rev-parse", "HEAD")


def once(station: Path) -> pull.Pulled:
    return pull.once(CFG, station, Path("asf"))


# ── one pass ─────────────────────────────────────────────────────────────────

def test_a_clean_checkout_behind_its_remote_is_fast_forwarded(three):
    upstream, station = three
    tip = merged(upstream, "README.md", "# moved on\n")

    pulled = once(station)

    assert pulled.outcome == "pulled"
    assert git(station, "rev-parse", "HEAD") == tip
    assert "(1 commit)" in pulled.detail
    assert not pulled.factory_changed


def test_a_pull_that_changed_the_factory_says_so_and_keeps_the_checkout_until_the_restart(
        three):
    upstream, station = three
    merged(upstream, "asf/workflows/quick/workflow.yaml", "name: quick\n")

    pulled = once(station)

    assert pulled.outcome == "pulled" and pulled.factory_changed
    # Nothing starts on the old processes while `up` stops them: a second
    # pass, or a run, finds the checkout taken until this process execs.
    assert once(station).outcome == "busy"


def test_a_checkout_at_its_remote_is_current(three):
    _, station = three

    assert once(station).outcome == "current"


def test_uncommitted_or_untracked_changes_are_left_alone(three):
    upstream, station = three
    before = git(station, "rev-parse", "HEAD")
    merged(upstream, "README.md", "# moved on\n")
    (station / "notes.txt").write_text("somebody's work\n")

    pulled = once(station)

    assert pulled.outcome == "dirty"
    assert git(station, "rev-parse", "HEAD") == before
    assert (station / "notes.txt").read_text() == "somebody's work\n"


def test_what_the_runtime_writes_is_ignored_and_never_makes_it_dirty(three):
    upstream, station = three
    merged(upstream, "README.md", "# moved on\n")
    (station / "asf" / "data" / "sessions").mkdir(parents=True)

    assert once(station).outcome == "pulled"


def test_a_branch_ahead_of_its_remote_is_left_as_it_is(three):
    _, station = three
    (station / "local.txt").write_text("a commit nobody pushed\n")
    commit_all(station, "local")
    ahead = git(station, "rev-parse", "HEAD")

    assert once(station).outcome == "ahead"
    assert git(station, "rev-parse", "HEAD") == ahead


def test_a_diverged_branch_is_left_as_it_is(three):
    upstream, station = three
    merged(upstream, "README.md", "# theirs\n")
    (station / "local.txt").write_text("ours\n")
    commit_all(station, "local")
    ours = git(station, "rev-parse", "HEAD")

    pulled = once(station)

    assert pulled.outcome == "diverged"
    assert git(station, "rev-parse", "HEAD") == ours


def test_a_detached_checkout_is_not_pulled(three):
    upstream, station = three
    merged(upstream, "README.md", "# moved on\n")
    git(station, "checkout", "-q", "--detach")

    assert once(station).outcome == "detached"


def test_no_remote_and_an_unreachable_one_are_said(three, tmp_path):
    _, station = three
    git(station, "remote", "set-url", "origin", str(tmp_path / "gone.git"))

    assert once(station).outcome == "unreachable"

    git(station, "remote", "remove", "origin")
    assert once(station).outcome == "no_remote"


# ── a run holds the checkout ─────────────────────────────────────────────────

def test_nothing_is_pulled_while_a_run_holds_the_checkout_and_it_is_after(three):
    upstream, station = three
    tip = merged(upstream, "README.md", "# moved on\n")

    assert pull.hold(station, CFG.data_dir)
    assert once(station).outcome == "busy"

    for stream in pull._held.values():
        stream.close()
    pull._held.clear()
    assert once(station).outcome == "pulled"
    assert git(station, "rev-parse", "HEAD") == tip


def test_a_run_waits_for_a_pull_in_progress_and_then_starts_unheld(three, monkeypatch):
    _, station = three
    taken = pull._take(station, CFG.data_dir)
    assert taken is not None
    monkeypatch.setattr(pull, "HOLD_WAIT", 0.3)

    try:
        assert pull.hold(station, CFG.data_dir) is False
    finally:
        taken.close()
    assert pull.hold(station, CFG.data_dir) is True


HOLDS = """
import fcntl, sys
with open(sys.argv[1], "a") as stream:
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("held by the run"); sys.exit(0)
print("NOT held: a pull could move the checkout under this run"); sys.exit(1)
"""


def test_every_run_holds_its_checkout_for_its_whole_life(stamped: Path):
    """A check run in the middle of a real run cannot take the checkout: the
    check exits 0 only then, and the run is green only if it did."""
    lock = pull.lock_path(stamped, CFG.data_dir)
    fake_roster(stamped, builder=[{"writes": {"app.py": "ok = 1\n"},
                                   "envelope": envelope(changed_files=["app.py"],
                                                        commit_message="feat: app")}] * 3)
    wire(stamped, "test", [sys.executable, "-c", HOLDS, str(lock)])
    write_workflow(stamped, "held", {
        "description": "build, then one check that reports whether the run holds its checkout",
        "stages": [{"implement": {}}, {"verify": {"blocks": ["test"], "max_fix_loops": 1}},
                   {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "held", "add app.py")

    assert result.returncode == 0, result.stdout + result.stderr
    assert run_state(stamped, adw_id_of(result))["status"] == "success"


# ── the loop behind `up --pull` ──────────────────────────────────────────────

def test_the_loop_says_a_pull_and_a_state_that_needs_a_person_once_and_never_the_normal_ones():
    passes = iter([pull.Pulled("current", "main is at origin/main"),
                   pull.Pulled("busy", "a run is working"),
                   pull.Pulled("dirty", "changes"), pull.Pulled("dirty", "changes"),
                   pull.Pulled("pulled", "main a..b (1 commit)"),
                   pull.Pulled("pulled", "main b..c (1 commit)", factory_changed=True)])
    said: list[str] = []
    changed: list[bool] = []
    puller = pull.Puller(lambda: next(passes), 0, said.append, lambda: changed.append(True),
                         last="current")

    for _ in range(6):
        puller.step()

    assert said == ["not pulled: changes", "pulled main a..b (1 commit)",
                    "pulled main b..c (1 commit) — the factory changed: starting again on it"]
    assert changed == [True]


def test_its_thread_stops_after_the_pass_that_changed_the_factory():
    calls: list[int] = []

    def step() -> pull.Pulled:
        calls.append(1)
        return pull.Pulled("pulled", "main a..b (1 commit)", factory_changed=True)

    puller = pull.Puller(step, 0.01, lambda _text: None, lambda: None).start()
    puller._thread.join(timeout=5)

    assert calls == [1]


# ── `up --pull` ──────────────────────────────────────────────────────────────

@pytest.fixture
def station_of(stamped: Path, tmp_path: Path) -> tuple[Path, Path]:
    """(upstream, station) for a stamped factory: the stamped repo pushes, and
    the station is a clone of what it pushed."""
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    git(stamped, "remote", "add", "origin", str(origin))
    git(stamped, "push", "-q", "-u", "origin", "main")
    return stamped, clone(origin, tmp_path / "station")


def test_up_pull_starts_again_before_anything_runs_when_the_factory_changed_while_it_was_down(
        station_of, monkeypatch, capsys):
    upstream, station = station_of
    merged(upstream, "asf/workflows/quick/tasks/note.md", "# a change to the factory\n")
    monkeypatch.chdir(station)
    config = "asf/factory.yaml"

    code = supervise.up(factory.load(config), config, supervise.Children(pull=True))

    assert code == supervise.RESTART
    out = capsys.readouterr().out
    assert "the factory changed: starting again on it" in out
    assert "polling every" not in out                     # nothing was started


def test_restart_runs_up_again_in_this_process(monkeypatch):
    called: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(os, "execv", lambda path, argv: called.append((path, argv)))
    monkeypatch.setattr(sys, "argv", ["asf/asf.py", "up", "--pull"])

    supervise.restart()

    assert called == [(sys.executable, [sys.executable, "asf/asf.py", "up", "--pull"])]


# ── install.py --station ─────────────────────────────────────────────────────

def test_install_stamps_the_station_only_when_asked_and_never_overwrites_it(repo: Path):
    stamp(repo)
    assert not (repo / "asf" / "station").exists()

    first = install(repo, "--harness", "claude_code", "--station")
    dockerfile = repo / "asf" / "station" / "Dockerfile"
    assert first.returncode == 0, first.stdout + first.stderr
    assert dockerfile.is_file() and (repo / "asf" / "station" / "compose.yaml").is_file()

    dockerfile.write_text(dockerfile.read_text() + "RUN npm install -g bun\n")
    forced = install(repo, "--harness", "claude_code", "--station", "--force")

    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert dockerfile.read_text().endswith("RUN npm install -g bun\n")
    assert "asf/station/Dockerfile" not in (repo / "asf" / ".skill-files").read_text()


def test_the_stamped_station_runs_up_pull_as_a_non_root_user_and_never_gets_the_docker_socket():
    station = Path(__file__).resolve().parent.parent / "skills/agentic-sf/templates/station"
    dockerfile = (station / "Dockerfile").read_text()
    compose = (station / "compose.yaml").read_text()

    assert 'CMD ["uv", "run", "asf/asf.py", "up", "--pull"]' in dockerfile
    assert "USER asf" in dockerfile
    assert "restart: unless-stopped" in compose
    assert "- ../..:/work" in compose
    mounts = [line for line in compose.splitlines()
              if line.strip().startswith("- ") and "docker.sock" in line]
    assert mounts == []


def test_the_station_passes_its_tokens_through_by_name_and_never_names_a_value():
    """A name with no `=`: Compose takes its value from asf/station/.env or the
    shell, and leaves out one set in neither, so a login in the volume holds."""
    compose = (Path(__file__).resolve().parent.parent
               / "skills/agentic-sf/templates/station/compose.yaml").read_text().splitlines()
    block = compose[compose.index("    environment:") + 1:]
    names = [line.strip()[2:] for line in block[:3]]

    assert names == ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
    assert not block[3].startswith("      - ")


@pytest.mark.parametrize("theirs", ["", "/.env\n"])
def test_the_station_s_env_file_is_gitignored_by_the_stamp_s_own_rule(repo: Path, theirs: str):
    """asf/station/.env holds the tokens; a commit stage runs `git add -A`. The
    stamp's `.env` is unanchored, so it reaches the file however the
    repository's own rule is written."""
    (repo / ".gitignore").write_text(theirs)
    done = install(repo, "--harness", "claude_code", "--station")
    assert done.returncode == 0, done.stdout + done.stderr
    (repo / "asf" / "station" / ".env").write_text("GH_TOKEN=github_pat_x\n")

    git(repo, "check-ignore", "-q", "asf/station/.env")             # raises when not ignored
    git(repo, "add", "-A")
    assert "asf/station/.env" not in git(repo, "diff", "--cached", "--name-only").splitlines()

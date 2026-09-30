"""A session's work branch on the remote: when it goes there, what it holds
when a gate asks, and when it is taken away again.

A cockpit reads a gate's subject from the forge at the commit the question was
asked about (spec #40), so these run a real stamped repository against a bare
remote beside it and ask the REMOTE what it has — never the local branch, which
would hold the work whether or not anything was published.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from . import projection
from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, fake_roster, git, session_dir,
                          set_config, wire, with_origin, write_workflow)
from .test_asf_events import build_reply
from .test_asf_slice2 import plan_reply

PLAN = "docs/asf/spec/plan.md"


@pytest.fixture(autouse=True)
def no_cockpit_from_the_shell(monkeypatch):
    """`worktree.publish` defaults by whether a cockpit is configured, and the
    `asf` subprocesses a test starts inherit os.environ."""
    for name in ("ASF_COCKPIT_URL", "ASF_COCKPIT_TOKEN"):
        monkeypatch.delenv(name, raising=False)


LANDS = [{"integrate": {}}]          # as `worktree.integration` says: push, no pull request


def gated(stamped: Path, publish: str, then: list[dict] | None = None) -> Path:
    """A bare remote, a workflow that stops at the plan gate, and `publish` set.
    `then` is what follows the build's commit."""
    fake_roster(stamped, planner=[plan_reply(), plan_reply("# Plan, revised\n")],
                builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "gated", {
        "description": "a person between the plan and the build",
        "stages": [{"plan": {"agent": "planner", "hitl": True}},
                   {"implement": {"agent": "builder"}},
                   {"commit": {"of": "implement"}}, *(then or [])],
    })
    origin = with_origin(stamped)
    set_config(stamped, worktree={"publish": publish, "integration": {"open_pr": False}})
    commit_all(stamped)             # after the push: main is now AHEAD of the remote's
    return origin


def remote_tip(origin: Path, branch: str) -> str:
    """The commit the remote holds for `branch`, "" when it has no such branch."""
    found = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
                           cwd=origin, capture_output=True, text=True)
    return found.stdout.strip()


def suspended(stamped: Path, adw_id: str) -> dict:
    """The newest `suspended` event: what a cockpit is told the gate asks about."""
    lines = [json.loads(line) for line in
             (session_dir(stamped, adw_id) / "events.jsonl").read_text().splitlines()]
    return [line["payload"] for line in lines if line["kind"] == "suspended"][-1]


def test_a_run_that_stops_at_a_gate_has_pushed_the_commit_that_holds_its_subject(stamped: Path):
    origin = gated(stamped, "on_create")

    result = asf(stamped, "run", "gated", "add app.py")
    assert result.returncode == 75, result.stdout + result.stderr
    adw_id = adw_id_of(result)

    waiting = suspended(stamped, adw_id)
    # The commit the question was asked about is the remote's tip for the branch…
    assert waiting["head_sha"] and remote_tip(origin, f"asf/{adw_id}") == waiting["head_sha"]
    # …and the plan the person is asked to approve is in it.
    assert git(origin, "show", f"{waiting['head_sha']}:{PLAN}") == "# Plan"
    # Committed in the planner's own words, as a commit stage would have.
    assert git(origin, "log", "-1", "--format=%s", waiting["head_sha"]) == "docs: plan"
    # The base the branch was cut from never reached the remote on `main`; it is
    # there all the same, so base…head is a comparison the forge can draw.
    assert waiting["base_commit"] != remote_tip(origin, "main")
    assert git(origin, "cat-file", "-t", waiting["base_commit"]) == "commit"


def test_every_suspend_pushes_the_subject_as_it_stands_in_that_round(stamped: Path):
    origin = gated(stamped, "on_create")
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))
    first = suspended(stamped, adw_id)

    rejected = asf(stamped, "reject", adw_id, "-m", "more detail")

    assert rejected.returncode == 75, rejected.stdout + rejected.stderr
    second = suspended(stamped, adw_id)
    assert second["waiting_for"]["round"] == 2
    assert remote_tip(origin, f"asf/{adw_id}") == second["head_sha"] != first["head_sha"]
    assert git(origin, "show", f"{second['head_sha']}:{PLAN}") == "# Plan, revised"
    # The first round's commit is still what ITS question was about.
    assert git(origin, "show", f"{first['head_sha']}:{PLAN}") == "# Plan"
    assert second["base_commit"] == first["base_commit"]
    # And the session's files still rebuild from its events alone.
    session = session_dir(stamped, adw_id)
    rebuilt, written = projection.replay(session), projection.on_disk(session)
    assert (rebuilt.run, rebuilt.decisions) == (written.run, written.decisions)


def test_a_session_begun_before_on_create_is_published_when_it_next_starts(stamped: Path):
    origin = gated(stamped, "on_integrate")
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))
    assert remote_tip(origin, f"asf/{adw_id}") == ""
    set_config(stamped, worktree={"publish": "on_create"})

    rejected = asf(stamped, "reject", adw_id, "-m", "more detail")

    assert rejected.returncode == 75, rejected.stdout + rejected.stderr
    waiting = suspended(stamped, adw_id)
    assert remote_tip(origin, f"asf/{adw_id}") == waiting["head_sha"]
    assert git(origin, "show", f"{waiting['head_sha']}:{PLAN}") == "# Plan, revised"


def test_on_integrate_pushes_nothing_until_the_branch_is_integrated(stamped: Path):
    origin = gated(stamped, "on_integrate", then=LANDS)

    result = asf(stamped, "run", "gated", "add app.py")
    assert result.returncode == 75, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    branch = f"asf/{adw_id}"

    # Waiting at the gate, the branch is this machine's alone — and the plan is
    # still uncommitted in its worktree, as it always was.
    assert remote_tip(origin, branch) == ""
    assert git(stamped, "rev-parse", branch) == suspended(stamped, adw_id)["base_commit"]

    approved = asf(stamped, "approve", adw_id)
    assert approved.returncode == 0, approved.stdout + approved.stderr
    assert remote_tip(origin, branch) == git(stamped, "rev-parse", branch)


def test_a_run_whose_base_cannot_reach_the_remote_is_refused_before_anything_exists(
        stamped: Path):
    gated(stamped, "on_create")
    git(stamped, "remote", "set-url", "origin", str(stamped.parent / "gone.git"))

    result = asf(stamped, "run", "gated", "add app.py")

    assert result.returncode == 1, result.stdout + result.stderr
    assert "cannot publish asf/" in result.stderr
    assert "worktree.publish: on_integrate" in result.stderr       # the way out, named
    # No branch was cut, no worktree made, no session opened and no agent paid.
    assert git(stamped, "branch", "--list", "asf/*") == ""
    assert not (stamped / ".asf-worktrees").exists() or not any(
        (stamped / ".asf-worktrees").iterdir())
    assert not (stamped / "asf" / "data" / "sessions").exists()


def test_aborting_at_a_gate_takes_the_branch_off_the_remote_and_keeps_it_here(stamped: Path):
    origin = gated(stamped, "on_create")
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))
    branch = f"asf/{adw_id}"
    assert remote_tip(origin, branch)

    aborted = asf(stamped, "abort", adw_id, "-m", "not this quarter")

    assert aborted.returncode == 1, aborted.stdout + aborted.stderr
    assert remote_tip(origin, branch) == ""
    assert git(stamped, "log", "-1", "--format=%s", branch)         # the branch is the record


def test_a_session_that_ends_without_integrating_leaves_nothing_on_the_remote(stamped: Path):
    origin = gated(stamped, "on_create")
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))
    branch = f"asf/{adw_id}"

    approved = asf(stamped, "approve", adw_id)

    assert approved.returncode == 0, approved.stdout + approved.stderr
    assert remote_tip(origin, branch) == ""
    assert git(stamped, "log", "-1", "--format=%s", branch) == "feat: app"


def test_a_session_that_integrates_keeps_its_branch_on_the_remote(stamped: Path):
    origin = gated(stamped, "on_create", then=LANDS)
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))
    branch = f"asf/{adw_id}"

    approved = asf(stamped, "approve", adw_id)

    assert approved.returncode == 0, approved.stdout + approved.stderr
    assert remote_tip(origin, branch) == git(stamped, "rev-parse", branch)
    assert git(origin, "log", "-1", "--format=%s", branch) == "feat: app"


def test_a_failed_session_keeps_its_branch_on_the_remote_for_a_resume(stamped: Path):
    fake_roster(stamped, builder=[build_reply("1/0\n", "feat: broken"),
                                  build_reply("2/0\n", "feat: still broken")])
    wire(stamped, "test", PY_CHECK)
    origin = with_origin(stamped)
    set_config(stamped, worktree={"publish": "on_create"})
    commit_all(stamped)

    failed = asf(stamped, "run", "quick", "add app.py")      # quick: max_fix_loops 2

    assert failed.returncode == 1, failed.stdout + failed.stderr
    adw_id = adw_id_of(failed)
    assert remote_tip(origin, f"asf/{adw_id}") == git(stamped, "rev-parse", f"asf/{adw_id}")


def test_a_later_run_in_an_integrated_session_pushes_to_the_branch_and_leaves_it(stamped: Path):
    """The branch was proposed by an earlier process of the session; a run that
    joins it and ends without an integrate stage of its own must not take it
    away — that would close whatever pull request was opened from it."""
    origin = gated(stamped, "on_create", then=LANDS)
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app"),
                                  build_reply("ok = 2\n", "feat: app, again")])
    commit_all(stamped)
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))
    assert asf(stamped, "approve", adw_id).returncode == 0

    joined = asf(stamped, "run", "quick", "make it 2", "--adw-id", adw_id)

    assert joined.returncode == 0, joined.stdout + joined.stderr
    assert git(origin, "log", "-1", "--format=%s", f"asf/{adw_id}") == "feat: app, again"


# ── which of the two a factory gets, and what `doctor` says about it ─────────

COCKPIT = "https://cockpit.example.com:3211"


def doctor(stamped: Path, tmp_path: Path, **env: str) -> subprocess.CompletedProcess:
    """`asf doctor` with nothing but git on PATH, so it asks no forge and no Docker."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    if not (bin_dir / "git").exists():
        (bin_dir / "git").symlink_to(shutil.which("git"))
    return asf(stamped, "doctor", env={"PATH": str(bin_dir), **env})


def finding(result: subprocess.CompletedProcess, check: str) -> str:
    """The line `doctor` printed for one check: `  <mark> <check>  <detail>`."""
    return next(line for line in result.stdout.splitlines() if line.split()[1:2] == [check])


def publishing(stamped: Path, tmp_path: Path, **env: str) -> str:
    """What `doctor` says about `worktree.publish`."""
    return finding(doctor(stamped, tmp_path, **env), "publish")


def test_publish_is_on_create_once_a_cockpit_is_configured_and_the_config_has_the_last_word(
        stamped: Path, tmp_path: Path):
    fake_roster(stamped)
    with_origin(stamped)

    # No cockpit: a branch stays on this machine, as it always did.
    assert "on_integrate" in publishing(stamped, tmp_path)
    # A shared cockpit reads gate subjects from the forge, so they have to be there.
    assert "on_create" in publishing(stamped, tmp_path, ASF_COCKPIT_URL=COCKPIT)
    # So does the local one `asf up` started — known by the token it issued this factory.
    record = stamped / "asf" / "data" / "cockpit.json"
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({"repository": "acme/widgets", "token": "asf_ingest_0a",
                                  "issued_at": "2026-09-30T00:00:00+00:00"}))
    assert "on_create" in publishing(stamped, tmp_path)
    # And `worktree.publish` decides, whatever is configured around it.
    set_config(stamped, worktree={"publish": "on_integrate"})
    said = publishing(stamped, tmp_path, ASF_COCKPIT_URL=COCKPIT)
    assert "on_integrate" in said and "subject not on the forge" in said


def test_on_create_without_a_remote_warns_and_runs_anyway(stamped: Path, tmp_path: Path):
    fake_roster(stamped, planner=[plan_reply()], builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    set_config(stamped, worktree={"publish": "on_create"})
    commit_all(stamped)

    result = asf(stamped, "run", "sdlc", "add app.py")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "no remote named 'origin'" in result.stdout
    said = doctor(stamped, tmp_path)
    assert said.returncode == 0, said.stdout + said.stderr          # a warning, never fatal
    line = finding(said, "publish")
    assert "~" in line and "no remote named 'origin'" in line


# ── `integration: none` is on its way out ────────────────────────────────────

def test_integration_none_warns_wherever_the_config_is_loaded_and_names_what_replaces_it(
        stamped: Path, tmp_path: Path):
    fake_roster(stamped)
    assert "integration.mode: none" not in asf(stamped, "check").stderr     # nothing to say yet
    set_config(stamped, worktree={"integration": {"mode": "none"}})

    loaded, checked, examined = (asf(stamped, "pending"), asf(stamped, "check"),
                                 doctor(stamped, tmp_path))

    for result in (loaded, checked, examined):
        said = result.stdout + result.stderr
        assert result.returncode == 0, said                  # a warning in 1.1, never a refusal
        assert "worktree.integration.mode: none" in said and "refused from 1.2" in said
        assert "`mode: pr`" in said and "`worktree.publish: on_integrate`" in said
    # Once per command, however many workflows load the config.
    assert checked.stderr.count("worktree.integration.mode: none") == 1
    # `doctor` counts it among the things to fix, with the fix beside it.
    line = finding(examined, "integration")
    assert "~" in line and "none" in line


def test_check_warns_about_a_workflow_whose_integrate_stage_says_none(stamped: Path):
    fake_roster(stamped)
    write_workflow(stamped, "keeps", {
        "description": "builds, and lands nothing",
        "stages": [{"implement": {}}, {"commit": {"of": "implement"}},
                   {"integrate": {"mode": "none"}}]})

    checked = asf(stamped, "check", "keeps")

    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert "✓ keeps:" in checked.stdout
    warning = next(line for line in checked.stdout.splitlines() if "~" in line)
    assert "integrate: {mode: none}" in warning and "refused from 1.2" in warning
    assert "~" not in asf(stamped, "check", "ship").stdout           # and only there


def test_on_create_is_honoured_under_integration_none_when_the_config_says_so(stamped: Path):
    """`none` alone keeps every branch on this machine, cockpit or not. Asking
    for `on_create` beside it is the repository saying otherwise, deliberately."""
    origin = gated(stamped, "on_create")
    set_config(stamped, worktree={"publish": "on_create", "integration": {"mode": "none"}})
    commit_all(stamped)

    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))

    waiting = suspended(stamped, adw_id)
    assert remote_tip(origin, f"asf/{adw_id}") == waiting["head_sha"]
    assert git(origin, "show", f"{waiting['head_sha']}:{PLAN}") == "# Plan"


def test_integration_none_keeps_a_branch_here_even_with_a_cockpit_configured(
        stamped: Path, tmp_path: Path):
    fake_roster(stamped)
    with_origin(stamped)
    set_config(stamped, worktree={"integration": {"mode": "none"}})

    said = publishing(stamped, tmp_path, ASF_COCKPIT_URL=COCKPIT)

    assert "on_integrate" in said and "integration.mode: none" in said

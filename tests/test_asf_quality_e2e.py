"""The `e2e` block: browser tests against a dev server the command starts itself.

It ships in `quality.py` like `test` or `lint`, but opt-in: nothing runs it
unless a workflow names it. When one does, each check gets a port of its own
and a directory for its evidence, and a dev server that never came up is
reported as exactly that. Proven through the CLI on the fake harness, with a
Python script standing in for Playwright.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from engine import quality

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster, git,
                          install, session_dir, set_config, wire, write_workflow)


class _Quiet:
    def note(self, *_args, **_kwargs) -> None: ...
    def event(self, *_args, **_kwargs) -> None: ...


def bare_run(tmp_path: Path) -> SimpleNamespace:
    """The least a block reads off a run: where to write, and where to say so."""
    return SimpleNamespace(phases=[SimpleNamespace(seq=1, phase_id="p1")],
                           context_handoff_dir=tmp_path / "handoff", repo_root=tmp_path,
                           console=_Quiet(), tracer=_Quiet())


def test_run_quality_leaves_e2e_out_and_run_blocks_runs_it_when_named(tmp_path: Path):
    run = bare_run(tmp_path)

    everything = quality.run_quality(run)
    named = quality.run_blocks(run, ["e2e"])

    assert [check.name for check in everything.checks] == ["test", "lint", "typecheck", "build"]
    assert [check.name for check in named.checks] == ["e2e"]


# ── opt-in: said only to a workflow that asks for it ─────────────────────────

def e2e_workflow(stamped: Path, name: str = "browser", blocks: list[str] | None = None) -> None:
    write_workflow(stamped, name, {
        "description": "a chain whose verify runs the browser tests",
        "stages": [{"implement": {}}, {"verify": {"blocks": blocks or ["test", "e2e"]}},
                   {"review": {"retest": ["test", "e2e"]}}, {"commit": {"of": "implement"}}]})


def test_doctor_says_nothing_of_an_unwired_e2e_no_workflow_names(stamped: Path):
    fake_roster(stamped)

    doctor = asf(stamped, "doctor")

    assert "still placeholders" in doctor.stdout          # test, lint, … as before
    assert "e2e" not in doctor.stdout


def test_check_and_doctor_refuse_a_workflow_that_names_an_unwired_e2e(stamped: Path):
    fake_roster(stamped)
    e2e_workflow(stamped)

    check = asf(stamped, "check", "browser")
    doctor = asf(stamped, "doctor")

    assert check.returncode == 1
    assert "verify: e2e is still a placeholder" in check.stdout
    assert "review: e2e is still a placeholder" in check.stdout
    assert "verify: e2e is still a placeholder" in doctor.stdout


def test_check_accepts_the_workflow_once_e2e_is_wired(stamped: Path):
    fake_roster(stamped)
    wire(stamped, "e2e", PY_CHECK)
    e2e_workflow(stamped)

    check = asf(stamped, "check", "browser")

    assert check.returncode == 0, check.stdout + check.stderr


def test_check_refuses_a_block_quality_py_does_not_offer(stamped: Path):
    fake_roster(stamped)
    e2e_workflow(stamped, blocks=["test", "playwright"])

    check = asf(stamped, "check", "browser")

    assert check.returncode == 1
    assert "verify: no block 'playwright' in asf/engine/quality.py" in check.stdout


# ── a check of its own: its port, its evidence ───────────────────────────────
#
# What stands in for `playwright test`: a script committed to the repo, so it
# is in every session's worktree, called the way the block's own example calls
# Playwright — with `--output <the check's evidence directory>`.

HOLDS_ITS_PORT = """\
import os, socket, sys, time
from pathlib import Path
output = Path(sys.argv[sys.argv.index("--output") + 1])
output.mkdir(parents=True, exist_ok=True)
with socket.socket() as server:              # what a dev server on PORT would do
    server.bind(("127.0.0.1", int(os.environ["PORT"])))
    server.listen()
    (output / "port").write_text(os.environ["PORT"])
    time.sleep(2)                            # long enough for the other session to try
"""

FAILS_WITH_A_TRACE = """\
import sys
from pathlib import Path
output = Path(sys.argv[sys.argv.index("--output") + 1])
(output / "checkout-chromium").mkdir(parents=True)
(output / "checkout-chromium" / "trace.zip").write_text("a trace")
print("1 failed: checkout.spec.ts:4 the cart shows the item")
sys.exit(1)
"""

# Playwright's own words when its `webServer` never answers, exit 1 — the same
# exit code as a failing spec, which is the whole problem.
NO_SERVER = """\
import sys
print("[WebServer] Error: Cannot find module 'next'", file=sys.stderr)
print("Error: Timed out waiting 60000ms from config.webServer.", file=sys.stderr)
sys.exit(1)
"""


def wire_e2e(stamped: Path, script: str) -> None:
    """Write the stand-in into the repo and point the e2e block at it, the
    evidence directory passed exactly as the block's example passes it."""
    (stamped / "playwright_stand_in.py").write_text(script)
    quality_py = stamped / "asf" / "engine" / "quality.py"
    source = quality_py.read_text()
    argv = f'argv=[{sys.executable!r}, "playwright_stand_in.py", "--output", str(evidence)],'
    # Over the placeholder, or over what the installer wired from a config.
    wired, count = re.subn(r'(name="e2e",[^)]*?)argv=[^\n]*', lambda m: m[1] + argv, source,
                           count=1)
    assert count == 1
    quality_py.write_text(wired)


def build_reply() -> dict:
    return {"writes": {"app.py": "ok = 1\n"},
            "envelope": envelope(changed_files=["app.py"], commit_message="feat: app")}


def browser_chain(stamped: Path, script: str, max_fix_loops: int = 1) -> None:
    fake_roster(stamped, builder=[build_reply()] * 3)
    wire_e2e(stamped, script)
    write_workflow(stamped, "browser", {
        "description": "build, then run the browser tests against it",
        "stages": [{"implement": {}},
                   {"verify": {"blocks": ["e2e"], "max_fix_loops": max_fix_loops}},
                   {"commit": {"of": "implement"}}]})
    commit_all(stamped)


def e2e_dir(stamped: Path, adw_id: str) -> Path:
    found = sorted((session_dir(stamped, adw_id) / "context_handoff" / "quality").glob("*_e2e"))
    assert found, f"no e2e check ran in {adw_id}"
    return found[0]


def test_two_sessions_running_e2e_at_once_do_not_share_a_port(stamped: Path):
    browser_chain(stamped, HOLDS_ITS_PORT)
    command = [sys.executable, "asf/asf.py", "run", "browser", "add app.py"]
    sessions = [subprocess.Popen(command, cwd=stamped, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for _ in range(2)]
    outputs = [session.communicate(timeout=120)[0] for session in sessions]

    assert [session.returncode for session in sessions] == [0, 0], "\n".join(outputs)
    ports = {(e2e_dir(stamped, adw_id_of(SimpleNamespace(stdout=out))) / "test-results"
              / "port").read_text() for out in outputs}
    assert len(ports) == 2


def test_a_failing_e2e_leaves_its_evidence_in_the_check_s_directory_and_names_it(stamped: Path):
    browser_chain(stamped, FAILS_WITH_A_TRACE, max_fix_loops=2)

    result = asf(stamped, "run", "browser", "add app.py")
    adw_id = adw_id_of(result)
    evidence = e2e_dir(stamped, adw_id) / "test-results"

    assert result.returncode == 1                     # red twice: the loop ran out
    assert (evidence / "checkout-chromium" / "trace.zip").is_file()
    assert not (stamped / ".asf-worktrees" / adw_id / "test-results").exists()
    # The builder asked to repair it is handed the directory, not just the log.
    fix_prompt = (session_dir(stamped, adw_id) / "builder" / "prompts" / "user.md").read_text()
    assert str(evidence) in fix_prompt
    assert "1 failed: checkout.spec.ts:4" in fix_prompt


def test_a_dev_server_that_never_came_up_is_reported_as_that_not_as_failing_specs(
        stamped: Path):
    browser_chain(stamped, NO_SERVER, max_fix_loops=2)

    result = asf(stamped, "run", "browser", "add app.py")
    adw_id = adw_id_of(result)

    fix_prompt = (session_dir(stamped, adw_id) / "builder" / "prompts" / "user.md").read_text()
    assert "e2e: the dev server never came up" in fix_prompt
    assert "no spec ran" in fix_prompt
    assert "Cannot find module 'next'" in fix_prompt       # and why, verbatim


# ── the installer wires it where the repository already runs Playwright ──────

@pytest.mark.parametrize("lockfile, runner", [
    ("bun.lock", "bunx playwright test"),
    ("pnpm-lock.yaml", "pnpm exec playwright test"),
    ("package-lock.json", "npx playwright test"),
])
def test_a_playwright_config_wires_e2e_at_install(repo: Path, lockfile, runner):
    (repo / "package.json").write_text('{"name": "web"}\n')
    (repo / lockfile).write_text("{}\n")
    (repo / "playwright.config.ts").write_text("export default {}\n")
    commit_all(repo, "a repo with browser tests")

    result = install(repo, "--harness", "claude_code")
    assert result.returncode == 0, result.stdout + result.stderr
    e2e_workflow(repo)

    assert f"e2e: {runner} --output <the check's evidence directory>" in result.stdout
    check = asf(repo, "check", "browser")
    assert check.returncode == 0, check.stdout + check.stderr
    ignored = (repo / ".gitignore").read_text().splitlines()
    assert "test-results/" in ignored and "playwright-report/" in ignored


LEAVES_ITS_DEFAULTS = """\
from pathlib import Path
for default in ("test-results", "playwright-report"):   # a config that names its own
    Path(default).mkdir()
    (Path(default) / "index.html").write_text("ran")
"""


def test_what_playwright_leaves_in_the_worktree_is_not_committed(repo: Path):
    (repo / "package.json").write_text('{"name": "web"}\n')
    (repo / "package-lock.json").write_text("{}\n")
    (repo / "playwright.config.ts").write_text("export default {}\n")
    commit_all(repo, "a repo with browser tests")
    assert install(repo, "--harness", "claude_code").returncode == 0
    set_config(repo, worktree={"setup": [], "keep_on_success": True})   # no `npm ci` here
    browser_chain(repo, LEAVES_ITS_DEFAULTS)

    result = asf(repo, "run", "browser", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)

    assert (repo / ".asf-worktrees" / adw_id / "test-results" / "index.html").is_file()
    landed = git(repo, "show", "--name-only", "--format=", f"asf/{adw_id}")
    assert landed.splitlines() == ["app.py"]


def test_without_a_playwright_config_e2e_stays_unwired_and_unmentioned(repo: Path):
    result = install(repo, "--harness", "claude_code")
    assert result.returncode == 0, result.stdout + result.stderr

    assert "still unwired: lint, typecheck, build" in result.stdout
    assert "e2e" not in result.stdout
    assert "test-results/" not in (repo / ".gitignore").read_text()

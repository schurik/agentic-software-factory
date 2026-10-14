"""`accept`: an agent drives the running app in a browser and judges it against
what was asked, on the fake harness.

Code owns the dev server — it starts it on a free port, waits until it
answers, hands the agent only the URL, and stops it however the stage ends —
and asks the browser's MCP server to answer before any agent is paid for.
Here the dev server is `python -m http.server` and the browser is a stub MCP
server that answers `initialize`: both real processes, neither a mock.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml

from engine import events

from .asf_helpers import (PY_CHECK, asf, commit_all, envelope, fake_roster, git, phase_names,
                          phase_rows, session_dir, wire, write_workflow)

ADW = "acce9701"

ACCEPTED = {"description": "implement, verify, accept, commit",
            "stages": [{"implement": {}}, {"verify": {}}, {"accept": {"max_rounds": 2}},
                       {"commit": {"of": "implement"}}]}

HTTP = f'[{sys.executable!r}, "-m", "http.server", str(port), "--bind", "127.0.0.1"]'
NEVER_UP = f'[{sys.executable!r}, "-c", "print(\'no port for you\'); raise SystemExit(3)"]'

# Answers `initialize` and nothing else, after writing down the arguments it was
# started with — `${ASF_HANDOFF_DIR}` among them, expanded as Claude Code would.
STUB_MCP = """\
import json, sys
from pathlib import Path
Path(sys.argv[1]).parent.mkdir(parents=True, exist_ok=True)
Path(sys.argv[1]).write_text(json.dumps(sys.argv[1:]))
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "serverInfo": {"name": "stub", "version": "1"}}}), flush=True)
"""
BROKEN_MCP = "import sys; print('chromium is not installed', file=sys.stderr); sys.exit(1)\n"


def serve(repo: Path, argv_source: str) -> None:
    """Wire the dev server command into the stamped quality.py."""
    quality = repo / "asf" / "engine" / "quality.py"
    source = quality.read_text()
    assert 'return _placeholder("serve")' in source
    quality.write_text(source.replace('return _placeholder("serve")', f"return {argv_source}"))


def browser(repo: Path, script: str = STUB_MCP) -> None:
    """Put the qa agent's browser server on a stub, under the same server name."""
    stub = repo / ".stub" / "mcp.py"
    stub.parent.mkdir(exist_ok=True)
    stub.write_text(script)
    (repo / "asf" / "agents" / "qa" / "playwright.json").write_text(json.dumps({"mcpServers": {
        "playwright": {"command": sys.executable,
                       "args": [str(stub), "${ASF_HANDOFF_DIR}/browser/args.json"]}}}))


def handoff(repo: Path) -> Path:
    return session_dir(repo, ADW) / "context_handoff"


def accept_reply(repo: Path, met: bool, shot: str = "") -> dict:
    requirement = "the page greets the visitor"
    screenshot = shot or str(handoff(repo) / "accept" / f"{'met' if met else 'unmet'}.png")
    report = handoff(repo) / "acceptance.md"
    writes = {str(report): "# Acceptance\n"}
    if not shot:
        writes[screenshot] = "PNG"
    return {"writes": writes, "envelope": envelope(
        approved=met, artifacts=[str(report)], screenshots=[screenshot],
        findings=[{"requirement": requirement, "met": met,
                   "evidence": "the heading reads Hello" if met else "the heading reads Bye"}],
        blocking=[] if met else ["the heading must greet the visitor, it says Bye"],
        steps=["opened /", "read the heading"], console_errors=[])}


def build_reply(content: str) -> dict:
    return {"writes": {"app.py": content},
            "envelope": envelope(changed_files=["app.py"], commit_message="feat: greet")}


def prepare(repo: Path, qa: list[dict], dev_server: str = HTTP, **more) -> None:
    fake_roster(repo, builder=[build_reply("greeting = 'Bye'\n"),
                               build_reply("greeting = 'Hello'\n")], qa=qa, **more)
    wire(repo, "test", PY_CHECK)
    serve(repo, dev_server)
    write_workflow(repo, "accepted", ACCEPTED)
    commit_all(repo)


def processes(repo: Path) -> list[dict]:
    return [json.loads(line) for line in
            (session_dir(repo, ADW) / "processes.jsonl").read_text().splitlines()]


def dev_servers(repo: Path) -> list[dict]:
    return [row for row in processes(repo) if row.get("kind") == "dev_server"]


def ended_because(repo: Path) -> str:
    """Why the session ended, as its `session_finished` event says."""
    return next(line.payload["reason"] for line in events.read(session_dir(repo, ADW))
                if line.kind == "session_finished")


def gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    # A zombie of a child we did not reap still answers; a group with no live
    # member is gone, which is what stopping a dev server means.
    return subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                          text=True).stdout.strip().startswith("Z")


def assert_stopped(repo: Path) -> None:
    started = dev_servers(repo)
    assert started, "no dev server was recorded"
    ended = {row["pid"] for row in processes(repo) if row.get("event") == "end"}
    for row in started:
        assert row["pid"] in ended and gone(row["pid"]), row


# ── the loop ──────────────────────────────────────────────────────────────────

def test_an_unmet_requirement_goes_to_the_builder_and_a_met_set_ends_the_loop(stamped: Path):
    browser(stamped)
    prepare(stamped, qa=[accept_reply(stamped, met=False), accept_reply(stamped, met=True)])

    result = asf(stamped, "run", "accepted", "greet the visitor", "--adw-id", ADW)
    assert result.returncode == 0, result.stdout + result.stderr
    assert phase_names(stamped, ADW) == [
        "request", "implement", "verify_1", "serve", "accept_1", "revise_1", "accept_2",
        "retest", "commit_implement"]
    assert git(stamped, "show", f"asf/{ADW}:app.py") == "greeting = 'Hello'"   # as revised
    # The agent was handed the URL and nothing else to run; the builder was
    # handed what the browser found, in acceptance's own words.
    asked = (session_dir(stamped, ADW) / "qa" / "prompts" / "user.md").read_text()
    assert asked.startswith("# Accept") and "http://localhost:" in asked
    revise = (session_dir(stamped, ADW) / "builder" / "prompts" / "user.md").read_text()
    assert revise.startswith("# Revise") and "it says Bye" in revise
    # The browser server was asked to start before any agent turn, with the
    # handoff directory in its arguments — where its own files go, not the tree.
    seen = handoff(stamped) / "browser" / "args.json"
    assert Path(json.loads(seen.read_text())[0]).resolve() == seen.resolve()
    assert_stopped(stamped)


def without_screenshots(reply: dict) -> dict:
    return {**reply, "envelope": {**reply["envelope"], "screenshots": []}}


@pytest.mark.parametrize("wrong", ["in the tree", "none at all"])
def test_the_dev_server_is_gone_when_a_gate_fails_the_phase(stamped: Path, wrong: str):
    browser(stamped)
    reply = (accept_reply(stamped, met=True, shot=str(stamped / "shot.png"))
             if wrong == "in the tree" else without_screenshots(accept_reply(stamped, True)))
    prepare(stamped, qa=[reply])

    result = asf(stamped, "run", "accepted", "greet the visitor", "--adw-id", ADW)
    assert result.returncode == 1
    assert ("accept_1" in [name for _, name, status in phase_rows(stamped, ADW)
                           if status == "fail"])
    assert ("not in the handoff directory" if wrong == "in the tree"
            else "names no screenshot") in ended_because(stamped)
    assert_stopped(stamped)


def test_the_dev_server_is_gone_when_the_run_is_killed(stamped: Path):
    browser(stamped)
    slow = {**accept_reply(stamped, met=True), "sleep": 60}
    prepare(stamped, qa=[slow])

    run = subprocess.Popen([sys.executable, "asf/asf.py", "run", "accepted", "greet",
                            "--adw-id", ADW], cwd=stamped, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.monotonic() + 60
    while "accept_1" not in (phase_names(stamped, ADW)
                             if (session_dir(stamped, ADW) / "events.jsonl").exists() else []):
        assert time.monotonic() < deadline and run.poll() is None, run.stdout.read()
        time.sleep(0.2)
    run.send_signal(signal.SIGTERM)
    run.wait(timeout=30)
    assert_stopped(stamped)


# ── found before anything is spent ───────────────────────────────────────────

def test_a_dev_server_that_never_comes_up_ends_the_session_before_any_agent_turn(stamped: Path):
    browser(stamped)
    prepare(stamped, qa=[accept_reply(stamped, met=True)], dev_server=NEVER_UP)

    result = asf(stamped, "run", "accepted", "greet the visitor", "--adw-id", ADW)
    assert result.returncode == 1
    assert phase_names(stamped, ADW)[-1] == "serve"
    reason = ended_because(stamped)
    assert "the environment, not the code" in reason and "no port for you" in reason
    assert not (session_dir(stamped, ADW) / "qa").exists()           # no turn was paid for


def test_a_browser_that_does_not_start_ends_the_session_before_any_agent_turn(stamped: Path):
    browser(stamped, BROKEN_MCP)
    prepare(stamped, qa=[accept_reply(stamped, met=True)])

    result = asf(stamped, "run", "accepted", "greet the visitor", "--adw-id", ADW)
    assert result.returncode == 1
    assert phase_names(stamped, ADW)[-1] == "serve"
    reason = ended_because(stamped)
    assert "the environment, not the code" in reason and "chromium is not installed" in reason
    assert not (session_dir(stamped, ADW) / "qa").exists()
    assert not dev_servers(stamped)                                  # never started either


# ── what `check` refuses ─────────────────────────────────────────────────────

@pytest.fixture
def here(stamped: Path) -> Path:
    fake_roster(stamped, builder=[build_reply("x = 1\n")], qa=[accept_reply(stamped, True)])
    return stamped


def check(repo: Path, name: str = "accepted") -> str:
    """`asf check <name>`, as a user runs it: what it says, "" when it passed."""
    result = asf(repo, "check", name)
    return "" if result.returncode == 0 else result.stdout + result.stderr


def test_check_refuses_accept_with_an_unwired_server_an_unknown_agent_or_a_widened_binding(here):
    write_workflow(here, "accepted", ACCEPTED)
    assert "serve is still a placeholder in asf/engine/quality.py" in check(here)

    serve(here, HTTP)
    assert check(here) == ""
    write_workflow(here, "accepted", {**ACCEPTED, "stages": [
        {"implement": {}}, {"accept": {"agent": "ghost"}}]})
    assert "agent 'ghost' is neither in the roster" in check(here)
    write_workflow(here, "accepted", {**ACCEPTED, "agents": {"qa": {
        "from": "qa", "harness": {"tools": ["Read", "Bash"]}}}})
    assert "tools ['Bash'] are not in qa's" in check(here)
    write_workflow(here, "accepted", {**ACCEPTED, "agents": {"qa": {
        "from": "qa", "writes": ["src/"]}}})
    assert "writes ['src/'] are not covered" in check(here)


def test_check_refuses_accept_played_by_an_agent_whose_harness_has_no_mcp(here):
    serve(here, HTTP)
    directory = here / "asf" / "agents" / "plain"
    directory.mkdir()
    (directory / "agent.md").write_text("---\npurpose: x\nwrites: []\nharness: {name: pi}\n"
                                        "---\n\n# Plain\n\nWho.\n")
    write_workflow(here, "accepted", {**ACCEPTED, "stages": [
        {"implement": {}}, {"accept": {"agent": "plain"}}]})
    message = check(here)
    assert "accept: agent 'plain' runs on pi, which cannot give it MCP servers (MCP)" in message
    assert "claude_code" in message


# ── shipped off, offered as an example ───────────────────────────────────────

def test_no_shipped_workflow_runs_accept_and_the_example_puts_it_between_verify_and_review(
        stamped: Path):
    shipped = stamped / "asf" / "workflows"
    for spec in shipped.glob("*/workflow.yaml"):
        stages = [next(iter(item)) for item in yaml.safe_load(spec.read_text())["stages"]]
        assert "accept" not in stages, spec

    shutil.copytree(stamped / "asf" / "examples" / "workflows" / "ship-accept",
                    shipped / "ship-accept")
    serve(stamped, HTTP)
    result = asf(stamped, "check", "ship-accept")
    assert result.returncode == 0, result.stdout
    assert "-> verify -> accept -> review ->" in result.stdout


def test_the_stamped_browser_is_a_pinned_server_headless_and_isolated_on_every_run(stamped):
    """`@latest` would change the tool names under the deny list from one run to
    the next; a headed or profiled browser would make an unattended run differ
    from an attended one."""
    spec = json.loads((stamped / "asf" / "agents" / "qa" / "playwright.json").read_text())
    args = spec["mcpServers"]["playwright"]["args"]
    package = next(arg for arg in args if arg.startswith("@playwright/mcp@"))
    assert re.fullmatch(r"@playwright/mcp@\d+\.\d+\.\d+", package)
    assert "--headless" in args and "--isolated" in args
    # The one directory the server may write to, and the one the task names.
    assert args[args.index("--output-dir") + 1] == "${ASF_HANDOFF_DIR}/accept"


# ── doctor: the browser, only when a workflow runs accept ───────────────────

def test_doctor_names_a_missing_browser_only_when_a_workflow_runs_accept(stamped: Path,
                                                                        tmp_path: Path):
    fake_roster(stamped)                        # qa stays on claude_code; no workflow runs it
    empty = tmp_path / "no-browsers"
    empty.mkdir()
    env = {"PLAYWRIGHT_BROWSERS_PATH": str(empty)}
    said = asf(stamped, "doctor", env=env).stdout
    assert "browser" not in said
    assert "not checked — no workflow here runs an agent on it" in said   # claude_code's CLI

    shutil.copytree(stamped / "asf" / "examples" / "workflows" / "ship-accept",
                    stamped / "asf" / "workflows" / "ship-accept")
    said = asf(stamped, "doctor", env=env).stdout
    assert f"no Chromium in Playwright's browser cache ({empty})" in said
    serve(stamped, HTTP)                        # the example loads once `serve` is written…
    assert "not checked" not in asf(stamped, "doctor", env=env).stdout    # …and qa's CLI is asked
    assert "npx playwright install chromium" in said

    (empty / "chromium-1243").mkdir()
    said = asf(stamped, "doctor", env=env).stdout
    assert "no Chromium" not in said and "browser: chromium" in said

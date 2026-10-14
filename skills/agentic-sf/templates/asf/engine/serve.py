"""The running app, for a stage that hands an agent a browser (`accept`).

Code owns the dev server, start to finish. It starts `quality.serve(port)` in
the run's worktree on a port nothing else holds, waits until it answers, hands
the agent the URL and nothing else, and stops the server — its whole process
group — however the stage ends: approved, rejected, a failed gate, a killed
run (SIGTERM is SystemExit in a run, so the `finally` below runs then too).
The agent never runs `bun dev`: no orphan processes, no port picked at random,
no two sessions meeting on 3000. The server is recorded in `processes.jsonl`
as well, so `asf kill` can reach it from outside.

Before the server starts, the agent's browser is asked for: each of its MCP
servers must start and answer `initialize`, and a Playwright one needs a
Chromium in Playwright's browser cache. Either missing is the environment, not
the code — the session ends here, in a code phase, before an agent turn is
paid for and without a word to the builder, exactly as a failed
`worktree.setup` does. Fix it and resume.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import artifacts, mcp, preflight, quality
from .data_types import AgentConfig, PhaseParams
from .utils import HANDOFF_ENV, agent_env, ensure_dir

STOP_SECONDS = 10                  # SIGTERM's grace before the group is SIGKILLed
LOG_TAIL_CHARS = 1500              # of the server's output, in an environment failure


class Serve(BaseModel):
    """`serve:` in a stage's options: where the agent is pointed, and how long
    the server and the browser get to come up."""

    model_config = ConfigDict(extra="forbid")

    path: str = "/"                                       # appended to http://localhost:<port>
    ready_seconds: int = Field(default=120, ge=1)         # until the dev server answers
    browser_seconds: int = Field(default=120, ge=1)       # until each MCP server answers

    @field_validator("path")
    @classmethod
    def _absolute(cls, path: str) -> str:
        if not path.startswith("/"):
            raise ValueError(f"path {path!r} must start with `/` — it follows the port")
        return path


class App(BaseModel):
    """What a stage hands its agent: the URL, and where the server's output goes."""

    url: str
    log: str


@contextmanager
def running(run, agent: AgentConfig, opts: Serve) -> Iterator[App]:
    """The app, up for the length of the `with` block, as a `serve` code phase."""
    process = None
    try:
        with run.phase(PhaseParams(
                name="serve", kind="code", owner="dev_server",
                description="Start the dev server on a free port once the agent's browser "
                            "answers — code owns both, so no agent starts a process")) as ph:
            problems = browser_problems(run, agent, opts.browser_seconds)
            if problems:
                raise SystemExit(_environment("the agent's browser is not ready", problems))
            port = quality.free_port()
            app = App(url=f"http://localhost:{port}{opts.path}",
                      log=str(ensure_dir(run.context_handoff_dir / "serve") / "server.log"))
            argv = quality.serve(port)
            process = _start(run, argv, port, Path(app.log))
            problem = _answering(app.url, process, opts.ready_seconds)
            if problem:
                tail = Path(app.log).read_text(errors="replace")[-LOG_TAIL_CHARS:].strip()
                raise SystemExit(_environment(
                    f"the dev server `{shlex.join(argv)}` {problem}",
                    [f"its output ({app.log}):\n{tail}" if tail else "it printed nothing"]))
            ph.log(url=app.url, command=shlex.join(argv), log=app.log, pid=process.pid)
        yield app
    finally:
        if process is not None:
            _stop(run, process)


def browser_problems(run, agent: AgentConfig, seconds: int) -> list[str]:
    """Why `agent` has no browser this session can use, or []."""
    servers, problems = mcp.servers(run.main_root, agent.harness_engineering)
    if problems:
        return problems
    if not servers:
        return [f"agent {agent.name!r} is given no MCP server — its browser is an `mcp:` "
                f"file in its harness_engineering (asf/agents/qa/playwright.json)"]
    env = {HANDOFF_ENV: str(run.context_handoff_dir.resolve())}
    for name, spec in servers.items():
        if preflight.PLAYWRIGHT_MCP in " ".join([str(spec.get("command", "")),
                                                 *map(str, spec.get("args") or [])]):
            missing = preflight.chromium_missing()
            if missing:
                problems.append(f"{name}: {missing} — fix: `{preflight.INSTALL_CHROMIUM}`")
                continue
        said = mcp.probe(mcp.expanded(spec, env), run.repo_root, seconds)
        if said:
            problems.append(f"{name}: {said}")
    return problems


def _environment(what: str, problems: list[str]) -> str:
    return (f"{what} — the environment, not the code, so no agent was asked about it. "
            f"Fix it and resume the session.\n- " + "\n- ".join(problems))


def _start(run, argv: list[str], port: int, log: Path) -> subprocess.Popen:
    """The server, in a process group of its own so it can be stopped whole."""
    with log.open("ab") as out:
        try:
            process = subprocess.Popen(
                argv, cwd=run.repo_root, stdin=subprocess.DEVNULL, stdout=out,
                stderr=subprocess.STDOUT, start_new_session=True,
                env={**agent_env(str(run.context_handoff_dir.resolve())), "PORT": str(port)})
        except OSError as error:
            raise SystemExit(_environment(f"the dev server `{shlex.join(argv)}` could not "
                                          f"start", [str(error)])) from None
    artifacts.record_process(run.session_dir, "dev_server", "serve", process.pid,
                             shlex.join(argv))
    return process


def _answering(url: str, process: subprocess.Popen, seconds: int) -> str:
    """"" once `url` answers at all — any status: a 404 or a 500 is the app,
    and the agent's to judge — else why it never did."""
    # Straight to the port: an HTTP_PROXY in the operator's environment must
    # not be asked about localhost.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return f"exited {process.returncode} before it answered {url}"
        try:
            opener.open(url, timeout=2).close()
            return ""
        except urllib.error.HTTPError:
            return ""
        except OSError:                      # URLError among them: nothing listening yet
            time.sleep(0.25)
    return f"did not answer {url} within {seconds}s"


def _stop(run, process: subprocess.Popen) -> None:
    """SIGTERM to the whole group, SIGKILL after the grace — a dev server's
    watcher and bundler children included, which a signal to the leader alone
    would leave holding the port."""
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=STOP_SECONDS)
    except subprocess.TimeoutExpired:
        _signal_group(process.pid, signal.SIGKILL)
        process.wait()
    _signal_group(process.pid, signal.SIGKILL)        # whatever outlived its leader
    artifacts.end_process(run.session_dir, process.pid)


def _signal_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass

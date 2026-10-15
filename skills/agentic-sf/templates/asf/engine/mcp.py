"""MCP servers, as the factory reads them: the `mcp:` files an agent is given,
the tools it is denied, and whether a server answers at all.

An MCP server reaches an agent as `harness_engineering: [mcp:<file.json>]`, a
file in Claude Code's own `--mcp-config` shape (`{"mcpServers": {name: …}}`).
What it grants is every tool it has: `tools:` filters a harness's built-in
tools only, so a server's are narrowed by `deny_tools`, each named
`mcp__<server>__<tool>` the way the harness names them to the model.

A deny list fails open — a misspelt entry withholds nothing and says nothing —
so every half of a denial that can be checked before a run is checked here,
by `check`: its shape, and that `<server>` is one this agent is actually
given. The `<tool>` half cannot be: a server's tools are known only once it
has started, and `harnesses/claude_code.py` says so when a turn shows a
denial that held nothing.

`probe` is the other question code can answer before an agent is paid for:
does the server start and answer `initialize`? A stage that hands an agent a
browser asks it first, and a server that does not answer is the environment,
not a finding for the builder.
"""

from __future__ import annotations

import json
import queue
import re
import subprocess
import threading
import time
from pathlib import Path

from .utils import anchor, operator_env

PREFIX = "mcp:"
# `mcp__<server>__<tool>`: the server is everything up to the first `__` after
# the prefix, as Claude Code splits it.
DENIAL = re.compile(r"^mcp__(?P<server>.+?)__(?P<tool>.+)$")


def files(extensions: list[str]) -> list[str]:
    """The `mcp:` files among an agent's harness_engineering entries."""
    return [entry[len(PREFIX):] for entry in extensions if str(entry).startswith(PREFIX)]


def servers(root: Path, extensions: list[str]) -> tuple[dict[str, dict], list[str]]:
    """Every server an agent's `mcp:` files give it, by name, and what is wrong
    with any file that could not be read. Paths resolve against `root`, the
    main checkout — the same repository path the agent's worktree holds."""
    found: dict[str, dict] = {}
    problems: list[str] = []
    for ref in files(extensions):
        path = anchor(root, ref)
        if not path.is_file():
            problems.append(f"{PREFIX}{ref} is not a file in {root}")
            continue
        try:
            given = json.loads(path.read_text()).get("mcpServers")
        except (ValueError, AttributeError) as error:
            problems.append(f"{PREFIX}{ref} is not an MCP config ({error})")
            continue
        if not isinstance(given, dict):
            problems.append(f"{PREFIX}{ref} has no `mcpServers` object — Claude Code's "
                            f"--mcp-config shape is {{\"mcpServers\": {{<name>: {{…}}}}}}")
            continue
        found.update({name: spec for name, spec in given.items() if isinstance(spec, dict)})
    return found, problems


def denials_refused(root: Path, extensions: list[str], deny_tools: list[str]) -> list[str]:
    """Why these denials cannot be honoured, as `check` says it — the files
    they name servers from included. Nothing to say when nothing is denied:
    a server given whole is the harness's to start or refuse."""
    if not deny_tools:
        return []
    given, problems = servers(root, extensions)
    for denied in deny_tools:
        match = DENIAL.match(denied)
        if match is None:
            problems.append(f"deny_tools {denied!r} is not `mcp__<server>__<tool>` — it "
                            f"withholds an MCP server's tool; a built-in tool is narrowed "
                            f"by leaving it out of `tools:`")
        elif match["server"] not in given:
            problems.append(f"deny_tools {denied!r} names server {match['server']!r}, which "
                            f"none of this agent's `mcp:` files gives it (they give: "
                            f"{', '.join(sorted(given)) or 'nothing'}) — a denial of a server "
                            f"it does not have withholds nothing, and a typo here fails open")
    return problems


# ── does it answer? ───────────────────────────────────────────────────────────

# `${VAR}` and `${VAR:-default}`, which Claude Code expands in an `mcp:` file's
# command, args and env before it starts a server.
VARIABLE = re.compile(r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?P<default>[^}]*))?\}")


def expanded(spec: dict, env: dict[str, str]) -> dict:
    """`spec` with its variables expanded from `env`, then the operator's
    environment — the server as the harness would start it."""
    known = {**operator_env(), **env}

    def expand(value):
        if isinstance(value, str):
            return VARIABLE.sub(lambda m: known.get(m["name"]) or m["default"] or "", value)
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value

    return {**expand(spec), "env": {**env, **expand(spec.get("env") or {})}}

INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "asf", "version": "1"}}}


def probe(spec: dict, cwd: Path, timeout: float) -> str:
    """Start one stdio server, ask it `initialize`, stop it. "" when it answered,
    else what went wrong — said for a person, since it is never an agent's.

    A server reached over HTTP (`url`, no `command`) is not started by anyone
    here, so there is nothing to probe: "" as well.
    """
    command = spec.get("command")
    if not command:
        return ""
    argv = [str(command), *(str(arg) for arg in spec.get("args") or [])]
    try:
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True,
                                   env={**operator_env(), **(spec.get("env") or {})})
    except OSError as error:
        return f"`{' '.join(argv)}` could not start: {error}"
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(json.dumps(INITIALIZE) + "\n")
        process.stdin.flush()
        return _answered(process, timeout, " ".join(argv))
    except OSError as error:                          # it died before reading a line
        return f"`{' '.join(argv)}` exited before it answered: {error}"
    finally:
        process.kill()
        process.wait()


def _answered(process: subprocess.Popen, timeout: float, command: str) -> str:
    """Read lines until the answer to `initialize`, the process ends, or time is up.

    On a thread, so a server that says nothing at all cannot hold the caller
    past `timeout` — and a queue rather than select(), which cannot see a line
    already sitting in the reader's buffer."""
    lines: queue.Queue = queue.Queue()

    def read() -> None:
        for line in process.stdout:
            lines.put(line)
        lines.put(None)                               # the server's stdout closed

    threading.Thread(target=read, daemon=True).start()
    deadline = time.monotonic() + timeout
    while (left := deadline - time.monotonic()) > 0:
        try:
            line = lines.get(timeout=left)
        except queue.Empty:
            break
        if line is None:
            process.wait()
            err = (process.stderr.read() if process.stderr else "").strip()[-500:]
            return f"`{command}` exited before it answered initialize{': ' + err if err else ''}"
        try:
            message = json.loads(line)
        except ValueError:
            continue                                  # a server that logs to stdout
        if isinstance(message, dict) and message.get("id") == 1:
            return ("" if "result" in message
                    else f"`{command}` refused initialize: {message.get('error')}")
    return f"`{command}` did not answer initialize within {timeout:.0f}s"

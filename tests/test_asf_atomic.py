"""A session file is only ever seen whole.

A session directory has readers the process writing it does not control: `asf
status` in another terminal, a watcher deciding whether a run is alive, and — soon
— a station's shipper in another thread or process turning those files into
domain events. An in-place `write_text` truncates first and writes after, so a
reader that lands in between reads half a `run.json`, or none. Every rewrite
goes through `utils.write_atomic` (temp file, then `os.replace`), and these
tests hold both halves of that: the reader never sees a partial file, and no
in-place rewrite creeps back into the engine or the stages.
"""

from __future__ import annotations

import ast
import threading
from pathlib import Path

import pytest

from engine import artifacts
from engine.data_types import RunState
from engine.utils import write_atomic

from .conftest import TEMPLATES


def _state(marker: str) -> RunState:
    # Large enough that one rewrite takes several write syscalls, so an in-place
    # write has a window a reader can land in.
    return RunState(adw_id="atomic", engineer=marker * 200_000, status="running")


def test_a_concurrent_reader_never_sees_a_partial_run_json(tmp_path: Path):
    session_dir = tmp_path / "sessions" / "atomic"
    states = [_state("a"), _state("b")]
    artifacts.write_run(session_dir, states[0])
    path = artifacts.run_path(session_dir)
    whole = {path.read_text()}
    artifacts.write_run(session_dir, states[1])
    whole.add(path.read_text())
    assert len(whole) == 2

    done = threading.Event()

    def rewrite() -> None:
        for i in range(300):
            artifacts.write_run(session_dir, states[i % 2])
        done.set()

    writer = threading.Thread(target=rewrite)
    writer.start()
    seen, torn = 0, []
    while not done.is_set():
        text = path.read_text()
        seen += 1
        if text not in whole:
            torn.append(len(text))
        assert artifacts.read_run(session_dir) is not None
    writer.join()

    assert seen > 0
    assert torn == [], f"{len(torn)} of {seen} reads saw a partial file (lengths {torn[:5]})"
    # Nothing is left behind beside the file it replaced.
    assert sorted(p.name for p in session_dir.iterdir()) == [path.name]


def test_a_failed_write_leaves_the_old_file_and_no_temp(tmp_path: Path):
    target = tmp_path / "pins.json"
    write_atomic(target, "before")

    with pytest.raises(TypeError):
        write_atomic(target, object())  # type: ignore[arg-type]
    assert target.read_text() == "before"
    assert [p.name for p in tmp_path.iterdir()] == ["pins.json"]


def test_an_atomic_write_keeps_the_mode_an_in_place_write_would_give(tmp_path: Path):
    plain, atomic = tmp_path / "plain", tmp_path / "atomic"
    plain.write_text("x")
    write_atomic(atomic, "x")
    assert atomic.stat().st_mode == plain.stat().st_mode


# ── no in-place rewrite remains ──────────────────────────────────────────────

# The only writes allowed to stay in place, and why. Neither is a session file.
IN_PLACE_ALLOWED = {
    # The fake harness playing an AGENT: it edits the run's worktree, which is
    # exactly what an agent's own tools do, and what permissions.py then diffs.
    ("engine/harnesses/fake.py", "_apply"),
    # An flock target. It holds no content; the handle is the lock.
    ("engine/watch.py", "claim"),
}


def _in_place_writes(source: Path) -> list[str]:
    tree = ast.parse(source.read_text())
    found: list[str] = []

    def visit(node: ast.AST, function: str) -> None:
        for child in ast.iter_child_nodes(node):
            name = function
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = child.name
            if isinstance(child, ast.Call):
                callee = child.func
                attr = callee.attr if isinstance(callee, ast.Attribute) else (
                    callee.id if isinstance(callee, ast.Name) else "")
                if attr in {"write_text", "write_bytes"}:
                    found.append(function)
                elif attr == "open":
                    modes = [a.value for a in child.args
                             if isinstance(a, ast.Constant) and isinstance(a.value, str)]
                    modes += [k.value.value for k in child.keywords if k.arg == "mode"
                              and isinstance(k.value, ast.Constant)]
                    if any("w" in m or "+" in m for m in modes):
                        found.append(function)
            visit(child, name)

    visit(tree, "<module>")
    return found


def test_no_session_file_is_rewritten_in_place():
    offenders = []
    for source in sorted(TEMPLATES.glob("*/**/*.py")):
        relative = source.relative_to(TEMPLATES).as_posix()
        if not relative.startswith(("engine/", "stages/")):
            continue
        for function in _in_place_writes(source):
            if relative == "engine/utils.py" and function == "write_atomic":
                continue
            if (relative, function) not in IN_PLACE_ALLOWED:
                offenders.append(f"{relative}::{function}")
    assert offenders == [], (
        "in-place writes found — use utils.write_atomic so no reader ever sees half a "
        f"file: {offenders}")

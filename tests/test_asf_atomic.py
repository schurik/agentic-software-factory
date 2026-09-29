"""A session file is only ever seen whole.

A session directory has readers the process writing it does not control: `asf
status` in another terminal, a watcher deciding whether a run is alive, and — soon
— a station's shipper in another thread or process turning those files into
domain events. An in-place `write_text` truncates first and writes after, so a
reader that lands in between reads half a `run.json`, or none. Every rewrite
goes through `utils.write_atomic` (temp file, then `os.replace`), and these
tests hold that: the reader never sees a partial file, a killed write's temp
file is swept when the session is next taken, and no in-place rewrite creeps
back into anything `install.py` stamps as `asf/`.
"""

from __future__ import annotations

import ast
import os
import threading
import time
from pathlib import Path

import pytest

from engine import artifacts, utils
from engine.data_types import RunState, SessionStarted
from engine.utils import sweep_temps, write_atomic

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
    seen, torn = 0, []

    def rewrite() -> None:
        # Keeps rewriting until the reader has had its turns too, so the two
        # always overlap — however the scheduler hands out the first slice.
        try:
            written = 0
            while written < 300 or seen < 300:
                artifacts.write_run(session_dir, states[written % 2])
                written += 1
        finally:
            done.set()

    writer = threading.Thread(target=rewrite)
    writer.start()
    while not done.is_set():
        text = path.read_text()
        seen += 1
        if text not in whole:
            torn.append(len(text))
        assert artifacts.read_run(session_dir) is not None
    writer.join()

    assert seen >= 300
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


# ── what a killed write leaves behind ────────────────────────────────────────

def _age(*paths: Path) -> None:
    hour_ago = time.time() - 3600
    for path in paths:
        os.utime(path, (hour_ago, hour_ago))


def test_the_sweep_knows_the_names_write_atomic_gives(tmp_path: Path, monkeypatch):
    temps: list[Path] = []
    real_replace = os.replace

    def spy(source, target):
        temps.append(Path(source))
        real_replace(source, target)

    monkeypatch.setattr(utils.os, "replace", spy)
    write_atomic(tmp_path / "run.json", "{}")
    assert len(temps) == 1 and utils._TEMP_NAME.match(temps[0].name)


def test_a_sweep_removes_only_stale_temps_of_its_own_shape(tmp_path: Path):
    agent_dir = tmp_path / "builder"
    agent_dir.mkdir()
    stale = agent_dir / ".envelope.json.1a2b3c4d.tmp"      # a killed write, an hour ago
    fresh = tmp_path / ".run.json.5e6f7a8b.tmp"            # may be a live writer's
    foreign = tmp_path / ".notes.tmp"                      # not a name write_atomic gives
    record = tmp_path / "run.json"
    for path in (stale, fresh, foreign, record):
        path.write_text("x")
    _age(stale, foreign, record)

    assert sweep_temps(tmp_path) == [stale]
    assert not stale.exists()
    assert fresh.exists() and foreign.exists() and record.exists()
    assert sweep_temps(tmp_path / "absent") == []


def test_taking_a_session_sweeps_what_a_killed_write_left(tmp_path: Path):
    session_dir = tmp_path / "sessions" / "swept"
    artifacts.write_run(session_dir, RunState(adw_id="swept", status="fail"))
    leftover = session_dir / f".{artifacts.RUN_FILE}.deadbeef.tmp"
    leftover.write_text('{"adw_id": "swe')
    _age(leftover)

    artifacts.start_run(session_dir, SessionStarted(adw_id="swept", workflow="sdlc"))
    assert not leftover.exists()
    assert artifacts.read_run(session_dir).adw_id == "swept"


# ── no in-place rewrite remains ──────────────────────────────────────────────

# The only writes allowed to stay in place, and why. None rewrites a session file.
IN_PLACE_ALLOWED = {
    # `events.jsonl`, opened "a+b": every write lands at the end (append mode),
    # and the "+" is only so the handle holding the flock can read the last seq.
    ("engine/events.py", "emit"),
    # The fake harness playing an AGENT: it edits the run's worktree, which is
    # exactly what an agent's own tools do, and what permissions.py then diffs.
    ("engine/harnesses/fake.py", "_apply"),
    # An flock target. It holds no content; the handle is the lock.
    ("engine/watch.py", "claim"),
}

# Openers whose first argument is the file and whose mode comes second;
# `Path.open` (any other `.open`) takes the mode first.
_FILE_FIRST = {"io", "builtins", "codecs"}


def _mode_of(call: ast.Call) -> ast.expr | None:
    for keyword in call.keywords:
        if keyword.arg == "mode":
            return keyword.value
    func = call.func
    file_first = isinstance(func, ast.Name) or (
        isinstance(func, ast.Attribute) and (
            func.attr == "fdopen"
            or (isinstance(func.value, ast.Name) and func.value.id in _FILE_FIRST)))
    index = 1 if file_first else 0
    return call.args[index] if len(call.args) > index else None


def _rewrites_in_place(call: ast.Call) -> bool:
    func = call.func
    name = (func.attr if isinstance(func, ast.Attribute)
            else func.id if isinstance(func, ast.Name) else "")
    owner = (func.value.id if isinstance(func, ast.Attribute)
             and isinstance(func.value, ast.Name) else "")
    if name in {"write_text", "write_bytes"}:
        return True
    if owner == "shutil" and name in {"copy", "copy2", "copyfile"}:
        return True
    if owner == "os" and name == "open":
        return True                    # its flags are where O_TRUNC would hide
    if name in {"open", "fdopen"}:
        mode = _mode_of(call)
        if mode is None:
            return False               # "r"
        if isinstance(mode, ast.Constant) and isinstance(mode.value, str):
            # "a" appends and "x" only ever creates: neither rewrites a file.
            return "w" in mode.value or "+" in mode.value
        return True                    # a mode the scan cannot read is a write
    return False


def _in_place_writes(source: str) -> list[str]:
    found: list[str] = []

    def visit(node: ast.AST, function: str) -> None:
        for child in ast.iter_child_nodes(node):
            name = function
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = child.name
            if isinstance(child, ast.Call) and _rewrites_in_place(child):
                found.append(function)
            visit(child, name)

    visit(ast.parse(source), "<module>")
    return found


@pytest.mark.parametrize("line, caught", [
    ("p.write_text(s)", True),
    ("p.write_bytes(b)", True),
    ("open(p, 'w')", True),
    ("open(p, mode='r+')", True),
    ("open(p, mode)", True),
    ("p.open('w')", True),
    ("p.open(mode)", True),
    ("io.open(p, 'wb')", True),
    ("os.fdopen(fd, 'w')", True),
    ("os.open(p, os.O_WRONLY | os.O_TRUNC)", True),
    ("shutil.copyfile(a, b)", True),
    ("open(p)", False),
    ("open('/tmp/w')", False),
    ("open(p, 'a')", False),
    ("p.open('a')", False),
    ("open(p, 'x')", False),
    ("p.open()", False),
])
def test_the_guard_recognises_an_in_place_write(line, caught):
    assert bool(_in_place_writes(f"def f():\n    {line}\n")) is caught


def test_no_session_file_is_rewritten_in_place():
    offenders = []
    for source in sorted(TEMPLATES.rglob("*.py")):
        relative = source.relative_to(TEMPLATES).as_posix()
        for function in _in_place_writes(source.read_text()):
            if (relative, function) not in IN_PLACE_ALLOWED:
                offenders.append(f"{relative}::{function}")
    assert offenders == [], (
        "in-place writes found — use utils.write_atomic so no reader ever sees half a "
        f"file: {offenders}")

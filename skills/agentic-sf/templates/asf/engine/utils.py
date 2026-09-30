"""Small shared helpers. Anything bigger belongs in its own module."""

from __future__ import annotations

import os
import re
import secrets
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def operator_env() -> dict[str, str]:
    """The engineer's own environment, as their shell would hand it over.

    Agents and quality blocks are meant to see exactly what the operator sees:
    their PATH, their toolchains, their globally installed packages. Copying
    os.environ gets almost all the way there — but ADWs launch under `uv run`,
    which prepends its ephemeral venv's bin to PATH and sets VIRTUAL_ENV. That
    venv holds the ADW's OWN dependencies (pydantic, pyyaml), not the
    operator's, so anything a subprocess resolves through it — `python3`,
    `pip`, every globally pip-installed CLI — silently becomes the wrong one.

    Stripping the venv restores parity: `python3` in an agent's bash is the
    same `python3` the engineer gets in their terminal. The ADW's own imports
    are unaffected; this env is only ever handed to child processes.
    """
    env = os.environ.copy()
    venv = env.pop("VIRTUAL_ENV", "")
    if not venv:
        return env
    venv_bin = str(Path(venv) / "bin")
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p and p != venv_bin]
    env["PATH"] = os.pathsep.join(parts)
    return env


def new_id(length: int = 8) -> str:
    return secrets.token_hex(length // 2)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


# `.<name>.<8 hex>.tmp` — the one shape `write_atomic` names its temp files, so a
# sweep can tell its own leftovers from anything else that happens to end in .tmp.
TEMP_SUFFIX = ".tmp"
_TEMP_NAME = re.compile(r"^\..+\.[0-9a-f]{8}" + re.escape(TEMP_SUFFIX) + "$")
STALE_TEMP_SECONDS = 60


def write_atomic(path: str | Path, text: str) -> Path:
    """Replace `path` with `text` so no reader ever sees anything but a whole file.

    A session directory is read by processes that did not write it — `asf
    status`, a watcher deciding whether a run is alive, a station's shipper —
    and `write_text` truncates first and writes after: a reader landing in
    between gets half a `run.json`, or an empty one. So the text goes to a
    sibling temp file and `os.replace` swaps it in, which POSIX makes atomic
    within one directory. A reader sees the old file or the new one.

    The temp name is hidden and ends in `.tmp`, so no `*.json` glob picks it up,
    and it is opened `"x"` rather than through `mkstemp`, so the file keeps the
    umask-derived mode an in-place write gave it. The promise is to concurrent
    readers, not to a power cut: nothing is fsynced. Append-only logs
    (`events.jsonl`, `processes.jsonl`) do not come through here — a one-line
    append is already the write that needs no coordination.
    """
    target = Path(path)
    temp = target.with_name(f".{target.name}.{secrets.token_hex(4)}{TEMP_SUFFIX}")
    try:
        with open(temp, "x") as stream:
            stream.write(text)
        os.replace(temp, target)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return target


def sweep_temps(directory: str | Path, older_than: float = STALE_TEMP_SECONDS) -> list[Path]:
    """Remove the temp files a killed `write_atomic` left behind. Never raises.

    The `except` above cleans up after anything Python sees; a SIGKILL or an
    OOM kill between the temp file and the `os.replace` is the one thing it
    cannot, and the hidden `.run.json.1a2b3c4d.tmp` then sits in the session
    directory for good. Only `write_atomic`'s own names are touched, and only
    once they are older than any write takes: a temp that young may belong to a
    writer that is still alive, in this process or another.
    """
    root = Path(directory)
    if not root.is_dir():
        return []
    cutoff = time.time() - older_than
    removed: list[Path] = []
    for path in root.rglob(f".*{TEMP_SUFFIX}"):
        if not _TEMP_NAME.match(path.name):
            continue
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed.append(path)
        except OSError:
            continue
    return removed


def clip_utf8(data: bytes, limit: int) -> tuple[str, bool]:
    """`data` as text of at most `limit` bytes, and whether anything was cut.

    Cut on a character, never inside one: a body that ends in half a character
    decodes to a replacement mark the file never held. Bytes that are not UTF-8
    at all read as that mark — what is sent is always text.
    """
    if len(data) <= limit:
        return data.decode("utf-8", errors="replace"), False
    cut = limit
    while cut and data[cut] & 0xC0 == 0x80:      # a continuation byte: step back to its lead
        cut -= 1
    return data[:cut].decode("utf-8", errors="replace"), True


def anchor(root: str | Path, path: str | Path) -> Path:
    """Resolve `path` against `root` unless it is already absolute.

    With a worktree per run there is no single "here" any more: the run's tree,
    the engineer's checkout and the session runtime under `data_dir` are three
    different directories, and a bare relative path means a different file in
    each. Everything that crosses between them goes through this, so the
    ambiguity is resolved once, at the point that knows which root it meant.
    """
    p = Path(path)
    return p if p.is_absolute() else (Path(root) / p)


def resolve_prompt(arg: str) -> str:
    """CLI prompt arg: a file path resolves to its contents, else inline text."""
    try:
        p = Path(arg)
        if p.is_file():
            return p.read_text()
    except OSError:
        pass
    return arg


def engineer_name() -> str:
    name = os.environ.get("ENGINEER_NAME", "").strip()
    if name:
        return name
    try:
        out = subprocess.run(["git", "config", "user.name"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except OSError:
        pass
    return os.environ.get("USER", "engineer")

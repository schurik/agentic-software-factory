"""`asf up --pull` — a long-lived station keeps its checkout at the remote's.

WHY THIS EXISTS. A session is cut from whatever the main checkout has checked
out (`worktree._base_ref_of`), with no fetch, and the factory that runs it —
its workflows, tasks and agents — is read from that same checkout. On a laptop
the engineer pulls. On a server nobody does: the checkout stays at the commit
it was cloned at, every run is cut from an older base than the last, a change
merged to `asf/` never reaches the station, and a cockpit reads it as drifted
for good. So a station that nobody sits at fast-forwards itself, between runs.

BETWEEN RUNS, because a run reads this checkout for its whole life: a task
file opened an hour in, or a module imported late, must be the version the
run started with. Every run holds a SHARED lock on `<data_dir>/checkout.lock`
for its process's life (`hold`, the first thing `session.ensure` does,
whoever launched it — a watcher, a cockpit command, a person). A pull takes
the EXCLUSIVE lock without waiting: held means a run is working, and the pull
is simply tried again at the next interval. A session waiting at a gate holds
nothing — it has no process — and is resumed on whatever the checkout then
says, exactly as it would be on a laptop that pulled in between.

ONLY EVER A FAST-FORWARD. A detached checkout, uncommitted or untracked
changes, a branch ahead of the remote or diverged from it: each is somebody's
work or somebody's decision, and the answer is to say so and leave it. The
remote's tip is read from FETCH_HEAD, never from `refs/remotes/…`, which a
narrowed clone does not have (invariant 12).

Opt-in, per process — a flag on `up`, not a key in `factory.yaml`: whether a
checkout may be moved under its owner's feet is a question about the machine,
not about the repository. When a pull changed the factory itself, the
processes running it hold the old code; `up` restarts itself (`supervise.py`).
"""

from __future__ import annotations

import fcntl
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Callable

from . import git_helper
from .data_types import FactoryConfig
from .utils import anchor, ensure_dir

LOCK_FILE = "checkout.lock"
HOLD_WAIT = 60.0          # the longest a run waits for a pull in progress; one takes seconds

# This process's shared holds, by lock path, open until the process ends. Python
# opens files non-inheritable (PEP 446), so an agent the run spawns never keeps
# the checkout held after the run itself is gone.
_held: dict[Path, IO[str]] = {}
# …and the exclusive one a station keeps after pulling a change to its factory.
_barred: list[IO[str]] = []


def lock_path(main_root: Path, data_dir: str) -> Path:
    return anchor(main_root, data_dir) / LOCK_FILE


def _open(path: Path) -> IO[str]:
    ensure_dir(path.parent)
    return path.open("a")


# ── a run: hold the checkout ─────────────────────────────────────────────────

def hold(main_root: Path, data_dir: str) -> bool:
    """Hold this checkout shared for the rest of this process. Never raises.

    Waits while a pull holds it — seconds — and gives up after `HOLD_WAIT`
    rather than never starting: a run that starts unheld risks reading a
    checkout mid-pull, which is what it would risk on any laptop. A data_dir
    that cannot be written is not this function's to report; `preflight`
    refuses the run a moment later and says why.
    """
    path = lock_path(main_root, data_dir)
    if path in _held:
        return True
    try:
        stream = _open(path)
    except OSError:
        return False
    deadline = time.monotonic() + HOLD_WAIT
    while True:
        try:
            fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                stream.close()
                return False
            time.sleep(0.2)
            continue
        except OSError:
            stream.close()
            return False
        _held[path] = stream
        return True


def _take(main_root: Path, data_dir: str) -> IO[str] | None:
    """The checkout to this process alone, if no run holds it right now: the
    open, exclusively locked stream — closing it lets go — or None."""
    try:
        stream = _open(lock_path(main_root, data_dir))
    except OSError:
        return None
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stream.close()
        return None
    return stream


# ── a station: fast-forward ──────────────────────────────────────────────────

@dataclass(frozen=True)
class Pulled:
    """What one pass found. `outcome` is the kind, `detail` the line to say;
    `factory_changed` is whether the commits it brought touched the factory
    the processes on this station are running."""
    outcome: str        # pulled | current | busy | dirty | ahead | diverged | detached
                        # | no_remote | unreachable | refused
    detail: str
    factory_changed: bool = False


def once(cfg: FactoryConfig, main_root: Path, factory_root: Path) -> Pulled:
    """One pass: fast-forward the checked-out branch to the remote's, if that is
    all it takes and no run is working from the checkout. `factory_root` is
    the factory's directory (`asf/`), which says what a restart is needed for.
    Never raises on anything git says."""
    try:
        branch = git_helper.current_branch(main_root)
    except RuntimeError as error:
        return Pulled("refused", f"cannot read the checkout's branch: {error}")
    if branch == "HEAD":
        return Pulled("detached", "the checkout is detached — check out the branch sessions "
                                  "are cut from, and it is kept current")
    remote = cfg.worktree.integration.remote
    if not git_helper.has_remote(main_root, remote):
        return Pulled("no_remote", f"no remote {remote!r} to pull {branch} from "
                                   f"(worktree.integration.remote)")
    taken = _take(main_root, cfg.data_dir)
    if taken is None:
        return Pulled("busy", "a run is working from this checkout — after it ends")
    pulled = Pulled("refused", "git stopped before the pass finished")
    try:
        pulled = _fast_forward(main_root, branch, remote, factory_root)
    except RuntimeError as error:
        pulled = Pulled("refused", str(error))
    finally:
        if pulled.factory_changed:
            # The processes running the old factory are about to be stopped. A
            # run a watcher launches meanwhile waits in `hold` and goes with
            # them, before it has a record — rather than starting on a station
            # that is restarting under it. Let go when this process execs.
            _barred.append(taken)
        else:
            taken.close()
    return pulled


def _fast_forward(main_root: Path, branch: str, remote: str, factory_root: Path) -> Pulled:
    if git_helper.is_dirty(main_root):
        return Pulled("dirty", "the checkout has uncommitted or untracked changes — "
                               "left as they are, and not pulled until they are gone")
    if not git_helper.fetch(main_root, remote, branch):
        return Pulled("unreachable", f"could not fetch {remote}/{branch} — tried again "
                                     f"at the next pass")
    here = git_helper.rev(main_root, "HEAD")
    there = git_helper.rev(main_root, "FETCH_HEAD")
    if here == there:
        return Pulled("current", f"{branch} is at {remote}/{branch}")
    if git_helper.is_ancestor(main_root, there, here):
        return Pulled("ahead", f"{branch} has commits {remote}/{branch} does not — "
                               f"left as it is")
    if not git_helper.is_ancestor(main_root, here, there):
        return Pulled("diverged", f"{branch} and {remote}/{branch} have diverged — "
                                  f"left as it is: reconcile them by hand")
    try:
        git_helper.merge(main_root, there, ["--ff-only", "--quiet"])
    except RuntimeError as error:
        return Pulled("refused", f"the fast-forward of {branch} was refused: {error}")
    count = git_helper.count_commits(main_root, here, there)
    touched = git_helper.diff_files(main_root, here)         # the tree is `there` now
    return Pulled("pulled", f"{branch} {here[:7]}..{there[:7]} ({count} commit"
                            f"{'' if count == 1 else 's'})",
                  factory_changed=_touches(main_root, factory_root, touched))


def _touches(main_root: Path, factory_root: Path, paths: list[str]) -> bool:
    """Whether any of `paths` (relative to the checkout) is under the factory."""
    try:
        factory = anchor(main_root, factory_root).resolve().relative_to(main_root.resolve())
    except ValueError:
        return True             # a factory outside the checkout: assume the worst
    if factory == Path("."):
        return bool(paths)
    return any(Path(path).is_relative_to(factory) for path in paths)


# ── the loop behind `up --pull` ──────────────────────────────────────────────

QUIET = ("current", "busy")     # the normal states: said by nobody


class Puller:
    """`step` every `interval` seconds on a thread, until stopped or until a
    pull changed the factory — which is said, handed to `on_factory_changed`,
    and is the last pass this process makes.

    It says a pull, and a state that needs a person (dirty, diverged, …) once
    when the station enters it rather than every interval it stays there;
    `current` and `busy` are the normal states and said by nobody.
    """

    def __init__(self, step: Callable[[], Pulled], interval: float,
                 say: Callable[[str], None], on_factory_changed: Callable[[], None],
                 last: str = ""):
        self._step = step
        self.interval = interval
        self.say = say
        self.on_factory_changed = on_factory_changed
        self.last = last
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "Puller":
        self._thread = threading.Thread(target=self._run, name="asf-pull", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stopping.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stopping.wait(self.interval):
            if self.step().factory_changed:
                return

    def step(self) -> Pulled:
        pulled = self._step()
        if pulled.outcome == "pulled":
            self.say(f"pulled {pulled.detail}" + (" — the factory changed: starting again on it"
                                                  if pulled.factory_changed else ""))
        elif pulled.outcome not in QUIET and pulled.outcome != self.last:
            self.say(f"not pulled: {pulled.detail}")
        self.last = pulled.outcome
        if pulled.factory_changed:
            self.on_factory_changed()
        return pulled

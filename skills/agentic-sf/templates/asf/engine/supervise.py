"""`asf up` — the station loop and its children in one foreground process; `asf status`.

The process behind `asf up` IS THE STATION LOOP (CONTEXT.md: a station is
online while its long-lived loop runs). It holds the checkout's station id
and ships every session on the station to a cockpit (`station.Loop`),
whichever process wrote it, and it supervises the children that make the
factory's long-running parts: `cockpit`, `issues`, `answers` and `prs`. Three
commands in three terminals go wrong every week — you forget one, and a
watcher that is not running looks exactly like a watcher with nothing to do —
so this is one process that owns every child, prefixes their output, restarts
what dies, and takes the whole tree down with it. NOT A DAEMON — the terminal
it runs in is the handle. `asf station` is the same loop without watchers.

The loop also POLLS FOR COMMANDS (`engine/commands.py`) as the station a
person registered — or, with a local cockpit, as its one person's station —
and reports the watchers it runs with every poll. That poll is what a cockpit
reads the station as online by.

`cockpit` is the LOCAL cockpit (`engine/cockpit.py`): the team deployment's
published images, started through the stamped compose file only when no
shared cockpit is configured (ASF_COCKPIT_URL unset), and the station ships to
it. Without Docker it is dropped with a WARNING and the watchers still run — a
service that silently did not start looks exactly like a service with nothing
to say, and the watchers are the part that must not be forgotten.

`status` answers the other half: is anything running right now, and did it
poll recently — from the watcher heartbeat FILES and a probe of each pid, so a
watcher killed with SIGKILL reads as gone rather than as its last row.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import artifacts, commands, git_helper, issues, station, worktree
from . import cockpit as local_cockpit
from .data_types import FactoryConfig, Station, StationCredential
from .station import Destination
from .utils import anchor

RUNNER = "asf/asf.py"
WATCHERS = ("issues", "answers", "prs")
SERVICES = ("cockpit", *WATCHERS)
COLORS = {"station": "\033[1m", "cockpit": "\033[36m",
          "issues": "\033[33m", "answers": "\033[34m", "prs": "\033[32m"}
DIM, WARN, RESET = "\033[2m", "\033[33m", "\033[0m"


def paint(color: str, text: str) -> str:
    return f"{color}{text}{RESET}" if sys.stdout.isatty() else text


@dataclass
class Service:
    name: str
    argv: list[str]
    cwd: Path
    env: dict[str, str] = field(default_factory=dict)
    grace: float = 8.0              # SIGTERM to SIGKILL
    # Asked before a restart: a reason not to (said, and the child is left
    # retired), or "". The local cockpit's, when another `up` put a newer one
    # in its place — restarting at this stamp's version would downgrade it.
    retire_if: Callable[[], str] | None = None
    # One more line for `up`'s summary of what it started, as (label, text):
    # the local cockpit's says whose forge token it was handed.
    summary: tuple[str, str] | None = None
    proc: subprocess.Popen | None = None
    restarts: int = 0
    started_at: float = 0.0
    give_up: bool = False
    retired: bool = False


def _spawn(service: Service, on_line) -> None:
    """Its OWN process group, so compose and the runner's children can be
    signalled whole — an orphan holding a port is what this exists to stop."""
    service.proc = subprocess.Popen(
        service.argv, cwd=str(service.cwd), env={**os.environ, **service.env},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        start_new_session=True)
    service.started_at = time.monotonic()
    threading.Thread(target=_pump, args=(service, on_line), daemon=True).start()


def _pump(service: Service, on_line) -> None:
    assert service.proc and service.proc.stdout
    for line in service.proc.stdout:
        on_line(service.name, line.rstrip("\n"))


def _stop(service: Service) -> None:
    """SIGTERM the group (the watchers turn it into a `stopped` beat, compose
    stops its containers), then SIGKILL."""
    proc = service.proc
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    deadline = time.monotonic() + service.grace
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _names(raw: str, flag: str) -> set[str]:
    chosen = {part.strip() for part in raw.split(",") if part.strip()}
    unknown = chosen - set(SERVICES)
    if unknown:
        raise SystemExit(f"{flag}: unknown service(s) {', '.join(sorted(unknown))} — "
                         f"pick from {', '.join(SERVICES)}")
    return chosen


@dataclass
class Children:
    """What `up` was asked to start. `only` replaces the default set;
    `watchers=False` is `asf station`, the loop alone; `interval` is the
    watchers' poll."""
    only: str = ""
    watchers: bool = True
    interval: int = 120


def wanted(cfg: FactoryConfig, children: Children) -> set[str]:
    """The children to start, before asking the machine whether it can."""
    only, watchers = children.only, children.watchers
    if only:
        want = _names(only, "--only")
    else:
        want = {"cockpit", *WATCHERS} if watchers else {"cockpit"}
        if watchers and not cfg.issues.enabled:
            # Both tracker pollers go: one launches runs from the item, the other
            # brings them back from it, and neither has anywhere to look without it.
            print(paint(DIM, "  ~ issues.enabled is false — not starting the issue or "
                             "answer watcher"))
            want -= {"issues", "answers"}
        if watchers and not cfg.pull_requests.enabled:
            print(paint(DIM, "  ~ pull_requests.enabled is false — not starting the review "
                             "watcher"))
            want.discard("prs")
    if "cockpit" in want and local_cockpit.shared():
        if only:
            print(paint(DIM, "  ~ ASF_COCKPIT_URL names a shared cockpit — not starting a "
                             "local one"))
        want.discard("cockpit")
    return want


def check(cfg: FactoryConfig, want: set[str]) -> str | None:
    """What would stop THESE services: each finding drops its service from
    `want` and says so, and everything else still starts.

    Returns what becomes of the local cockpit: "start" (this process runs
    it), "join" (a newer one already runs on this machine, and this
    process ships to it without owning it — so an older stamp never
    downgrades it), or None (no local cockpit)."""
    local = None
    if "cockpit" in want:
        problem = local_cockpit.docker_problem()
        already = "" if problem else local_cockpit.running()
        if problem:
            print(paint(WARN, f"  ! no local cockpit: {problem} — the watchers run without "
                              f"it, and nothing is shipped. `asf doctor` says more; "
                              f"ASF_COCKPIT_URL names a shared cockpit instead"))
            want.discard("cockpit")
        elif already and local_cockpit.newer(already):
            print(paint(DIM, f"  ~ the local cockpit {already} already runs on this machine — "
                             f"shipping to it; the `asf up` that started it owns it"))
            want.discard("cockpit")
            local = "join"
        else:
            local = "start"
    forge = (cfg.issues.list_command or ["gh"])[0]
    if want & set(WATCHERS) and not shutil.which(forge):
        print(paint(WARN, f"  ! {forge!r} is not on PATH — the watchers can start, but every "
                          f"poll will fail to list anything"))
    return local


def services(want: set[str], config_path: str, interval: int,
             main_root: Path) -> list[Service]:
    found: list[Service] = []
    if "cockpit" in want:
        # compose stops its containers on SIGTERM, and a Convex backend takes
        # its own stop_grace_period to go — more than a watcher's 8s.
        # …and it asks the forge as whoever started it: their `gh auth token`
        # goes to the app container in the child's environment, not its argv.
        forge = local_cockpit.forge_credential()
        found.append(Service("cockpit", local_cockpit.up_argv(), main_root,
                             {**local_cockpit.compose_env(), **forge.env()},
                             grace=30.0, retire_if=_superseded, summary=("forge", forge.line)))
    for name in WATCHERS:
        if name in want:
            found.append(Service(name, [sys.executable, RUNNER, "--config", config_path, name,
                                        "loop", "--interval", str(interval)],
                                 main_root, {"PYTHONUNBUFFERED": "1"}))
    return found


def _superseded() -> str:
    already = local_cockpit.running()
    if already and local_cockpit.newer(already):
        return (f"another `asf up` runs the local cockpit {already} now — shipping to it "
                f"rather than restarting this one at {local_cockpit.version()}")
    return ""


@dataclass
class Target:
    """Where the station loop ships, and the command token it polls there with."""
    destination: Destination
    credential: Callable[[], StationCredential | None]
    local: bool


def destination(cfg: FactoryConfig, main_root: Path, local: str | None) -> Target | None:
    """The shared cockpit, the local one this process starts or joined, or None."""
    shared = station.configured(anchor(main_root, cfg.defaults.data_dir))
    if shared is not None:
        return Target(Destination(lambda: shared, label=f"shared: {shared.url}"),
                      lambda: station.credential(main_root, cfg.defaults.data_dir), local=False)
    if local_cockpit.shared() or local is None:
        return None
    repository = issues.resolve_project(cfg.issues, main_root) or main_root.name
    cockpit = local_cockpit.Local(anchor(main_root, cfg.defaults.data_dir), repository,
                                  here=station.identify(main_root, cfg.defaults.data_dir))
    started = ("joined, started by another `asf up`" if local == "join" else
               f"{local_cockpit.version()}; the first start pulls its images")
    return Target(Destination(cockpit.get, cockpit.refused,
                              f"{local_cockpit.app_url()}   (local, {started})"),
                  cockpit.credential, local=True)


def _commands_line(cfg: FactoryConfig, main_root: Path, here: Station,
                   target: Target | None) -> str:
    """What `up` says about commands: which it would obey, and as whose station."""
    if target is None:
        return "none — no cockpit to take them from"
    if here.kind == "ci":
        return "none — a CI station takes no commands"
    verbs = commands.obeyed(cfg)
    obeys = ", ".join(verbs) if verbs else "none opted in (cockpit.commands in asf/factory.yaml)"
    if target.local:
        return f"{obeys} — the local cockpit's own station"
    held = station.credential(main_root, cfg.defaults.data_dir)
    if held is None or held.cockpit != station.configured().url:
        return f"{obeys} — not registered with this cockpit: `asf station register`"
    return f"{obeys} — registered to {held.owner or 'its owner'}"


def up(cfg: FactoryConfig, config_path: str, children: Children) -> int:
    main_root = git_helper.main_root()
    here = station.identify(main_root, cfg.defaults.data_dir)
    interval = children.interval
    print(f"asf {'up' if children.watchers else 'station'} — {main_root}")
    want = wanted(cfg, children)
    target = destination(cfg, main_root, check(cfg, want))
    ships_to = target.destination if target else None
    if not want and ships_to is None:
        print("  ! nothing to start and no cockpit to ship to — see the messages above",
              file=sys.stderr)
        return 2

    width = max(len(name) for name in COLORS)
    lock = threading.Lock()

    def on_line(name: str, line: str) -> None:
        with lock:
            print(f"{paint(COLORS.get(name, ''), name.rjust(width))} {paint(DIM, '│')} {line}",
                  flush=True)

    loop = None
    started: list[Service] = []
    if target is not None:
        sessions = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
        steering = None
        if here.kind != "ci":
            steering = commands.Steering(commands.Here(cfg, main_root, config_path),
                                         target.credential, watchers=lambda: _watching(started))
            steering.say = lambda text: on_line("station", text)
        loop = station.Loop(lambda: station.every_session(sessions), target.destination,
                            steering=steering)
        loop.say = lambda text: on_line("station", text)
        loop.start()
    started.extend(services(want, config_path, interval, main_root))
    for service in started:
        _spawn(service, on_line)
    print()
    print(f"  station    {here.name} ({here.kind}, {here.id})")
    print(f"  cockpit    {ships_to.label if ships_to else 'none — nothing is shipped'}")
    print(f"  commands   {_commands_line(cfg, main_root, here, target)}")
    for service in started:
        if service.summary:
            print(f"  {service.summary[0]:<9}  {service.summary[1]}")
    for name in WATCHERS:
        if name in want:
            print(f"  {name:<9}  polling every {interval}s")
    print(f"\n{paint(DIM, '  ctrl-c stops all of it')}\n")

    stopping = threading.Event()

    def shutdown(signum, _frame) -> None:
        if not stopping.is_set():
            stopping.set()
            print(f"\n{paint(DIM, 'stopping…')}", flush=True)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        collapsed = _supervise(started, stopping, on_line)
    finally:
        if loop is not None:
            loop.stop()          # its last round, while the cockpit is still up
        for service in started:
            _stop(service)
        print(paint(DIM, "stopped"))
    return 1 if collapsed else 0


def _watching(started: list[Service]) -> list[str]:
    """The watchers alive right now: what the station's report says it runs."""
    return sorted(service.name for service in started if service.name in WATCHERS
                  and service.proc is not None and service.proc.poll() is None)


def _supervise(started: list[Service], stopping: threading.Event, on_line) -> bool:
    """Restart what dies; a crash loop (three restarts inside a minute) is
    given up on and said, and the rest keeps running. True when nothing is
    left — never with no children at all, which is `asf station` shipping to a
    shared cockpit (the loop is the whole job), nor with a child retired in
    favour of a cockpit the loop now ships to."""
    while not stopping.is_set():
        time.sleep(0.4)
        alive = False
        for service in started:
            if service.give_up or service.retired:
                continue
            if service.proc and service.proc.poll() is None:
                alive = True
                continue
            code = service.proc.returncode if service.proc else -1
            why = service.retire_if() if service.retire_if else ""
            if why:
                on_line(service.name, why)
                service.retired = True
                continue
            service.restarts = service.restarts + 1 if time.monotonic() - service.started_at < 60 else 0
            if service.restarts > 3:
                on_line(service.name, f"exited ({code}) and keeps exiting — giving up on it; "
                                      f"the rest keeps running")
                service.give_up = True
                continue
            on_line(service.name, f"exited ({code}) — restarting")
            time.sleep(min(2 ** service.restarts, 15))
            if stopping.is_set():
                return False
            _spawn(service, on_line)
            alive = True
        if started and not alive and not any(service.retired for service in started):
            on_line("up", "every service has given up — nothing left to supervise")
            return True
    return False


# ── status ───────────────────────────────────────────────────────────────────

def _age(iso: str | None) -> str:
    if not iso:
        return "never"
    try:
        then = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    seconds = int((datetime.now(timezone.utc) - then).total_seconds())
    if seconds < 60:
        return f"{seconds}s ago"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    return f"{seconds // 3600}h ago"


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def status(cfg: FactoryConfig) -> int:
    """One screen: what is watching, what is running, what is left behind —
    all from files."""
    main_root = git_helper.main_root()
    sessions = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
    rows = artifacts.watcher_states(artifacts.watchers_dir(main_root, cfg.defaults.data_dir))
    print(f"repo:      {main_root}")
    print(f"sessions:  {sessions}{'' if sessions.is_dir() else '  (no runs yet)'}")
    ships_to = local_cockpit.shared()
    if ships_to:
        token = station.shipped_with(anchor(main_root, cfg.defaults.data_dir))
        ships_to += (f" — ships with {token}" if token
                     else " — no ingest token, nothing ships: `asf station register`")
        held = station.credential(main_root, cfg.defaults.data_dir)
        if held is not None and held.cockpit == station.configured().url:
            ships_to += f"; takes commands for {held.owner or 'its owner'}"
    else:
        ships_to = f"local — `asf up` starts it at {local_cockpit.app_url()}"
    print(f"cockpit:   {ships_to}\n")
    print("watchers")
    for kind, enabled in (("issues", cfg.issues.enabled), ("prs", cfg.pull_requests.enabled)):
        row = rows.get(kind)
        if not row:
            state = "never started here" if enabled else "off (enabled: false)"
            print(f"  {kind:<7} {state}" + ("        — `asf up`" if enabled else ""))
            continue
        if not _pid_alive(int(row.get("pid") or 0)):
            age = _age(row.get("last_poll_at"))
            print(f"  {kind:<7} stopped {age}" if row.get("status") == "stopped"
                  else f"  {kind:<7} not running (last {row.get('status')}, {age})")
            continue
        note = row.get("note") or ""
        print(f"  {kind:<7} {row.get('status'):<8} pid {row.get('pid')}  "
              f"last poll {_age(row.get('last_poll_at'))}{'  · ' + note if note else ''}")
    live = {adw_id: pid for adw_id, pid in artifacts.running_pids(sessions).items()
            if _pid_alive(pid)}
    print(f"\nruns in flight: {len(live)}")
    for adw_id, pid in sorted(live.items()):
        print(f"  {adw_id}  pid {pid}")
    waiting = artifacts.waiting_sessions(sessions)
    print(f"waiting for a human: {len(waiting)}" + ("   (`asf pending`)" if waiting else ""))
    for adw_id, what in sorted(waiting.items()):
        print(f"  {adw_id}  gate {what.gate} round {what.round}  since {_age(what.since)}")
    try:
        trees = worktree.inventory(main_root, cfg.worktree, str(sessions))
        if trees:
            print(f"\nworktrees: {len(trees)}   (`asf worktrees list` for detail)")
    except Exception:                                   # noqa: BLE001 — a footnote
        pass
    return 0

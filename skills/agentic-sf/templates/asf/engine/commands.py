"""Commands: what a cockpit asks a station to do, and how the station decides.

A COMMAND (`CONTEXT.md`) is the steering a forge cannot carry — kill, resume,
answering a terminal-channel gate, a prompt run — from a closed vocabulary,
with typed fields only. The cockpit only ever QUEUES one. The station obeys on
its own terms, here, and the cockpit learns what happened from the
`command_result` event the station writes into the session, never from having
sent it:

  * the verb is in `cockpit.commands` in `asf/factory.yaml` — each verb is
    opted in by the repository, in a reviewed file, and nothing else is obeyed;
  * this release of the factory carries it out (`CARRIED_OUT`);
  * it has not expired — a kill queued last week is not carried out by a
    laptop that just woke up;
  * whoever asked (`by`, a forge login) passes `issues.trusted_authors`, the
    same list a reply on an issue is held to; empty accepts everyone the
    cockpit let ask, which is a writer on the repository;
  * and it names a session this station holds.

Then it goes through the same `operate.*` function the CLI uses — never a shell
line — and the outcome is written to `<data_dir>/commands/<id>.json` before
anything is said about it: a second delivery of the same id finds the file and
does nothing, so a cockpit that never heard the answer can safely ask again.

WHO POLLS. A live run's own shipper polls for its own session, so a kill
reaches the run with no daemon running and the run stops itself, gracefully,
through its own SIGTERM handler. The station loop (`asf up`, `asf station`)
polls for everything else. Each poll carries the station's REPORT — the verbs
it would obey, the commit it has out, a hash of its config, the watchers it
runs — so the cockpit greys out what it would refuse, and each poll is how the
cockpit knows the session is attended or the station online.

REGISTERING. Commands need a person behind them, so a station takes none until
one approves it: `asf station register` asks the cockpit for a code, prints
where to approve it, and waits; the cockpit hands back a command token that is
that person's, for this station alone (`station-token.json`). A CI station
never registers: it holds the ingest token and nothing else. A local cockpit
(`asf up` without ASF_COCKPIT_URL) is its one person's, and issues the token
by itself (`engine/cockpit.py`).
"""

from __future__ import annotations

import dataclasses
import hashlib
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, get_args

from . import artifacts, events, git_helper, hitl, operate, station
from .data_types import (Cockpit, Command, CommandRecord, CommandResult, CommandVerb,
                         FactoryConfig, Reply, StationCredential, StationReport)
from .factory import DEFAULT_CONFIG
from .utils import anchor, ensure_dir, new_id, now_iso, write_atomic

VOCABULARY = get_args(CommandVerb)
# What this release of the factory can carry out. A verb opted in that is not
# here is refused, and left out of the report so the cockpit never offers it.
CARRIED_OUT = VOCABULARY
# What an `answer` may say; `abort` is a verb of its own, opted in on its own.
ANSWER_VERDICTS = ("approve", "reject", "answer")
COMMANDS_DIR = "commands"
POLL_INTERVAL = 2.5             # seconds between command polls, per poller
REPORT_EVERY = 30.0             # how long the commit and config hash are trusted
DETAIL_CHARS = 500

_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


# ── registering: `asf station register` ──────────────────────────────────────

def register(cfg: FactoryConfig, transport: station.Transport = station.post,
             wait: Callable[[float], None] = time.sleep,
             say: Callable[[str], None] = print) -> int:
    """Ask the configured cockpit for a code, say where to approve it, and wait.

    The device flow: no secret is copy-pasted, and no forge credential reaches
    the cockpit from here. The request is made with the factory's ingest token,
    which tells the cockpit which factory the station belongs to; the person
    who approves becomes the station's owner, and the token that comes back is
    theirs for this station.
    """
    main_root = git_helper.main_root()
    here = station.identify(main_root, cfg.defaults.data_dir)
    if here.kind == "ci":
        say(f"station {here.name} is a CI station: it ships with the ingest token and takes "
            f"no commands, so there is nothing to register")
        return 1
    cockpit = station.configured()
    if cockpit is None:
        say("no shared cockpit configured — set ASF_COCKPIT_URL and ASF_COCKPIT_TOKEN to "
            "register with one. A local cockpit (`asf up` without them) needs no "
            "registering: it is yours, and owns this station by itself")
        return 1
    say(f"station {here.name} ({here.kind}, {here.id}) -> {cockpit.url}")
    asked = _ask(transport, cockpit, {"station": here.model_dump(mode="json")}, say)
    if asked is None:
        return 1
    device, code = str(asked.get("device", "")), str(asked.get("code", ""))
    if not device or not code:
        say("  the cockpit answered without a code — is ASF_COCKPIT_URL its site origin?")
        return 1
    interval = max(1.0, float(asked.get("interval") or 2))
    expires_in = max(interval, float(asked.get("expires_in") or 600))
    where = str(asked.get("url") or "")
    say("  approve this station in the cockpit, signed in as the person it will act for:")
    say(f"    {where or 'the cockpit, under Stations'}")
    say(f"  code {code} — waiting {max(1, int(expires_in // 60))} min for it")
    for _attempt in range(int(expires_in // interval)):
        wait(interval)
        try:
            status, answer = transport(f"{cockpit.url}/station/register/poll", cockpit.token,
                                       {"device": device})
        except (OSError, ValueError):
            continue                   # a cockpit restarting: the code still stands
        state = answer.get("status")
        if status == 200 and state == "approved" and answer.get("token"):
            held = StationCredential(cockpit=cockpit.url, station=here.id,
                                     token=str(answer["token"]), owner=str(answer.get("owner", "")),
                                     issued_at=now_iso())
            path = station.keep(main_root, cfg.defaults.data_dir, held)
            say(f"  approved by {held.owner or 'someone'} — the token is kept in {path}")
            say(f"  this station now takes commands from {cockpit.url}: "
                f"{_verbs_line(cfg)}")
            return 0
        if status == 200 and state == "pending":
            continue
        say(f"  {answer.get('error') or state or f'HTTP {status}'} — run "
            f"`asf station register` again for a fresh code")
        return 1
    say("  the code expired before anyone approved it — run `asf station register` again")
    return 1


def _ask(transport: station.Transport, cockpit: Cockpit, body: dict,
         say: Callable[[str], None]) -> dict | None:
    """The first request of a registration: its answer, or None having said why not."""
    try:
        status, answer = transport(f"{cockpit.url}/station/register", cockpit.token, body)
    except (OSError, ValueError) as error:
        say(f"  could not reach the cockpit: {error}")
        return None
    if status == 401:
        say("  the cockpit refused ASF_COCKPIT_TOKEN — registering needs the factory's ingest "
            "token, so the cockpit knows which factory this station is")
        return None
    if status != 200:
        say(f"  the cockpit refused: HTTP {status}: {answer.get('error') or 'no reason given'}")
        return None
    return answer


def _verbs_line(cfg: FactoryConfig) -> str:
    verbs = obeyed(cfg)
    if verbs:
        return f"{', '.join(verbs)} (cockpit.commands in asf/factory.yaml)"
    return "none yet — asf/factory.yaml's cockpit.commands opts verbs in"


# ── the report every poll carries ────────────────────────────────────────────

def obeyed(cfg: FactoryConfig) -> list[str]:
    """The verbs this station would carry out: opted in, and known to this release."""
    return [verb for verb in cfg.cockpit.commands if verb in CARRIED_OUT]


def config_hash(main_root: Path, data_dir: str) -> str:
    """sha256 over every file under `asf/` that git would see — tracked, or
    untracked and not ignored — so a local edit shows as drift from the
    default branch. Runtime under `data_dir` is gitignored, and so outside."""
    try:
        listed = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z", "--", "asf"],
                                cwd=main_root, capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return ""
    if listed.returncode != 0:
        return ""
    digest = hashlib.sha256()
    for name in sorted(set(filter(None, listed.stdout.decode(errors="replace").split("\0")))):
        try:
            content = (main_root / name).read_bytes()
        except OSError:
            continue                   # listed, then deleted: not part of the config now
        digest.update(name.encode() + b"\0" + content + b"\0")
    return digest.hexdigest()


def _head(main_root: Path) -> str:
    try:
        return git_helper.rev(main_root)
    except Exception:              # noqa: BLE001 — a report is evidence, never a reason to stop
        return ""


# ── carrying one out ─────────────────────────────────────────────────────────

# `(argv, env, cwd, log) -> pid`: how a station starts a run it will not wait
# for. The default is `detached`; a test hands in one that records instead.
Launcher = Callable[[list[str], dict[str, str], Path, Path], int]


def detached(argv: list[str], env: dict[str, str], cwd: Path, log: Path) -> int:
    """Start `argv` apart from this process — its own session, its output to
    `log` — and return its pid without waiting for it.

    A resume or a run takes minutes, and the loop that took the command has
    shipping and polling to get on with; a run it started also outlives an
    `asf up` that is stopped, as one typed at a terminal outlives that
    terminal. It is reaped by a daemon thread all the same: an exited child
    nobody waited for is a zombie, which answers `kill -0` as if it were alive,
    and a run that looks alive is one `asf resume` refuses to touch.
    """
    ensure_dir(log.parent)
    with open(log, "ab") as out:
        child = subprocess.Popen(argv, cwd=cwd, env={**os.environ, **env},
                                 stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True)
    threading.Thread(target=child.wait, name=f"reap-{child.pid}", daemon=True).start()
    return child.pid


@dataclass
class Here:
    """The station a command is carried out on, as one value.

    `config_path` is what a launched `asf resume`/`asf run` is pointed at.
    `owner` is the forge login of the person the station is registered to —
    its command token's — and the only person a `run` is taken from: a
    teammate never starts an agent with write tools on someone else's machine
    or budget. "" when the station cannot say, and then no run is taken.
    """

    cfg: FactoryConfig
    main_root: Path
    config_path: str = DEFAULT_CONFIG
    owner: str = ""
    launch: Launcher = detached


def record_path(main_root: Path, data_dir: str, command_id: str) -> Path:
    return anchor(main_root, data_dir) / COMMANDS_DIR / f"{command_id}.json"


def recorded(main_root: Path, data_dir: str, command_id: str) -> CommandRecord | None:
    try:
        return CommandRecord.model_validate_json(
            record_path(main_root, data_dir, command_id).read_text())
    except (OSError, ValueError):
        return None


def carry_out(here: Here, command: Command, now_ms: int | None = None) -> CommandRecord | None:
    """Decide on one delivered command, act on it, and record what happened.

    The record — `commands/<id>.json`, and a `command_result` in the session
    it names — is written before this returns, or, when the command stops the
    very process carrying it out, before that process signals itself. One that
    starts a process is kept on file BEFORE the process is started, so a
    second delivery finds it and starts nothing. A command already recorded is
    not acted on again: its record is returned. None for an id no file can be
    named after, which is nothing a cockpit issues.
    """
    if not _ID.fullmatch(command.id):
        return None
    done = recorded(here.main_root, here.cfg.defaults.data_dir, command.id)
    if done is not None:
        return done
    refused = refusal(here, command, now_ms)
    if refused:
        return _record(here, _outcome(command, ok=False, detail=refused))
    return _ACTS[command.verb](here, command)


def refusal(here: Here, command: Command, now_ms: int | None = None) -> str:
    """Why this station will not carry `command` out, or "" when it will."""
    cfg, verb = here.cfg, command.verb
    if verb not in VOCABULARY:
        return f"{verb!r} is not a command: the vocabulary is {', '.join(VOCABULARY)}"
    if verb not in cfg.cockpit.commands:
        opted = ", ".join(cfg.cockpit.commands) or "nothing"
        return (f"{verb} is not opted in on this station: asf/factory.yaml's cockpit.commands "
                f"lists {opted}")
    if verb not in CARRIED_OUT:
        return f"this station's factory release does not carry out {verb}"
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if command.expires_at and now > command.expires_at:
        return f"expired at {_iso(command.expires_at)}, before this station saw it"
    if not command.by:
        return "the command does not say who asked, and a station acts for somebody or not at all"
    trusted = cfg.issues.trusted_authors
    if trusted and command.by.casefold() not in {login.casefold() for login in trusted}:
        return (f"{command.by} is not in issues.trusted_authors, which this station holds "
                f"every command's author to")
    if verb == "run":
        return _run_refusal(here, command)
    if not carried(here, command):
        return f"no session {command.session or '(none named)'} on this station"
    if verb == "resume":
        return operate.unresumable(cfg, command.session)
    if verb in ("answer", "abort"):
        return _answer_refusal(here, command)
    return ""


def _answer_refusal(here: Here, command: Command) -> str:
    """An answer is held to what a reply on a work item is held to: it names the
    wait it was written about, and a wait the run has moved past — another
    gate, another round, a subject that changed, a round already decided —
    is not the one it answers."""
    adw_id = command.session
    if command.verb == "answer" and command.verdict not in ANSWER_VERDICTS:
        return (f"an answer names its verdict — {', '.join(ANSWER_VERDICTS)} — and this one "
                f"named {command.verdict or 'none'}")
    session_dir = _session_dir(here, adw_id)
    state = artifacts.read_run(session_dir)
    waiting = state.waiting_for if state is not None else None
    if waiting is None:
        return f"{adw_id} is not waiting at a gate"
    if waiting.channel == "issue" and waiting.issue_number:
        return (f"{adw_id} waits on issue #{waiting.issue_number}: it is answered there, on the "
                f"forge's record, never by a command")
    if waiting.channel != "terminal":
        return (f"{adw_id} waits on the {waiting.channel} channel: a command answers only a gate "
                f"on no work item, a prompt run's")
    if (waiting.gate, waiting.round) != (command.gate, command.round):
        return (f"{adw_id} is no longer waiting at {command.gate} round {command.round}: it "
                f"waits at {waiting.gate} round {waiting.round}")
    if waiting.subject_digest != command.digest:
        return (f"the {waiting.gate} changed since it was shown: the answer was about a "
                f"subject the run no longer has in front of it")
    if hitl.read_decision(session_dir, waiting.gate, waiting.round) is not None:
        return (f"a decision is already recorded for {waiting.gate} round {waiting.round}, and "
                f"the run acts on that one")
    return ""


def _run_refusal(here: Here, command: Command) -> str:
    """A run goes to its own person's station only, and starts a workflow that
    takes a prompt — the only kind a cockpit can start without a work item."""
    from . import workflow       # here, not above: workflow → session → this module

    if not here.owner:
        return ("this station cannot say whose it is, and a run is taken only from the person "
                "it is registered to: `asf station register` again")
    if command.by.casefold() != here.owner.casefold():
        return (f"{command.by} asked to run on {here.owner}'s station, and a run is taken only "
                f"from the person a station is registered to")
    if not command.prompt.strip():
        return "the run names no prompt"
    names = [name for name, _ in workflow.available(here.config_path)]
    if command.workflow not in names:
        return (f"no workflow {command.workflow!r} on this station: `asf list` names "
                f"{', '.join(names) or 'none'}")
    try:
        loaded = workflow.load(command.workflow, here.config_path)
    except SystemExit as error:
        return f"{command.workflow} does not load on this station: {error}"
    if loaded.input != "prompt":
        return (f"{command.workflow} takes input: {loaded.input}, and a run from the cockpit "
                f"starts a workflow that takes a prompt")
    return ""


# ── the verbs ────────────────────────────────────────────────────────────────

def _kill(here: Here, command: Command) -> CommandRecord:
    said: list[str] = []
    ending: list[CommandRecord] = []

    def before_own_end() -> None:
        ending.append(_record(here, _outcome(command, ok=True, detail=_detail(said))))

    code = operate.kill(here.cfg, command.session, say=said.append,
                        before_own_end=before_own_end)
    if ending:
        return ending[0]
    return _record(here, _outcome(command, ok=code == 0, detail=_detail(said)))


def _resume(here: Here, command: Command) -> CommandRecord:
    """`asf resume`, which replays what the session recorded and lands its label."""
    return _launched(here, command, Launch(
        ["resume", command.session],
        f"relaunched {command.session} on this station: it picks up from what it recorded"))


def _answer(here: Here, command: Command) -> CommandRecord:
    """The decision a person gave in the cockpit, recorded as theirs — then the
    run is brought back to act on it, as `asf approve` would. A run asking in
    place at its own terminal is polling for the same file and needs nothing."""
    verdict = "abort" if command.verb == "abort" else command.verdict
    session_dir = _session_dir(here, command.session)
    try:
        hitl.answer(session_dir, Reply(verdict=verdict, notes=command.notes, by=command.by,
                                       channel="cockpit"))
    except RuntimeError as error:
        return _record(here, _outcome(command, ok=False, detail=str(error)))
    state = artifacts.read_run(session_dir)
    if state is not None and operate.still_running(state):
        return _record(here, _outcome(command, ok=True, detail=(
            f"{verdict} recorded for {command.gate} round {command.round}: the run is asking "
            f"in place and takes it at once")))
    return _launched(here, command, Launch(
        ["resume", command.session], f"{verdict} recorded for {command.gate} round "
        f"{command.round}, and {command.session} relaunched to act on it"))


def _run(here: Here, command: Command) -> CommandRecord:
    """`asf run <workflow> <prompt>` for the station's own person, recorded as
    triggered by them, and unattended — its gates wait for the cockpit's inbox.

    The prompt goes in a file beside the record rather than on the command
    line, where a prompt that happens to name a file in the repository would
    be read as that file (`utils.resolve_prompt`)."""
    from .session import TRIGGERED_BY_ENV       # here, not above: session imports this module

    adw_id = new_id(8)
    prompt = _beside(here, command.id, ".prompt.md")
    ensure_dir(prompt.parent)
    write_atomic(prompt, command.prompt)
    return _launched(here, command, Launch(
        ["run", command.workflow, str(prompt), "--adw-id", adw_id],
        f"started session {adw_id} ({command.workflow}) on this station",
        env={TRIGGERED_BY_ENV: command.by}, started=adw_id))


@dataclass
class Launch:
    """One `asf <args>` a command starts, and what its record says it did:
    `detail`, and for a run, the session it `started`."""

    args: list[str]
    detail: str
    env: dict[str, str] = dataclasses.field(default_factory=dict)
    started: str = ""


def _launched(here: Here, command: Command, launch: Launch) -> CommandRecord:
    """Keep the record, start `asf <args>` detached, then say so in the session.

    Kept first, so a second delivery finds the record and starts nothing,
    even when this process dies between the two; a launch that fails replaces
    the record before anything has been said about it.
    """
    record = _outcome(command, ok=True, detail=launch.detail, started=launch.started)
    _keep(here, record)
    argv = [sys.executable, operate.RUNNER, "--config", here.config_path, *launch.args]
    try:
        here.launch(argv, {hitl.UNATTENDED_ENV: "1", **launch.env}, here.main_root,
                    _beside(here, command.id, ".log"))
    except OSError as error:
        record = _outcome(command, ok=False,
                          detail=f"could not launch `asf {launch.args[0]}`: {error}")
        _keep(here, record)
    _tell(here, record)
    return record


def _beside(here: Here, command_id: str, suffix: str) -> Path:
    """A file kept next to a command's record: its prompt, its launch's output."""
    return record_path(here.main_root, here.cfg.defaults.data_dir, command_id).with_suffix(suffix)


_ACTS: dict[str, Callable[[Here, Command], CommandRecord]] = {
    "kill": _kill, "resume": _resume, "answer": _answer, "abort": _answer, "run": _run}


# ── the record ───────────────────────────────────────────────────────────────

def _outcome(command: Command, ok: bool, detail: str, started: str = "") -> CommandRecord:
    return CommandRecord(command=command, ok=ok, detail=detail[:DETAIL_CHARS], at=now_iso(),
                         started=started)


def _record(here: Here, record: CommandRecord) -> CommandRecord:
    _keep(here, record)
    _tell(here, record)
    return record


def _keep(here: Here, record: CommandRecord) -> None:
    """Write the outcome where a second delivery of the same id finds it."""
    path = record_path(here.main_root, here.cfg.defaults.data_dir, record.command.id)
    ensure_dir(path.parent)
    write_atomic(path, record.model_dump_json(indent=2))


def _tell(here: Here, record: CommandRecord) -> None:
    """Tell the session the command names, which ships it to the cockpit. A
    command naming no session here — a run, or one refused for naming a
    session this station does not hold — has its result carried by the next
    poll instead (`Steering`)."""
    if carried(here, record.command):
        events.emit(_session_dir(here, record.command.session), _result(record))


def carried(here: Here, command: Command) -> bool:
    """Whether `command`'s result travels in a session of this station's."""
    return bool(command.session) and (_session_dir(here, command.session)
                                      / artifacts.RUN_FILE).is_file()


def _result(record: CommandRecord) -> CommandResult:
    command = record.command
    return CommandResult(command_id=command.id, verb=command.verb,
                         adw_id=record.started or command.session, by=command.by,
                         ok=record.ok, detail=record.detail)


def _session_dir(here: Here, adw_id: str) -> Path:
    return artifacts.sessions_root(here.main_root, here.cfg.defaults.data_dir) / Path(adw_id).name


def _detail(said: list[str]) -> str:
    return "; ".join(line.strip() for line in said if line.strip())


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


# ── polling ──────────────────────────────────────────────────────────────────

class Steering:
    """One poller's side of the command channel, run by a `station.Loop`.

    `session` set: a run's own shipper, asking only for commands that name
    it, and the cockpit's sign that the session is attended. Unset: the
    station loop, asking for the rest, and the sign the station is online.
    `watchers` is what the station loop runs; a run cannot know, and says None.

    A result with no session of this station's to travel in — a run, which
    starts its session rather than naming one — goes with the next poll, as
    the same `command_result` payload, and again whenever the cockpit delivers
    that command again, until a poll that carried it was answered.

    A cockpit that refuses the token (revoked, or issued by another cockpit's
    database) is not asked again by this process — commands stop, shipping
    goes on, and it is said once.
    """

    def __init__(self, here: Here, credential: Callable[[], StationCredential | None],
                 session: str = "", watchers: Callable[[], list[str]] | None = None):
        self.here = dataclasses.replace(here, main_root=Path(here.main_root))
        self.credential = credential
        self.session = session
        self.watchers = watchers
        self.interval = POLL_INTERVAL      # seconds between polls; a test sets 0
        self.say: Callable[[str], None] = lambda text: print(f"station: {text}",
                                                             file=sys.stderr, flush=True)
        self.revoked = False
        self._due = 0.0
        self._report: StationReport | None = None
        self._reported_at = 0.0
        self._said: set[str] = set()
        self._results: dict[str, dict] = {}      # command id -> its result, until a poll took it

    def poll(self, cockpit: Cockpit, transport: station.Transport) -> None:
        now = time.monotonic()
        if self.revoked or now < self._due:
            return
        self._due = now + self.interval
        held = self.credential()
        if held is None or held.cockpit != cockpit.url:
            return                     # not registered with this cockpit: nothing to ask
        body = {"station": held.station, "report": self.report().model_dump(mode="json")}
        if self.session:
            body["session"] = self.session
        sending = dict(self._results)
        if sending:
            body["results"] = list(sending.values())
        try:
            status, answer = transport(f"{cockpit.url}/commands", held.token, body)
        except (OSError, ValueError):
            return                     # the shipping half already said the cockpit is down
        if status == 401:
            self.revoked = True
            self._say("revoked", "the cockpit refused this station's command token — it takes "
                                 "no more commands from this process; `asf station register` "
                                 "issues a new one")
            return
        if status != 200:
            self._say(f"poll {status}", f"the cockpit refused a command poll: HTTP {status}: "
                                        f"{answer.get('error') or 'no reason given'}")
            return
        for command_id in sending:
            self._results.pop(command_id, None)
        here = dataclasses.replace(self.here, owner=held.owner)
        for raw in answer.get("commands") or []:
            self._carry(here, raw)

    def _carry(self, here: Here, raw: object) -> None:
        try:
            command = Command.model_validate(raw)
        except ValueError as error:
            self._say("malformed", f"the cockpit sent a command this station cannot read: {error}")
            return
        record = carry_out(here, command)
        if record is not None and not carried(here, command):
            self._results[command.id] = _result(record).model_dump(mode="json")
        if record is not None:
            self.say(f"{command.verb} {command.session} by {command.by or 'nobody'}: "
                     f"{'done' if record.ok else 'refused'}"
                     + (f" — {record.detail}" if record.detail else ""))

    def report(self) -> StationReport:
        now = time.monotonic()
        if self._report is None or now - self._reported_at > REPORT_EVERY:
            cfg, main_root = self.here.cfg, self.here.main_root
            self._report = StationReport(verbs=obeyed(cfg), head=_head(main_root),
                                         config_hash=config_hash(main_root, cfg.defaults.data_dir))
            self._reported_at = now
        watchers = self.watchers() if self.watchers is not None else None
        return self._report.model_copy(update={"watchers": watchers})

    def _say(self, key: str, text: str) -> None:
        if key not in self._said:
            self._said.add(key)
            self.say(text)

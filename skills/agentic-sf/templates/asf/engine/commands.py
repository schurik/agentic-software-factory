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

import hashlib
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, get_args

from . import artifacts, events, git_helper, operate, station
from .data_types import (Cockpit, Command, CommandRecord, CommandResult, CommandVerb,
                         FactoryConfig, StationCredential, StationReport)
from .utils import anchor, ensure_dir, now_iso, write_atomic

VOCABULARY = get_args(CommandVerb)
# What this release of the factory can carry out. A verb opted in that is not
# here is refused, and left out of the report so the cockpit never offers it.
CARRIED_OUT = ("kill",)
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

def record_path(main_root: Path, data_dir: str, command_id: str) -> Path:
    return anchor(main_root, data_dir) / COMMANDS_DIR / f"{command_id}.json"


def recorded(main_root: Path, data_dir: str, command_id: str) -> CommandRecord | None:
    try:
        return CommandRecord.model_validate_json(
            record_path(main_root, data_dir, command_id).read_text())
    except (OSError, ValueError):
        return None


def carry_out(cfg: FactoryConfig, main_root: Path, command: Command,
              now_ms: int | None = None) -> CommandRecord | None:
    """Decide on one delivered command, act on it, and record what happened.

    The record — `commands/<id>.json`, and a `command_result` in the session
    it names — is written before this returns, or, when the command stops the
    very process carrying it out, before that process signals itself. A
    command already recorded is not acted on again: its record is returned.
    None for an id no file can be named after, which is nothing a cockpit
    issues.
    """
    if not _ID.fullmatch(command.id):
        return None
    data_dir = cfg.defaults.data_dir
    done = recorded(main_root, data_dir, command.id)
    if done is not None:
        return done
    refused = refusal(cfg, main_root, command, now_ms)
    if refused:
        return _record(cfg, main_root, _outcome(command, ok=False, detail=refused))
    said: list[str] = []
    ending: list[CommandRecord] = []

    def before_own_end() -> None:
        ending.append(_record(cfg, main_root, _outcome(command, ok=True, detail=_detail(said))))

    code = operate.kill(cfg, command.session, say=said.append, before_own_end=before_own_end)
    if ending:
        return ending[0]
    return _record(cfg, main_root, _outcome(command, ok=code == 0, detail=_detail(said)))


def refusal(cfg: FactoryConfig, main_root: Path, command: Command,
            now_ms: int | None = None) -> str:
    """Why this station will not carry `command` out, or "" when it will."""
    verb = command.verb
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
    if not command.session or not (_session_dir(cfg, main_root, command.session)
                                   / artifacts.RUN_FILE).is_file():
        return f"no session {command.session or '(none named)'} on this station"
    return ""



def _outcome(command: Command, ok: bool, detail: str) -> CommandRecord:
    return CommandRecord(command=command, ok=ok, detail=detail[:DETAIL_CHARS], at=now_iso())


def _record(cfg: FactoryConfig, main_root: Path, record: CommandRecord) -> CommandRecord:
    """Write the outcome where a second delivery finds it, then tell the session."""
    command, ok = record.command, record.ok
    path = record_path(main_root, cfg.defaults.data_dir, command.id)
    ensure_dir(path.parent)
    write_atomic(path, record.model_dump_json(indent=2))
    session = _session_dir(cfg, main_root, command.session) if command.session else None
    if session is not None and (session / artifacts.RUN_FILE).is_file():
        events.emit(session, CommandResult(command_id=command.id, verb=command.verb,
                                           adw_id=command.session, by=command.by, ok=ok,
                                           detail=record.detail))
    return record


def _session_dir(cfg: FactoryConfig, main_root: Path, adw_id: str) -> Path:
    return artifacts.sessions_root(main_root, cfg.defaults.data_dir) / Path(adw_id).name


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

    A cockpit that refuses the token (revoked, or issued by another cockpit's
    database) is not asked again by this process — commands stop, shipping
    goes on, and it is said once.
    """

    def __init__(self, cfg: FactoryConfig, main_root: Path,
                 credential: Callable[[], StationCredential | None], session: str = "",
                 watchers: Callable[[], list[str]] | None = None,
                 interval: float = POLL_INTERVAL):
        self.cfg = cfg
        self.main_root = Path(main_root)
        self.credential = credential
        self.session = session
        self.watchers = watchers
        self.interval = interval
        self.say: Callable[[str], None] = lambda text: print(f"station: {text}",
                                                             file=sys.stderr, flush=True)
        self.revoked = False
        self._due = 0.0
        self._report: StationReport | None = None
        self._reported_at = 0.0
        self._said: set[str] = set()

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
        for raw in answer.get("commands") or []:
            self._carry(raw)

    def _carry(self, raw: object) -> None:
        try:
            command = Command.model_validate(raw)
        except ValueError as error:
            self._say("malformed", f"the cockpit sent a command this station cannot read: {error}")
            return
        record = carry_out(self.cfg, self.main_root, command)
        if record is not None:
            self.say(f"{command.verb} {command.session} by {command.by or 'nobody'}: "
                     f"{'done' if record.ok else 'refused'}"
                     + (f" — {record.detail}" if record.detail else ""))

    def report(self) -> StationReport:
        now = time.monotonic()
        if self._report is None or now - self._reported_at > REPORT_EVERY:
            self._report = StationReport(
                verbs=obeyed(self.cfg), head=_head(self.main_root),
                config_hash=config_hash(self.main_root, self.cfg.defaults.data_dir))
            self._reported_at = now
        watchers = self.watchers() if self.watchers is not None else None
        return self._report.model_copy(update={"watchers": watchers})

    def _say(self, key: str, text: str) -> None:
        if key not in self._said:
            self._said.add(key)
            self.say(text)

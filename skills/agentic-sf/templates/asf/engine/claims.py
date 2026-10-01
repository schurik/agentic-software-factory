"""Claims: which station starts a work item, as a shared cockpit decides (ADR 0003).

THE LABEL IS NOT A LOCK. The forge has no conditional label edit, so two
watchers on two machines that listed the same `asf:queued` issue both flip it
to `asf:running` and both come back ok. A CLAIM (`CONTEXT.md`) is what makes
one of them lose: one transactional mutation in the shared cockpit, keyed on
the work item — its repository, `issue` or `pr`, and its number — granted to
the first session that asks, and again to that session on that station, and
refused to any other.

Every starter of a work item asks, BEFORE it touches a label: the issues
watcher, the pull-request watcher (whose trigger is a reviewer's comment), and
`asf run <workflow> <number>` typed by hand — which `--force` lets through
unasked, for a person recovering by hand. A resume asks too, though its
session already holds the claim — kept on failure precisely so that `asf
resume` works. It asks so that a session a writer abandoned does not carry
on beside the run that took its item afresh, so only the cockpit's word stops
it: a cockpit that does not answer does not. A prompt run has no work item to
claim.

What the starter learns:

  * `granted` — go ahead, as the session the claim names;
  * `held` — another session holds it, and says on which station: leave the
    item as it is;
  * `abandoned` — a writer released a claim this session held: the session
    is abandoned, and gets no claim again;
  * `unreachable` / `refused` — no answer is no grant: the item stays queued
    for the next poll, and a run by hand is refused with `--force` named;
  * `alone` — no shared cockpit is configured (ASF_COCKPIT_URL), so there are
    no claims at all and the starter goes ahead as before. The rule then is one
    issues watcher per repository, which the watcher says when it starts. A
    cockpit too old to know claims (no route: 404) is the same, said once.

A claim is held until its session finishes or is aborted — the cockpit reads
that off the session's own events — and kept on failure and while its station
is offline: a laptop asleep over a weekend is not a dead one. Nothing releases
one automatically. A writer frees one in the cockpit (Release claim), which
relabels the item `asf:queued` and abandons the session. The one thing a
station gives back itself is a claim no session ever used (`drop`): its label
would not flip, or its run died before it started. A claim carries how the
item is put back (`requeue`), in this factory's own label names.

The request goes with the factory's ingest token, which says which factory is
asking; the station says which checkout. `apps/cockpit/convex/claims.ts` is
the other end, and `tests/fake_cockpit.py` stands in for it.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path

from . import artifacts, events, git_helper, station
from .data_types import ClaimAnswer, ClaimAsk, FactoryConfig, Invocation
from .inputs import REFUSED

# Set by a watcher on the run it launches: the claim it already holds for
# that run, so the run does not ask a second time (and is not refused for a
# cockpit that blinked between the two).
CLAIMED_ENV = "ASF_CLAIMED"
_SAID_OLDER: set[str] = set()      # cockpits already said to be older than claims


def item(ask: ClaimAsk) -> str:
    """The work item, as a person names it."""
    what = "issue" if ask.kind == "issue" else "pull request"
    return f"{what} #{ask.number}" + (f" of {ask.repo}" if ask.repo else "")


def take(cfg: FactoryConfig, ask: ClaimAsk,
         transport: station.Transport | None = None) -> ClaimAnswer:
    """Ask the shared cockpit for `ask`'s work item. Never raises.

    The request says how far the session's own log already runs (`since`: 0
    for one not started yet). A pull request's run re-enters a session that
    finished before, and a station back from a weekend offline ships that
    older `session_finished` late: the cockpit reads only what comes after
    `since` as the end of the run this claim is for.
    """
    cockpit = station.configured()
    if cockpit is None:
        return ClaimAnswer(outcome="alone")
    body = {"op": "take", **ask.model_dump(mode="json"), "since": _since(cfg, ask),
            "requeue": requeue(cfg, ask)}
    status, answer, error = _ask(cfg, cockpit, body, transport)
    if error:
        return ClaimAnswer(outcome="unreachable", detail=(
            f"could not reach the cockpit at {cockpit.url} to claim {item(ask)} ({error}) — "
            f"no answer is no claim"))
    if status == 200 and answer.get("granted") is True:
        return ClaimAnswer(outcome="granted")
    if status == 404:
        return _older(cockpit.url)
    if status == 409 and isinstance(answer.get("abandoned"), dict):
        by = str(answer["abandoned"].get("by") or "a writer")
        return ClaimAnswer(outcome="abandoned", detail=(
            f"session {ask.session} was abandoned by {by}, who released its claim in the cockpit "
            f"so that {item(ask)} could start afresh — it gets no claim again"))
    if status == 409:
        held = answer.get("held") if isinstance(answer.get("held"), dict) else {}
        name = str(held.get("name") or held.get("station") or "another station")
        session = str(held.get("session") or "")
        return ClaimAnswer(outcome="held", detail=(
            f"{item(ask)} is held by {name}" + (f" (session {session})" if session else "")
            + " — a writer frees it in the cockpit with Release claim"))
    return ClaimAnswer(outcome="refused", detail=(
        f"the cockpit refused to claim {item(ask)}: HTTP {status}: "
        f"{answer.get('error') or 'no reason given'}"))


def requeue(cfg: FactoryConfig, ask: ClaimAsk) -> dict[str, list[str]]:
    """How a writer's Release claim puts the item back, in this factory's own
    label names — the cockpit never reads `factory.yaml`, so the claim carries
    them: an issue goes back on `queued`, off whichever state an earlier run
    left; a pull request loses the `failed` mark that keeps the watcher off it."""
    if ask.kind == "pr":
        return {"add": [], "remove": [name for name in [cfg.pull_requests.states.failed] if name]}
    states = cfg.issues.states
    return {"add": [name for name in [states.queued] if name],
            "remove": [name for name in (states.running, states.failed, states.done) if name]}


def _older(url: str) -> ClaimAnswer:
    """A cockpit with no claims route is older than claims: version skew
    degrades to no claims, as with no shared cockpit, said once — never to a
    factory whose watchers start nothing."""
    detail = (f"the cockpit at {url} grants no claims (it is older than this factory): until it "
              f"is upgraded, only one issues watcher per repository is safe")
    if url not in _SAID_OLDER:
        _SAID_OLDER.add(url)
        print(f"! {detail}", file=sys.stderr, flush=True)
    return ClaimAnswer(outcome="alone", detail=detail)


def drop(cfg: FactoryConfig, ask: ClaimAsk, transport: station.Transport | None = None) -> bool:
    """Give back a claim no session ever used. Never raises; True when the
    cockpit let it go — which it does only for this station's own claim, held
    by exactly this session."""
    cockpit = station.configured()
    if cockpit is None:
        return False
    status, answer, error = _ask(cfg, cockpit, {"op": "drop", **ask.model_dump(mode="json")},
                                 transport)
    return not error and status == 200 and answer.get("dropped") is True


def _ask(cfg: FactoryConfig, cockpit, body: dict,
         transport: station.Transport | None) -> tuple[int, dict, str]:
    here = station.identify(git_helper.main_root(), cfg.defaults.data_dir)
    body["station"] = here.model_dump(mode="json")
    try:
        status, answer = (transport or station.post)(f"{cockpit.url}/claims", cockpit.token, body)
    except (OSError, ValueError) as error:
        return 0, {}, str(error) or type(error).__name__
    return status, answer, ""


def _since(cfg: FactoryConfig, ask: ClaimAsk) -> int:
    """The last seq the claim's session has written on this station; 0 for none."""
    sessions = artifacts.sessions_root(git_helper.main_root(), cfg.defaults.data_dir)
    return events.last_seq(sessions / Path(ask.session).name) if ask.session else 0


def started(cfg: FactoryConfig, ask: ClaimAsk) -> bool:
    """Whether the session a claim names ever started on this station."""
    return _since(cfg, ask) > 0


# ── a launcher's claim, handed to the run it starts ──────────────────────────

def mark(ask: ClaimAsk) -> str:
    """What CLAIMED_ENV says: the item, and the session the claim is for."""
    return f"{ask.kind}:{ask.number}:{ask.session}"


def launched_with(env: Mapping[str, str], ask: ClaimAsk) -> bool:
    """Whether the launcher of this process already holds `ask`'s claim."""
    return bool(ask.session) and env.get(CLAIMED_ENV, "") == mark(ask)


def for_run(cfg: FactoryConfig, ask: ClaimAsk, invocation: Invocation) -> None:
    """A run on a work item asks before its session is opened, and is refused
    — exit 2, nothing spent — when it is not granted. `--force` starts it
    unasked; a run its watcher launched is already claimed. A resume is
    refused only on the cockpit's word (`held`, `abandoned`): its session
    holds the claim already, and an outage is no reason to stop continuing."""
    if invocation.force:
        if station.configured() is not None:
            print(f"--force: starting {item(ask)} without asking the cockpit for a claim",
                  file=sys.stderr)
        return
    if launched_with(os.environ, ask):
        return
    answer = take(cfg, ask)
    if answer.granted:
        return
    if invocation.resume and answer.outcome in ("unreachable", "refused"):
        print(f"{answer.detail}; resuming {ask.session}, which holds the claim already",
              file=sys.stderr)
        return
    print(f"{answer.detail}.\nNothing was started. `--force` starts it without a claim — for "
          f"recovering by hand, when you know no other station is working it.", file=sys.stderr)
    raise SystemExit(REFUSED)


# ── without a shared cockpit ─────────────────────────────────────────────────

def alone_warning() -> str:
    """What the issues watcher says once when it starts with no shared cockpit
    to ask, or "" when it has one."""
    if station.configured() is not None:
        return ""
    return ("no shared cockpit (ASF_COCKPIT_URL), so no claims: only one issues watcher per "
            "repository is safe. The label is not a lock — a second watcher, on another "
            "machine, can start the same issue beside this one")

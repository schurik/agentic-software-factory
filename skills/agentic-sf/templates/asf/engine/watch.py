"""The three pollers: a run per labelled issue, a run per reviewed pull request, a
run resumed because somebody answered it.

Deliberately ABOVE the control plane: a queue and a worker sit over the runner,
not inside it, and nothing here knows what a phase is. Both live in one module
because they are the same shape — list, guard, claim, launch, read the exit
code — at the two ends of a branch's life. `asf issues once|loop|status` and
`asf prs once|loop|status` reach them; `asf up` supervises both.

THE LABEL IS THE QUEUE for issues, and the flip is the claim, NOT the lock:
the forge has no conditional label change, so two watchers that listed
concurrently both come back ok. Exclusion is a file lock per issue, taken
before the claim and held for the whole run — which covers one watcher per
repository on one machine, and nothing covers two machines. Run one.

THE SUSPENDED SESSION IS THE QUEUE for answers, and it is the odd one of the
three: nothing new is launched, an existing run is brought back. A question
round put its questions on a work item and stopped at exit 75, and without this
poller the reply sits there while the run waits for somebody to type
`asf answer`. So this one walks the sessions THIS REPOSITORY already has
waiting, looks for a comment that came after the question, and resumes.

THE UNRESOLVED THREAD IS THE QUEUE for pull requests. No label to claim: the
forge maintains that state, and the run that answers a thread resolves it.
Two things that state cannot do on its own: a run that ends red leaves its
threads open (the `failed` label is the mark that stops the loop, and a human
removing it is the restart), and a merged pull request ends its session
(`reap` stops a review run still working a landed branch).

A RUN HAS THREE OUTCOMES, NOT TWO. It can succeed, fail, or stop for a person
at a gate — exit 75, worktree intact, `asf pending` naming it. Reading the
third as failure tells the reporter the opposite of what happened.

Every launch is a subprocess of the stamped runner, with `ASF_UNATTENDED`
set: this watcher's terminal is not the run's, and a gate must suspend rather
than prompt whoever is watching the queue.
"""

from __future__ import annotations

import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from . import artifacts, git_helper, hitl, issues, operate, pull_requests, worktree
from .data_types import (Decision, IssueRef, IssueUpdate, PullRequestRef, PullRequestUpdate,
                         FactoryConfig, Reply)
from .tracer import watcher_beat as db_beat
from .utils import anchor, ensure_dir, now_iso, operator_env

RUNNER = "asf/asf.py"
EXIT_WAITING = hitl.EXIT_WAITING

# (project, number) this process will not launch again, because a run failed on
# it and the label that would have said so could not be applied. Process-local
# and lost on restart: the honest scope of a fallback for a mark that was
# supposed to live on the pull request.
_HELD: set[tuple[str, int]] = set()


# ── shared ───────────────────────────────────────────────────────────────────

def _forge(argv: list[str], main_root) -> list[dict]:
    """One listing. Never raises — an outage is not a crash."""
    completed = subprocess.run(argv, cwd=str(main_root), env=operator_env(),
                               capture_output=True, text=True)
    if completed.returncode != 0:
        print(f"  ! could not list: {(completed.stderr or completed.stdout).strip()[-300:]}")
        return []
    try:
        return json.loads(completed.stdout or "[]")
    except json.JSONDecodeError:
        print("  ! the list command did not return JSON")
        return []


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                     # exists, owned by someone else


def live_runs(cfg: FactoryConfig, main_root) -> dict[str, int]:
    """{adw_id: pid} for sessions whose process still exists.

    A session row saying `running` is a belief: a SIGKILL or a reboot leaves
    one behind forever, and budgeting on the count would wedge a watcher at
    max_concurrent while looking like a busy factory.
    """
    sessions = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
    return {adw_id: pid for adw_id, pid in artifacts.running_pids(sessions).items()
            if _alive(pid)}


def beat(cfg: FactoryConfig, main_root, kind: str, status: str, *, project: str = "",
         interval: int = 0, note: str = "") -> None:
    """Say that this watcher exists and what it just did — a file for `asf
    status`, a db row for the trace UI's badge. Never raises."""
    artifacts.watcher_beat(
        artifacts.watchers_dir(main_root, cfg.defaults.data_dir), kind,
        {"status": status, "pid": os.getpid(), "project": project, "interval_s": interval,
         "note": note, "started_at": now_iso(), "last_poll_at": now_iso()})
    try:
        db_beat(anchor(main_root, cfg.observability.db), kind, status, pid=os.getpid(),
                project=project, interval_s=interval, note=note)
    except Exception:                                   # noqa: BLE001 — a badge, not a run
        pass


@contextmanager
def claim(cfg: FactoryConfig, main_root, bucket: str, project: str, number: int):
    """Hold an exclusive claim on one item, or yield False. `flock`, non-blocking,
    held for the whole run and released by the OS even if this process dies."""
    lock_dir = ensure_dir(anchor(main_root, f"{cfg.defaults.data_dir}/{bucket}"))
    handle = open(lock_dir / _slug(project, number), "w")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print(f"  #{number}: another watcher on this machine holds it")
            yield False
            return
        yield True
    finally:
        handle.close()


def _slug(project: str, number: int) -> str:
    return f"{project.replace('/', '-')}-{number}.lock" if project else f"{number}.lock"


def launch(config_path: str, workflow: str, number: int, main_root) -> int:
    """One run, to completion, serially. `max_concurrent` bounds how many exist
    and the honest way to hold that is to wait for the one just started."""
    argv = [sys.executable, RUNNER, "--config", config_path, "run", workflow, str(number)]
    print(f"  #{number}: {' '.join(argv[1:])}")
    env = {**os.environ, hitl.UNATTENDED_ENV: "1"}
    return subprocess.run(argv, cwd=str(main_root), env=env).returncode


def _names(labels: list) -> list[str]:
    return [entry.get("name", "") if isinstance(entry, dict) else str(entry)
            for entry in labels]


def _exit_on_sigterm() -> None:
    """The FIRST SIGTERM becomes an ordinary exit so the goodbye beat is written;
    the rest are ignored — `asf up` signals the whole group, and a second
    delivery mid-teardown is how that beat went missing once."""
    def leave(*_) -> None:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        sys.exit(143)
    signal.signal(signal.SIGTERM, leave)


def _loop(kind: str, once, cfg: FactoryConfig, main_root, interval: int) -> int:
    print(f"polling every {interval}s — ctrl-c to stop")
    try:
        while True:
            try:
                code = once()
                if code == 3:                       # a pinned pull request finished
                    return 0
            except KeyboardInterrupt:
                raise
            except Exception as error:              # noqa: BLE001 — an outage is not a crash
                print(f"! poll failed: {error}")
                beat(cfg, main_root, kind, "error", note=str(error)[:200])
            time.sleep(interval)
    finally:
        # Written from the config resolved at STARTUP: this runs while the
        # process is torn down, and a re-read could lose the race.
        beat(cfg, main_root, kind, "stopped", note="watcher exited")


# ── issues ───────────────────────────────────────────────────────────────────

def route(cfg: FactoryConfig, labels: list) -> str:
    """Which workflow this issue's labels ask for; "" when none does. The
    routing label is never removed — it is the authorization a human applied."""
    names = _names(labels)
    for label, workflow in cfg.issues.route.items():
        if label in names:
            return workflow
    return ""


def stale_states(cfg: FactoryConfig, labels: list, keep: str) -> list[str]:
    """State labels this issue still carries from an EARLIER run, and only ones
    it actually carries: `gh issue edit --remove-label` on a name the repository
    never defined is an error, and it would fail the claim it rides on.

    THE FOUR STATES ARE THE ONLY THINGS THIS CLEARS. `refined_label` is not one
    of them — it is a different axis, and a refined item is still queued, still
    running, still done. It says the requirements were settled with a person,
    and that does not stop being true because the issue was queued again. The
    discard below makes that hold even if someone spells the two the same.
    """
    states = cfg.issues.states
    known = {states.queued, states.running, states.done, states.failed}
    known.discard(cfg.issues.refined_label)
    return sorted({name for name in _names(labels) if name in known and name != keep})


def flip(cfg: FactoryConfig, main_root, project: str, number: int,
         add: str, remove: list[str]) -> bool:
    result = issues.set_state(main_root, cfg.issues, IssueUpdate(
        number=number, project=project, add_labels=[add], remove_labels=list(remove)))
    if not result.ok:
        print(f"  #{number}: {' · '.join(result.notes)}")
    return result.ok


def issues_once(cfg: FactoryConfig, config_path: str, interval: int = 0) -> int:
    main_root = git_helper.main_root()
    project = issues.resolve_project(cfg.issues, main_root)
    if not cfg.issues.enabled:
        print("issues.enabled is false — nothing to watch")
        beat(cfg, main_root, "issues", "disabled", note="issues.enabled is false")
        return 0
    if not project:
        print("issues.project is empty and no origin remote could be read. Set "
              "issues.project: a watcher that cannot name its project polls nothing.",
              file=sys.stderr)
        beat(cfg, main_root, "issues", "error", note="issues.project is unresolved")
        return 2

    argv = [*cfg.issues.list_command, "--label", cfg.issues.states.queued, "--state", "open",
            "--json", "number,title,labels,author", "--limit", "50", "--repo", project]
    queued = _forge(argv, main_root)
    print(f"{project}: {len(queued)} issue(s) labelled {cfg.issues.states.queued}")
    beat(cfg, main_root, "issues", "polling", project=project, interval=interval,
         note=f"{len(queued)} queued")
    launched = waiting = 0
    for entry in queued:
        number = entry.get("number")
        workflow = route(cfg, entry.get("labels") or [])
        if not workflow:
            print(f"  #{number}: no routing label — leaving it queued")
            continue
        if len(live_runs(cfg, main_root)) >= cfg.issues.max_concurrent:
            print(f"  #{number}: max_concurrent ({cfg.issues.max_concurrent}) reached — "
                  f"leaving it queued for the next poll")
            break
        with claim(cfg, main_root, "issue-locks", project, number) as mine:
            if not mine:
                continue
            # The claim clears whatever an earlier run left on this issue in the
            # same edit, so the flip after the run removes only a label it put on.
            if not flip(cfg, main_root, project, number, cfg.issues.states.running,
                        stale_states(cfg, entry.get("labels") or [],
                                     keep=cfg.issues.states.running)):
                continue
            beat(cfg, main_root, "issues", "working", project=project, interval=interval,
                 note=f"#{number} {workflow}")
            code = launch(config_path, workflow, number, main_root)
            launched += 1
            if code == EXIT_WAITING:
                # Left on `running`: true, and only `queued` is dequeued, so it
                # cannot be claimed twice while a person decides. The process
                # that ends the run owns its label — `asf approve` lands it.
                waiting += 1
                print(f"  #{number}: stopped for a human at a gate — left on "
                      f"{cfg.issues.states.running}, NOT {cfg.issues.states.failed}. "
                      f"`asf pending` names the run; `asf approve` / `asf reject -m` / "
                      f"`asf abort` answer it")
                continue
            flip(cfg, main_root, project, number,
                 cfg.issues.states.done if code == 0 else cfg.issues.states.failed,
                 [cfg.issues.states.running])
    stalled = f", {waiting} waiting for a human" if waiting else ""
    print(f"launched {launched} run(s){stalled}")
    beat(cfg, main_root, "issues", "polling", project=project, interval=interval,
         note=f"{len(queued)} queued, launched {launched}{stalled}")
    return 0


def issues_loop(cfg: FactoryConfig, config_path: str, interval: int) -> int:
    _exit_on_sigterm()
    return _loop("issues", lambda: issues_once(cfg, config_path, interval), cfg,
                 git_helper.main_root(), interval)


def issues_status(cfg: FactoryConfig) -> int:
    main_root = git_helper.main_root()
    project = issues.resolve_project(cfg.issues, main_root)
    print(f"enabled:        {cfg.issues.enabled}")
    print(f"project:        {project or '(unresolved — set issues.project)'}"
          f"{'  (from origin)' if project and not cfg.issues.project else ''}")
    print(f"queued label:   {cfg.issues.states.queued}")
    print(f"max_concurrent: {cfg.issues.max_concurrent}"
          f"  (running now: {len(live_runs(cfg, main_root))})")
    print(f"force_pr:       {cfg.issues.force_pr}")
    print(f"trusted:        {', '.join(cfg.issues.trusted_authors) or '(anyone who gets labelled)'}")
    print("routes:")
    for label, workflow in cfg.issues.route.items():
        print(f"  {label:<16} -> {workflow}")
    if not cfg.issues.route:
        print("  (none — no label routes to a workflow, so nothing would ever launch)")
    return 0


# ── answers ──────────────────────────────────────────────────────────────────
#
# Nothing is launched here; a run that already exists is brought BACK. That
# makes this the only poller with no queue of its own — it reads the sessions
# this repository has waiting, which is the same record `asf pending` prints.


def _answering(cfg: FactoryConfig, main_root) -> dict:
    """{adw_id: what it waits for} for the waits this poller can actually end.

    Filtered by CHANNEL and by name, never by "everything I do not recognise":
    a pull request round records `channel: "pr"` and nothing reads that yet, so
    treating an unknown channel as this one's would resume a run on an answer
    that never came.
    """
    sessions = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
    return {adw_id: what for adw_id, what in artifacts.waiting_sessions(sessions).items()
            if what.channel == "issue" and what.issue_number}


def _heard(cfg: FactoryConfig, main_root, what) -> list:
    """The comments that could answer THIS wait. Never raises: a forge outage
    is a poll that found nothing, not a crash of the loop above it."""
    # `asked_at` is stamped when the questions go up and should always be set;
    # `since` — when the wait was recorded — is the honest fallback, and it is
    # the conservative one. An empty value would accept every comment ever
    # written on the item, including ones from before the question.
    since = what.asked_at or what.since
    try:
        comments = issues.comments(main_root, cfg.issues, IssueRef(number=what.issue_number))
    except RuntimeError as error:
        print(f"  #{what.issue_number}: could not be read ({error})")
        return []
    return issues.answers_since(comments, since=since, authors=cfg.issues.trusted_authors)


def _as_reply(answers: list) -> Reply:
    """What several comments say, as one answer, with everyone attributed.

    The analyst reads this as prose, so two people disagreeing in two comments
    must not arrive as one anonymous paragraph — which is what joining the
    bodies alone would do.
    """
    return Reply(verdict="answer", channel="issue", by=answers[-1].author or "someone",
                 notes="\n\n".join(f"{c.author or 'someone'}: {c.body.strip()}"
                                    for c in answers))


def answers_once(cfg: FactoryConfig, config_path: str, interval: int = 0) -> int:
    main_root = git_helper.main_root()
    project = issues.resolve_project(cfg.issues, main_root)
    if not cfg.issues.enabled:
        print("issues.enabled is false — nothing to answer")
        beat(cfg, main_root, "answers", "disabled", note="issues.enabled is false")
        return 0
    if not project:
        print("issues.project is empty and no origin remote could be read. Set "
              "issues.project: a watcher that cannot name its project polls nothing.",
              file=sys.stderr)
        beat(cfg, main_root, "answers", "error", note="issues.project is unresolved")
        return 2

    # THIS PROCESS IS NOT ANYBODY'S TERMINAL, and every run it resumes inherits
    # that. `issues_once` says the same thing per launch; here the resume goes
    # through `operate.relaunch`, which runs the child on this environment — so
    # the statement belongs to the process. A resumed run that prompted would
    # be asking whoever left the watcher running, about a round they never read.
    os.environ[hitl.UNATTENDED_ENV] = "1"

    waits = _answering(cfg, main_root)
    print(f"{project}: {len(waits)} run(s) waiting on an answer")
    beat(cfg, main_root, "answers", "polling", project=project, interval=interval,
         note=f"{len(waits)} waiting")

    resumed = 0
    for adw_id, what in sorted(waits.items(), key=lambda item: item[1].since):
        if len(live_runs(cfg, main_root)) >= cfg.issues.max_concurrent:
            print(f"  {adw_id}: max_concurrent ({cfg.issues.max_concurrent}) reached — "
                  f"next poll")
            break
        session_dir = artifacts.sessions_root(main_root, cfg.defaults.data_dir) / adw_id
        with claim(cfg, main_root, "issue-locks", project, what.issue_number) as mine:
            # The SAME lock the issue watcher takes. The two cannot collide
            # today — that one only claims `queued` items and this one's are on
            # `running` — but sharing the key costs nothing and means the
            # question never has to be re-answered when a third poller appears.
            if not mine:
                continue
            if hitl.read_decision(session_dir, what.gate, what.round) is None:
                answers = _heard(cfg, main_root, what)
                if not answers:
                    continue
                reply = _as_reply(answers)
                try:
                    hitl.answer(session_dir, reply)
                except RuntimeError as error:
                    print(f"  {adw_id}: {error}")
                    continue
                print(f"  {adw_id}: #{what.issue_number} answered by {reply.by}")
            else:
                # A decision is already on record — written by `asf answer
                # --no-resume`, or by a poll whose relaunch then died. Either
                # way the run is answered and still stopped, which is the one
                # state this poller exists to clear. `--no-resume` means "not
                # by that command", not "never".
                print(f"  {adw_id}: already answered and still waiting — resuming")
            beat(cfg, main_root, "answers", "working", project=project, interval=interval,
                 note=f"{adw_id} #{what.issue_number}")
            code = operate.relaunch(cfg, config_path, adw_id)
            resumed += 1
            if code == EXIT_WAITING:
                print(f"  {adw_id}: asked again — round {what.round + 1} is on "
                      f"#{what.issue_number}")
    print(f"resumed {resumed} run(s)")
    beat(cfg, main_root, "answers", "polling", project=project, interval=interval,
         note=f"{len(waits)} waiting, resumed {resumed}")
    return 0


def answers_loop(cfg: FactoryConfig, config_path: str, interval: int) -> int:
    _exit_on_sigterm()
    return _loop("answers", lambda: answers_once(cfg, config_path, interval), cfg,
                 git_helper.main_root(), interval)


def answers_status(cfg: FactoryConfig) -> int:
    main_root = git_helper.main_root()
    project = issues.resolve_project(cfg.issues, main_root)
    waits = _answering(cfg, main_root)
    print(f"enabled:        {cfg.issues.enabled}")
    print(f"project:        {project or '(unresolved — set issues.project)'}")
    print(f"trusted:        {', '.join(cfg.issues.trusted_authors) or '(anyone who can comment)'}")
    print(f"waiting on an answer: {len(waits)}")
    for adw_id, what in sorted(waits.items(), key=lambda item: item[1].since):
        print(f"  {adw_id}  #{what.issue_number}  {what.gate} · round {what.round}  "
              f"asked {what.asked_at or what.since}")
    if not waits:
        print("  (none — `asf pending` lists every wait, including the ones on a terminal)")
    return 0


# ── pull requests ────────────────────────────────────────────────────────────

def _pr_number(pr_url: str) -> int:
    tail = (pr_url or "").rstrip("/").rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def mark(cfg: FactoryConfig, main_root, project: str, number: int, add: str = "",
         remove: str = "") -> bool:
    result = pull_requests.set_state(main_root, cfg.pull_requests, PullRequestUpdate(
        number=number, project=project,
        add_labels=[add] if add else [], remove_labels=[remove] if remove else []))
    if not result.ok:
        print(f"  #{number}: {' · '.join(result.notes)}")
    return result.ok


def hold(cfg: FactoryConfig, main_root, project: str, number: int) -> None:
    """Mark a failed pull request; keep this process off it if the mark failed.
    THE LABEL IS THE ONLY BRAKE this path has, and `_HELD` is the weaker fallback."""
    failed = cfg.pull_requests.states.failed
    if mark(cfg, main_root, project, number, add=failed):
        return
    _HELD.add((project, number))
    print(f"  #{number}: {failed} did not stick, so this watcher is holding the pull "
          f"request itself — otherwise the next poll would find the same open threads "
          f"and buy the same failed run again. Add {failed} by hand, or fix the forge "
          f"CLI (`asf doctor`) and restart the watcher")


def waiting_on(cfg: FactoryConfig, main_root, number: int) -> str:
    """The session already stopped at a gate on this pull request, or "". Its
    threads are still unresolved — the condition that launched it — and the
    `failed` label cannot guard a run that did exactly what it was asked."""
    sessions = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
    urls = artifacts.pr_urls(sessions)
    for adw_id in artifacts.waiting_sessions(sessions):
        if _pr_number(urls.get(adw_id, "")) == number:
            return adw_id
    return ""


def has_work(cfg: FactoryConfig, main_root, project: str, number: int) -> bool:
    """The full read, not the listing: `gh pr list` cannot see review threads."""
    try:
        context = pull_requests.describe(main_root, cfg.pull_requests,
                                         PullRequestRef(number=number, project=project))
    except RuntimeError as error:
        print(f"  #{number}: could not read it ({error})")
        return False
    threads = pull_requests.actionable(cfg.pull_requests, context)
    print(f"  #{number}: {len(threads)} open review thread(s)" if threads
          else f"  #{number}: no open review threads")
    return bool(threads)


def reap(cfg: FactoryConfig, main_root, project: str) -> int:
    """Close out sessions whose pull request has been merged or closed.

    Only the factory's own open state is examined — worktrees on disk and
    sessions that believe they run — so the pass costs less the tidier the
    factory is. For each such session on a pull request no longer open: stop a
    REVIEW run still working it (SIGTERM; any other workflow is left running
    and told), abort a run waiting at a gate nobody is left to answer, release
    the worktree by the same conservative rule `asf worktrees prune` uses,
    drop the loop-stop label and the lock. Idempotent; never raises.
    """
    sessions = artifacts.sessions_root(main_root, cfg.defaults.data_dir)
    live = live_runs(cfg, main_root)
    names = artifacts.adw_names(sessions)
    trees = {info.adw_id for info in worktree.inventory(main_root, cfg.worktree, str(sessions))}
    candidates = sorted(trees | set(live))
    urls = artifacts.pr_urls(sessions)
    reaped = 0
    for adw_id in candidates:
        number = _pr_number(urls.get(adw_id, ""))
        if not number:
            continue
        try:
            context = pull_requests.describe(main_root, cfg.pull_requests,
                                             PullRequestRef(number=number, project=project))
        except RuntimeError as error:
            print(f"  ~ {adw_id}: could not read #{number} ({error}) — left alone")
            continue
        if context.open:
            continue
        print(f"  ~ {adw_id}: #{number} is {context.state.lower()}")
        if adw_id in live:
            if cfg.pull_requests.workflow in (names.get(adw_id) or ""):
                _terminate(adw_id, live[adw_id])
            else:
                print(f"    {names.get(adw_id) or 'a run'} is still working it (pid "
                      f"{live[adw_id]}) — left running; its commits would now push onto "
                      f"a landed branch. `asf kill {adw_id}` to stop it")
        _abort_if_waiting(sessions / adw_id, number, context.state.lower())
        _release(cfg, main_root, adw_id, str(sessions))
        mark(cfg, main_root, project, number, remove=cfg.pull_requests.states.failed)
        try:
            (anchor(main_root, f"{cfg.defaults.data_dir}/pr-locks")
             / _slug(project, number)).unlink(missing_ok=True)
        except OSError:
            pass
        reaped += 1
    return reaped


def _terminate(adw_id: str, pid: int) -> None:
    """SIGTERM, not SIGKILL: the run's own handler closes the trace it owns."""
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"    stopped the run still working it (pid {pid})")
    except ProcessLookupError:
        pass
    except PermissionError:
        print(f"    a run is working it (pid {pid}) but belongs to another user — "
              f"not stopping it")


def _abort_if_waiting(session_dir: Path, number: int, state: str) -> None:
    run = artifacts.read_run(session_dir)
    if run is None or run.status != "waiting" or run.waiting_for is None:
        return
    waiting = run.waiting_for
    hitl.record(session_dir, Decision(
        gate=waiting.gate, round=waiting.round, verdict="abort", by="policy",
        channel="auto", subject_digest=waiting.subject_digest,
        notes=f"#{number} {state} while the run was waiting at this gate"))
    artifacts.finish_run(session_dir, "fail")
    print(f"    was waiting at gate {waiting.gate} — aborted and recorded")


def _release(cfg: FactoryConfig, main_root, adw_id: str, sessions: str) -> None:
    """Re-read after the SIGTERM above: `reclaimable` asks about the status it changed."""
    for info in worktree.inventory(main_root, cfg.worktree, sessions):
        if info.adw_id != adw_id:
            continue
        if not worktree.reclaimable(info):
            print(f"    kept {info.path} — "
                  f"{'uncommitted work' if info.dirty else f'run is {info.status}'}")
            return
        try:
            worktree.remove(main_root, info.path)
            print(f"    removed {info.path}; branch {info.branch} retained")
        except RuntimeError as error:
            print(f"    kept {info.path} — {error}")
        return


def prs_once(cfg: FactoryConfig, config_path: str, only: int = 0, interval: int = 0) -> int:
    """One pass: reap what merged, then answer what is outstanding. 3 means the
    pinned pull request is finished — a signal for `loop --pr`, not a failure."""
    main_root = git_helper.main_root()
    pr = cfg.pull_requests
    project = pull_requests.resolve_project(pr, main_root)
    if not pr.enabled:
        print("pull_requests.enabled is false — nothing to watch")
        beat(cfg, main_root, "prs", "disabled", note="pull_requests.enabled is false")
        return 0
    if not project:
        print("pull_requests.project is empty and no origin remote could be read. Set "
              "pull_requests.project: a watcher that cannot name its project polls "
              "nothing.", file=sys.stderr)
        beat(cfg, main_root, "prs", "error", note="pull_requests.project is unresolved")
        return 2

    if pr.reap_merged:
        reaped = reap(cfg, main_root, project)
        if reaped:
            print(f"reaped {reaped} finished pull request(s)")

    argv = [*pr.list_command, "--state", "open", "--json", "number,headRefName,labels,isDraft",
            "--limit", "50", "--repo", project]
    prefix = cfg.worktree.branch_prefix
    entries = [entry for entry in _forge(argv, main_root)
               if str(entry.get("headRefName", "")).startswith(prefix)]
    if only:
        entries = [entry for entry in entries if entry.get("number") == only]
        if not entries:
            print(f"#{only} is no longer open — done watching it")
            return 3

    print(f"{project}: {len(entries)} open pull request(s) on {prefix}*")
    beat(cfg, main_root, "prs", "polling", project=project, interval=interval,
         note=f"{len(entries)} open")
    launched = 0
    for entry in entries:
        number = entry.get("number")
        if entry.get("isDraft"):
            print(f"  #{number}: draft — not answering review feedback on it yet")
            continue
        if pr.states.failed in _names(entry.get("labels") or []):
            print(f"  #{number}: carries {pr.states.failed} — a run already failed on it; "
                  f"remove the label to try again")
            continue
        if (project, number) in _HELD:
            print(f"  #{number}: a run failed on it and {pr.states.failed} could not be "
                  f"applied, so this watcher is holding it")
            continue
        stalled = waiting_on(cfg, main_root, number)
        if stalled:
            print(f"  #{number}: {stalled} is stopped at a gate — `asf show {stalled}`, then "
                  f"`asf approve` / `asf reject -m` / `asf abort`")
            continue
        if not has_work(cfg, main_root, project, number):
            continue
        if len(live_runs(cfg, main_root)) >= pr.max_concurrent:
            print(f"  #{number}: max_concurrent ({pr.max_concurrent}) reached — leaving "
                  f"it for the next poll")
            break
        with claim(cfg, main_root, "pr-locks", project, number) as mine:
            if not mine:
                continue
            beat(cfg, main_root, "prs", "working", project=project, interval=interval,
                 note=f"#{number} {pr.workflow}")
            code = launch(config_path, pr.workflow, number, main_root)
            launched += 1
            if code == EXIT_WAITING:
                print(f"  #{number}: stopped for a human at a gate — not marked "
                      f"{pr.states.failed}; `asf pending` names the run")
            elif code != 0:
                hold(cfg, main_root, project, number)
    print(f"launched {launched} run(s)")
    beat(cfg, main_root, "prs", "polling", project=project, interval=interval,
         note=f"{len(entries)} open, launched {launched}")
    return 0


def prs_loop(cfg: FactoryConfig, config_path: str, interval: int, only: int = 0) -> int:
    _exit_on_sigterm()
    return _loop("prs", lambda: prs_once(cfg, config_path, only, interval), cfg,
                 git_helper.main_root(), interval)


def prs_status(cfg: FactoryConfig) -> int:
    main_root = git_helper.main_root()
    pr = cfg.pull_requests
    project = pull_requests.resolve_project(pr, main_root)
    print(f"enabled:        {pr.enabled}")
    print(f"project:        {project or '(unresolved — set pull_requests.project)'}"
          f"{'  (from origin)' if project and not pr.project else ''}")
    print(f"branches:       {cfg.worktree.branch_prefix}*")
    print(f"workflow:       {pr.workflow}")
    print(f"queue:          unresolved review threads (max {pr.max_threads} per run)")
    print(f"failed label:   {pr.states.failed}")
    print(f"max_concurrent: {pr.max_concurrent}  (running now: {len(live_runs(cfg, main_root))})")
    print(f"writes back:    reply={pr.reply_to_threads} resolve={pr.resolve_threads}")
    print(f"reap_merged:    {pr.reap_merged}")
    print(f"trusted:        {', '.join(pr.trusted_reviewers) or '(anyone who can review)'}")
    print(f"ignored:        {', '.join(pr.ignore_authors) or '(no bots ignored)'}")
    return 0

"""A git worktree and a branch per run — isolation, not a sandbox.

Upstream runs in the engineer's working tree, on whatever branch happens to be
checked out. That makes two runs unable to be concurrent, makes a failed run
destructive, and makes `commit_all()` pick up whatever else was lying around.

So every run gets `<worktrees_dir>/<adw_id>` on branch `asf/<adw_id>`, cut from
a base ref pinned once at run start. `Run.repo_root` becomes that directory, and
because agents, gates, quality blocks and the permission snapshot all derive
from `repo_root`, the isolation follows from one assignment rather than from
fourteen call sites remembering to opt in.

Three properties this file exists to keep:

  * **A joined run re-attaches.** A second ADW pinned to the same `--adw-id`
    must land in the SAME worktree, never a second one — the first ADW's
    uncommitted work is the second one's input.
  * **The branch is the record, the worktree is a copy of it.** So a worktree
    may be removed whenever it is clean, and re-created later from its branch
    with nothing lost. That is what makes pruning on success safe.
  * **A failure keeps its evidence.** A failed or killed run's worktree is where
    you go to see what happened, and anything with uncommitted work in it stays
    put whatever the outcome.

It is not a sandbox. An agent with `bash` can `cd` anywhere; `permissions.py`
remains the boundary, and it measures the tree this module hands it.
"""

from __future__ import annotations

import json
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from . import artifacts, git_helper, publish
from .data_types import (RAW_TAIL_CHARS, CommandFinished, PhaseParams, Workspace, WorktreeConfig,
                         WorktreeInfo, WorktreeRequest)
from .utils import anchor, ensure_dir, now_iso, operator_env, write_atomic

META_SUFFIX = ".json"          # <worktrees_dir>/<adw_id>.json, beside the worktree
ENDED = {"success", "fail"}    # session statuses that mean nothing is using the tree
SETUP_TIMEOUT_SECONDS = 1800   # a cold `bun install` on a slow line, with room to spare
SAID_TAIL_CHARS = 4_000        # of a failed setup's output, in the message that ends the run


def _meta_path(root: Path, adw_id: str) -> Path:
    """Where a run's pinned base is recorded — BESIDE the worktree, never in it.

    Inside, it would be an untracked file in the tree the run commits with
    `git add -A`, so the factory's own bookkeeping would end up in the
    engineer's history.
    """
    return root / f"{adw_id}{META_SUFFIX}"


def _base_ref_of(main_root: Path, config: WorktreeConfig) -> str:
    """What to cut from: the configured ref, else whatever main has checked out.

    A detached main checkout has no branch name to inherit, so the sha is used —
    it is still a perfectly good thing to branch from, and pinning it is the
    point.
    """
    if config.base_ref:
        return config.base_ref
    branch = git_helper.current_branch(main_root)
    return git_helper.rev(main_root, "HEAD") if branch == "HEAD" else branch


def ensure(request: WorktreeRequest) -> Workspace:
    """The run's workspace: create the worktree, re-attach to it, or do neither.

    Returns a Workspace whose two roots are the same directory when worktrees
    are off, when this is not a git repository, or when the repository has no
    commit to branch from — every one of which is a legitimate way to run an
    ADW, and none of which is worth failing a run over.

    An isolated request (a benchmark's session) is never published, and says
    so on the workspace however it was reached — created, re-created from its
    branch or re-attached — since every later process of the session asks it.
    """
    workspace = _ensure(request)
    return workspace.model_copy(update={"isolated": True}) if request.isolated else workspace


def _ensure(request: WorktreeRequest) -> Workspace:
    main = Path(request.main_root).resolve()
    config = request.config
    plain = Workspace(main_root=main, repo_root=main)

    if not config.enabled or not git_helper.is_repo(main):
        return plain
    if not git_helper.ref_exists(main, "HEAD"):
        return plain          # a fresh `git init` has nothing to branch from yet

    root = anchor(main, config.dir)
    path = root / request.adw_id
    branch = f"{config.branch_prefix}{request.adw_id}"
    meta = _meta_path(root, request.adw_id)

    if path.is_dir():
        joined = _reattach(path, main, branch, meta)
        _publish(request, joined.branch)
        return joined          # it already has its files: nothing is copied again

    # A worktree whose directory was deleted by hand still holds its
    # registration, and `worktree add` refuses the same path twice. Pruning is
    # administrative — it forgets records for directories that are already gone
    # and touches nothing that exists.
    git_helper.worktree_prune(main)
    ensure_dir(root)
    found, missing = _to_copy(main, config, root)

    if git_helper.branch_exists(main, branch):
        # The run's branch outlived its worktree — a pruned success, or a rerun.
        # Check it out again rather than branching a second time from the base:
        # the branch is the record, and re-creating it would discard the record.
        _refuse_if_held(main, branch)
        _publish(request, branch)
        git_helper.worktree_add(main, path, branch)
        recorded = _read_meta(meta)
        base_ref = recorded.get("base_ref") or _base_ref_of(main, config)
        base_commit = recorded.get("base_commit") or git_helper.merge_base(
            path, base_ref, "HEAD")
    else:
        # A pinned commit (a benchmark's session, which starts where the session
        # it re-works started) is its own base ref: there is no branch to name.
        base_ref = (request.base_commit if request.isolated and request.base_commit
                    else _base_ref_of(main, config))
        base_commit = git_helper.rev(main, base_ref)
        # Before the branch exists, so a push the remote refuses leaves nothing
        # behind — see publish.on_create on why the base has to get there.
        _publish(request, branch, base_commit)
        git_helper.worktree_add(main, path, branch, base_ref)

    _refuse_on_the_branch(main, path, branch, found)
    _copy(main, path, found)
    workspace = Workspace(main_root=main, repo_root=path.resolve(), enabled=True,
                          branch=branch, base_ref=base_ref, base_commit=base_commit,
                          created=True, copied=found, missing=missing,
                          setup_owed=bool(config.setup))
    _write_meta(meta, request.adw_id, workspace)
    return workspace


# ── what the branch cannot give it ───────────────────────────────────────────

GLOB_CHARS = frozenset("*?[")


def _matches(main: Path, pattern: str, worktrees: Path) -> list[str]:
    """What one `worktree.copy` glob names in the main checkout, as paths from
    its root — never anything inside a run's worktree, which a `**` would
    otherwise find a copy of."""
    if not GLOB_CHARS & set(pattern):
        return [pattern] if (main / pattern).exists() else []
    return sorted(found.relative_to(main).as_posix() for found in main.glob(pattern)
                  if worktrees not in found.parents)


def _outside(pattern: str) -> bool:
    path = Path(pattern)
    return path.is_absolute() or ".." in path.parts


def _uncopyable(main: Path, paths: list[str]) -> list[str]:
    """Why each of `paths` must not be copied into a worktree, one line each.

    Gitignored is the whole test, because a commit stage runs `git add -A` in
    the worktree: one entry that is not ignored there is a secret committed.
    A tracked file is said apart — check-ignore calls it "not ignored" too, but
    its fix is a different one: the worktree has it already.
    """
    tracked = git_helper.tracked(main, paths)
    ignored = git_helper.ignored(main, [each for each in paths if each not in tracked])
    said = []
    for each in paths:
        if each in tracked:
            said.append(f"worktree.copy: {each} is tracked — the worktree has it already, "
                        f"from the branch; take it out of the list")
        elif each not in ignored:
            said.append(f"worktree.copy: {each} is not gitignored — a commit stage runs "
                        f"`git add -A` in the worktree, and would commit it. Ignore it in "
                        f".gitignore, or take it out of the list")
    return said


def refused(main_root: Path, config: WorktreeConfig) -> list[str]:
    """What `worktree.copy` and `worktree.setup` say that no run may do, one line
    each — asked by `factory.load`, so `check`, `doctor` and every run refuse
    the same entries before anything is created.

    A literal path is judged as written, whether or not the checkout has it
    yet (CI's fresh clone has no `.env`); a glob by what it matches here, and
    each match is judged again when it is copied (`_to_copy`).
    """
    main = Path(main_root)
    if not config.enabled or not git_helper.is_repo(main):
        return []                       # nothing is ever copied, or nowhere to copy it
    said = [f"worktree.setup: {argv} {why} — argv lists with a bare binary name, as in "
            f"quality.py" for argv, why in
            ((argv, "is empty" if not argv else "names its binary by path")
             for argv in config.setup if not argv or "/" in argv[0])]
    worktrees = anchor(main, config.dir)
    judged: list[str] = []
    for pattern in config.copy_:
        if _outside(pattern):
            said.append(f"worktree.copy: {pattern} is outside the repository — name a file "
                        f"by its path from the main checkout's root")
        elif GLOB_CHARS & set(pattern):
            judged += _matches(main, pattern, worktrees)
        else:
            judged.append(pattern)
    return said + _uncopyable(main, list(dict.fromkeys(judged)))


def _to_copy(main: Path, config: WorktreeConfig, worktrees: Path) -> tuple[list[str], list[str]]:
    """The files `worktree.copy` names that exist, and the patterns that named
    none — a missing one is skipped, and said, not refused. A match that may
    not be copied refuses the run while nothing is created yet."""
    found: list[str] = []
    missing: list[str] = []
    for pattern in config.copy_:
        matched = [] if _outside(pattern) else _matches(main, pattern, worktrees)
        found += [each for each in matched if each not in found]
        if not matched:
            missing.append(pattern)
    said = [f"worktree.copy: {pattern} is outside the repository"
            for pattern in config.copy_ if _outside(pattern)] + _uncopyable(main, found)
    if said:
        raise SystemExit("\n".join(said) + "\nNothing was created.")
    return found, missing


def _refuse_on_the_branch(main: Path, path: Path, branch: str, found: list[str]) -> None:
    """Judge each file again where it lands, by the BRANCH's ignore rules.

    `git add -A` in the worktree obeys the `.gitignore` the branch carries, and
    that need not be the checkout's: a fresh install's `.gitignore` edit that
    was never committed ignores `.env` here and not there. A file refused there
    is not copied, and the worktree — just made, nothing in it yet — goes with
    it; the branch is kept, as the record always is.
    """
    tracked = git_helper.tracked(path, found)
    ignored = git_helper.ignored(path, [each for each in found if each not in tracked])
    said = [f"worktree.copy: {each} is not gitignored on the branch {branch} — its commit "
            f"stage would commit it. Commit the .gitignore that ignores it, then run again"
            for each in found if each not in ignored]
    if said:
        git_helper.worktree_remove(main, path, force=True)
        raise SystemExit("\n".join(said) + f"\nThe worktree was removed; {branch} is kept.")


def _copy(main: Path, path: Path, found: list[str]) -> None:
    """Copy each file into the worktree: its contents, never a link to them.

    A copy is also a snapshot — an operator editing their `.env` mid-run does
    not change the run's — and a link through to a symlinked source is
    followed, so the worktree holds the bytes and not the way back.
    """
    for relative in found:
        source, target = main / relative, path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)


def _refuse_if_held(main: Path, branch: str) -> None:
    """git hands a branch to one worktree at a time, so a branch someone else
    has checked out cannot become this run's worktree — and `worktree add`
    says so as a raw error, a traceback in whatever watcher launched the run.

    The usual holder is the engineer's own checkout: fixing review feedback by
    hand on a session's branch is a natural thing to do. Nothing is lost by
    refusing — the branch is the record, and the run can go once it is free.
    Asked before the publish, so a refused run has touched nothing.
    """
    for entry in git_helper.worktree_list(main):
        if entry["branch"] == branch:
            raise SystemExit(
                f"{branch} is checked out at {entry['path']}, and git checks a branch "
                f"out in one place at a time — this run cannot re-create its worktree "
                f"from it. Nothing was created.\n"
                f"fix: commit or push what is there, `git checkout <another branch>` in "
                f"{entry['path']}, and run again")


def _publish(request: WorktreeRequest, branch: str, base_commit: str = "") -> None:
    """Under `worktree.publish: on_create`, the branch goes to the remote before
    the run starts — or the run is refused (`publish.on_create`)."""
    if request.publish_on_create and not request.isolated:
        publish.on_create(Path(request.main_root).resolve(), request.config, branch,
                          base_commit)


def _reattach(path: Path, main: Path, branch: str, meta: Path) -> Workspace:
    """Join the worktree an earlier ADW in this session created.

    The base ref is read back rather than re-derived: it was pinned when the
    session started, and re-deriving it now would measure against whatever the
    engineer's checkout has moved on to since.
    """
    if not git_helper.is_repo(path):
        raise RuntimeError(
            f"{path} exists but is not a git worktree — an earlier run left a "
            f"directory behind, or the path is in use. Move it aside, or pass a "
            f"fresh --adw-id.")
    recorded = _read_meta(meta)
    return Workspace(
        main_root=main,
        repo_root=path.resolve(),
        enabled=True,
        branch=recorded.get("branch") or git_helper.current_branch(path) or branch,
        base_ref=recorded.get("base_ref", ""),
        base_commit=recorded.get("base_commit", ""),
        created=False,
        # Only a setup that never finished is run again: a tree it finished in
        # has its dependencies, and one recorded before `setup` existed was
        # never owed any.
        setup_owed=bool(recorded.get("setup_owed", False)),
    )


def _read_meta(meta: Path) -> dict:
    try:
        return json.loads(meta.read_text())
    except (OSError, ValueError):
        return {}


def _write_meta(meta: Path, adw_id: str, workspace: Workspace) -> None:
    write_atomic(meta, json.dumps({
        "adw_id": adw_id,
        "path": str(workspace.repo_root),
        "branch": workspace.branch,
        "base_ref": workspace.base_ref,
        "base_commit": workspace.base_commit,
        "setup_owed": workspace.setup_owed,
        "created_at": now_iso(),
    }, indent=2))


# ── setup: the dependencies a fresh tree has to install ──────────────────────

def set_up(run) -> None:
    """Run `worktree.setup` in the run's worktree, when the tree is owed it.

    Owed once, by a tree this run created or re-created from its branch; a
    re-attached one already has its dependencies — unless the setup that ran
    when it was created failed, in which case it is owed still, and a resumed
    session pays it before anything else (`setup_owed` in the worktree's record).

    A code phase, because a known invocation is not an agent's to rediscover,
    and the FIRST phase, because a dependency that is not installed fails a
    check in a way that reads as a code failure — and a builder sent that
    failure starts fixing code that is not broken. So a command that fails ends
    the session here, as an environment failure, before any agent runs.
    """
    workspace, setup = run.workspace, run.cfg.worktree.setup
    if not workspace.setup_owed or not setup:
        return
    with run.phase(PhaseParams(
            name="setup", kind="code", owner="worktree",
            description="Install this worktree's dependencies with worktree.setup — a "
                        "fresh tree has the branch, not what the branch installs")) as ph:
        for index, argv in enumerate(setup, 1):
            _command(run, ph.phase.phase_id, index, argv)
        ph.log(ran=" · ".join(shlex.join(argv) for argv in setup))
    workspace.setup_owed = False
    meta = _meta_path(anchor(workspace.main_root, run.cfg.worktree.dir), run.adw_id)
    write_atomic(meta, json.dumps({**_read_meta(meta), "setup_owed": False}, indent=2))


def _command(run, phase_id: str, index: int, argv: list[str]) -> None:
    """One setup command in the worktree, with the operator's environment —
    quality.py's rules: an argv list, a bare binary name. Its output stays in
    the session's handoff directory; its tail travels on `command_finished`,
    as a quality block's does. Raises SystemExit when it fails."""
    command = shlex.join(argv)
    run.console.note(f"setup: {command}")
    clock = time.monotonic()
    try:
        done = subprocess.run(argv, cwd=run.repo_root, env=operator_env(), capture_output=True,
                              text=True, timeout=SETUP_TIMEOUT_SECONDS)
        code, output = done.returncode, done.stdout + done.stderr
    except subprocess.TimeoutExpired as error:
        code = 124
        output = f"{error.stdout or ''}{error.stderr or ''}\nTimed out after {error.timeout}s."
    except OSError as error:                 # a binary that is not there: exit 127
        code, output = 127, str(error)
    duration = time.monotonic() - clock
    log = ensure_dir(run.context_handoff_dir / "setup") / f"{index:02d}_{argv[0]}.log"
    write_atomic(log, f"$ {command}\nexit: {code}\nduration_seconds: {duration:.3f}\n\n{output}")
    run.tracer.event(CommandFinished(phase_id=phase_id, name="setup", argv=list(argv),
                                     exit_code=code, duration_seconds=round(duration, 3),
                                     output_tail=output[-RAW_TAIL_CHARS:]))
    if code != 0:
        raise SystemExit(f"worktree.setup: `{command}` exited {code} in {run.repo_root} — "
                         f"the environment, not the code, so no agent was asked to fix it. "
                         f"Fix it and resume the session; the full output is {log}\n"
                         f"{output[-SAID_TAIL_CHARS:]}".rstrip())


# ── lifecycle ────────────────────────────────────────────────────────────────

def release(workspace: Workspace) -> str:
    """Remove a finished run's worktree, but only when it is safe to.

    Safe means clean. A worktree with uncommitted or untracked work in it is the
    only copy of that work — a plan-only chain never commits, so its `plan.md`
    lives exactly there — and removing it to reclaim a few megabytes would be
    the same harm permissions.py exists to prevent. The branch survives either
    way, so a clean worktree is a copy and nothing is lost by dropping it.

    Returns the sentence the console and the trace show. Never raises: cleanup
    failing must not turn an accepted run into a failed one.
    """
    if not workspace.enabled:
        return "no worktree to release"
    try:
        if git_helper.is_dirty(workspace.repo_root):
            return (f"kept {workspace.repo_root} — uncommitted work on "
                    f"{workspace.branch}")
        git_helper.worktree_remove(workspace.main_root, workspace.repo_root)
        return f"removed {workspace.repo_root}; branch {workspace.branch} retained"
    except RuntimeError as error:
        return f"kept {workspace.repo_root} — {error}"


def remove(main_root, path, force: bool = False) -> str:
    """Delete one worktree by path. `force` also discards uncommitted work."""
    git_helper.worktree_remove(main_root, path, force=force)
    return f"removed {path}"


def inventory(main_root, config: WorktreeConfig, sessions_dir: str = "") -> list[WorktreeInfo]:
    """Every run worktree on disk, with the state of the run that owns it.

    "Left behind" and "orphaned" are different things: a killed run keeps its
    worktree on purpose, and git has no idea whether the process that made this
    directory is still alive. The runs' own records say so — one `run.json` per
    session. Statuses come from there; git supplies the paths.
    """
    root = anchor(main_root, config.dir)
    statuses = artifacts.statuses(Path(sessions_dir)) if sessions_dir else {}
    found: list[WorktreeInfo] = []
    for entry in git_helper.worktree_list(main_root):
        path = Path(entry["path"])
        branch = entry.get("branch", "")
        mine = branch.startswith(config.branch_prefix) or root in path.parents
        if not mine or path.resolve() == Path(main_root).resolve():
            continue
        adw_id = (branch.removeprefix(config.branch_prefix) if branch.startswith(config.branch_prefix)
                  else path.name)
        prunable = bool(entry.get("prunable"))
        found.append(WorktreeInfo(
            path=str(path), branch=branch, adw_id=adw_id, prunable=prunable,
            dirty=(not prunable and path.is_dir() and git_helper.is_dirty(path)),
            status=statuses.get(adw_id, "unknown"),
        ))
    return found


def reclaimable(info: WorktreeInfo, force: bool = False) -> bool:
    """Whether cleanup may take this worktree. Conservative on purpose.

    A run that has not ended is still using its tree. A tree holding
    uncommitted work is the only copy of that work. `force` overrides only the
    second — nothing reclaims a worktree out from under a live run.
    """
    if info.status not in ENDED:
        return False
    return force or not info.dirty

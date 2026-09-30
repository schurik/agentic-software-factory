"""A session's branch on the remote BEFORE anything is integrated.

A cockpit never reads a session's files off a station. It renders a gate's
subject from the forge, at exactly the commit the question was asked about —
the plan at `head_sha`, the diff as `base_commit…head_sha` — so a person
approves what the agent produced and not whatever the branch tip has become
since. That only works when those two commits are ON the forge, and until now
a session's branch went there in one place: the integrate stage, after every gate
had already been answered.

So publishing is its own decision, `worktree.publish`, with two answers:

  * **`on_create`** — the branch is pushed as the session starts and again
    before every suspend, and the gate's subject is committed first, so
    `head_sha` in `suspended` is a commit the remote has and the subject is in
    its tree.
  * **`on_integrate`** — nothing leaves the machine until an integrate stage
    pushes it. The factory behaves exactly as it did before this module, and a
    cockpit cannot show what that session's gates ask about.

Landing the branch is still `engine/integration.py`. Nothing here merges, opens
a pull request, or decides what happens to the work — it keeps a copy readable.
"""

from __future__ import annotations

from pathlib import Path

from . import cockpit as local_cockpit
from . import git_helper
from .data_types import FactoryConfig, Phase, PublishMode, Workspace, WorktreeConfig
from .utils import anchor

ON_CREATE: PublishMode = "on_create"
ON_INTEGRATE: PublishMode = "on_integrate"


def resolve(cfg: FactoryConfig, main_root: Path) -> tuple[PublishMode, str]:
    """(`on_create` | `on_integrate`, why) for this factory as it stands now.

    `worktree.publish` decides when it is set. Unset, the answer follows the
    one thing that needs a branch on the forge early: a cockpit. One is
    configured when ASF_COCKPIT_URL names a shared one, or when the machine's
    local cockpit has issued this factory a token — `asf up` started it, and it
    reads the forge exactly as a shared one does. Without either, nothing reads
    the branch before it is integrated, and nothing is pushed before then.

    `integration.mode: none` is the exception to the default, never to the
    setting: a repository that said its branches stay on this machine does not
    start pushing them because a cockpit appeared. It says `on_create` itself.
    """
    if cfg.worktree.publish:
        return cfg.worktree.publish, "worktree.publish"
    if cfg.worktree.integration.mode == "none":
        return ON_INTEGRATE, "the default under worktree.integration.mode: none"
    data_dir = anchor(main_root, cfg.defaults.data_dir)
    if local_cockpit.shared() or local_cockpit.has_issued_token(data_dir):
        return ON_CREATE, "the default once a cockpit is configured"
    return ON_INTEGRATE, "the default without a cockpit"


def mode(cfg: FactoryConfig, main_root: Path) -> PublishMode:
    return resolve(cfg, main_root)[0]


def publishes(cfg: FactoryConfig, workspace: Workspace) -> bool:
    """Whether this session's branch is one this module keeps on the remote:
    `on_create`, a branch of its own to keep there, and a remote to keep it on.

    Asked of the config and the checkout, never of `refs/remotes/…`. A clone
    with a narrowed fetch refspec (`--single-branch`, `--depth`) keeps no
    remote-tracking ref for a branch it pushes, so that ref going missing says
    nothing about what the remote holds — and a session that decided from it
    would stop committing its gates' subjects without a word.
    """
    return (workspace.enabled and mode(cfg, workspace.main_root) == ON_CREATE
            and git_helper.has_remote(workspace.main_root, cfg.worktree.integration.remote))


# ── as the session starts ────────────────────────────────────────────────────

def on_create(main_root: Path, config: WorktreeConfig, branch: str,
              base_commit: str = "") -> None:
    """Put the session's branch on the remote, or refuse the run.

    THE PINNED BASE MUST BE ON THE REMOTE, and this is where it gets there. A
    new branch is pushed as `<base_commit>:refs/heads/<branch>` BEFORE the
    worktree or the local branch exists: the base a session is cut from is
    often ahead of anything the remote has (an engineer's unpushed `main`), and
    a comparison against a commit the forge has never seen cannot be drawn. A
    push that fails is therefore a refusal, raised while the repository is
    still untouched — no branch, no worktree, no session to clean up after.

    A branch that already exists here (a joined session, a rerun whose worktree
    was pruned) is pushed as it stands — unless its remote-tracking ref says it
    has been pushed before, which keeps a resume off the network. That ref
    proves presence and its absence proves nothing, so without one the push is
    made: it is how a session begun under `on_integrate` gets there.

    No remote of that name is not a refusal. There is nowhere to publish to, the
    run is the run it always was, and `preflight.publishing` has said so.
    """
    remote = config.integration.remote
    if not git_helper.has_remote(main_root, remote):
        return
    if not base_commit and git_helper.remote_tip(main_root, remote, branch):
        return
    source = f"{base_commit}:refs/heads/{branch}" if base_commit else branch
    pushed = git_helper.push(main_root, remote, source, set_upstream=False)
    if pushed.returncode != 0:
        raise SystemExit(
            f"cannot publish {branch} to {remote}: {pushed.stderr.strip()}\n"
            f"worktree.publish is on_create, so a session's branch — and the commit it "
            f"is cut from — has to be on the remote before the run starts: a cockpit "
            f"reads a gate's subject there. Nothing was created.\n"
            f"fix: make `git push {remote} {source}` work, or set `worktree.publish: "
            f"on_integrate` in asf/factory.yaml to keep a branch local until it is "
            f"integrated")


# ── before a suspend ─────────────────────────────────────────────────────────

def before_suspend(run, phase: Phase, message: str) -> None:
    """Commit what the gate is asking about, and push it. Never raises.

    The subject of a gate is usually NOT committed when the gate fires: a plan
    gate sits before the stage that commits the plan, and a checkpoint sits
    before the checks that decide whether the build is worth committing. So the
    tree is committed here, whole, and `head_sha` — read a moment later, as the
    phase closes — names a commit whose tree holds the subject. A commit stage
    that follows finds the tree clean and says so; that is a resumed run, and
    `allow_clean` already covers it.

    Through `run.commit`, so the `committed` event a cockpit reads repo
    artifacts by is written for this commit like any other. The push follows
    whether or not there was anything to commit: what the remote must hold is
    the branch as it stands, and an earlier push may have failed.

    A run about to wait must not die committing or pushing: whatever goes wrong
    is a note, the suspend happens anyway, and a cockpit shows the gate as one
    whose subject it cannot read.
    """
    if not publishes(run.cfg, run.workspace):
        return
    workspace = run.workspace
    remote = run.cfg.worktree.integration.remote
    try:
        sha = run.commit(phase, message, allow_clean=True)
    except RuntimeError as error:
        run.console.note(f"! could not commit what this gate asks about: {error}")
        return
    if sha:
        run.console.note(f"committed what this gate asks about as {sha}")
    pushed = git_helper.push(workspace.main_root, remote, workspace.branch, set_upstream=False)
    if pushed.returncode != 0:
        run.console.note(f"! could not push {workspace.branch} to {remote} — a cockpit "
                         f"cannot show what this gate asks about: "
                         f"{pushed.stderr.strip()[-300:]}")
        return
    run.console.note(f"pushed {workspace.branch} to {remote}")


# ── when the session ends ────────────────────────────────────────────────────

def withdraw(run) -> str:
    """Take the session's branch off the remote again. Returns the sentence the
    console shows, "" when there was nothing to do. Never raises.

    Called when a session is aborted, and when it finishes accepted. A branch
    published for a cockpit to read is a copy, and once the session is over
    there is nothing left for anyone to read there: left behind, it is one more
    stale branch on the forge per session. A FAILED session is not over —
    `resume` picks it up, and a cockpit still shows where it stopped — so
    nothing calls this for one. The LOCAL branch is never touched: it is the
    record, and pushing it again is one command.

    AN INTEGRATED BRANCH STAYS — `integrated` says how that is known, and what
    it cannot know.
    """
    if not publishes(run.cfg, run.workspace) or integrated(run):
        return ""
    workspace = run.workspace
    remote = run.cfg.worktree.integration.remote
    deleted = git_helper.delete_remote_branch(workspace.main_root, remote, workspace.branch)
    if deleted.returncode == 0:
        return f"deleted {remote}/{workspace.branch}; the local branch is kept"
    if "remote ref does not exist" in deleted.stderr:
        return ""                         # never published, or already withdrawn
    return (f"could not delete {remote}/{workspace.branch}: "
            f"{deleted.stderr.strip()[-300:]} — `git push {remote} --delete "
            f"{workspace.branch}` removes it by hand")


def integrated(run) -> bool:
    """Whether this session's work went somewhere its remote branch is still
    needed for. Read off the session and the repository, by any process of the
    session, with nothing new to record:

      * **It has a pull request.** `run.pr_url` — opened by an integration, or
        learned by a review run. Deleting the head of an open pull request
        closes it, which is the one thing `withdraw` must never do.
      * **Its branch tracks its remote counterpart.** An integration's push
        sets that (`push -u`), and so does a person who pushed it by hand;
        every push this module makes, and `integration.keep_published`, leaves
        it unset. So `open_pr: false` — pushed, the pull request left to a
        person — still reads as proposed, in a later process too.
      * **Its commits are on the base branch.** A merge landed them, and a
        cockpit reads this session's files at those commits, which reach the
        forge on their own branch until the base branch is pushed.

    WHAT THIS CANNOT SEE is a pull request opened on the forge, from its own
    page or another clone, while the session was still working: nothing here
    records it, and an accepted finish or an abort deletes the branch under it.
    A review run on that pull request records it (`Run.record_pull_request`),
    and so does pushing the branch with `-u`.
    """
    workspace = run.workspace
    tree = workspace.main_root
    if run.pr_url or git_helper.tracks(tree, workspace.branch,
                                       run.cfg.worktree.integration.remote):
        return True
    try:
        head = git_helper.rev(tree, workspace.branch)
    except RuntimeError:
        return False
    return head != workspace.base_commit and git_helper.is_ancestor(
        tree, head, workspace.base_ref)

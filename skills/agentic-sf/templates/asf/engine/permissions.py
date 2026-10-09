"""What an agent may CHANGE, enforced in code after the fact.

`tools:` is a capability list, not a sandbox, and two holes make it
unenforceable on its own:

  * `bash` runs anything. A builder handed bash to run a test suite can also
    run `git checkout asf/` — which is not hypothetical: one did, discarding
    uncommitted changes to the very quality check it was about to be judged by.
  * `write` reaches any path, not just the one report file an agent was given
    it for. A reviewer configured with "no edit, so it cannot quietly fix"
    could still rewrite the code it was reviewing.

So permission is verified the way every other claim in this system is —
after the fact, against the repo itself. `snapshot()` fingerprints the working
tree's change-set before an agent runs; `enforce()` compares it afterwards and
fails the phase if the agent touched anything outside its allowlist.

Comparing change-sets, rather than watching for writes, is what catches the
`git checkout` case: a path that was modified before the agent ran and is clean
afterwards has been reverted, and a reversion is a modification. Appearing,
disappearing, and changing all count.

A breach is NOT a gate violation. Gates are for work an agent can be asked to
redo; a breach cannot be corrected by re-prompting, because the write already
happened. It aborts the phase and names every offending path.

Two keys drive it:
    protected_files      factory.yaml: paths no agent may touch unless it names them itself
    writes               an agent.md: None = unrestricted · [] = read-only · [...] = only these
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .data_types import AgentConfig, FactoryConfig


class PermissionBreach(RuntimeError):
    """An agent modified a path it was not permitted to modify."""


def _git(args: list[str], cwd) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def snapshot(run) -> dict[str, str]:
    """Fingerprint every path the working tree currently differs on.

    Tracked files carry their numstat counts, so an edit to an already-dirty
    file still registers as a change. Untracked files are listed by name.
    Gitignored paths never appear, which is why the session runtime under
    `data_dir` — where handoff files legitimately land — needs no special case.

    Every path is read with `-z`, so it is the path as it is on disk. Without
    it git quotes and octal-escapes whatever it finds unusual (`plän.md` comes
    back as `"pl\\303\\244n.md"`), and that string matches no `writes:` rule and
    names no file: an agent was refused a file it was allowed to write, and the
    rollback of one it was not allowed undid nothing. `--no-renames` keeps one
    record per path: a staged move is otherwise a single record naming both
    ends, which a `writes:` prefix matched by where the file CAME from — so
    `git mv` out of an allowed directory carried a file past the boundary. A
    moved file is a path that vanished and a path that appeared.
    """
    fingerprints: dict[str, str] = {}
    for record in _git(["diff", "HEAD", "--numstat", "--no-renames", "-z"],
                       run.repo_root).split("\0"):
        fields = record.split("\t", 2)
        if len(fields) == 3:
            added, removed, path = fields
            fingerprints[path] = f"{added},{removed}"
    for path in _git(["ls-files", "--others", "--exclude-standard", "-z"],
                     run.repo_root).split("\0"):
        if path:
            fingerprints[path] = "untracked"
    return fingerprints


def changed_paths(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Every path whose state differs — appeared, vanished, or was rewritten."""
    return sorted({p for p in set(before) | set(after)
                   if before.get(p) != after.get(p)})


def _glob(pattern: str) -> re.Pattern:
    """Translate a pattern, with `*` stopping at a path separator.

    fnmatch would let `*` cross `/`, which quietly widens every pattern:
    `asf/asf.py` would match `asf/data/sessions/x/y.py` as well as the
    ADW scripts it means. `**` is the way to say "cross directories".
    """
    out, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif char == "*":
            out.append("[^/]*")
            i += 1
        elif char == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(char))
            i += 1
    return re.compile("".join(out))


def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):                      # directory prefix
        return path.startswith(pattern)
    if "*" in pattern or "?" in pattern:
        return _glob(pattern).fullmatch(path) is not None
    return path == pattern


def always_writable(cfg: FactoryConfig) -> list[str]:
    """The session runtime, which EVERY agent must be able to write.

    `context_handoff/` is the one place agents hand work to each other, and an
    agent's own prompts, raw_output.jsonl, and envelope.json land beside it.
    Scout writes its findings there, the reviewer its review, the planner its
    plan — a read-only agent is read-only with respect to the REPO, never with
    respect to its own report.

    This is granted from `data_dir` rather than left to .gitignore. The runtime
    is normally ignored, so it never even appears in a snapshot — but an agent's
    ability to record its work must not hang on a gitignore entry that someone
    can delete or that a changed `data_dir` can outgrow.

    **Under a worktree per run this grant is inert, and that is correct.**
    `data_dir` is anchored to the MAIN checkout while the snapshot measures the
    run's worktree, so a runtime path can no longer appear in the change-set
    this module compares — there is nothing left for the exemption to exempt.
    It stays because it is still load-bearing whenever the two roots are the
    same directory: worktrees disabled, or a repository with no commit to
    branch from. Delete it and a `writes: []` agent in that configuration loses
    the ability to write its own report.
    """
    return [cfg.data_dir.rstrip("/") + "/"]


def permitted(path: str, agent: AgentConfig, cfg: FactoryConfig) -> bool:
    """Session runtime first, then the agent's own list, then what is protected."""
    if any(_matches(path, p) for p in always_writable(cfg)):
        return True
    if any(_matches(path, p) for p in (agent.writes or [])):
        return True                      # naming a path is what unlocks a protected one
    if any(_matches(path, p) for p in cfg.protected_files):
        return False
    return agent.writes is None          # None = unrestricted, [] = no repo writes


def _roll_back(run, path: str, before: dict[str, str], after: dict[str, str]) -> str:
    """Undo one unauthorized change. Returns a word describing what happened.

    Only changes the agent INTRODUCED are undone. A path that was already dirty
    when the agent started is left exactly as it is: the operator had
    uncommitted work there, and discarding it to tidy up would be the same harm
    this module exists to prevent, committed by the cleanup instead of the agent.

    What "undo" means is decided by HEAD, not by how the path shows up in the
    snapshot, because an agent with `bash` can stage what it did. A path HEAD
    holds is restored FROM HEAD, index and tree both: `git checkout -- path`
    restores from the index, which for a staged edit is the agent's own version
    and for a `git rm` is nothing at all. A path HEAD never held was created by
    the agent, so it leaves the index as well as the disk — left staged, it
    would be reported as undone and then landed by the next commit stage's
    `git add -A`.

    One path at a time, and only the paths that breached. A file moved out of
    the agent's boundary is removed where it arrived; that it is gone from
    where it left is a deletion inside the boundary, which the agent is allowed
    to make, and the file is still in HEAD for whoever wants it back.
    """
    if path in before:
        # Already dirty beforehand. If it is gone from the diff now, the agent
        # reverted an engineer's uncommitted work and the content is not ours
        # to reconstruct — say so loudly rather than pretend it was handled.
        return "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)" \
            if path not in after else "left as-is (was already modified)"

    def git(*args: str) -> bool:
        return subprocess.run(["git", *args], cwd=run.repo_root,
                              capture_output=True, text=True).returncode == 0

    if git("cat-file", "-e", f"HEAD:{path}"):
        return "rolled back" if git("checkout", "HEAD", "--", path) else "could not roll back"
    git("rm", "--cached", "--force", "--quiet", "--", path)     # a no-op for a path never staged
    try:
        (Path(run.repo_root) / path).unlink()
        return "deleted"
    except OSError as error:
        return f"could not delete ({error})"


def enforce(run, phase, agent: AgentConfig, before: dict[str, str]) -> list[str]:
    """Compare the tree against `before`; undo and raise if the agent overstepped.

    Returns the paths it legitimately changed, so the trace records what an
    agent actually touched rather than only what it claimed in its envelope.

    Detection alone would leave the repo holding the unauthorized change while
    reporting a failure, so anything the agent introduced outside its allowlist
    is rolled back before the phase dies. What it cannot undo, it names.
    """
    after = snapshot(run)
    touched = changed_paths(before, after)
    breaches = [p for p in touched if not permitted(p, agent, run.cfg)]
    if not breaches:
        return touched

    outcomes = {p: _roll_back(run, p, before, after) for p in breaches}
    scope = ("read-only" if agent.writes == []
             else f"limited to {agent.writes}" if agent.writes
             else f"barred from {run.cfg.protected_files}")
    detail = "\n".join(f"  - {p} — {outcome}" for p, outcome in outcomes.items())
    raise PermissionBreach(
        f"{agent.name} is {scope} but modified {len(breaches)} path(s):\n{detail}")

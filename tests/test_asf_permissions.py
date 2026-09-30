"""The write boundary, end to end, for the paths git does not print as they are.

`permissions.py` learns what an agent changed by asking git, and git quotes and
octal-escapes any path it finds unusual unless it is told not to: `plän.md`
comes back as `"pl\\303\\244n.md"`. A boundary that compares that string with a
`writes:` rule refuses a file the agent was allowed to write, and a rollback
that hands it back to the filesystem undoes nothing. Both are shown here on the
fake harness, in a real worktree.

A staged move is the third such spelling: one record, `old => new`, that a
prefix rule matched by the end the file left.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from engine import events, permissions
from engine.data_types import AgentConfig, FactoryConfig, PromptEngineering

from .asf_helpers import (adw_id_of, asf, commit_all, db_rows, envelope, fake_roster, git,
                          session_dir, write_workflow)


def test_an_agent_may_write_a_file_with_a_non_ascii_name_inside_its_boundary(stamped: Path):
    # The planner's `writes:` is `docs/asf/spec/`, and this is a file under it.
    fake_roster(stamped, planner=[{
        "writes": {"docs/asf/spec/plän.md": "# Plan\n"},
        "envelope": envelope(artifacts=["docs/asf/spec/plän.md"], commit_message="docs: plan")}])
    write_workflow(stamped, "planned", {
        "description": "a plan, written and committed",
        "stages": [{"plan": {}}, {"commit": {"of": "plan"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "planned", "plan the thing")

    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    assert git(stamped, "show", f"asf/{adw_id}:docs/asf/spec/plän.md") == "# Plan"
    # What the trace says the planner touched is the path, not git's spelling of it.
    [touched] = db_rows(stamped, "select payload_json from events "
                                 f"where adw_id='{adw_id}' and name='paths_touched'")
    assert json.loads(touched[0])["paths"] == ["docs/asf/spec/plän.md"]


def test_a_read_only_agent_s_changes_to_files_with_non_ascii_names_are_undone(stamped: Path):
    (stamped / "docs").mkdir(exist_ok=True)
    (stamped / "docs" / "café.md").write_text("as the engineer left it\n")
    # The scout's `writes:` is `[]`: a new file and an edit to a tracked one are both breaches.
    fake_roster(stamped, scout=[{
        "writes": {"notes/résumé.md": "left behind\n", "docs/café.md": "rewritten\n"},
        "envelope": envelope(findings=[], artifacts=[])}])
    write_workflow(stamped, "scouted", {
        "description": "a scout that oversteps",
        "stages": [{"scout": {}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "scouted", "look around")

    assert result.returncode == 1, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    worktree = stamped / ".asf-worktrees" / adw_id          # kept: the run failed
    assert not (worktree / "notes" / "résumé.md").exists()
    assert (worktree / "docs" / "café.md").read_text() == "as the engineer left it\n"
    [ended] = [line.payload for line in events.read(session_dir(stamped, adw_id))
               if line.kind == "phase_ended" and line.payload["name"] == "scout"]
    assert ended["status"] == "fail"
    assert ended["error"] == ("scout is read-only but modified 2 path(s):\n"
                              "  - docs/café.md — rolled back\n"
                              "  - notes/résumé.md — deleted")


# ── what an agent STAGED ─────────────────────────────────────────────────────
#
# `git add`, `git rm` and `git mv` are one line of bash each, and the scripted
# harness has no bash — so these drive the boundary directly, in a real
# repository, the way `agents.execute` does around a call.

def boundary(repo: Path, writes: list[str]) -> tuple[SimpleNamespace, AgentConfig]:
    """The two things `enforce` reads: where the tree is, and what may be written."""
    run = SimpleNamespace(repo_root=repo, cfg=FactoryConfig())
    agent = AgentConfig(name="scout", writes=writes,
                        prompt_engineering=PromptEngineering(system="agent.md"))
    return run, agent


def test_a_new_file_an_agent_staged_outside_its_boundary_leaves_the_tree_and_the_index(
        repo: Path):
    run, scout = boundary(repo, writes=[])
    before = permissions.snapshot(run)
    (repo / "naïve.py").write_text("x = 1\n")
    git(repo, "add", "naïve.py")

    with pytest.raises(permissions.PermissionBreach) as breach:
        permissions.enforce(run, None, scout, before)

    assert str(breach.value) == ("scout is read-only but modified 1 path(s):\n"
                                 "  - naïve.py — deleted")
    assert not (repo / "naïve.py").exists()
    assert git(repo, "status", "--porcelain") == ""       # nothing left for `git add -A` to land


def test_a_staged_edit_and_a_staged_deletion_of_tracked_files_are_restored_from_head(
        repo: Path):
    (repo / "kept.md").write_text("as committed\n")
    (repo / "gone.md").write_text("as committed\n")
    commit_all(repo)
    run, scout = boundary(repo, writes=[])
    before = permissions.snapshot(run)
    (repo / "kept.md").write_text("rewritten\n")
    git(repo, "add", "kept.md")
    git(repo, "rm", "-q", "gone.md")

    with pytest.raises(permissions.PermissionBreach) as breach:
        permissions.enforce(run, None, scout, before)

    assert str(breach.value) == ("scout is read-only but modified 2 path(s):\n"
                                 "  - gone.md — rolled back\n"
                                 "  - kept.md — rolled back")
    assert (repo / "kept.md").read_text() == "as committed\n"
    assert (repo / "gone.md").read_text() == "as committed\n"
    assert git(repo, "status", "--porcelain") == ""


def test_a_file_moved_out_of_an_agent_s_boundary_is_a_breach_at_the_path_it_landed_on(
        repo: Path):
    (repo / "docs" / "asf" / "spec").mkdir(parents=True)
    (repo / "docs" / "asf" / "spec" / "plan.md").write_text("# Plan\n\n1. one\n2. two\n")
    (repo / "asf" / "engine").mkdir(parents=True)
    (repo / "asf" / "engine" / "gates.py").write_text("GATES = []\n")
    commit_all(repo)
    run, planner = boundary(repo, writes=["docs/asf/spec/"])
    before = permissions.snapshot(run)

    git(repo, "mv", "docs/asf/spec/plan.md", "asf/engine/plän.py")

    # One record naming both paths would start with the directory the planner
    # may write, and pass. Two records do not: leaving is allowed, arriving is not.
    with pytest.raises(permissions.PermissionBreach) as breach:
        permissions.enforce(run, None, planner, before)
    assert str(breach.value) == ("scout is limited to ['docs/asf/spec/'] but modified "
                                 "1 path(s):\n  - asf/engine/plän.py — deleted")
    assert not (repo / "asf" / "engine" / "plän.py").exists()
    # Where it left is inside the boundary, and deleting there is the planner's
    # to do: that half stands, and the plan is still what HEAD says it is.
    assert git(repo, "status", "--porcelain") == "D  docs/asf/spec/plan.md"
    assert git(repo, "show", "HEAD:docs/asf/spec/plan.md").startswith("# Plan")

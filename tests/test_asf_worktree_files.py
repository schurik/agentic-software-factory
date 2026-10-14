"""What a session's worktree gets that its branch cannot give it: the operator's
gitignored files (`worktree.copy`), and its dependencies (`worktree.setup`).

A worktree is cut from a branch, so anything gitignored in the operator's
checkout — `.env`, local keys, `node_modules` — is missing there, and a check
that needs one fails in a way that reads as a code failure. Proven through the
CLI, on a real install and the fake harness.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from engine import events

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster,
                          git, phase_names, phase_rows, run_state, session_dir, set_config, wire)


def build_reply(writes: dict[str, str]) -> dict:
    return {"writes": {"app.py": "ok = 1\n", **writes},
            "envelope": envelope(changed_files=["app.py"], commit_message="feat: app")}


def prepare(stamped: Path, worktree: dict, writes: dict[str, str] | None = None) -> None:
    """A quick workflow whose worktree is kept, so a test can look inside it."""
    fake_roster(stamped, builder=[build_reply(writes or {})] * 3)
    wire(stamped, "test", PY_CHECK)
    set_config(stamped, worktree={"keep_on_success": True, **worktree})
    commit_all(stamped)


def test_a_new_worktree_gets_a_copy_of_the_env_never_a_symlink(stamped: Path):
    (stamped / ".env").write_text("SECRET=operator\n")
    prepare(stamped, {"copy": [".env"]})

    result = asf(stamped, "run", "quick", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    copied = stamped / ".asf-worktrees" / adw_id_of(result) / ".env"

    assert copied.is_file() and not copied.is_symlink()
    assert copied.read_text() == "SECRET=operator\n"
    # The commit stage ran `git add -A` in that worktree, and left it out.
    landed = git(stamped, "show", "--name-only", "--format=", f"asf/{adw_id_of(result)}")
    assert landed.splitlines() == ["app.py"]


def test_an_agent_writing_the_worktree_s_env_leaves_the_operator_s_unchanged(stamped: Path):
    # Gitignored, so permissions.py's diff never sees the write: a symlink here
    # would hand the agent the operator's real file, and nothing would undo it.
    (stamped / ".env").write_text("SECRET=operator\n")
    prepare(stamped, {"copy": [".env"]}, writes={".env": "SECRET=agent\n"})

    result = asf(stamped, "run", "quick", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr

    assert (stamped / ".asf-worktrees" / adw_id_of(result) / ".env").read_text() == \
        "SECRET=agent\n"
    assert (stamped / ".env").read_text() == "SECRET=operator\n"


def test_a_listed_file_the_checkout_lacks_is_skipped_and_named(stamped: Path):
    (stamped / ".env").write_text("SECRET=operator\n")
    (stamped / ".gitignore").write_text((stamped / ".gitignore").read_text() + ".env.local\n")
    prepare(stamped, {"copy": [".env", ".env.local"]})

    result = asf(stamped, "run", "quick", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr

    assert "copied into the worktree: .env" in result.stdout
    assert "not in the main checkout, so not copied: .env.local" in result.stdout


def test_a_worktree_re_created_from_its_branch_gets_its_files_again(stamped: Path):
    # The branch is the record and a clean worktree a copy of it: pruned on
    # success, rebuilt by the session's next run — and a rebuilt one must not
    # come back without its `.env`.
    (stamped / ".env").write_text("SECRET=operator\n")
    fake_roster(stamped, builder=[
        {"writes": {"app.py": f"ok = {n}\n"},
         "envelope": envelope(changed_files=["app.py"], commit_message=f"feat: app {n}")}
        for n in (1, 2)])
    wire(stamped, "test", PY_CHECK)
    set_config(stamped, worktree={"copy": [".env"]})
    commit_all(stamped)
    first = asf(stamped, "run", "quick", "add app.py")
    assert first.returncode == 0, first.stdout + first.stderr
    adw_id = adw_id_of(first)
    tree = stamped / ".asf-worktrees" / adw_id
    assert not tree.exists()                                    # pruned on success

    set_config(stamped, worktree={"keep_on_success": True})
    again = asf(stamped, "run", "quick", "change app.py", "--adw-id", adw_id)
    assert again.returncode == 0, again.stdout + again.stderr

    assert (tree / ".env").read_text() == "SECRET=operator\n"


@pytest.mark.parametrize("entry, why", [
    ("README.md", "is tracked"),                     # the worktree has it already
    ("notes.txt", "is not gitignored"),              # `git add -A` would commit it
    ("../secrets.env", "is outside the repository"),
    ("/etc/hosts", "is outside the repository"),
])
def test_check_and_doctor_refuse_a_copy_entry_a_commit_could_carry(stamped: Path, entry, why):
    (stamped / "notes.txt").write_text("not ignored\n")
    set_config(stamped, worktree={"copy": [".env", entry]})

    check = asf(stamped, "check")
    assert check.returncode == 1
    assert f"worktree.copy: {entry} {why}" in check.stdout

    doctor = asf(stamped, "doctor")
    assert doctor.returncode == 1
    assert f"worktree.copy: {entry} {why}" in doctor.stdout + doctor.stderr


def test_a_glob_is_checked_by_what_it_matches(stamped: Path):
    (stamped / ".gitignore").write_text((stamped / ".gitignore").read_text() + "*.local\n")
    (stamped / ".env.local").write_text("A=1\n")
    (stamped / ".env.example").write_text("A=\n")       # matched, and not gitignored
    set_config(stamped, worktree={"copy": [".env*"]})

    check = asf(stamped, "check")
    assert check.returncode == 1
    assert "worktree.copy: .env.example is not gitignored" in check.stdout
    assert ".env.local" not in check.stdout


@pytest.mark.parametrize("argv, why", [
    (["/usr/local/bin/bun", "install"], "names its binary by path"),
    ([], "is empty"),
])
def test_check_refuses_a_setup_command_quality_py_would_not_accept(stamped: Path, argv, why):
    set_config(stamped, worktree={"setup": [argv]})

    check = asf(stamped, "check")
    assert check.returncode == 1
    assert f"worktree.setup: {argv} {why}" in check.stdout


# `cp` because it is on every machine the suite runs on, by its bare name — and
# copying the `.env` is the proof that setup ran after `copy` did.
SAW_ENV = ["cp", ".env", ".setup-saw-env"]


def ignore(stamped: Path, *names: str) -> None:
    (stamped / ".gitignore").write_text((stamped / ".gitignore").read_text()
                                        + "".join(f"{name}\n" for name in names))


def test_setup_runs_in_the_new_worktree_after_copy_before_any_agent(stamped: Path):
    (stamped / ".env").write_text("SECRET=operator\n")
    ignore(stamped, ".setup-saw-env")
    prepare(stamped, {"copy": [".env"], "setup": [SAW_ENV]})

    result = asf(stamped, "run", "quick", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)

    assert (stamped / ".asf-worktrees" / adw_id / ".setup-saw-env").read_text() == \
        "SECRET=operator\n"
    assert not (stamped / ".setup-saw-env").exists()           # in the worktree, not here
    assert phase_names(stamped, adw_id) == ["setup", "request", "implement", "verify_1",
                                            "commit_implement"]


def test_a_failing_setup_command_ends_the_session_before_any_agent_runs(stamped: Path):
    prepare(stamped, {"setup": [["git", "no-such-subcommand"]]})

    result = asf(stamped, "run", "quick", "add app.py")
    assert result.returncode == 1
    adw_id = adw_id_of(result)

    assert phase_rows(stamped, adw_id) == [(1, "setup", "fail")]
    assert "git no-such-subcommand" in result.stdout + result.stderr
    told = events.read(session_dir(stamped, adw_id))
    [finished] = [row.payload for row in told if row.kind == "workflow_finished"]
    assert finished["status"] == "fail" and "no-such-subcommand" in finished["reason"]
    assert run_state(stamped, adw_id)["status"] == "fail"
    # An environment failure, said as one: the setup command is on the record,
    # and no check ever ran for a builder to be sent.
    assert [row.payload["name"] for row in told if row.kind == "command_finished"] == ["setup"]


def test_a_joined_run_re_attaches_without_setting_up_again(stamped: Path):
    (stamped / ".env").write_text("SECRET=operator\n")
    ignore(stamped, ".setup-saw-env")
    fake_roster(stamped, builder=[
        {"writes": {"app.py": f"ok = {n}\n"},
         "envelope": envelope(changed_files=["app.py"], commit_message=f"feat: app {n}")}
        for n in (1, 2)])
    wire(stamped, "test", PY_CHECK)
    set_config(stamped, worktree={"keep_on_success": True, "setup": [SAW_ENV]})
    commit_all(stamped)
    adw_id = adw_id_of(asf(stamped, "run", "quick", "add app.py"))

    joined = asf(stamped, "run", "quick", "change app.py", "--adw-id", adw_id)
    assert joined.returncode == 0, joined.stdout + joined.stderr

    assert phase_names(stamped, adw_id).count("setup") == 1


def test_a_setup_that_failed_is_still_owed_when_the_session_resumes(stamped: Path):
    ignore(stamped, ".setup-saw-env")
    prepare(stamped, {"setup": [["git", "no-such-subcommand"]]})
    adw_id = adw_id_of(asf(stamped, "run", "quick", "add app.py"))

    set_config(stamped, worktree={"setup": [SAW_ENV]})        # the operator fixes it
    resumed = asf(stamped, "run", "quick", "add app.py", "--adw-id", adw_id, "--resume")
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr

    assert (stamped / ".asf-worktrees" / adw_id / ".setup-saw-env").is_file()
    assert phase_rows(stamped, adw_id)[0] == (1, "setup", "success")


def test_a_file_only_the_checkout_s_uncommitted_gitignore_ignores_is_refused(stamped: Path):
    # `git add -A` in the worktree obeys the BRANCH's ignore rules. A fresh
    # install's `.gitignore` edit that was never committed ignores the file
    # here and not there — so the copy is judged in the worktree too, and a
    # refused one leaves no worktree behind.
    prepare(stamped, {"copy": [".env.local"]})
    ignore(stamped, ".env.local")                            # ...and never committed
    (stamped / ".env.local").write_text("SECRET=operator\n")

    result = asf(stamped, "run", "quick", "add app.py")
    assert result.returncode == 1
    assert "worktree.copy: .env.local is not gitignored on the branch" in result.stderr
    assert not any((stamped / ".asf-worktrees").glob("*/.env.local"))
    assert not [path for path in (stamped / ".asf-worktrees").iterdir() if path.is_dir()]

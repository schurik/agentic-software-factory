"""`asf benchmark run <name>`: each task worked again, N times per variant.

Through the seam a person meets it by — the `asf` CLI in a stamped repo, on the
fake harness, with the `gh` stand-in recording every forge call and a bare
origin standing in for the remote:

  * each task is worked `repetitions` times under each variant, as a session of
    its own with `trigger: benchmark`, cut from the commit the task pins and run
    by the variant's factory files — its agents, workflows and options;
  * nothing leaves the machine: no push, no pull request, no tracker write;
  * a gate a person answered is answered as the source session's person did,
    and a gate the source never put to a person stops the session as "not
    comparable";
  * the sessions are scored by the station's own scorers, paid from the
    measurement budget, which stops the benchmark once it is spent, and counted
    in no self-improvement window.

Every `asf` call says it is not CI: a CI checkout holds no session's record.
"""

from __future__ import annotations

from pathlib import Path

from engine import events

from . import projection
from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, fake_roster, forge,
                          forge_calls, forge_data, git, issue_json, run_state, scorer,
                          session_dir, set_config, wire, with_origin, write_workflow)
from .test_asf_benchmarks import benchmark, build_reply, task_of

LOCAL = {"CI": ""}


def local(repo: Path, *args: str, env: dict | None = None):
    return asf(repo, *args, env={**LOCAL, **(env or {})})


def prepared(repo: Path) -> None:
    wire(repo, "test", PY_CHECK)
    if git(repo, "status", "--porcelain"):
        commit_all(repo)


def source_run(repo: Path, prompt: str, content: str = "ok = 1\n") -> str:
    """One accepted session of `quick` on main: the task a benchmark re-works."""
    fake_roster(repo, builder=[build_reply(content, "feat: app")])
    prepared(repo)
    result = local(repo, "run", "quick", prompt)
    assert result.returncode == 0, result.stdout + result.stderr
    return adw_id_of(result)


def on_a_branch(repo: Path, change) -> None:
    """A branch of the factory's files, `change`, made by `change(repo)` —
    what a self-improvement pull request's branch is — leaving main checked out."""
    git(repo, "checkout", "-q", "-b", "change")
    change(repo)
    commit_all(repo, "change: what a self-improvement pull request proposes")
    git(repo, "checkout", "-q", "main")


def benchmark_sessions(repo: Path) -> dict[str, dict]:
    """{adw_id: what its `session_started` said it re-works} for every
    session of a benchmark on the station."""
    found = {}
    for directory in sorted((repo / "asf" / "data" / "sessions").iterdir()):
        started = [line.payload for line in events.read(directory)
                   if line.kind == "session_started"]
        if started and started[0].get("trigger") == "benchmark":
            found[directory.name] = started[0]
    return found


def kinds(repo: Path, adw_id: str) -> list[str]:
    return [line.kind for line in events.read(session_dir(repo, adw_id))]


# ── worked, per variant ──────────────────────────────────────────────────────

def test_each_task_is_worked_n_times_per_variant_under_that_variant_s_files(stamped: Path):
    source = source_run(stamped, "add app.py")
    on_a_branch(stamped, lambda repo: fake_roster(
        repo, builder=[build_reply("ok = 2\n", "feat: app, as the change builds it")]))
    benchmark(stamped, "app", {"tasks": [task_of(stamped, source, "add app.py")],
                               "variants": [{"ref": "main"}, {"ref": "change", "label": "PR"}],
                               "repetitions": 2})
    commit_all(stamped, "benchmark app")

    result = local(stamped, "benchmark", "run", "app")

    assert result.returncode == 0, result.stdout + result.stderr
    worked = benchmark_sessions(stamped)
    assert sorted((each["benchmark"]["variant"], each["benchmark"]["repetition"])
                  for each in worked.values()) == [("PR", 1), ("PR", 2), ("main", 1), ("main", 2)]
    commit = task_of(stamped, source, "")["commit"]
    for adw_id, started in worked.items():
        assert started["benchmark"]["benchmark"] == "app"
        assert started["benchmark"]["task"] == source
        assert started["base_commit"] == commit
        assert run_state(stamped, adw_id)["status"] == "success"
        built = git(stamped, "show", f"{started['branch']}:app.py")
        assert built == ("ok = 2" if started["benchmark"]["variant"] == "PR" else "ok = 1")
    assert "4 session(s)" in result.stdout


# ── isolated ─────────────────────────────────────────────────────────────────

def issue_factory(repo: Path) -> None:
    """Issues read from and reported to the stand-in, every branch published as
    it is cut, and a pull request opened on integration."""
    base = forge(repo)
    set_config(repo, issues={"enabled": True, "project": "acme/widgets",
                             "fetch_command": [*base, "view"], "state_command": [*base, "edit"],
                             "comment_command": [*base, "comment"]},
               worktree={"publish": "on_create",
                         "integration": {"mode": "pr", "open_pr": True,
                                         "pr_command": [*base, "pr-create"]}})
    write_workflow(repo, "fix", {
        "description": "implement an issue, verify, commit and open a pull request",
        "input": "issue",
        "stages": [{"implement": {"agent": "builder"}}, {"verify": {"blocks": ["test"]}},
                   {"commit": {"of": "implement"}}, {"integrate": {}}]})
    forge_data(repo, "issue.json", issue_json(number=12, labels=("asf:queued", "asf:ship")))
    with_origin(repo)


REACHING_OUT = """

_commit = run


def run(ctx, opts):
    from engine import git_helper, issues
    from engine.data_types import IssueUpdate
    issues.comment(ctx.run.main_root, ctx.run.cfg.issues,
                   IssueUpdate(number=12, comment="a stage of the variant's own, reaching out"))
    git_helper.push(ctx.run.main_root, "origin", ctx.run.workspace.branch)
    return _commit(ctx, opts)
"""


def reaching_out(repo: Path) -> None:
    """The variant's commit stage comments on the issue and pushes, first."""
    stage = repo / "asf" / "stages" / "commit" / "stage.py"
    stage.write_text(stage.read_text() + REACHING_OUT)


def test_a_benchmark_never_pushes_integrates_or_writes_to_the_tracker(stamped: Path):
    issue_factory(stamped)
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "fix: health")])
    prepared(stamped)
    ran = local(stamped, "run", "fix", "12")
    assert ran.returncode == 0, ran.stdout + ran.stderr
    source = adw_id_of(ran)
    assert run_state(stamped, source)["pr_url"]           # the source did all three
    # A variant whose own stage reaches out — what an older one's might do.
    on_a_branch(stamped, reaching_out)
    benchmark(stamped, "fix", {"tasks": [task_of(stamped, source, "#12 health")],
                               "variants": [{"ref": "main"}, {"ref": "change"}],
                               "repetitions": 1})
    commit_all(stamped, "benchmark fix")
    git(stamped, "push", "-q", "origin", "main")
    calls, remote = forge_calls(stamped), git(stamped, "ls-remote", "origin")

    result = local(stamped, "benchmark", "run", "fix")

    assert result.returncode == 0, result.stdout + result.stderr
    worked = benchmark_sessions(stamped)
    assert len(worked) == 2
    assert forge_calls(stamped) == calls
    assert git(stamped, "ls-remote", "origin") == remote
    for adw_id in worked:
        state = run_state(stamped, adw_id)
        assert state["status"] == "success" and not state["pr_url"]
        assert "pull_request_opened" not in kinds(stamped, adw_id)
        # ...and the request it worked is the issue's text, as its source read it
        handed = session_dir(stamped, adw_id) / "context_handoff" / "issue.md"
        assert "The /health endpoint returns 500." in handed.read_text()


# ── gates: answered as the source's were ─────────────────────────────────────

GATED = {"description": "implement, verify, commit, and stop for a person before landing",
         "input": "prompt",
         "stages": [{"implement": {"agent": "builder"}},
                    {"verify": {"blocks": ["test"], "max_fix_loops": 2,
                                "fix": {"agent": "builder"}}},
                    {"commit": {"of": "implement"}}, {"integrate": {"hitl": True}}]}


def decisions(repo: Path, adw_id: str) -> list[dict]:
    return [line.payload["decision"] for line in events.read(session_dir(repo, adw_id))
            if line.kind == "decision_recorded"]


def test_a_gate_a_person_answered_is_answered_as_they_did(stamped: Path):
    write_workflow(stamped, "gated", GATED)
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    prepared(stamped)
    waiting = local(stamped, "run", "gated", "add app.py")
    assert waiting.returncode == 75, waiting.stdout + waiting.stderr
    source = adw_id_of(waiting)
    answered = local(stamped, "approve", source, "-m", "land it, and keep the name")
    assert answered.returncode == 0, answered.stdout + answered.stderr
    benchmark(stamped, "gated", {"tasks": [task_of(stamped, source, "add app.py")],
                                 "variants": [{"ref": "main"}, {"ref": "main", "label": "again"}],
                                 "repetitions": 1})
    commit_all(stamped, "benchmark gated")

    result = local(stamped, "benchmark", "run", "gated")

    assert result.returncode == 0, result.stdout + result.stderr
    worked = benchmark_sessions(stamped)
    assert len(worked) == 2
    person = decisions(stamped, source)[-1]["by"]
    for adw_id in worked:
        assert run_state(stamped, adw_id)["status"] == "success"
        said = decisions(stamped, adw_id)[-1]
        assert (said["gate"], said["verdict"], said["by"], said["notes"]) == (
            "integrate", "approve", person, "land it, and keep the name")
        assert "suspended" not in kinds(stamped, adw_id)
        # ...and its record, what it re-works included, is its events'
        rebuilt, written = (projection.replay(session_dir(stamped, adw_id)),
                            projection.on_disk(session_dir(stamped, adw_id)))
        assert rebuilt.run == written.run and rebuilt.run["benchmark"]["task"] == source
        assert rebuilt.decisions == written.decisions
        assert rebuilt.journal == written.journal


def test_a_gate_no_person_answered_in_the_source_stops_the_session_as_not_comparable(
        stamped: Path):
    source = source_run(stamped, "add app.py")
    on_a_branch(stamped, lambda repo: write_workflow(repo, "quick", {**GATED, "description":
                                                                   "quick, with a gate"}))
    benchmark(stamped, "app", {"tasks": [task_of(stamped, source, "add app.py")],
                               "variants": [{"ref": "main"}, {"ref": "change"}],
                               "repetitions": 1})
    commit_all(stamped, "benchmark app")

    result = local(stamped, "benchmark", "run", "app")

    assert result.returncode == 0, result.stdout + result.stderr
    ended = {started["benchmark"]["variant"]: adw_id
             for adw_id, started in benchmark_sessions(stamped).items()}
    assert run_state(stamped, ended["main"])["status"] == "success"
    assert run_state(stamped, ended["change"])["status"] == "fail"
    finished = [line.payload for line in events.read(session_dir(stamped, ended["change"]))
                if line.kind == "workflow_finished"]
    assert finished[-1]["reason"].startswith("not comparable: ")
    assert "integrate gate, round 1" in finished[-1]["reason"]
    assert "change: 1 not comparable" in result.stdout


# ── measurement ──────────────────────────────────────────────────────────────

def test_the_measurement_budget_stops_a_benchmark_and_a_later_run_works_the_rest(
        stamped: Path):
    source = source_run(stamped, "add app.py")
    set_config(stamped, measurement={"usd_per_day": 0.01})
    benchmark(stamped, "app", {"tasks": [task_of(stamped, source, "add app.py")],
                               "variants": [{"ref": "main"}, {"ref": "main", "label": "again"}],
                               "repetitions": 1})
    commit_all(stamped, "benchmark app, on a small budget")

    result = local(stamped, "benchmark", "run", "app")

    assert result.returncode == 1, result.stdout + result.stderr
    assert len(benchmark_sessions(stamped)) == 1          # its $0.02 spent the day's $0.01
    assert "the measurement budget is spent" in result.stdout
    assert "1 of 2 session(s) not worked" in result.stdout

    # Run again with budget left — the station's, uncommitted, so main is the
    # same variant — it works only what it did not.
    set_config(stamped, measurement={"usd_per_day": 5})
    again = local(stamped, "benchmark", "run", "app")

    assert again.returncode == 0, again.stdout + again.stderr
    worked = benchmark_sessions(stamped)
    assert sorted(each["benchmark"]["variant"] for each in worked.values()) == ["again", "main"]
    assert "1 already worked" in again.stdout


BROKEN = [build_reply("1/0\n", "feat: broken"), build_reply("2/0\n", "feat: still broken")]


def test_benchmark_sessions_are_scored_by_the_station_s_scorers_and_counted_in_no_window(
        stamped: Path):
    base = forge(stamped)
    set_config(stamped, issues={
        "enabled": True, "project": "acme/widgets", "list_command": [*base, "list"],
        "create_command": [*base, "create"], "comment_command": [*base, "comment"],
        "state_command": [*base, "edit"], "labels_create_command": [*base, "label-create"]})
    source = source_run(stamped, "add app.py")
    on_a_branch(stamped, lambda repo: fake_roster(repo, builder=BROKEN))
    # The scorer is the station's, written after the change was cut: its
    # files have none. Three failing sessions in the last three would file.
    scorer(stamped, "refused", {"workflow": "quick", "kind": "code", "predicate": "not_accepted",
                                "improve_after": {"failures": 3, "of_last": 3}})
    fake_roster(stamped, builder=BROKEN)
    prepared(stamped)
    first = local(stamped, "run", "quick", "add app.py, broken")
    assert first.returncode == 1, first.stdout + first.stderr
    benchmark(stamped, "app", {"tasks": [task_of(stamped, source, "add app.py")],
                               "variants": [{"ref": "change"},
                                            {"ref": "change", "label": "again"}],
                               "repetitions": 1})
    commit_all(stamped, "benchmark app")

    result = local(stamped, "benchmark", "run", "app")
    second = local(stamped, "run", "quick", "add app.py, broken again")

    assert result.returncode == 0, result.stdout + result.stderr
    assert second.returncode == 1, second.stdout + second.stderr
    for adw_id in benchmark_sessions(stamped):
        scores = [line.payload for line in events.read(session_dir(stamped, adw_id))
                  if line.kind == "chapter_scored"]
        assert [(each["scorer"], each["failing"]) for each in scores] == [("refused", True)]
    # Two of the factory's own sessions failed, of the last three it judged:
    # the two benchmark sessions between them would have made it three.
    assert not [call for call in forge_calls(stamped) if call[0] == "create"]

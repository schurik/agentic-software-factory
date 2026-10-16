"""Benchmarks: past sessions' requests, pinned, to be worked again under variants.

A benchmark is a committed `asf/benchmarks/<name>.yaml` — its tasks (a source
session, its request and the commit it started from), its variants (git refs,
labelled) and how many times each task is worked per variant. Through the
seams a person meets it by:

  * `asf benchmark new --from-scorer <s>`: seeded with the sessions the scorer
    cited as failing and two passing ones as controls, against the default
    branch and the scorer's open self-improvement pull request's branch;
  * `asf check`: a benchmark naming a session this station has no record of, a
    ref that does not resolve, or fewer than two variants is refused, and the
    self-description lists the benchmarks.

Every `asf` call here says it is not CI: a CI checkout holds no session's
record, so there `check` reads a benchmark's shape only, which is its own test.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

from engine import events

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster, forge_data,
                          git, issue_json, scorer, session_dir, set_config, stand_in_gh, wire,
                          with_origin, write_workflow)

LOCAL = {"CI": ""}
# Two failures in ten never file an issue here: no tracker is asked anything.
REFUSED = {"workflow": "quick", "kind": "code", "predicate": "not_accepted",
           "improve_after": {"failures": 10, "of_last": 10}}
IMPROVER = "1a2b3c4d"


def local(repo: Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return asf(repo, *args, env={**LOCAL, **(env or {})})


def build_reply(content: str, message: str) -> dict:
    return {"writes": {"app.py": content}, "tokens": 50, "cost": 0.02,
            "envelope": envelope(changed_files=["app.py"], commit_message=message)}


def prepared(repo: Path) -> None:
    wire(repo, "test", PY_CHECK)
    if git(repo, "status", "--porcelain"):
        commit_all(repo)


def refused_run(repo: Path, prompt: str) -> str:
    """One session of `quick` its workflow refused (max_fix_loops 2)."""
    fake_roster(repo, builder=[build_reply("1/0\n", "feat: broken"),
                               build_reply("2/0\n", "feat: still broken")])
    prepared(repo)
    result = local(repo, "run", "quick", prompt)
    assert result.returncode == 1, result.stdout + result.stderr
    return adw_id_of(result)


def accepted_run(repo: Path, prompt: str) -> str:
    fake_roster(repo, builder=[build_reply("ok = 1\n", "feat: app")])
    prepared(repo)
    result = local(repo, "run", "quick", prompt)
    assert result.returncode == 0, result.stdout + result.stderr
    return adw_id_of(result)


def started_from(repo: Path, adw_id: str) -> str:
    return next(line.payload["base_commit"] for line in events.read(session_dir(repo, adw_id))
                if line.kind == "session_started")


def improving(repo: Path, name: str) -> str:
    """The scorer's self-improvement issue worked by a session of its own,
    whose pull request (#9, as the stand-in opens every one) is still open.
    Returns that session's branch."""
    stand_in_gh(repo)
    set_config(repo, issues={"enabled": True, "project": "acme/widgets"},
               worktree={"integration": {"mode": "pr", "open_pr": True}})
    write_workflow(repo, "fix", {
        "description": "implement an issue, verify, commit and open a pull request",
        "input": "issue",
        "stages": [{"implement": {"agent": "builder"}}, {"verify": {"blocks": ["test"]}},
                   {"commit": {"of": "implement"}}, {"integrate": {}}]})
    fake_roster(repo, builder=[build_reply("ok = 1\n", "fix: what the scorer found")])
    forge_data(repo, "issue.json", issue_json(number=12, labels=(f"asf:improve:{name}",
                                                                 "asf:queued", "asf:ship")))
    if not git(repo, "remote"):
        with_origin(repo)
    prepared(repo)
    result = local(repo, "run", "fix", "12", "--adw-id", IMPROVER)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads((session_dir(repo, IMPROVER) / "run.json").read_text())["branch"]


def written(repo: Path, name: str) -> dict:
    return yaml.safe_load((repo / "asf" / "benchmarks" / f"{name}.yaml").read_text())


def benchmark(repo: Path, name: str, body: dict) -> Path:
    """A benchmark the way a person edits one."""
    path = repo / "asf" / "benchmarks" / f"{name}.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(body, sort_keys=False))
    return path


def task_of(repo: Path, adw_id: str, request: str) -> dict:
    return {"session": adw_id, "request": request, "commit": started_from(repo, adw_id)}


# ── asf benchmark new --from-scorer ──────────────────────────────────────────

def test_from_scorer_pins_the_cited_failures_two_passing_controls_and_the_default_variants(
        stamped: Path):
    scorer(stamped, "refused", REFUSED, "A refused chapter is work a person picks up.\n")
    oldest = accepted_run(stamped, "add app.py, first")
    first = refused_run(stamped, "add app.py, second")
    control = accepted_run(stamped, "add app.py, third")
    second = refused_run(stamped, "add app.py, fourth")
    newest = accepted_run(stamped, "add app.py, fifth")
    branch = improving(stamped, "refused")

    result = local(stamped, "benchmark", "new", "--from-scorer", "refused")

    assert result.returncode == 0, result.stdout + result.stderr
    pinned = written(stamped, "refused")
    # The failures it cited, newest first, then the two newest passing sessions.
    assert pinned["tasks"] == [task_of(stamped, second, "add app.py, fourth"),
                               task_of(stamped, first, "add app.py, second"),
                               task_of(stamped, newest, "add app.py, fifth"),
                               task_of(stamped, control, "add app.py, third")]
    assert oldest not in json.dumps(pinned)
    # The default branch against the open self-improvement pull request's branch.
    assert pinned["variants"] == [{"ref": "main", "label": "main"},
                                  {"ref": branch, "label": "PR #9"}]
    assert pinned["repetitions"] == 3
    # What it wrote is one `check` accepts, and it says where it went.
    assert "asf/benchmarks/refused.yaml" in result.stdout
    checked = local(stamped, "check")
    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert "✓ benchmark refused: 4 tasks × 2 variants (main, PR #9) × 3" in checked.stdout


def test_once_an_issue_is_filed_it_pins_what_the_issue_cites_however_the_window_moved(
        stamped: Path):
    stand_in_gh(stamped)
    set_config(stamped, issues={"enabled": True, "project": "acme/widgets"})
    scorer(stamped, "refused", {**REFUSED, "improve_after": {"failures": 2, "of_last": 2}})
    first = refused_run(stamped, "add app.py, first")
    second = refused_run(stamped, "add app.py, second")
    [issue] = json.loads((stamped / ".forge" / "created.json").read_text())
    # Two passing sessions since: the window of the last two cites no failure now.
    older = accepted_run(stamped, "add app.py, third")
    newer = accepted_run(stamped, "add app.py, fourth")
    improving(stamped, "refused")

    result = local(stamped, "benchmark", "new", "--from-scorer", "refused")

    assert result.returncode == 0, result.stdout + result.stderr
    assert [task["session"] for task in written(stamped, "refused")["tasks"]] == [
        second, first, newer, older]
    text = (stamped / "asf" / "benchmarks" / "refused.yaml").read_text()
    assert f"# failing: cited by #{issue['number']}, not_accepted" in text


def test_the_definition_says_which_task_is_a_failure_and_which_a_control(stamped: Path):
    scorer(stamped, "refused", REFUSED)
    failing = refused_run(stamped, "add app.py")
    passing = accepted_run(stamped, "add app.py again")

    result = local(stamped, "benchmark", "new", "nightly", "--from-scorer", "refused",
                   "--variant", "main", "--variant", "main~1=before")

    assert result.returncode == 0, result.stdout + result.stderr
    text = (stamped / "asf" / "benchmarks" / "nightly.yaml").read_text()
    assert "asf benchmark new --from-scorer refused" in text
    assert text.index("failing: not_accepted") < text.index(f"session: {failing}")
    assert text.index("control: accepted") < text.index(f"session: {passing}")
    # Variants given replace the defaults, and a label is the ref unless one is given.
    assert written(stamped, "nightly")["variants"] == [{"ref": "main", "label": "main"},
                                                       {"ref": "main~1", "label": "before"}]
    assert "only 1 passing session" in result.stdout


def test_without_an_open_self_improvement_pull_request_it_asks_for_the_second_variant(
        stamped: Path):
    scorer(stamped, "refused", REFUSED)
    refused_run(stamped, "add app.py")

    result = local(stamped, "benchmark", "new", "--from-scorer", "refused")

    assert result.returncode == 1
    assert "--variant" in result.stdout + result.stderr
    assert not (stamped / "asf" / "benchmarks" / "refused.yaml").exists()


def test_a_scorer_that_cited_no_failure_seeds_nothing(stamped: Path):
    scorer(stamped, "refused", REFUSED)
    accepted_run(stamped, "add app.py")

    result = local(stamped, "benchmark", "new", "--from-scorer", "refused",
                   "--variant", "main", "--variant", "main~1")

    assert result.returncode == 1
    assert "no failing session" in result.stdout + result.stderr
    assert not (stamped / "asf" / "benchmarks").exists()


def test_an_unknown_scorer_is_refused_by_name(stamped: Path):
    result = local(stamped, "benchmark", "new", "--from-scorer", "nobody")

    assert result.returncode == 1
    assert "no scorer named nobody" in result.stdout + result.stderr


def test_a_benchmark_already_written_is_never_overwritten(stamped: Path):
    scorer(stamped, "refused", REFUSED)
    refused_run(stamped, "add app.py")
    path = benchmark(stamped, "refused", {"tasks": [], "variants": []})
    before = path.read_text()

    result = local(stamped, "benchmark", "new", "--from-scorer", "refused",
                   "--variant", "main", "--variant", "main~1")

    assert result.returncode == 1
    assert "already" in result.stdout + result.stderr
    assert path.read_text() == before


# ── asf check ────────────────────────────────────────────────────────────────

def well_formed(repo: Path, adw_id: str) -> dict:
    return {"tasks": [task_of(repo, adw_id, "add app.py")],
            "variants": [{"ref": "main", "label": "main"}, {"ref": "main~1"}]}


def test_check_refuses_a_benchmark_with_an_unknown_session(stamped: Path):
    adw_id = accepted_run(stamped, "add app.py")
    body = well_formed(stamped, adw_id)
    body["tasks"].append({"session": "0badc0de", "request": "gone", "commit": "main"})
    benchmark(stamped, "broken", body)

    result = local(stamped, "check")

    assert result.returncode == 1
    assert "✗ benchmark broken" in result.stdout
    assert "asf/benchmarks/broken.yaml" in result.stdout and "session 0badc0de" in result.stdout


def test_check_refuses_a_benchmark_with_a_ref_that_does_not_resolve(stamped: Path):
    adw_id = accepted_run(stamped, "add app.py")
    body = well_formed(stamped, adw_id)
    body["variants"][1]["ref"] = "no-such-branch"
    body["tasks"][0]["commit"] = "f" * 40
    benchmark(stamped, "broken", body)

    result = local(stamped, "check")

    assert result.returncode == 1
    assert "✗ benchmark broken" in result.stdout
    assert "no-such-branch" in result.stdout and "f" * 40 in result.stdout


def test_check_refuses_a_benchmark_with_fewer_than_two_variants(stamped: Path):
    adw_id = accepted_run(stamped, "add app.py")
    body = well_formed(stamped, adw_id)
    body["variants"] = body["variants"][:1]
    benchmark(stamped, "alone", body)

    result = local(stamped, "check")

    assert result.returncode == 1
    assert "✗ benchmark alone" in result.stdout and "two or more variants" in result.stdout


def test_check_refuses_a_benchmark_it_cannot_read(stamped: Path):
    adw_id = accepted_run(stamped, "add app.py")
    body = {**well_formed(stamped, adw_id), "winner": "main", "repetitions": 0}
    benchmark(stamped, "odd", body)

    result = local(stamped, "check")

    assert result.returncode == 1
    assert "✗ benchmark odd" in result.stdout
    assert "winner" in result.stdout and "repetitions" in result.stdout


def test_check_refuses_a_session_pinned_twice_or_two_variants_labelled_alike(stamped: Path):
    adw_id = accepted_run(stamped, "add app.py")
    body = well_formed(stamped, adw_id)
    body["tasks"] *= 2
    body["variants"][1]["label"] = "main"
    benchmark(stamped, "twice", body)
    # The same ref twice, told apart, is a fair comparison: of the noise alone.
    benchmark(stamped, "noise", {**well_formed(stamped, adw_id),
                                 "variants": [{"ref": "main"}, {"ref": "main", "label": "again"}]})

    result = local(stamped, "check")

    assert result.returncode == 1
    assert "✗ benchmark twice" in result.stdout and "✓ benchmark noise" in result.stdout
    assert f"pins session {adw_id} twice" in result.stdout
    assert "labels a variant main twice" in result.stdout


def test_a_ci_checkout_holds_no_record_and_checks_a_benchmark_s_shape_only(stamped: Path):
    # The CI workflow's checkout: no session's record, and only the commit it checked out.
    benchmark(stamped, "nightly", {"tasks": [{"session": "0badc0de", "request": "add app.py",
                                              "commit": "f" * 40}],
                                   "variants": [{"ref": "main"}, {"ref": "asf/0badc0de"}]})
    benchmark(stamped, "alone", {"tasks": [{"session": "0badc0de", "request": "add app.py",
                                            "commit": "f" * 40}],
                                 "variants": [{"ref": "main"}]})

    result = asf(stamped, "check", env={"CI": "true"})

    assert result.returncode == 1, result.stdout + result.stderr
    assert "✓ benchmark nightly" in result.stdout
    assert "~ " in result.stdout and "not checked" in result.stdout
    assert "✗ benchmark alone" in result.stdout


# ── the self-description ─────────────────────────────────────────────────────

def test_the_self_description_lists_the_benchmarks_and_the_ones_check_refused(stamped: Path):
    adw_id = accepted_run(stamped, "add app.py")
    benchmark(stamped, "nightly", well_formed(stamped, adw_id))
    benchmark(stamped, "alone", {**well_formed(stamped, adw_id), "variants": [{"ref": "main"}]})

    described = local(stamped, "check", "--json")

    raw = json.loads(described.stdout)
    assert described.returncode == 1 and raw["ok"] is False
    assert raw["benchmarks"] == [{
        "name": "nightly", "tasks": [task_of(stamped, adw_id, "add app.py")],
        "variants": [{"ref": "main", "label": "main"}, {"ref": "main~1", "label": "main~1"}],
        "repetitions": 3}]
    [problem] = raw["benchmark_problems"]
    assert problem["benchmark"] == "alone" and "two or more variants" in problem["error"]

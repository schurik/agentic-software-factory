"""Scorers: a team's judgement of a finished chapter, recorded beside it (ADR 0006).

A scorer is one `asf/scorers/<name>/scorer.md` — frontmatter for the engine,
prose for the criteria — bound to one workflow. Through the seams a person
meets it by:

  * `asf run` on the fake harness: every scorer bound to the workflow leaves a
    `chapter_scored` on the session's own record once the chapter has ended,
    and the chapter ends the way it would have with no scorer at all;
  * `asf check`: a malformed scorer is refused before anything runs, and the
    self-description lists the scorers with their thresholds resolved;
  * `install.py --force`: a scorer is the operator's, and is never rewritten.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from engine import events

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster, forge,
                          forge_data, git, install, pr_json, run_state, scorer, session_dir,
                          set_config, wire, with_origin, write_workflow)

REVIEWED = "5c0be7ed"


def build_reply(content: str, message: str) -> dict:
    return {"writes": {"app.py": content}, "tokens": 50, "cost": 0.02,
            "envelope": envelope(changed_files=["app.py"], commit_message=message)}


def lines_of(repo: Path, adw_id: str, kind: str) -> list[events.EventLine]:
    return [line for line in events.read(session_dir(repo, adw_id)) if line.kind == kind]


def scores(repo: Path, adw_id: str) -> dict[str, dict]:
    return {line.payload["scorer"]: line.payload for line in lines_of(repo, adw_id, "chapter_scored")}


# ── scoring a chapter ────────────────────────────────────────────────────────

def test_a_run_leaves_one_score_per_scorer_bound_to_its_workflow(stamped: Path):
    # The builder's first two answers are not JSON: two corrections of the same session.
    fake_roster(stamped, builder=[{"text": "not json at all"}, {"text": "still not json"},
                                  build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    scorer(stamped, "strict", {"workflow": "quick", "kind": "code",
                               "predicate": "corrections_above(1)"})
    scorer(stamped, "lenient", {"workflow": "quick", "kind": "code",
                                "predicate": "corrections_above(5)"})
    scorer(stamped, "elsewhere", {"workflow": "sdlc", "kind": "code",
                                  "predicate": "corrections_above(0)"})
    commit_all(stamped)

    result = asf(stamped, "run", "quick", "add app.py")

    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    rejected = [line.seq for line in lines_of(stamped, adw_id, "envelope_rejected")]
    assert len(rejected) == 2
    found = scores(stamped, adw_id)
    assert set(found) == {"strict", "lenient"}               # sdlc's scorer judges sdlc
    for payload in found.values():
        assert payload["usage"]["total_tokens"] == 0 and payload["usage"]["total_cost"] == 0
    assert {name: {k: v for k, v in payload.items() if k != "usage"}
            for name, payload in found.items()} == {
        "strict": {"chapter": 1, "scorer": "strict", "kind": "code", "class": "above",
                   "failing": True, "evidence": rejected},
        "lenient": {"chapter": 1, "scorer": "lenient", "kind": "code", "class": "within",
                    "failing": False, "evidence": rejected},
    }

    # A failing score changes nothing about how the chapter ended.
    [finished] = lines_of(stamped, adw_id, "workflow_finished")
    assert (finished.payload["status"], finished.payload["accepted"]) == ("success", True)
    assert run_state(stamped, adw_id)["status"] == "success"
    # ...and it was scored once it had ended: the score joins a finished record.
    assert min(line.seq for line in lines_of(stamped, adw_id, "chapter_scored")) > finished.seq


def test_a_refused_chapter_is_scored_too_and_a_broken_scorer_is_said_and_skipped(
        stamped: Path):
    fake_roster(stamped, builder=[build_reply("1/0\n", "feat: broken"),
                                  build_reply("2/0\n", "feat: still broken")])
    wire(stamped, "test", PY_CHECK)
    scorer(stamped, "builder-corrections", {"workflow": "quick", "focus": "builder",
                                            "kind": "code", "predicate": "corrections_above(0)"})
    scorer(stamped, "typo", {"workflow": "quick", "kind": "code",
                             "predicate": "corections_above(0)"})
    scorer(stamped, "judge", {"workflow": "quick", "kind": "judge",
                              "classes": [{"name": "fine", "fail": False},
                                          {"name": "lost", "fail": True}]},
           "Did the builder stay on the prompt?\n")
    commit_all(stamped)

    result = asf(stamped, "run", "quick", "add app.py")       # quick: max_fix_loops 2

    assert result.returncode == 1, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    [finished] = lines_of(stamped, adw_id, "workflow_finished")
    assert (finished.payload["status"], finished.payload["accepted"]) == ("fail", False)
    assert run_state(stamped, adw_id)["status"] == "fail"
    found = scores(stamped, adw_id)
    assert set(found) == {"builder-corrections"}
    assert (found["builder-corrections"]["class"], found["builder-corrections"]["failing"],
            found["builder-corrections"]["evidence"]) == ("within", False, [])
    assert "scorer typo did not score" in result.stdout
    assert "corections_above(0)" in result.stdout
    assert "scorer judge is a judge: checked, not run" in result.stdout     # and left no score


def test_a_failed_round_of_gates_is_one_correction_and_a_focus_counts_only_its_agent(
        stamped: Path):
    claimed = ["docs/asf/spec/plan.md", "docs/asf/spec/notes.md"]
    plan = {"writes": {path: "# Plan\n" for path in claimed}, "tokens": 100, "cost": 0.01,
            "envelope": envelope(artifacts=claimed, commit_message="docs: plan")}
    # The planner first claims a plan it never wrote and notes it left empty:
    # both of plan's gates fail, in one round.
    fake_roster(stamped, planner=[{**plan, "writes": {"docs/asf/spec/notes.md": ""}}, plan],
                builder=[{"text": "not json at all"}, build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    for name, focus, most in (("planner-strict", "planner", 0), ("planner-one", "planner", 1),
                              ("builder-strict", "builder", 0)):
        scorer(stamped, name, {"workflow": "sdlc", "focus": focus, "kind": "code",
                               "predicate": f"corrections_above({most})"})
    commit_all(stamped)

    result = asf(stamped, "run", "sdlc", "add app.py")

    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    failed_gates = [line.seq for line in lines_of(stamped, adw_id, "gate_result")
                    if not line.payload["passed"]]
    [rejected] = [line.seq for line in lines_of(stamped, adw_id, "envelope_rejected")]
    assert len(failed_gates) == 2
    found = scores(stamped, adw_id)
    assert {name: (payload["class"], payload["evidence"]) for name, payload in found.items()} == {
        "planner-strict": ("above", failed_gates),
        "planner-one": ("within", failed_gates),         # two gates, one round: one correction
        "builder-strict": ("above", [rejected]),
    }


# ── the rest of the closed set, each on a chapter scripted to need it ────────

def classed(repo: Path, adw_id: str) -> dict[str, tuple[str, bool, list[int]]]:
    return {name: (payload["class"], payload["failing"], payload["evidence"])
            for name, payload in scores(repo, adw_id).items()}


def test_a_rollback_is_scored_from_its_own_event_and_a_focus_counts_only_its_agent(
        stamped: Path):
    # The scout's `writes:` is `[]`: a file it leaves in the repository is undone.
    fake_roster(stamped, scout=[{"writes": {"notes.md": "left behind\n"},
                                 "envelope": envelope(findings=[], artifacts=[])}])
    write_workflow(stamped, "scouted", {"description": "a scout that oversteps",
                                        "stages": [{"scout": {}}]})
    scorer(stamped, "rollbacks", {"workflow": "scouted", "kind": "code",
                                  "predicate": "permission_rolled_back"})
    scorer(stamped, "scout-rollbacks", {"workflow": "scouted", "focus": "scout", "kind": "code",
                                        "predicate": "permission_rolled_back()"})
    commit_all(stamped)

    result = asf(stamped, "run", "scouted", "look around")

    assert result.returncode == 1, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    [rolled_back] = [line.seq for line in lines_of(stamped, adw_id, "permission_rolled_back")]
    assert classed(stamped, adw_id) == {"rollbacks": ("rolled_back", True, [rolled_back]),
                                        "scout-rollbacks": ("rolled_back", True, [rolled_back])}


def test_a_chapter_with_nothing_rolled_back_is_clean(stamped: Path):
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    scorer(stamped, "rollbacks", {"workflow": "quick", "kind": "code",
                                  "predicate": "permission_rolled_back"})
    commit_all(stamped)

    result = asf(stamped, "run", "quick", "add app.py")

    assert result.returncode == 0, result.stdout + result.stderr
    assert classed(stamped, adw_id_of(result)) == {"rollbacks": ("clean", False, [])}


def test_a_limit_hit_is_scored_by_any_kind_or_only_the_kind_it_names(stamped: Path):
    plan = {"writes": {"docs/asf/spec/plan.md": "# Plan\n"}, "tokens": 100, "cost": 0.01,
            "envelope": envelope(artifacts=["docs/asf/spec/plan.md"], commit_message="docs: plan")}
    fake_roster(stamped, planner=[plan], builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    set_config(stamped, budget={"max_tokens": 100})          # the planner spends exactly that
    for name, predicate in (("limits", "limit_hit"), ("tokens", "limit_hit(tokens)"),
                            ("timeouts", "limit_hit(timeout)"),
                            ("planner-limits", "limit_hit")):
        scorer(stamped, name, {"workflow": "sdlc", "kind": "code", "predicate": predicate,
                               **({"focus": "planner"} if name.startswith("planner") else {})})
    commit_all(stamped)

    result = asf(stamped, "run", "sdlc", "add app.py")

    assert result.returncode == 1, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    [hit] = [line.seq for line in lines_of(stamped, adw_id, "limit_hit")]   # the builder's
    assert classed(stamped, adw_id) == {"limits": ("hit", True, [hit]),
                                        "tokens": ("hit", True, [hit]),
                                        "timeouts": ("none", False, []),
                                        "planner-limits": ("none", False, [])}


def test_not_accepted_is_a_chapter_its_workflow_refused_and_not_one_that_failed(stamped: Path):
    fake_roster(stamped, builder=[build_reply("1/0\n", "feat: broken"),
                                  build_reply("2/0\n", "feat: still broken")])
    wire(stamped, "test", PY_CHECK)
    scorer(stamped, "refused", {"workflow": "quick", "kind": "code", "predicate": "not_accepted"})
    commit_all(stamped)

    refused = asf(stamped, "run", "quick", "add app.py")      # quick: max_fix_loops 2

    assert refused.returncode == 1, refused.stdout + refused.stderr
    [finished] = [line.seq for line in lines_of(stamped, adw_id_of(refused), "workflow_finished")]
    assert classed(stamped, adw_id_of(refused)) == {"refused": ("not_accepted", True, [finished])}

    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    commit_all(stamped)
    accepted = asf(stamped, "run", "quick", "add app.py")

    assert accepted.returncode == 0, accepted.stdout + accepted.stderr
    assert classed(stamped, adw_id_of(accepted)) == {"refused": ("accepted", False, [])}


def test_review_chapters_are_counted_per_session_and_scored_on_the_latest(stamped: Path):
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    base = forge(stamped)
    set_config(stamped, pull_requests={
        "enabled": True, "project": "acme/widgets",
        "list_command": [*base, "list"], "comment_command": [*base, "comment"],
        "state_command": [*base, "edit"], "graphql_command": [*base, "graphql"]})
    scorer(stamped, "review-rounds", {"workflow": "pr-review", "kind": "code",
                                      "predicate": "review_chapters_above(1)"})
    with_origin(stamped)
    commit_all(stamped)
    first = asf(stamped, "run", "quick", "add app.py", "--adw-id", REVIEWED)
    assert first.returncode == 0, first.stdout + first.stderr
    git(stamped, "push", "-q", "-u", "origin", f"asf/{REVIEWED}")

    for round_, said_ in enumerate(("make ok 2", "make ok 3"), start=2):
        fake_roster(stamped, builder=[build_reply(f"ok = {round_}\n", f"fix: ok is {round_}")])
        forge_data(stamped, "pr.json", pr_json(72, f"asf/{REVIEWED}", [{"body": said_}]))
        commit_all(stamped)
        result = asf(stamped, "run", "pr-review", "72")
        assert result.returncode == 0, result.stdout + result.stderr

    opened = [line.seq for line in lines_of(stamped, REVIEWED, "workflow_started")
              if line.payload["input"] == "pr"]
    by_chapter = {line.payload["chapter"]: (line.payload["class"], line.payload["failing"],
                                            line.payload["evidence"])
                  for line in lines_of(stamped, REVIEWED, "chapter_scored")}
    # Chapter 1 is the quick workflow's, which this scorer does not judge; each
    # review chapter is scored on the review chapters the session has had by then.
    assert by_chapter == {2: ("within", False, opened[:1]), 3: ("above", True, opened)}


# ── checking a scorer before it costs anything ───────────────────────────────

JUDGE = {"workflow": "issue", "kind": "judge",
         "classes": [{"name": "checked_both", "fail": False}, {"name": "plan_only", "fail": True}]}


@pytest.mark.parametrize("meta, prose, said", [
    ({"workflow": "isue", "kind": "code", "predicate": "corrections_above(2)"}, "",
     "workflow 'isue' is not one this factory loads"),
    ({"workflow": "issue", "focus": "reviwer", "kind": "code",
      "predicate": "corrections_above(2)"}, "",
     "focus 'reviwer' is not one of issue's agents"),
    ({"workflow": "issue", "kind": "code", "predicate": "corrections_over(2)"}, "",
     "predicate 'corrections_over(2)' is not one of the closed set"),
    ({"workflow": "issue", "kind": "code", "predicate": "corrections_above"}, "",
     "takes a whole number"),
    ({"workflow": "issue", "kind": "code"}, "", "a code scorer names its predicate"),
    ({"workflow": "issue", "kind": "code", "predicate": "limit_hit(money)"}, "",
     "names no kind of limit: limit_hit(kind?), where kind is one of tokens, cost, timeout"),
    ({"workflow": "issue", "kind": "code", "predicate": "not_accepted(2)"}, "",
     "takes nothing: not_accepted"),
    ({"workflow": "issue", "kind": "code", "predicate": "review_chapters_above()"}, "",
     "takes a whole number: review_chapters_above(k)"),
    ({"workflow": "issue", "focus": "builder", "kind": "code", "predicate": "not_accepted"}, "",
     "not_accepted judges the whole chapter, not one agent"),
    ({**JUDGE, "classes": [{"name": "fine", "fail": False}]}, "Did it check both?\n",
     "declares no failing class"),
    ({**JUDGE, "classes": []}, "Did it check both?\n", "declares no failing class"),
    ({**JUDGE, "sample_rate": 1.5}, "Did it check both?\n", "sample_rate 1.5 is out of range"),
    ({**JUDGE, "sample_rate": -0.1}, "Did it check both?\n", "sample_rate -0.1 is out of range"),
    ({"workflow": "issue", "kind": "code", "predicate": "corrections_above(2)",
      "sample_rate": 0.5}, "", "sample_rate is a judge's"),
    ({"workflow": "issue", "kind": "grader"}, "", "kind: Input should be 'judge' or 'code'"),
    ({"workflow": "issue", "kind": "code", "predicate": "corrections_above(2)",
      "improve_after": {"failures": 5, "of_last": 3}}, "", "can never happen"),
], ids=["unknown-workflow", "unknown-focus", "unknown-predicate", "no-argument",
        "no-predicate", "unknown-limit-kind", "argument-to-none", "empty-argument",
        "focus-on-the-whole-chapter", "no-failing-class", "no-classes", "sample-rate-high",
        "sample-rate-negative", "judge-option-on-code", "unknown-kind", "impossible-threshold"])
def test_check_refuses_a_malformed_scorer_before_anything_runs(
        stamped: Path, meta: dict, prose: str, said: str):
    scorer(stamped, "broken", meta, prose)

    result = asf(stamped, "check")

    assert result.returncode == 1, result.stdout + result.stderr
    assert "✗ scorer broken" in result.stdout
    assert said in result.stdout, result.stdout
    assert not (stamped / "asf" / "data" / "sessions").exists()     # nothing ran


def test_check_accepts_a_well_formed_scorer_of_either_kind(stamped: Path):
    scorer(stamped, "corrections", {"workflow": "issue", "focus": "builder", "kind": "code",
                                    "predicate": "corrections_above(2)"})
    scorer(stamped, "reviewer-scope", {**JUDGE, "focus": "reviewer", "sample_rate": 0.2},
           "Did the reviewer read the diff as well as the plan?\n")

    result = asf(stamped, "check")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "✓ scorer corrections: issue · builder · corrections_above(2)" in result.stdout
    assert "✓ scorer reviewer-scope: issue · reviewer · judge" in result.stdout


def test_a_threshold_that_can_never_be_met_is_refused_in_factory_yaml(stamped: Path):
    set_config(stamped, self_improvement={"failures": 11, "of_last": 10})

    result = asf(stamped, "check")

    assert result.returncode == 1, result.stdout + result.stderr
    assert "self_improvement" in result.stdout and "can never happen" in result.stdout


# ── the self-description ─────────────────────────────────────────────────────

def test_the_self_description_lists_scorers_with_their_thresholds_resolved(stamped: Path):
    # A team that deleted the scorers a stamp ships has none, and is still described.
    shutil.rmtree(stamped / "asf" / "scorers")
    plain = json.loads(asf(stamped, "check", "--json").stdout)
    assert plain["settings"]["measure"] == {"self_improvement": {"failures": 3, "of_last": 10}}
    assert (plain["scorers"], plain["scorer_problems"]) == ([], [])

    set_config(stamped, self_improvement={"failures": 2, "of_last": 8})
    scorer(stamped, "corrections", {"workflow": "issue", "focus": "builder", "kind": "code",
                                    "predicate": "corrections_above(2)"})
    scorer(stamped, "reviewer-scope", {**JUDGE, "focus": "reviewer", "sample_rate": 0.2,
                                       "model": "sonnet",
                                       "improve_after": {"failures": 4, "of_last": 6}},
           "Did the reviewer read the diff as well as the plan?\n")
    scorer(stamped, "orphan", {"workflow": "gone", "kind": "code",
                               "predicate": "corrections_above(2)"})

    checked = asf(stamped, "check", "--json")

    assert checked.returncode == 1, checked.stdout + checked.stderr
    raw = json.loads(checked.stdout)
    assert raw["ok"] is False and raw["problems"] == []
    assert raw["settings"]["measure"] == {"self_improvement": {"failures": 2, "of_last": 8}}
    assert raw["scorers"] == [
        {"name": "corrections", "workflow": "issue", "focus": "builder", "kind": "code",
         "predicate": "corrections_above(2)",
         "classes": [{"name": "above", "fail": True}, {"name": "within", "fail": False}],
         "sample_rate": 1.0, "model": "", "improve_after": {"failures": 2, "of_last": 8}},
        {"name": "reviewer-scope", "workflow": "issue", "focus": "reviewer", "kind": "judge",
         "predicate": "", "classes": JUDGE["classes"], "sample_rate": 0.2, "model": "sonnet",
         "improve_after": {"failures": 4, "of_last": 6}},
    ]
    [refused] = raw["scorer_problems"]
    assert refused["scorer"] == "orphan" and "workflow 'gone'" in refused["error"]


# ── a scorer is the operator's ───────────────────────────────────────────────

def test_install_force_never_overwrites_a_scorer(stamped: Path):
    mine = scorer(stamped, "corrections", {"workflow": "issue", "kind": "code",
                                           "predicate": "corrections_above(4)"},
                  "# Corrections\n\nOur builders get four.\n")
    written = mine.read_text()

    forced = install(stamped, "--harness", "claude_code", "--force")

    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert mine.read_text() == written
    assert asf(stamped, "check").returncode == 0


# ── the four a stamp ships ───────────────────────────────────────────────────

DEFAULTS = {
    "corrections": "corrections_above(2)",
    "limit-hits": "limit_hit",
    "not-accepted": "not_accepted",
    "permission-rollbacks": "permission_rolled_back",
}


def test_a_fresh_stamp_is_measured_from_its_first_chapter(stamped: Path):
    described = json.loads(asf(stamped, "check", "--json").stdout)

    assert described["ok"] is True and described["scorer_problems"] == []
    assert {each["name"]: (each["workflow"], each["kind"], each["predicate"])
            for each in described["scorers"]} == {
        name: ("issue", "code", predicate) for name, predicate in DEFAULTS.items()}


def test_a_re_run_reports_the_scorers_as_there_and_an_upgrade_adds_them(repo: Path):
    first = install(repo, "--harness", "claude_code")
    assert first.returncode == 0, first.stdout + first.stderr
    stamped = {Path(line.strip()[2:]).parent.name for line in first.stdout.splitlines()
               if line.strip().startswith("+ ") and "/asf/scorers/" in line}
    assert stamped == set(DEFAULTS)

    again = install(repo, "--harness", "claude_code")
    assert again.returncode == 0, again.stdout + again.stderr
    for name in DEFAULTS:
        assert f"= {repo / 'asf' / 'scorers' / name / 'scorer.md'}" in again.stdout
    assert "yours, never overwritten" in again.stdout

    # A factory stamped before there were scorers gets them from a plain re-run.
    for name in ("limit-hits", "not-accepted"):
        (repo / "asf" / "scorers" / name / "scorer.md").unlink()
    upgraded = install(repo, "--harness", "claude_code")
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    assert "stamped: 2 file" in upgraded.stdout
    assert all((repo / "asf" / "scorers" / name / "scorer.md").is_file() for name in DEFAULTS)


def test_install_force_leaves_the_shipped_scorers_as_the_team_left_them(stamped: Path):
    shipped = stamped / "asf" / "scorers" / "corrections" / "scorer.md"
    shipped.write_text(shipped.read_text().replace("corrections_above(2)", "corrections_above(4)"))
    written = shipped.read_text()

    forced = install(stamped, "--harness", "claude_code", "--force")

    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert shipped.read_text() == written

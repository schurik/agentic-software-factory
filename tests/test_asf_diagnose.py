"""The diagnosis: one bounded agent phase saying what to change, before a
self-improvement issue is filed (ADR 0006).

When a scorer's failures are a pattern and no issue is open for it, the
`diagnostician` reads the failing sessions' records and answers a typed
envelope — the cause, the surface (factory or application), the files and the
proposed change — checked by gates like any other phase's claims. Code then
applies the rules no model decides: a skill-owned task file is redirected to
the workflow's task override and marked upstreamable, and factory code — where
every gate is — is reported, never proposed. The issue body carries the
result. Through the seam a person meets it by: `asf run` on the fake harness,
filing on a forge that records (`asf_helpers.forge`).
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from engine import factory, measurement

from .asf_helpers import asf, commit_all, envelope, fake_roster, scorer, set_config
from .test_asf_improve import (CONFIG, CRITERIA, REFUSED, filed, on_the_forge, refuse,
                               refused_run)
from .test_asf_scorers import worktrees

CAUSE = "The builder's fix loop gives up after two tries on a module that fails to import."
CHANGE = "Raise `max_fix_loops` for `verify` to 3, so an import error gets a third look."


def diagnosed(files: list[str], surface: str = "factory", change: str = CHANGE,
              upstreamable: bool = False) -> dict:
    return {"tokens": 40, "cost": 0.02, "envelope": envelope(
        cause=CAUSE, surface=surface, files=files, proposed_change=change,
        upstreamable=upstreamable)}


def filed_after_a_pattern(repo: Path, *answers: dict) -> str:
    """Two refused sessions of `quick` — the threshold — diagnosed by `answers`;
    the body of the one issue filed."""
    on_the_forge(repo)
    scorer(repo, "refused", REFUSED, CRITERIA)
    if answers:
        fake_roster(repo, diagnostician=list(answers))
    refused_run(repo)
    refused_run(repo)
    [issue] = filed(repo)
    return issue["body"]


def test_the_filed_issue_carries_the_diagnosis(stamped: Path):
    body = filed_after_a_pattern(stamped, diagnosed(["asf/factory.yaml"]))

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert CAUSE in diagnosis and CHANGE in diagnosis
    assert "**Surface:** the factory" in diagnosis
    assert "`asf/factory.yaml`" in diagnosis
    assert "upstreamable" not in diagnosis.lower()     # the operator's own file


def test_a_diagnosis_naming_files_that_do_not_exist_is_sent_back_and_its_correction_stands(
        stamped: Path):
    on_the_forge(stamped)
    scorer(stamped, "refused", REFUSED, CRITERIA)
    fake_roster(stamped, diagnostician=[
        diagnosed(["asf/stages/verify/retry.md", "/etc/passwd"]),
        diagnosed([]),
        diagnosed(["asf/factory.yaml"])])
    refused_run(stamped)

    result = refuse(stamped)

    said = result.stdout
    assert "asf/stages/verify/retry.md is no file of the repository" in said
    assert "/etc/passwd is no file of the repository" in said
    assert "surface factory is a change under `asf/`, and /etc/passwd is not" in said
    assert "names no file" in said
    [issue] = filed(stamped)
    assert "`asf/factory.yaml`" in issue["body"] and "retry.md" not in issue["body"]
    assert "diagnosed: a change to the factory, in asf/factory.yaml" in said


def test_a_diagnosis_that_cannot_be_made_still_files_the_evidence(stamped: Path):
    # The roster's diagnostician has no script: every send fails.
    body = filed_after_a_pattern(stamped)

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert "None was made: " in diagnosis and "'diagnostician'" in diagnosis
    assert "## The failing scores" in body


# ── code's rulings ───────────────────────────────────────────────────────────

def test_a_skill_owned_task_file_is_redirected_to_the_workflow_override_and_upstreamable(
        stamped: Path):
    change = "In asf/stages/verify/fix.md, tell the builder to read the import error first."
    body = filed_after_a_pattern(stamped, diagnosed(["asf/stages/verify/fix.md"],
                                                    change=change))

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert "**Proposed change:**" in diagnosis
    # The fix lands where `install.py --force` leaves it: the workflow's override.
    assert ("> In asf/workflows/quick/tasks/fix.md, tell the builder to read the import "
            "error first.") in diagnosis
    assert ("`asf/workflows/quick/tasks/fix.md` — the workflow's own task override, in place "
            "of `asf/stages/verify/fix.md`") in diagnosis
    assert "**Upstreamable:**" in diagnosis


def test_a_factory_file_the_operator_wrote_is_proposed_as_it_is(stamped: Path):
    mine = stamped / "asf" / "agents" / "mine" / "agent.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("---\npurpose: the operator's own\n---\n\n# Mine\n")
    commit_all(stamped)

    body = filed_after_a_pattern(stamped, diagnosed(["asf/agents/mine/agent.md",
                                                     "asf/agents/builder/agent.md"]))

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert "- `asf/agents/mine/agent.md`\n" in diagnosis
    # The builder's prose is the skill's: proposed, and marked for a person to carry upstream.
    assert ("- `asf/agents/builder/agent.md` — the skill owns it, and `install.py --force` "
            "would overwrite it") in diagnosis
    assert "**Upstreamable:**" in diagnosis


def test_a_diagnosis_pointing_at_a_gate_is_reported_never_proposed(stamped: Path):
    body = filed_after_a_pattern(stamped, diagnosed(["asf/stages/verify/stage.py"]))

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert "**Proposed change:**" not in diagnosis
    assert "**Reported, not proposed**" in diagnosis
    assert "`asf/stages/verify/stage.py` — factory code, where gates decide" in diagnosis


# ── what it may do, and what it costs ────────────────────────────────────────

def test_a_diagnosis_is_paid_from_the_measurement_budget(stamped: Path):
    body = filed_after_a_pattern(stamped, diagnosed(["asf/factory.yaml"]))

    assert CAUSE in body
    cfg = factory.load(stamped / CONFIG)
    assert measurement.today(cfg, stamped).spent == 0.02          # the diagnostician's send


def test_once_the_day_s_measurement_is_spent_the_issue_is_filed_undiagnosed(stamped: Path):
    set_config(stamped, measurement={"usd_per_day": 0})

    body = filed_after_a_pattern(stamped, diagnosed(["asf/factory.yaml"]))

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert "None was made: the measurement budget is spent" in diagnosis
    assert not (stamped / "asf" / "data" / "diagnoses").exists()  # never called


def test_a_diagnosis_reads_in_a_tree_of_its_own_and_may_change_nothing(stamped: Path):
    # The operator is editing in the main checkout while the pattern is diagnosed.
    (stamped / "README.md").write_text("half-written, and nobody's but the operator's\n")
    answer = {**diagnosed(["asf/factory.yaml"]), "writes": {"notes.md": "my notes\n"}}

    body = filed_after_a_pattern(stamped, answer, answer, answer)

    assert "None was made: " in body and "notes.md" in body
    assert (stamped / "README.md").read_text() == "half-written, and nobody's but the operator's\n"
    assert not (stamped / "notes.md").exists()
    assert [tree for tree in worktrees(stamped) if "asf-diagnostician-" in tree["path"]] == []


def test_new_evidence_for_an_open_issue_is_not_diagnosed_again(stamped: Path):
    filed_after_a_pattern(stamped, diagnosed(["asf/factory.yaml"]))
    [first] = list((stamped / "asf" / "data" / "diagnoses").iterdir())

    refused_run(stamped)

    assert len(filed(stamped)) == 1
    assert list((stamped / "asf" / "data" / "diagnoses").iterdir()) == [first]


# ── the contract, and `asf check` ────────────────────────────────────────────

def test_the_diagnosis_s_report_block_is_the_envelope_its_answer_is_parsed_as():
    from engine import diagnose, tasks
    from engine.data_types import DiagnosisOutput

    assert tasks.check(diagnose.TASK, DiagnosisOutput) == []


@pytest.mark.parametrize("break_it, said", [
    (lambda repo: shutil.rmtree(repo / "asf" / "agents" / "diagnostician"),
     "there is no diagnostician agent"),
    (lambda repo: (repo / "asf" / "engine" / "diagnose.md").write_text(
        (repo / "asf" / "engine" / "diagnose.md").read_text().replace('"cause":', '"why":')),
     "## Report omits ['cause']"),
], ids=["no-diagnostician", "drifted-report"])
def test_a_diagnostician_that_cannot_answer_is_warned_of_and_never_called(
        stamped: Path, break_it, said: str):
    break_it(stamped)
    commit_all(stamped)

    result = asf(stamped, "check")

    # Undiagnosed is worse, not broken: every scorer still scores, and files.
    assert result.returncode == 0, result.stdout + result.stderr
    assert "~ self-improvement files its issues undiagnosed" in result.stdout
    assert said in result.stdout, result.stdout
    body = filed_after_a_pattern(stamped)
    assert "None was made: " in body and said in body
    assert not (stamped / "asf" / "data" / "diagnoses").exists()   # nothing was spent


def test_a_gate_named_beside_a_task_file_is_still_only_reported(stamped: Path):
    body = filed_after_a_pattern(stamped, diagnosed(["asf/stages/verify/stage.py",
                                                     "asf/stages/verify/fix.md"]))

    diagnosis = body[body.index("## Diagnosis"):body.index("## The scorer's criteria")]
    assert "**Proposed change** — for `asf/workflows/quick/tasks/fix.md` only" in diagnosis
    assert "`asf/stages/verify/stage.py` — factory code, where gates decide" in diagnosis


def test_a_redirect_lands_only_where_a_re_stamp_leaves_it(tmp_path: Path):
    from engine import diagnose
    from engine.data_types import DiagnosisOutput

    # pr-review's own override of `implement` is one the skill stamps, too.
    owned = {"asf/stages/implement/task.md", "asf/workflows/pr-review/tasks/implement.md"}
    answer = DiagnosisOutput(status="success", summary="s", cause="c", surface="factory",
                             files=["asf/stages/implement/task.md"], proposed_change="p")

    ruled = diagnose.ruled(answer, owned.__contains__, {
        "asf/stages/implement/task.md": "asf/workflows/pr-review/tasks/implement.md"})

    [named] = ruled.files
    assert (named.path, named.ruling, ruled.upstreamable) == (
        "asf/stages/implement/task.md", "proposed", True)

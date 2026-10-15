"""`reproduce`: a bug report becomes a failing test before anyone fixes it.

Everything here runs on the `fake` harness against a real stamp: the builder is
a script, and the test it writes is a real file the gate really runs. The
"application" is one function with an off-by-one in it, and its repro is a
plain python script that asserts on it — a runner with no collection step, so
what the gate refuses is decided by the output and the exit code, the way it is
for every runner.

What is proven, in the order the issue asks for it:

  * the gate refuses a repro that passes, one that never runs, and one that
    fails some other way than it declared — each back to the same session;
  * the test is frozen once the gate passed: a later call that edits it is
    corrected, and the commit lands it as it was shown failing;
  * `verify` runs it beside its blocks, and a red repro goes to the builder;
  * the repro and the fix land in ONE commit, and the pull request says what
    the gate saw;
  * not reproduced: asked on the item, answered, tried again, and after the
    last round the run ends not accepted, with what was tried on the item.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

from engine import events, factory, integration, issues, reproduction
from engine.data_types import IntegrationResult, Option, Question, ReproOutput

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, envelope, fake_roster, forge,
                          forge_calls, forge_data, git, issue_json, phase_names, run_state,
                          session_dir, set_config, task_text, wire, write_workflow)

ADW = "be9f1c0d"
BUGGY = "def add(a, b):\n    return a + b + 1\n"
FIXED = "def add(a, b):\n    return a + b\n"
REPRO = ("from app import add\n"
         "assert add(2, 2) == 4, f'add(2, 2) returned {add(2, 2)}'\n")
DECLARED = "add(2, 2) returned 5"
COMMAND = [sys.executable, "test_bug.py"]

FIXING = {"description": "reproduce the bug, fix it, verify, commit",
          "input": "prompt",
          "stages": [{"reproduce": {"agent": "builder"}},
                     {"implement": {"agent": "builder"}},
                     {"verify": {"blocks": ["test"], "max_fix_loops": 2,
                                 "fix": {"agent": "builder"}}},
                     {"commit": {"of": "implement"}}]}


def repro_reply(content: str = REPRO, expected: str = DECLARED, **fields) -> dict:
    return {"writes": {"test_bug.py": content},
            "envelope": envelope(reproduced=True, repro_test="test_bug.py",
                                 repro_command=COMMAND, expected_failure=expected, **fields)}


def fix_reply(content: str = FIXED, **writes: str) -> dict:
    return {"writes": {"app.py": content, **writes},
            "envelope": envelope(changed_files=["app.py"], commit_message="fix: add adds")}


def prepare(repo: Path, builder: list[dict], spec: dict = FIXING) -> None:
    (repo / "app.py").write_text(BUGGY)
    fake_roster(repo, builder=builder)
    wire(repo, "test", PY_CHECK)
    write_workflow(repo, "fixing", spec)
    commit_all(repo)


def run(repo: Path):
    return asf(repo, "run", "fixing", "add(2, 2) is 5", "--adw-id", ADW)


def lines_of(repo: Path, kind: str, adw_id: str = ADW) -> list[events.EventLine]:
    return [line for line in events.read(session_dir(repo, adw_id)) if line.kind == kind]


def gate_results(repo: Path, gate: str) -> list[dict]:
    return [line.payload for line in lines_of(repo, "gate_result")
            if line.payload["gate"] == gate]


def sent(repo: Path) -> str:
    """Every prompt the builder was sent, oldest first, as its harness saw them."""
    raw = session_dir(repo, ADW) / "builder" / "raw_output.jsonl"
    return raw.read_text() if raw.is_file() else ""


# ── the gate: a reproduction is a test that fails the declared way ───────────

def test_a_real_repro_is_frozen_fixed_verified_and_lands_with_the_fix_in_one_commit(
        stamped: Path):
    prepare(stamped, builder=[repro_reply(), fix_reply()])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    assert phase_names(stamped, ADW) == [
        "request", "reproduce", "implement", "verify_1", "commit_implement"]
    shown = gate_results(stamped, "reproduces")
    assert [entry["passed"] for entry in shown] == [True]
    # The proof is in the record: the gate's own checks name what it saw.
    said = " ".join(check["note"] for check in shown[0]["checks"])
    assert DECLARED in said
    # ...and the repro ran as a command, beside the blocks, every time it did.
    assert [line.payload["name"] for line in lines_of(stamped, "command_finished")] == [
        "repro", "test", "repro"]
    # ONE commit on the branch, holding the test and the fix together: no
    # commit anywhere has a red repro in it.
    branch = f"asf/{ADW}"
    commits = git(stamped, "rev-list", f"main..{branch}").split()
    assert len(commits) == 1
    landed = git(stamped, "show", "--name-only", "--format=", branch).split()
    assert sorted(landed) == ["app.py", "test_bug.py"]
    assert git(stamped, "show", f"{branch}:test_bug.py") == REPRO.rstrip()


@pytest.mark.parametrize("content, expected, refused", [
    # It passes: whatever it tests, it is not the reported bug.
    ("from app import add\nassert add(2, 2) == 5\n", DECLARED, "passed"),
    # It never runs: an import error is not a failing test.
    ("from appp import add\nassert add(2, 2) == 4\n", DECLARED, "never ran"),
    # It fails, and not the way it said it would.
    ("from app import add\nassert add(2, 2) == 4, 'wrong'\n", DECLARED, "did not print"),
], ids=["passes", "broken", "wrong-failure"])
def test_the_gate_refuses_what_is_not_a_reproduction_and_the_same_session_corrects_it(
        stamped: Path, content: str, expected: str, refused: str):
    prepare(stamped, builder=[repro_reply(content, expected), repro_reply(), fix_reply()])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    shown = gate_results(stamped, "reproduces")
    assert [entry["passed"] for entry in shown] == [False, True]
    assert any(refused in violation for violation in shown[0]["violations"]), shown[0]
    # A correction, in the same session — never a new phase.
    assert phase_names(stamped, ADW).count("reproduce") == 1


def test_a_command_that_does_not_run_the_declared_test_is_refused_before_it_is_run(
        stamped: Path):
    elsewhere = repro_reply()
    elsewhere["envelope"]["repro_command"] = [sys.executable, "-c", "raise SystemExit(1)"]
    prepare(stamped, builder=[elsewhere, repro_reply(), fix_reply()])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    first = gate_results(stamped, "reproduces")[0]
    assert any("does not name test_bug.py" in violation for violation in first["violations"])
    # Refused on the claim alone: the first command run is the corrected one's.
    assert [line.payload["name"] for line in lines_of(stamped, "command_finished")] == [
        "repro", "test", "repro"]


def test_an_envelope_that_claims_a_repro_without_saying_how_is_refused_at_parse():
    with pytest.raises(ValueError, match="repro_command"):
        ReproOutput(status="success", reproduced=True, repro_test="t.py",
                    expected_failure="boom")
    with pytest.raises(ValueError, match="tried"):
        ReproOutput(status="success", reproduced=False)


# ── a browser bug: the spec runs through the repository's own e2e block ──────

# A stand-in for Playwright: runs the spec it is handed last, after checking it
# was handed what the e2e block hands its command, and leaves evidence where
# `--output` would.
PLAYWRIGHT = [sys.executable, "-c",
              "import os, runpy, sys; assert os.environ['PORT'] and os.environ['ASF_CHECK_DIR']; "
              "os.makedirs(os.path.join(os.environ['ASF_CHECK_DIR'], 'test-results'), "
              "exist_ok=True); runpy.run_path(sys.argv[-1])"]
SPEC = "e2e/bug_spec.py"


def e2e_reply(spec: str = SPEC, **fields) -> dict:
    return {"writes": {spec: REPRO},
            "envelope": envelope(reproduced=True, kind="e2e", repro_test=spec,
                                 expected_failure=DECLARED, **fields)}


def test_an_e2e_repro_runs_through_the_e2e_block_with_its_spec_appended(stamped: Path):
    wire(stamped, "e2e", PLAYWRIGHT)
    prepare(stamped, builder=[e2e_reply(), fix_reply()])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    assert [entry["passed"] for entry in gate_results(stamped, "reproduces")] == [True]
    ran = [line.payload for line in lines_of(stamped, "command_finished")]
    assert [entry["name"] for entry in ran] == ["repro", "test", "repro"]
    # The block's own argv, with the spec as its last argument — no command
    # the agent wrote.
    assert ran[0]["argv"] == [*PLAYWRIGHT, SPEC]
    assert git(stamped, "show", f"asf/{ADW}:{SPEC}") == REPRO.rstrip()


def test_an_e2e_repro_in_a_repository_without_a_wired_e2e_block_is_refused(stamped: Path):
    only = {**FIXING, "stages": [{"reproduce": {"agent": "builder"}}]}
    prepare(stamped, builder=[e2e_reply(), repro_reply()], spec=only)

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    first = gate_results(stamped, "reproduces")[0]
    assert any("placeholder" in violation for violation in first["violations"]), first
    # Refused before anything ran: the corrected unit repro is the first command.
    assert lines_of(stamped, "command_finished")[0].payload["argv"] == COMMAND
    # ...and the builder was told up front which kinds this repository can run.
    asked = (session_dir(stamped, ADW) / "builder" / "prompts" / "user.md").read_text()
    assert "is not wired" in asked


def test_a_red_e2e_repro_hands_the_builder_its_evidence(stamped: Path):
    wire(stamped, "e2e", PLAYWRIGHT)
    no_fix = {"writes": {"notes.txt": "looked\n"},
              "envelope": envelope(changed_files=["notes.txt"], commit_message="fix: add")}
    prepare(stamped, builder=[e2e_reply(), no_fix, fix_reply()])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    fix_prompt = (session_dir(stamped, ADW) / "builder" / "prompts" / "user.md").read_text()
    assert DECLARED in fix_prompt and "test-results" in fix_prompt


def test_an_e2e_repro_declares_no_command_of_its_own():
    with pytest.raises(ValueError, match="e2e block"):
        ReproOutput(status="success", reproduced=True, kind="e2e", repro_test="e2e/x.spec.ts",
                    repro_command=["npx", "playwright", "test"], expected_failure="boom")
    ReproOutput(status="success", reproduced=True, kind="e2e", repro_test="e2e/x.spec.ts",
                expected_failure="boom")


# ── frozen: the reproduction cannot be weakened afterwards ───────────────────

def test_a_later_call_that_edits_the_repro_is_corrected_and_the_test_lands_unchanged(
        stamped: Path):
    weakened = "from app import add\nassert add(2, 2) in (4, 5)\n"
    prepare(stamped, builder=[repro_reply(),
                              fix_reply(**{"test_bug.py": weakened}),
                              fix_reply(**{"test_bug.py": REPRO})])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    held = gate_results(stamped, "repro_unchanged")
    # Every later agent call carries it; the implement call failed it once.
    assert [entry["passed"] for entry in held] == [False, True]
    assert "restore it" in held[0]["violations"][0]
    assert phase_names(stamped, ADW).count("implement") == 1
    assert git(stamped, "show", f"asf/{ADW}:test_bug.py") == REPRO.rstrip()


def test_the_frozen_copy_is_kept_where_a_correction_can_restore_it_from(stamped: Path):
    prepare(stamped, builder=[repro_reply(), fix_reply()])

    run(stamped)

    kept = session_dir(stamped, ADW) / "context_handoff" / "frozen" / "test_bug.py"
    assert kept.read_text() == REPRO


# ── verify runs the repro, whatever its blocks collect ───────────────────────

def test_verify_runs_the_repro_and_a_red_one_goes_back_to_the_builder(stamped: Path):
    no_fix = {"writes": {"notes.txt": "looked\n"},
              "envelope": envelope(changed_files=["notes.txt"], commit_message="fix: add")}
    prepare(stamped, builder=[repro_reply(), no_fix, fix_reply()])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    assert phase_names(stamped, ADW) == [
        "request", "reproduce", "implement", "verify_1", "fix_1", "verify_2",
        "commit_implement"]
    # The test block was green on verify_1; the repro is what sent it back.
    fix_prompt = (session_dir(stamped, ADW) / "builder" / "prompts" / "user.md").read_text()
    assert DECLARED in fix_prompt


def test_an_unfixed_repro_stops_the_run_before_anything_lands(stamped: Path):
    no_fix = {"writes": {"notes.txt": "looked\n"},
              "envelope": envelope(changed_files=["notes.txt"], commit_message="fix: add")}
    prepare(stamped, builder=[repro_reply(), no_fix, no_fix])

    result = run(stamped)

    assert result.returncode != 0
    assert "commit_implement" not in phase_names(stamped, ADW)
    assert git(stamped, "rev-list", f"main..asf/{ADW}") == ""


def test_a_review_s_revision_is_held_to_the_frozen_test_and_its_retest_runs_the_repro(
        stamped: Path):
    reviewed = {**FIXING, "stages": [*FIXING["stages"][:3],
                                     {"review": {"agent": "reviewer", "max_rounds": 2,
                                                 "revise": {"agent": "builder"},
                                                 "retest": ["test"]}},
                                     FIXING["stages"][3]]}
    report = str(session_dir(stamped, ADW) / "context_handoff" / "review.md")
    verdict = lambda approved: {"writes": {report: "# Review\n"}, "envelope": envelope(  # noqa: E731
        approved=approved, artifacts=[report],
        blocking=[] if approved else ["name the off-by-one in a comment"])}
    fake_roster(stamped, reviewer=[verdict(False), verdict(True)])
    prepare(stamped, spec=reviewed, builder=[
        repro_reply(), fix_reply(),
        fix_reply(FIXED + "# was off by one\n", **{"test_bug.py": "assert True\n"}),
        fix_reply(FIXED + "# was off by one\n", **{"test_bug.py": REPRO})])

    result = run(stamped)

    assert result.returncode == 0, result.stdout + result.stderr
    assert phase_names(stamped, ADW) == [
        "request", "reproduce", "implement", "verify_1", "review_1", "revise_1", "review_2",
        "retest", "commit_implement"]
    # implement, review_1, revise_1 (refused, then restored), review_2.
    assert [entry["passed"] for entry in gate_results(stamped, "repro_unchanged")] == [
        True, True, False, True, True]
    assert [line.payload["name"] for line in lines_of(stamped, "command_finished")] == [
        "repro", "test", "repro", "test", "repro"]
    assert git(stamped, "show", f"asf/{ADW}:test_bug.py") == REPRO.rstrip()


# ── the pull request says what the gate saw ──────────────────────────────────

class PullRun:
    def __init__(self, handoff: Path):
        self.adw_id, self.issue_number, self.issue_url = ADW, 7, ""
        self.context_handoff_dir = handoff


def test_the_pull_request_shows_the_declared_failure_and_the_output_the_gate_saw(
        stamped: Path):
    prepare(stamped, builder=[repro_reply(), fix_reply()])
    run(stamped)

    body = integration._pr_body(PullRun(session_dir(stamped, ADW) / "context_handoff"), "",
                                IntegrationResult())

    assert "Reproduced before the fix" in body
    assert DECLARED in body and "test_bug.py" in body
    assert body.rstrip().endswith("Closes #7")


def test_a_run_that_reproduced_nothing_adds_nothing_to_the_pull_request(tmp_path: Path):
    body = integration._pr_body(PullRun(tmp_path), "", IntegrationResult())
    assert body == "Closes #7"
    assert reproduction.pr_section(tmp_path) == ""


# ── not reproduced: ask the reporter, then stop ──────────────────────────────

def ask(*texts: str) -> list[dict]:
    return [Question(topic="steps", question=text, options=[
        Option(answer="on login", because="the report mentions it", recommended=True),
        Option(answer="on refresh", because="where add() is called")]).model_dump()
        for text in texts]


def not_reproduced(tried: str) -> dict:
    return {"envelope": envelope(reproduced=False, tried=tried,
                                 open_questions=ask("Where does it happen?"))}


@pytest.fixture
def tracked(stamped: Path, monkeypatch):
    monkeypatch.chdir(stamped)
    base = forge(stamped)
    set_config(stamped, issues={
        "enabled": True, "project": "acme/widgets",
        "fetch_command": [*base, "view"], "comments_command": [*base, "view"],
        "body_command": [*base, "edit"], "state_command": [*base, "edit"],
        "comment_command": [*base, "comment"], "list_command": [*base, "list"]})
    forge_data(stamped, "issue.json", issue_json(labels=("asf:queued", "asf:bugfix")))
    return stamped


def bugfixing(repo: Path, builder: list[dict]) -> None:
    spec = {**FIXING, "input": "issue"}
    prepare(repo, builder=builder, spec=spec)


def comments_posted(repo: Path) -> list[str]:
    return [call[call.index("--body") + 1] for call in forge_calls(repo) if call[0] == "comment"]


def test_not_reproduced_asks_on_the_item_and_an_answer_brings_a_second_try(tracked: Path):
    bugfixing(tracked, builder=[not_reproduced("ran add(2, 2) from a shell: 4"),
                                repro_reply(), fix_reply()])

    asked = asf(tracked, "run", "fixing", "42", "--adw-id", ADW)

    assert asked.returncode == 75, asked.stdout + asked.stderr
    assert adw_id_of(asked) == ADW
    assert issues.questions_mark(ADW, 1) in comments_posted(tracked)[0]
    waiting = run_state(tracked, ADW)["waiting_for"]
    assert (waiting["gate"], waiting["kind"], waiting["channel"]) == (
        "reproduction", "questions", "issue")

    answered = asf(tracked, "answer", ADW, "-m", "it happens on login, with 2 and 2")

    assert answered.returncode == 0, answered.stdout + answered.stderr
    assert phase_names(tracked, ADW) == [
        "issue", "reproduce", "ask_reproduction", "reproduce_2", "implement", "verify_1",
        "commit_implement", "report"]
    retried = (session_dir(tracked, ADW) / "builder" / "prompts" / "user.md")
    # The answer travelled forward as a file the second try was told to read.
    answers = session_dir(tracked, ADW) / "context_handoff" / "reproduction_answers_1.md"
    assert "on login, with 2 and 2" in answers.read_text()
    assert retried.is_file()


def test_still_not_reproduced_after_the_last_round_stops_with_what_was_tried_on_the_item(
        tracked: Path):
    bugfixing(tracked, builder=[not_reproduced("ran add(2, 2) from a shell: 4"),
                                not_reproduced("ran add on login's inputs: 4 again")])

    asf(tracked, "run", "fixing", "42", "--adw-id", ADW)
    ended = asf(tracked, "answer", ADW, "-m", "on login")

    assert ended.returncode != 0
    assert phase_names(tracked, ADW) == [
        "issue", "reproduce", "ask_reproduction", "reproduce_2", "reproduce_report", "report"]
    assert run_state(tracked, ADW)["status"] == "fail"
    # Not a crash: every phase passed, and the workflow did not accept it, for
    # this reason — which is how a cockpit tells it apart from a failure.
    finished = lines_of(tracked, "workflow_finished")[-1].payload
    assert finished["accepted"] is False
    assert finished["reason"].startswith("not reproduced")
    told = next(body for body in comments_posted(tracked) if "could not reproduce" in body)
    assert "ran add(2, 2) from a shell: 4" in told and "ran add on login's inputs" in told
    # Nothing was built on a bug nobody could show.
    assert git(tracked, "rev-list", f"main..asf/{ADW}") == ""


def test_a_question_round_with_no_options_is_refused_like_refine_s(tracked: Path):
    bare = {"envelope": envelope(reproduced=False, tried="ran it: 4", open_questions=[
        {"topic": "steps", "question": "Where?", "options": []}])}
    bugfixing(tracked, builder=[bare, not_reproduced("ran it: 4")])

    asked = asf(tracked, "run", "fixing", "42", "--adw-id", ADW)

    assert asked.returncode == 75, asked.stdout + asked.stderr
    refused = [entry for entry in lines_of(tracked, "gate_result")
               if entry.payload["gate"] == "questions_are_answerable"]
    assert [entry.payload["passed"] for entry in refused] == [False, True]


# ── what a stamped repo ships ────────────────────────────────────────────────

def test_bugfix_is_stamped_routed_and_checks_clean(stamped: Path, monkeypatch):
    monkeypatch.chdir(stamped)
    cfg = factory.load("asf/factory.yaml")

    assert cfg.issues.route["asf:bugfix"] == "bugfix"
    listed = asf(stamped, "check")
    assert listed.returncode == 0, listed.stdout + listed.stderr
    line = next(row for row in listed.stdout.splitlines() if row.startswith("✓ bugfix:"))
    assert line.split("agents:")[0].strip() == (
        "✓ bugfix: scout -> reproduce -> implement -> verify -> review -> commit -> integrate")
    # pr-review is untouched: review threads are about code just written.
    pr_review = (stamped / "asf" / "workflows" / "pr-review" / "workflow.yaml").read_text()
    assert "reproduce" not in pr_review


def test_the_bugfix_accept_example_judges_the_running_app_after_verify(stamped: Path):
    shipped = stamped / "asf" / "workflows"
    example = stamped / "asf" / "examples" / "workflows" / "bugfix-accept"
    shutil.copytree(example, shipped / "bugfix-accept")
    (stamped / "asf" / "factory.yaml").write_text(
        (stamped / "asf" / "factory.yaml").read_text()
        + "\nserve:\n  commands: [[python3, -m, http.server, '{port}']]\n")

    checked = asf(stamped, "check", "bugfix-accept")

    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert "reproduce -> implement -> verify -> accept -> review ->" in checked.stdout
    # Judged against the report and the reproduction, not a plan there is none of.
    task = (example / "tasks" / "accept.md").read_text()
    assert "issue.md" in task and "reproduction.md" in task


def test_check_refuses_a_reproduce_task_whose_report_drifted(stamped: Path):
    drifted = {"status": "success", "summary": "<s>", "reproduced": True,
               "repro_cmd": ["pytest"], "artifacts": []}
    write_workflow(stamped, "fixing", FIXING,
                   tasks={"reproduce": task_text("Reproduce", "drifted", drifted)})

    checked = asf(stamped, "check")

    assert checked.returncode != 0
    assert "repro_cmd" in checked.stdout + checked.stderr

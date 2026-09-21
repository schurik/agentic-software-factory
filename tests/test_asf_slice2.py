"""Slice two, end to end on the fake harness: the full `ship` chain, the gate
CLI (pending, show, reject, approve, resume), and doctor."""

from __future__ import annotations

import json
from pathlib import Path

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, db_rows, envelope,
                          fake_roster, git, phase_names, run_state, session_dir,
                          set_config, wire, write_workflow)


SHIP_ID = "5c0075aa"       # pinned, so the scout's scripted write can name the handoff dir


def scout_reply(repo: Path) -> dict:
    findings = session_dir(repo, SHIP_ID) / "context_handoff" / "scout_findings.md"
    return {"writes": {str(findings): "# Findings\n\n- app.py: not there yet.\n"},
            "envelope": envelope(findings=[{"file": "app.py", "note": "does not exist yet"}],
                                 artifacts=[str(findings)],
                                 notes_for_next_agent="nothing to read: app.py is new")}


def plan_reply(text: str = "# Plan\n") -> dict:
    return {"writes": {"docs/asf/spec/plan.md": text},
            "envelope": envelope(artifacts=["docs/asf/spec/plan.md"], commit_message="docs: plan")}


def build_reply(content: str, message: str) -> dict:
    return {"writes": {"app.py": content},
            "envelope": envelope(changed_files=["app.py"], commit_message=message)}


def review_reply(approved: bool, *blocking: str) -> dict:
    findings = [] if approved else [{"requirement": b, "met": False, "evidence": "app.py:1"}
                                    for b in blocking]
    return {"envelope": envelope(approved=approved, blocking=list(blocking), findings=findings,
                                 artifacts=[])}


def document_reply() -> dict:
    return {"writes": {"docs/asf/app.md": "# app\n\nWhat changed: app.py.\n"},
            "envelope": envelope(artifacts=["docs/asf/app.md"], document_path="docs/asf/app.md",
                                 documented_files=["app.py"], commit_message="docs: app")}


def test_ship_reviews_revises_retests_documents_and_lands_three_commits(stamped: Path):
    fake_roster(
        stamped,
        scout=[scout_reply(stamped)],
        planner=[plan_reply()],
        builder=[build_reply("ok = 1\n", "feat: app"),
                 build_reply("ok = 2\n", "feat: app, ok is 2 as reviewed")],
        reviewer=[review_reply(False, "ok must be 2"), review_reply(True)],
        documenter=[document_reply()])
    wire(stamped, "test", PY_CHECK)
    # The stamped default is `pr`, which lands nothing on main; this test is
    # about the three commits main receives, so it asks for a merge.
    set_config(stamped, worktree={"integration": {"mode": "merge"}})
    commit_all(stamped)
    before = git(stamped, "rev-parse", "main")

    result = asf(stamped, "run", "ship", "add app.py", "--adw-id", SHIP_ID)
    assert result.returncode == 0, result.stdout + result.stderr
    adw_id = adw_id_of(result)
    assert adw_id == SHIP_ID

    assert phase_names(stamped, adw_id) == [
        "request", "scout", "plan", "commit_plan", "implement", "verify_1",
        "review_1", "revise_1", "review_2", "retest",
        "commit_implement", "changes", "document", "commit_document", "integrate"]
    # Three work products, three commits, each in its author's words — and the
    # code commit is the build AS REVISED, landed only after review and retest.
    subjects = git(stamped, "log", "--format=%s", f"{before}..main").splitlines()
    assert subjects[1:] == ["docs: app", "feat: app, ok is 2 as reviewed", "docs: plan"]
    assert subjects[0].startswith(f"asf({adw_id}): merge asf/{adw_id} into main")
    assert (stamped / "app.py").read_text() == "ok = 2\n"
    assert (stamped / "docs" / "asf" / "app.md").is_file()
    # The reviewer was asked with the review task and the builder's revision
    # with the revise task, not the implement task.
    prompts = session_dir(stamped, adw_id)
    assert (prompts / "reviewer" / "prompts" / "user.md").read_text().startswith("# Review")
    assert (prompts / "builder" / "prompts" / "user.md").read_text().startswith("# Revise")
    # The scout went first and changed nothing; the planner was handed its findings.
    assert (prompts / "scout" / "prompts" / "user.md").read_text().startswith("# Scout")
    planner_brief = (prompts / "planner" / "prompts" / "user.md").read_text()
    assert '"file": "app.py"' in planner_brief and "scout_findings.md" in planner_brief


def test_a_reviewer_that_never_approves_stops_the_run_before_the_code_lands(stamped: Path):
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")],
                reviewer=[review_reply(False, "still wrong")])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "reviewed", {
        "description": "implement, verify, review, commit",
        "stages": [{"implement": {}}, {"verify": {}},
                   {"review": {"max_rounds": 2, "retest": []}},
                   {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "reviewed", "add app.py")
    assert result.returncode == 1
    adw_id = adw_id_of(result)
    names = phase_names(stamped, adw_id)
    assert names[-3:] == ["review_1", "revise_1", "review_2"]
    assert "commit_implement" not in names
    assert "withheld approval after 2 round(s)" in result.stdout
    assert git(stamped, "log", "-1", "--format=%s", f"asf/{adw_id}") == "prepare"


def test_the_gate_cli_answers_a_suspended_run_and_brings_it_back(stamped: Path):
    fake_roster(stamped, planner=[plan_reply("# Plan v1\n"), plan_reply("# Plan v2, revised\n")],
                builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "gated", {
        "description": "a person between the plan and the code",
        "stages": [{"plan": {"hitl": True}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    run = asf(stamped, "run", "gated", "add app.py")
    assert run.returncode == 75, run.stdout + run.stderr           # suspended, nothing spent
    adw_id = adw_id_of(run)

    pending = asf(stamped, "pending")
    assert pending.returncode == 0 and adw_id in pending.stdout and "plan · round 1" in pending.stdout
    shown = asf(stamped, "show", adw_id)
    assert shown.returncode == 0 and "# Plan v1" in shown.stdout

    # A reject goes back to the planner in the same session, and the run asks again.
    rejected = asf(stamped, "reject", adw_id, "-m", "more detail")
    assert rejected.returncode == 75, rejected.stdout + rejected.stderr
    assert "waiting again — gate plan, round 2" in rejected.stdout
    assert run_state(stamped, adw_id)["waiting_for"]["round"] == 2
    assert "# Plan v2" in asf(stamped, "show", adw_id).stdout
    decision = json.loads((session_dir(stamped, adw_id) / "decisions" / "plan_1.json").read_text())
    assert decision["verdict"] == "reject" and decision["notes"] == "more detail"

    # An approve brings it back: recorded phases replay, the rest runs for real.
    approved = asf(stamped, "approve", adw_id)
    assert approved.returncode == 0, approved.stdout + approved.stderr
    names = phase_names(stamped, adw_id)
    assert names[-2:] == ["implement", "commit_implement"]
    # Three processes walked this chain — the run, the reject, the approve —
    # and every phase each of them re-entered landed back on its own row
    # rather than beside it (issue #4).
    assert names == ["request", "plan", "approve_plan", "plan_revise_1",
                     "approve_plan_2", "implement", "commit_implement"]
    assert run_state(stamped, adw_id)["status"] == "success"
    assert git(stamped, "log", "-1", "--format=%s", f"asf/{adw_id}") == "feat: app"

    # And a reject without notes is refused before anything is written.
    fresh = asf(stamped, "run", "gated", "add app.py")
    again = adw_id_of(fresh)
    refused = asf(stamped, "reject", again)
    assert refused.returncode == 1 and "a reject needs notes" in refused.stdout
    assert not (session_dir(stamped, again) / "decisions").exists()


def test_resume_rebuilds_the_recorded_invocation_and_refuses_an_unanswered_gate(stamped: Path):
    fake_roster(stamped, planner=[plan_reply()], builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "gated", {
        "description": "x",
        "stages": [{"plan": {"hitl": True}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))

    blocked = asf(stamped, "resume", adw_id)
    assert blocked.returncode == 1 and "no decision recorded" in blocked.stdout

    asf(stamped, "approve", adw_id, "--no-resume")
    dry = asf(stamped, "resume", adw_id, "--dry-run")
    assert dry.returncode == 0, dry.stdout + dry.stderr
    command = dry.stdout.splitlines()[-1].strip()
    assert command.endswith(f"run gated 'add app.py' --adw-id {adw_id} --resume")
    assert "--config asf/factory.yaml run" in command

    resumed = asf(stamped, "resume", adw_id)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    assert run_state(stamped, adw_id)["status"] == "success"


def test_a_resumed_run_re_enters_its_phases_instead_of_recording_them_again(stamped: Path):
    """The trace is a session's phases, not a log of how often it was picked up.

    A resume re-walks the chain from the top by design — the phases before the
    failure are replayed or, where code owns them, re-run — and each of those
    walks used to open a NEW phase, so the visualizer drew every finished stage
    once per recovery. They land on the rows they already have.
    """
    # A builder that claims a file it never writes: the gate catches it, the
    # correction gets the same answer back, and the implement phase fails with
    # the plan before it already on the record.
    fake_roster(stamped, planner=[plan_reply()],
                builder=[{"envelope": envelope(changed_files=["app.py"],
                                               commit_message="feat: app")}])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "recoverable", {
        "description": "a chain whose builder gets it wrong the first time",
        "stages": [{"plan": {}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    failed = asf(stamped, "run", "recoverable", "add app.py")
    assert failed.returncode == 1, failed.stdout + failed.stderr
    adw_id = adw_id_of(failed)
    assert phase_names(stamped, adw_id) == ["request", "plan", "implement"]

    # Script the builder and pick it back up: `plan` replays, `implement` runs
    # for real under the number it already had, and `commit` is the only phase
    # the resume adds.
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    resumed = asf(stamped, "resume", adw_id)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    assert run_state(stamped, adw_id)["status"] == "success"

    rows = db_rows(stamped, "select seq, name, status from phases "
                            f"where adw_id='{adw_id}' order by seq")
    assert rows == [(1, "request", "success"), (2, "plan", "success"),
                    (3, "implement", "success"), (4, "commit_implement", "success")]


def test_doctor_names_every_placeholder_and_checks_every_workflow(stamped: Path):
    fake_roster(stamped, planner=[plan_reply()], builder=[build_reply("ok = 1\n", "feat")])
    commit_all(stamped)
    result = asf(stamped, "doctor")
    assert result.returncode == 0, result.stdout + result.stderr      # warnings, nothing fatal
    assert "asf doctor" in result.stdout
    assert "still placeholders" in result.stdout and "lint" in result.stdout
    assert "FAKE harness" in result.stdout
    for name in ("quick", "sdlc", "ship"):
        assert f"✓ {name}:" in result.stdout

    # `stamped` has ASF_SKILL, so whatever else the machine lacks (bun, a free
    # :4600), reaching the visualizer is not what the trace UI complains about.
    trace = next(line for line in result.stdout.splitlines() if "trace UI" in line)
    assert "ASF_SKILL" not in trace

    # `--config` is accepted after the subcommand too; a wrong one is refused.
    assert asf(stamped, "list", "--config", "asf/factory.yaml").returncode == 0
    missing = asf(stamped, "doctor", "--config", "asf/nope.yaml")
    assert missing.returncode != 0 and "no config at asf/nope.yaml" in missing.stderr


def test_doctor_will_not_tick_a_trace_ui_that_cannot_start(stamped: Path):
    """The bug this exists for: with ASF_SKILL unset the visualizer is
    unreachable, `up` drops it silently — and doctor printed `✓ trace UI` on
    the strength of bun being installed, pointing away from the one thing
    wrong. Empty rather than deleted because load_dotenv does not override."""
    fake_roster(stamped)
    result = asf(stamped, "doctor", env={"ASF_SKILL": ""})
    assert result.returncode == 0, result.stdout + result.stderr
    assert "✓ trace UI" not in result.stdout
    assert "~ trace UI" in result.stdout
    for line in result.stdout.splitlines():
        if "trace UI" in line:
            assert "just up" in line and "just obs" in line
    # and the ASF_SKILL finding names the visualizer, not only re-installing
    skill_line = next(line for line in result.stdout.splitlines() if "ASF_SKILL" in line)
    assert "trace UI" in skill_line


def test_a_gate_remark_reaches_every_agent_after_it_not_only_the_next_one(stamped: Path):
    """Issue #2: an engineer approved a plan and asked for one more thing in the
    same breath. The builder read it off `notes_for_next_agent` and built it; the
    reviewer, two phases later, measured that build against a plan nobody had
    amended, called the extra work unrequested and sent the builder back to take
    it out. A remark is a standing amendment to the request, so every agent the
    run calls afterwards reads it — see engine/remarks.py."""
    fake_roster(stamped, planner=[plan_reply()], builder=[build_reply("ok = 1\n", "feat: app")],
                reviewer=[review_reply(True)])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "remarked", {
        "description": "a person approves the plan and asks for one more thing",
        "stages": [{"plan": {"hitl": True}}, {"implement": {}},
                   {"review": {"max_rounds": 1, "retest": []}},
                   {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    run = asf(stamped, "run", "remarked", "add app.py")
    assert run.returncode == 75, run.stdout + run.stderr
    adw_id = adw_id_of(run)
    said = "yes — and give status a --json flag while you are in there"

    approved = asf(stamped, "approve", adw_id, "-m", said)
    assert approved.returncode == 0, approved.stdout + approved.stderr

    session = session_dir(stamped, adw_id)
    # The next agent, which always had it.
    assert said in (session / "builder" / "prompts" / "user.md").read_text()
    # And the one after that, which is the whole point.
    reviewed = (session / "reviewer" / "prompts" / "user.md").read_text()
    assert "## What a person said to this run" in reviewed
    assert said in reviewed
    assert "### plan gate, round 1 — approve by" in reviewed   # provenance travels too
    # The planner asked before anybody had said anything, and its prompt says so.
    assert "What a person said" not in (session / "planner" / "prompts" / "user.md").read_text()

    # One remark, though two processes walked that round — the second replayed it.
    ledger = json.loads((session / "remarks.json").read_text())
    assert [(r["gate"], r["round"], r["kind"], r["verdict"], r["text"]) for r in ledger] == [
        ("plan", 1, "gate", "approve", said)]


def test_every_round_that_said_something_is_kept_in_the_order_it_was_said(stamped: Path):
    """A reject's notes are a remark too: the run reworked the plan along them,
    and an agent reading only the approve would not know why the plan says what
    it says. `asf show` prints them back, so whoever answers the second gate can
    see what they asked for at the first."""
    fake_roster(stamped, planner=[plan_reply("# Plan v1\n"), plan_reply("# Plan v2\n")],
                builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    write_workflow(stamped, "gated", {
        "description": "a person between the plan and the code",
        "stages": [{"plan": {"hitl": True}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)
    adw_id = adw_id_of(asf(stamped, "run", "gated", "add app.py"))

    assert asf(stamped, "reject", adw_id, "-m", "name the migration").returncode == 75
    shown = asf(stamped, "show", adw_id)
    assert "already said to this run:" in shown.stdout
    assert "plan round 1 (reject by" in shown.stdout and "name the migration" in shown.stdout

    assert asf(stamped, "approve", adw_id, "-m", "ship it behind a flag").returncode == 0
    session = session_dir(stamped, adw_id)
    ledger = json.loads((session / "remarks.json").read_text())
    assert [(r["round"], r["verdict"], r["text"]) for r in ledger] == [
        (1, "reject", "name the migration"), (2, "approve", "ship it behind a flag")]
    built = (session / "builder" / "prompts" / "user.md").read_text()
    assert "name the migration" in built and "ship it behind a flag" in built

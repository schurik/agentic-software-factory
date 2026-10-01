"""The factory describes itself: `asf check --json`, and the CI station that ships it.

A cockpit never interprets workflow files (spec #40). What it shows of a
factory's workflows — their stages, agents, gates, the budget — is the
SELF-DESCRIPTION the factory's own `check` prints, which is a contract with a
cockpit this repo does not run: it carries its own format version, and the
golden corpus holds one fixture per version (`tests/golden/self-description/
v<N>.json`), never edited, which the cockpit's suite reads too.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from engine import commands, describe, factory
from engine.data_types import SelfDescription

from .asf_helpers import asf, git
from .fake_cockpit import FakeCockpit

GOLDEN = Path(__file__).resolve().parent / "golden" / "self-description"


@pytest.fixture(autouse=True)
def no_cockpit_from_the_shell(monkeypatch):
    for name in ("ASF_COCKPIT_URL", "ASF_COCKPIT_TOKEN", "ASF_STATION_NAME", "CI",
                 "GITHUB_REF_NAME", "GITHUB_HEAD_REF"):
        monkeypatch.delenv(name, raising=False)


def described(repo: Path, *args: str):
    checked = asf(repo, "check", "--json", *args)
    return checked, json.loads(checked.stdout)


# ── what `check --json` says ─────────────────────────────────────────────────

def test_check_json_describes_the_stamped_factory(stamped: Path):
    checked, raw = described(stamped)

    assert checked.returncode == 0, checked.stdout + checked.stderr
    description = SelfDescription.model_validate(raw)
    assert description.format == SelfDescription.FORMAT
    assert description.ok and description.problems == []
    assert description.skill_version == (stamped / "asf" / ".skill-version").read_text().strip()
    assert description.checked.head == git(stamped, "rev-parse", "HEAD")
    assert description.checked.ref == "main"
    assert description.checked.config_hash == commands.config_hash(stamped, "asf/data")

    by_name = {workflow.name: workflow for workflow in description.workflows}
    assert set(by_name) == {"issue", "pr-review", "quick", "refine", "refine-ship", "sdlc", "ship"}
    issue = by_name["issue"]
    assert issue.input == "issue"
    assert issue.description.startswith("a tracked work item")
    assert [step.stage for step in issue.stages] == [
        "scout", "plan", "commit", "implement", "verify", "review", "commit", "document",
        "commit", "integrate"]
    assert issue.stages[1].agents == ["planner"] and issue.stages[1].kind == "agent"
    assert issue.stages[2].agents == [] and issue.stages[2].kind == "code"
    assert issue.trigger.labels == ["asf:ship"] and issue.trigger.watched
    # The workflow turns the plan gate on; factory.yaml leaves integrate's off.
    assert {(gate.name, gate.stage, gate.kind, gate.on) for gate in issue.gates} == {
        ("plan", "plan", "gate", True), ("integrate", "integrate", "gate", False)}
    planner = next(agent for agent in issue.agents if agent.name == "planner")
    assert planner.harness == "claude_code" and planner.model
    assert sorted(agent.name for agent in issue.agents) == sorted(
        {name for step in issue.stages for name in step.agents})
    assert [step.agents for step in issue.stages if step.stage == "verify"] == [["builder"]]

    refine = by_name["refine"]
    assert [(gate.name, gate.kind, gate.on) for gate in refine.gates] == [
        ("requirements", "questions", True)]
    assert by_name["pr-review"].trigger.watched and by_name["pr-review"].trigger.labels == []
    assert not by_name["sdlc"].trigger.watched
    assert description.budget.max_cost_usd == 0 and description.budget.max_tokens == 0


def test_a_workflow_that_does_not_load_is_a_problem_and_the_rest_are_still_described(
        stamped: Path):
    spec = stamped / "asf" / "workflows" / "quick" / "workflow.yaml"
    spec.write_text(spec.read_text().replace("implement: {agent: builder}",
                                             "implement: {agent: nobody}"))

    checked, raw = described(stamped)

    assert checked.returncode == 1
    description = SelfDescription.model_validate(raw)
    assert not description.ok
    assert [problem.workflow for problem in description.problems] == ["quick"]
    assert "nobody" in description.problems[0].error
    assert "quick" not in {workflow.name for workflow in description.workflows}
    assert "sdlc" in {workflow.name for workflow in description.workflows}
    # A local edit is drift from the default branch: the hash says so.
    assert description.checked.config_hash == commands.config_hash(stamped, "asf/data")


def test_the_budget_is_factory_yaml_s_per_session_ceiling(stamped: Path):
    config = stamped / "asf" / "factory.yaml"
    config.write_text(config.read_text() + "\nbudget: {max_cost_usd: 2.5, max_tokens: 900000}\n")

    _, raw = described(stamped)

    assert raw["budget"] == {"max_cost_usd": 2.5, "max_tokens": 900000}


# ── the golden corpus ────────────────────────────────────────────────────────

def test_the_writer_matches_the_golden_fixture_for_the_current_format():
    path = GOLDEN / f"v{SelfDescription.FORMAT}.json"
    assert path.is_file(), (
        f"no golden self-description for format {SelfDescription.FORMAT} at {path} — a change "
        f"to the self-description bumps SelfDescription.FORMAT and adds tests/golden/"
        f"self-description/v<N>.json beside the old one, which is never edited")
    golden = path.read_text()

    written = describe.dumps(SelfDescription.model_validate_json(golden))

    assert written == golden, (
        "the self-description's writer no longer writes its golden fixture: a change to it "
        "bumps SelfDescription.FORMAT and adds a new fixture (CLAUDE.md, invariant 10)")


def test_the_stamped_factory_s_description_has_the_golden_fixture_s_shape(stamped: Path):
    """The writer, run on a real stamp (one workflow broken, so a problem is
    described too), emits exactly the fields the current fixture holds, at
    every depth — so a field added or dropped without a format bump fails
    here, not in a cockpit."""
    spec = stamped / "asf" / "workflows" / "quick" / "workflow.yaml"
    spec.write_text(spec.read_text().replace("{agent: builder}", "{agent: nobody}", 1))
    _, raw = described(stamped)
    golden = json.loads((GOLDEN / f"v{SelfDescription.FORMAT}.json").read_text())

    assert fields(raw) == fields(golden)


def fields(value, at: str = "") -> set[str]:
    """Every dotted path to a field in `value`; a list's items share `at[]`."""
    if isinstance(value, dict):
        found = set()
        for key, item in value.items():
            found |= {f"{at}.{key}"} | fields(item, f"{at}.{key}")
        return found
    if isinstance(value, list):
        return set().union(*(fields(item, f"{at}[]") for item in value)) if value else set()
    return set()


# ── shipping it: the CI station ──────────────────────────────────────────────

URL, TOKEN = "http://cockpit.test", "asf_ingest_test"
RUNNER = Path(__file__).resolve().parent / "fake_cockpit_run.py"


@pytest.fixture
def shared(monkeypatch, stamped) -> FakeCockpit:
    monkeypatch.setenv("ASF_COCKPIT_URL", URL)
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", TOKEN)
    monkeypatch.setenv("CI", "true")
    monkeypatch.chdir(stamped)
    return FakeCockpit(TOKEN)


def test_a_ci_job_ships_the_description_as_a_ci_station_with_the_ingest_token(shared):
    cfg = factory.load()
    description = describe.build()

    assert describe.ship(description, cfg, shared) == 0

    [sent] = shared.descriptions
    assert sent["description"] == json.loads(describe.dumps(description))
    assert sent["station"]["kind"] == "ci" and sent["station"]["id"].startswith("st_")


def test_a_refused_token_is_the_one_shipping_failure_that_fails_the_job(shared, monkeypatch):
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", "asf_ingest_wrong")

    assert describe.ship(describe.build(), factory.load(), shared) == 1
    assert shared.descriptions == []


def test_a_cockpit_that_is_down_or_a_job_without_the_token_ships_nothing_and_passes(
        shared, monkeypatch, capsys):
    shared.down = True
    assert describe.ship(describe.build(), factory.load(), shared) == 0
    assert "could not reach the cockpit" in capsys.readouterr().err

    shared.down = False
    monkeypatch.setenv("ASF_COCKPIT_TOKEN", "")          # a pull request from a fork
    assert describe.ship(describe.build(), factory.load(), shared) == 0
    assert shared.descriptions == [] and "no ASF_COCKPIT_TOKEN" in capsys.readouterr().err


def test_a_local_checkout_does_not_ship_the_description(shared, monkeypatch, capsys):
    """What the default branch's description says is what every station's
    drift is measured against — a laptop's edits must not become it."""
    monkeypatch.delenv("CI")

    assert describe.ship(describe.build(), factory.load(), shared) == 0

    assert shared.descriptions == []
    assert "CI workflow" in capsys.readouterr().err


def test_check_json_ship_prints_the_description_ships_it_and_exits_as_check_does(
        shared, stamped, tmp_path):
    spec = stamped / "asf" / "workflows" / "quick" / "workflow.yaml"
    spec.write_text(spec.read_text().replace("{agent: builder}", "{agent: nobody}", 1))
    out = tmp_path / "told.json"
    (tmp_path / "spec.json").write_text(json.dumps({"out": str(out)}))

    result = subprocess.run([sys.executable, str(RUNNER), str(tmp_path / "spec.json"),
                             "check", "--json", "--ship"], cwd=stamped, capture_output=True,
                            text=True)

    assert result.returncode == 1, result.stdout + result.stderr     # the check failed
    printed = json.loads(result.stdout)
    [sent] = json.loads(out.read_text())["descriptions"]
    assert sent["description"] == printed and not printed["ok"]
    assert "shipped to" in result.stderr

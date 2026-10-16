"""`forge:` and `tracker:` select an implementation in Python that owns the argv
and the parsing (`engine/forge/`); the `*_command` keys that only ever worked
with `gh` are gone.

A key that only works with one value is a promise the code cannot keep: the
engine appended gh's flags, parsed gh's JSON and sent GitHub's graphql whatever
the prefix said. So the CLI is named in exactly one module, and the suite meets
it through a stand-in `gh` on PATH — or, where the question is what the engine
does with a tracker that cannot do something, through the fake.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from engine import forge, issues, labels
from engine.data_types import IssueRef, IssueUpdate, NewIssue
from engine.forge import fake
from engine.forge.github import RETIRED

from .asf_helpers import (SKILL_ROOT, _installer, asf, defaults, forge_calls, forge_data, install,
                          issue_json, new_repo, stand_in_gh)

ENGINE = SKILL_ROOT / "templates" / "asf" / "engine"
GITHUB = ENGINE / "forge" / "github.py"
CONFIG = Path("asf") / "factory.yaml"


# ── the CLI is named in one module ───────────────────────────────────────────

def test_the_engine_names_gh_and_github_s_environment_only_in_the_github_module():
    named = re.compile(r"\bgh\b|GITHUB_")
    found = [f"{path.relative_to(ENGINE)}:{number}: {line.strip()}"
             for path in sorted(ENGINE.rglob("*.py")) if path != GITHUB
             for number, line in enumerate(path.read_text().splitlines(), start=1)
             if named.search(line)]
    assert found == []
    assert named.search(GITHUB.read_text())


def test_no_setting_names_a_forge_command_any_more():
    cfg = defaults()
    assert (cfg.forge, cfg.tracker) == ("github", "github")
    said = cfg.model_dump_json()
    assert "_command" not in said.replace("notify_command", "")


def test_an_unknown_forge_is_refused_by_name(stamped: Path):
    (stamped / CONFIG).write_text((stamped / CONFIG).read_text() + "tracker: jira\n")

    checked = asf(stamped, "check")

    assert checked.returncode == 1
    assert "tracker" in checked.stdout + checked.stderr


# ── the retired keys in a full factory.yaml ──────────────────────────────────

FULL = Path(__file__).resolve().parent / "golden" / "factory-yaml" / \
    "before-overlay-claude_code.yaml"


def test_a_full_config_whose_commands_are_untouched_loads_with_a_warning(tmp_path: Path):
    repo = new_repo(tmp_path / "full")
    assert install(repo, "--harness", "claude_code").returncode == 0
    (repo / CONFIG).write_text(FULL.read_text())

    checked = asf(repo, "check")

    assert checked.returncode == 0, checked.stdout + checked.stderr
    said = checked.stdout + checked.stderr
    assert "issues.fetch_command" in said and "worktree.integration.pr_command" in said
    assert "dropped" in said


def test_a_command_a_person_changed_is_refused_by_name(tmp_path: Path):
    repo = new_repo(tmp_path / "changed")
    assert install(repo, "--harness", "claude_code").returncode == 0
    raw = yaml.safe_load(FULL.read_text())
    raw["issues"]["list_command"] = ["glab", "issue", "list"]
    (repo / CONFIG).write_text(yaml.safe_dump(raw))

    checked = asf(repo, "check")

    assert checked.returncode == 1
    said = checked.stdout + checked.stderr
    assert "issues.list_command" in said and "glab" in said
    assert "issues.fetch_command" not in said          # the untouched ones are not the problem


def test_the_installer_names_each_retired_command_and_what_becomes_of_it(tmp_path: Path):
    repo = new_repo(tmp_path / "linted")
    assert install(repo, "--harness", "claude_code").returncode == 0
    raw = yaml.safe_load(FULL.read_text())
    raw["pull_requests"]["graphql_command"] = ["my-gh", "api", "graphql"]
    (repo / CONFIG).write_text(yaml.safe_dump(raw, default_flow_style=None))

    again = install(repo, "--harness", "claude_code")

    said = again.stdout + again.stderr
    assert "issues.fetch_command" in said and "dropped" in said
    assert "pull_requests.graphql_command" in said and "refused" in said


def test_the_installer_s_table_of_retired_commands_is_the_engine_s():
    installer = _installer()
    assert installer.RETIRED == {path: default for path, (default, _) in RETIRED.items()}


# ── the GitHub implementation, through a `gh` on PATH ────────────────────────

def test_github_reads_an_issue_and_moves_its_labels_with_gh(stamped: Path):
    stand_in_gh(stamped)
    forge_data(stamped, "issue.json", issue_json(number=7, labels=("asf:queued",)))
    cfg = defaults()

    tracker = forge.tracker_of(cfg)
    read = tracker.issue(stamped, "acme/widgets", 7)
    issues.set_state(stamped, cfg, IssueUpdate(number=7, project="acme/widgets",
                                               add_labels=["asf:running"],
                                               remove_labels=["asf:queued"]))

    assert (read.number, read.labels, read.author) == (7, ["asf:queued"], "someone")
    assert forge_calls(stamped)[-1] == ["edit", "7", "--repo", "acme/widgets",
                                        "--add-label", "asf:running",
                                        "--remove-label", "asf:queued"]


def test_a_rejected_write_is_evidence_naming_the_command(stamped: Path):
    stand_in_gh(stamped)
    forge_data(stamped, "refuse.json", ["comment"])

    result = issues.comment(stamped, defaults(),
                            IssueUpdate(number=7, project="acme/widgets", comment="hi"))

    assert not result.ok
    assert "gh issue comment" in result.notes[0] and "not something this forge" in \
        result.notes[0]


# ── what the engine does with a tracker that cannot do something ─────────────

@pytest.fixture
def faked(monkeypatch) -> fake.Fake:
    forge_ = fake.Fake()
    monkeypatch.setattr(fake, "FAKE", forge_)
    return forge_


def test_a_tracker_that_defines_no_labels_is_not_asked_about_them(faked, tmp_path: Path):
    faked.defines_labels = False
    cfg = defaults(tracker="fake")

    found = labels.survey(cfg, tmp_path)

    assert not found.applicable
    assert "does not define labels" in found.note


def test_a_tracker_that_cannot_say_who_labelled_records_nobody(faked, tmp_path: Path):
    faked.knows_labellers = False
    cfg = defaults(tracker="fake")

    assert issues.labeller(tmp_path, cfg, IssueRef(number=1, project="a/b"), ["x"]) == ""


def test_the_fake_tracker_files_and_finds_an_issue(faked, tmp_path: Path):
    cfg = defaults(tracker="fake")

    filed = issues.create(tmp_path, cfg, NewIssue(project="a/b", title="t", body="b",
                                                  labels=["asf:improve:x"]))
    found = issues.labelled(tmp_path, cfg, "asf:improve:x")

    assert filed.ok and filed.number == found[0].number

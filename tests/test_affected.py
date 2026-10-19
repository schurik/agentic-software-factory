"""`pytest --affected`: the selector picks what a change can reach, and when
it does not know, everything.

Most cases run against this checkout's own tests — the rules are only worth
what they select from the suite that exists. The import graph is proven on a
small checkout built here, where the answer is known in advance.
"""

from __future__ import annotations

import ast
import subprocess
from pathlib import Path

import pytest

from . import affected
from .affected import Suite, choose

SKILL = affected.SKILL
ENGINE = affected.ENGINE


@pytest.fixture(scope="module")
def suite() -> Suite:
    return Suite()


def chosen(suite: Suite, path: str) -> frozenset[str] | None:
    return choose(suite, path).files


# ── the rules, against this checkout ─────────────────────────────────────────

def test_a_cockpit_change_runs_no_python_test(suite):
    choice = choose(suite, "apps/cockpit/convex/model/session.ts")
    assert (choice.rule, choice.files, choice.only) == ("cockpit", frozenset(), {})


def test_a_cockpit_file_a_test_reads_by_name_still_runs_that_test(suite):
    """`test_asf_supervise.py` pins the team compose's backend version — a
    cockpit path the Python suite does read."""
    assert "test_asf_supervise.py" in chosen(suite, "apps/cockpit/docker-compose.yml")


@pytest.mark.parametrize("kind, readers", [
    ("events", {"test_asf_events.py", "test_asf_golden_sessions.py", "test_asf_answers.py"}),
    ("sessions", {"test_asf_golden_sessions.py"}),
    ("answers", {"test_asf_answers.py"}),
    ("self-description", {"test_asf_describe.py"}),
    ("factory-yaml", {"test_asf_install.py", "test_asf_overlay.py"}),
    ("labels", {"test_asf_labels.py"}),
])
def test_a_golden_fixture_runs_the_tests_that_read_its_kind(suite, kind, readers):
    choice = choose(suite, f"tests/golden/{kind}/some/fixture.json")
    assert choice.rule == "golden"
    assert readers <= choice.files
    assert "test_asf_scorers.py" not in choice.files          # the point: not everything


@pytest.mark.parametrize("path", [f"{SKILL}/CHANGELOG.md", f"{SKILL}/SKILL.md",
                                  f"{SKILL}/cookbooks/install.md",
                                  f"{SKILL}/references/design.md", "README.md"])
def test_skill_prose_runs_the_docs_and_release_tests(suite, path):
    choice = choose(suite, path)
    assert choice.rule == "skill prose"
    assert choice.files == {"test_asf_docs.py"}
    assert choice.only == {"test_asf_install.py": frozenset(affected.RELEASE_TESTS)}


def test_the_release_tests_it_names_exist():
    """A renamed release test would otherwise drop out of the selection
    without a word."""
    tree = ast.parse((Path(__file__).parent / "test_asf_install.py").read_text())
    defined = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    assert set(affected.RELEASE_TESTS) <= defined


def test_a_test_file_runs_itself_and_the_tests_that_import_it(suite):
    files = chosen(suite, "tests/test_asf_slice2.py")
    assert "test_asf_slice2.py" in files
    assert "test_asf_publish.py" in files                     # `from .test_asf_slice2 import`
    assert len(files) < len(suite.test_files)


def test_a_helper_runs_what_imports_it_or_runs_it(suite):
    assert "test_asf_events.py" in chosen(suite, "tests/projection.py")
    assert "test_asf_claims.py" in chosen(suite, "tests/fake_cockpit_run.py")    # its RUNNER
    assert "test_asf_claims.py" in chosen(suite, "tests/fake_cockpit.py")   # through the runner
    assert "test_affected.py" in chosen(suite, "tests/affected.py")


def test_an_engine_module_runs_its_importers_and_every_stamped_run(suite):
    files = chosen(suite, f"{ENGINE}/journal.py")
    assert "test_asf_journal.py" in files
    assert suite.runners <= files
    assert "test_asf_docs.py" not in files


@pytest.mark.parametrize("path", [
    "tests/conftest.py", "tests/asf_helpers.py", "pyproject.toml",
    f"{SKILL}/templates/asf/asf.py", f"{SKILL}/templates/asf/stages/plan/stage.py",
    f"{SKILL}/templates/asf/engine/forge/README.md", f"{SKILL}/scripts/install.py",
    f"{SKILL}/scripts/uninstall.py",
])
def test_what_every_test_runs_through_runs_everything(suite, path):
    assert chosen(suite, path) is None


@pytest.mark.parametrize("path", ["somewhere/new.txt", ".gitignore", "apps/other/x.ts"])
def test_a_path_no_rule_knows_runs_everything(suite, path):
    choice = choose(suite, path)
    assert (choice.rule, choice.files) == ("unknown", None)


def test_repository_prose_runs_only_what_reads_it_by_name(suite):
    assert chosen(suite, "CLAUDE.md") == frozenset()
    assert chosen(suite, ".github/workflows/ci.yml") == frozenset()
    assert "test_asf_supervise.py" in chosen(suite, ".github/workflows/release.yml")
    assert "test_asf_install.py" in chosen(suite, ".claude-plugin/plugin.json")


def test_a_selection_is_the_union_and_everything_wins():
    selection = affected.select(["apps/cockpit/x.ts", f"{SKILL}/CHANGELOG.md"])
    assert not selection.everything
    assert selection.keeps_file("test_asf_install.py")
    assert selection.keeps("test_asf_install.py", affected.RELEASE_TESTS[0])
    assert not selection.keeps("test_asf_install.py", "test_some_stamping_test")
    assert not selection.keeps_file("test_asf_scorers.py")

    wider = affected.select(["apps/cockpit/x.ts", "somewhere/new.txt"])
    assert wider.everything and wider.keeps("test_asf_scorers.py", "anything")


def test_the_report_names_the_rule_behind_each_path():
    selection = affected.select(["apps/cockpit/x.ts", "somewhere/new.txt"])
    text = "\n".join(affected.report(selection, "main", 38))
    assert "cockpit (the cockpit has its own `bun run test`): no tests" in text
    assert "unknown (no rule knows the path" in text and "everything" in text
    assert "running all 38 test files" in text


# ── the import graph, on a checkout whose answer is known ────────────────────

def write(root: Path, files: dict[str, str]) -> None:
    for path, text in files.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)


@pytest.fixture
def small(tmp_path: Path) -> Suite:
    """`test_a` imports `engine.x`, which imports `engine.z`; `test_c` reaches
    `engine.z` through a helper and a subpackage; `test_b` imports nothing of
    the engine; `test_d` runs a stamped factory."""
    write(tmp_path, {
        f"{ENGINE}/x.py": "from . import z\n",
        f"{ENGINE}/z.py": "THING = 1\n",
        f"{ENGINE}/lone.py": "",
        f"{ENGINE}/forge/__init__.py": "",
        f"{ENGINE}/forge/y.py": "from ..z import THING\n",
        "tests/helper.py": "def h():\n    from engine.forge import y\n",
        "tests/test_a.py": "from engine import x\n",
        "tests/test_b.py": "import json\n",
        "tests/test_c.py": "from .helper import h\n",
        "tests/test_d.py": "def test_run(stamped):\n    asf(stamped, 'run', 'sdlc')\n",
    })
    return Suite(tmp_path)


def test_an_engine_module_reaches_its_importers_transitively(small):
    assert chosen(small, f"{ENGINE}/z.py") == {"test_a.py", "test_c.py", "test_d.py"}
    assert chosen(small, f"{ENGINE}/x.py") == {"test_a.py", "test_d.py"}


def test_importing_a_submodule_runs_its_package(small):
    assert chosen(small, f"{ENGINE}/forge/__init__.py") == {"test_c.py", "test_d.py"}


def test_a_module_nothing_imports_still_runs_the_stamped_runs(small):
    assert chosen(small, f"{ENGINE}/lone.py") == {"test_d.py"}


# ── what changed ─────────────────────────────────────────────────────────────

def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_changed_paths_are_the_branch_the_index_the_tree_and_the_untracked(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "tests@example.invalid")
    git(tmp_path, "config", "user.name", "asf tests")
    git(tmp_path, "config", "commit.gpgsign", "false")
    write(tmp_path, {"kept.txt": "1\n", "edited.txt": "1\n", "moved.txt": "1\n"})
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "base")
    git(tmp_path, "checkout", "-q", "-b", "work")
    write(tmp_path, {"committed.txt": "1\n"})
    git(tmp_path, "mv", "moved.txt", "renamed.txt")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "work")
    write(tmp_path, {"edited.txt": "2\n", "untracked.txt": "1\n"})

    assert affected.changed_paths("main", tmp_path) == [
        "committed.txt", "edited.txt", "moved.txt", "renamed.txt", "untracked.txt"]
    with pytest.raises(ValueError, match="name a base that exists"):
        affected.changed_paths("no-such-branch", tmp_path)

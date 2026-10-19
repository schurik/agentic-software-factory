"""Fixtures for agentic-sf's own tests.

Three things every test here needs and nothing else provides:

  * `engine` on the path. The modules under test are TEMPLATES — stamped into a
    target repo as `asf/engine/` — so they are not an installed package.
    `templates/asf` is what they are stamped FROM, and importing from there is
    importing exactly what a stamped repo runs.
  * A real git repository, stamped the way `install.py` stamps it. `session.
    ensure` cuts a worktree, `permissions.py` reads `git diff`, and the loader
    resolves stages, agents and workflows relative to `asf/factory.yaml` — so
    the tests run against a real install into a tmp_path, not against a mock
    of one.
  * A `gh` that knows nobody (`no_one_s_gh`), so no test depends on whose
    machine it runs on.

Helpers live in `asf_helpers.py`; `__init__.py` says why this directory is a
package, and why it sits beside the skill rather than inside it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SKILL_ROOT = REPO_ROOT / "skills" / "agentic-sf"
TEMPLATES = SKILL_ROOT / "templates" / "asf"

if str(TEMPLATES) not in sys.path:
    sys.path.insert(0, str(TEMPLATES))

from . import affected  # noqa: E402
from .asf_helpers import new_repo, stamp  # noqa: E402

SELECTION = pytest.StashKey[affected.Selection]()


# ── `pytest --affected [BASE]`: only what a change can reach (`affected.py`) ──

def pytest_addoption(parser):
    parser.addoption("--affected", nargs="?", const="main", default=None, metavar="BASE",
                     help="run only the tests a change since BASE (default: main) can affect, "
                          "and say which rule chose each; CI runs them all")


def pytest_configure(config):
    base = config.getoption("--affected")
    if base is None:
        return
    try:
        paths = affected.changed_paths(base)
    except ValueError as error:
        raise pytest.UsageError(str(error)) from None
    config.stash[SELECTION] = affected.select(paths)
    config.stash[BASE] = base


BASE = pytest.StashKey[str]()


def pytest_ignore_collect(collection_path, config):
    selection = config.stash.get(SELECTION, None)
    if selection is None or collection_path.parent != TESTS_DIR \
            or not collection_path.name.startswith("test_"):
        return None
    return True if not selection.keeps_file(collection_path.name) else None


def pytest_collection_modifyitems(config, items):
    selection = config.stash.get(SELECTION, None)
    if selection is None:
        return
    kept = [item for item in items
            if selection.keeps(item.path.name, getattr(item, "originalname", item.name))]
    dropped = [item for item in items if item not in kept]
    if dropped:
        config.hook.pytest_deselected(items=dropped)
        items[:] = kept


@pytest.hookimpl(trylast=True)
def pytest_sessionstart(session):
    """Said once, by the process at the terminal: under `-n` the workers
    collect, and their output never reaches it."""
    config = session.config
    selection = config.stash.get(SELECTION, None)
    reporter = config.pluginmanager.get_plugin("terminalreporter")
    if selection is None or reporter is None or hasattr(config, "workerinput"):
        return
    total = len(list(TESTS_DIR.glob("test_*.py")))
    for line in affected.report(selection, config.stash[BASE], total):
        reporter.write_line(line)


def pytest_sessionfinish(session, exitstatus):
    """Nothing selected is a pass, not pytest's "no tests ran" (exit 5): a
    change to the cockpit alone has no Python test to run."""
    selection = session.config.stash.get(SELECTION, None)
    if selection is not None and exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED \
            and not (selection.everything or selection.files or selection.only):
        session.exitstatus = pytest.ExitCode.OK


@pytest.fixture(autouse=True)
def no_one_s_gh(tmp_path_factory, monkeypatch):
    """Every test's `gh` reads an empty config, never the developer's (and no
    CI job's actor is in the environment): a run
    started by hand records the login `gh` is logged in as (`station.operator`),
    and a suite that recorded whoever ran it would differ from machine to
    machine — and put their login into a recorded golden session. A test that
    wants a login puts a `gh` of its own on PATH. Nor is the job's branch: the
    description names `GITHUB_HEAD_REF`/`GITHUB_REF_NAME` over the checkout's
    own, and a push to main would have every test describe `main`."""
    monkeypatch.setenv("GH_CONFIG_DIR", str(tmp_path_factory.mktemp("gh-config")))
    # Recorded so it is restored: a test puts the stand-in `gh` first on PATH
    # (`asf_helpers.stand_in_gh`) for as long as it runs, and no longer.
    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))
    for name in ("GITHUB_ACTOR", "GITHUB_HEAD_REF", "GITHUB_REF_NAME"):   # ...nor CI's
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A git repository with one commit and a pyproject that names pytest — the
    least a worktree can branch from, and enough for the installer to detect a
    test command."""
    return new_repo(tmp_path / "repo")


@pytest.fixture
def stamped(repo: Path) -> Path:
    """The fixture repo with the factory installed, on the claude_code harness."""
    return stamp(repo)

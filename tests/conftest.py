"""Fixtures for agentic-sf's own tests.

Two things every test here needs and nothing else provides:

  * `engine` on the path. The modules under test are TEMPLATES — stamped into a
    target repo as `asf/engine/` — so they are not an installed package.
    `templates/asf` is what they are stamped FROM, and importing from there is
    importing exactly what a stamped repo runs.
  * A real git repository, stamped the way `install.py` stamps it. `session.
    ensure` cuts a worktree, `permissions.py` reads `git diff`, and the loader
    resolves stages, agents and workflows relative to `asf/factory.yaml` — so
    the tests run against a real install into a tmp_path, not against a mock
    of one.

Helpers live in `asf_helpers.py`; `__init__.py` says why this directory is a
package, and why it sits beside the skill rather than inside it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SKILL_ROOT = REPO_ROOT / "skills" / "agentic-sf"
TEMPLATES = SKILL_ROOT / "templates" / "asf"

if str(TEMPLATES) not in sys.path:
    sys.path.insert(0, str(TEMPLATES))

from .asf_helpers import new_repo, stamp  # noqa: E402


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

"""Which tests a change can affect: what `pytest --affected [BASE]` runs.

The suite takes ten minutes, and most changes reach a fraction of it. So a
local run (a person's, an agent's) maps each path changed since BASE — the
commits on `BASE...HEAD`, plus the working tree — to the tests that read it,
and runs those. CI runs everything on every pull request; this is the fast
loop before it, never a replacement for it.

The mapping is written out, not measured. Coverage-based selection
(`pytest-testmon` and the like) cannot see this suite: most tests stamp a repo
into `tmp_path` and run `asf/asf.py` from that copy as a subprocess, so
coverage never links them to the template they exercise, and it would
under-select without a word. Every rule here leans the other way. When a rule
is unsure it takes more, and a path no rule knows runs the whole suite.

Each changed path is judged by the first rule that matches it (`RULES`), and
`report` says which rule chose what, so a person can see why a test ran — or
why one did not.
"""

from __future__ import annotations

import ast
import re
import subprocess
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from functools import cached_property
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL = "skills/agentic-sf"
ENGINE = f"{SKILL}/templates/asf/engine"

# The tests in `test_asf_install.py` that read the changelog and the version
# mirrors, rather than stamping a repo. `test_affected.py` fails when one of
# these names stops naming a test, so a rename cannot drop it silently.
RELEASE_TESTS = ("test_every_version_this_repo_carries_is_plugin_json_s",
                 "test_the_changelog_names_upgrade_steps_for_every_release")

# A test file that runs the factory out of a stamp, as a subprocess: the
# `asf(…)` helper, `asf/asf.py` named outright, a script run beside it
# (`fake_cockpit_run.py`, the `RUNNER` those tests name). Such a test
# exercises the whole engine, whatever it imports, so any engine change runs it.
# The selector and its test name every kind of path as data, read none of
# them, and run none: their strings are never evidence that a test reads a file.
SELF = frozenset({"affected.py", "test_affected.py"})

RUNS_A_STAMP = re.compile(r"(?<![\w.])asf\(|asf\.py|\bRUNNER\b|sys\.executable|runpy")


@dataclass(frozen=True)
class Choice:
    """What one changed path selected, and why."""
    path: str
    rule: str
    why: str
    files: frozenset[str] | None              # whole test files; None is all of them
    only: dict[str, frozenset[str]] = field(default_factory=dict)   # file → its tests


class Suite:
    """What the selector knows about one checkout: its tests, and what each
    of them reads. `root` is a parameter so `test_affected.py` can build a
    small checkout of its own."""

    def __init__(self, root: Path = REPO_ROOT):
        self.root = root
        self.tests = root / "tests"
        self.engine = root / ENGINE
        self._closures: dict[str, set[str]] = {}

    @cached_property
    def test_files(self) -> frozenset[str]:
        return frozenset(p.name for p in self.tests.glob("test_*.py"))

    @cached_property
    def sources(self) -> dict[str, str]:
        """Every Python file directly in `tests/`, by name."""
        return {p.name: p.read_text() for p in sorted(self.tests.glob("*.py"))}

    @cached_property
    def trees(self) -> dict[str, ast.Module]:
        return {name: ast.parse(text) for name, text in self.sources.items()}

    # ── the import graph ────────────────────────────────────────────────────

    @cached_property
    def graph(self) -> dict[str, set[str]]:
        """Module → the modules it loads, over `engine/` and `tests/`.

        Static imports, plus the loads no import statement shows: `engine.stage`
        loads every stage's `stage.py` by path (so it reaches whatever they
        import), a test that names `fake_cockpit_run.py` runs it, and a test
        that stamps runs `scripts/install.py`, which loads the engine modules
        it names (`overlay.py`, and rewrites `quality.py`)."""
        graph: dict[str, set[str]] = {}
        for path in sorted(self.engine.rglob("*.py")):
            graph[engine_module(path.relative_to(self.root).as_posix())] = \
                _imports(ast.parse(path.read_text()), engine_module(
                    path.relative_to(self.root).as_posix()), path.name == "__init__.py")
        stages = self.root / SKILL / "templates" / "asf" / "stages"
        graph.setdefault("engine.stage", set()).update(
            name for stage in sorted(stages.glob("*/stage.py"))
            for name in _imports(ast.parse(stage.read_text()), "stage", False))
        installer = set()
        for script in ("install.py", "uninstall.py", "_detect.py"):
            path = self.root / SKILL / "scripts" / script
            if path.is_file():
                installer |= {f"engine.{name}" for name in re.findall(
                    r"""engine["']?\s*/\s*["']?(\w+)\.py""", path.read_text())}
        graph["scripts.install"] = installer
        stems = {name.removesuffix(".py") for name in self.sources}
        for name, tree in self.trees.items():
            loads = {f"tests.{m}" if m in stems else m
                     for m in _imports(tree, f"tests.{name.removesuffix('.py')}", False)}
            loads |= {f"tests.{s}" for s in stems if f"{s}.py" in self.constants[name]
                      and name not in SELF}
            if re.search(r"\bstamp(ed)?\b|\binstall\(|\bINSTALL\b", self.sources[name]):
                loads.add("scripts.install")
            graph[f"tests.{name.removesuffix('.py')}"] = loads
        return graph

    def reaching(self, module: str) -> frozenset[str]:
        """The test files that load `module`, directly or through others."""
        return frozenset(name for name in self.test_files
                         if module in self._closure(f"tests.{name.removesuffix('.py')}"))

    def _closure(self, start: str) -> set[str]:
        if start in self._closures:
            return self._closures[start]
        seen, todo = set(), [start]
        while todo:
            module = todo.pop()
            for name in _with_parents(module):
                if name not in seen:
                    seen.add(name)
                    todo.extend(self.graph.get(name, ()))
        self._closures[start] = seen
        return seen

    def matching(self, pattern: str) -> frozenset[str]:
        """Test files whose own source, or a test-local module they load,
        matches `pattern`."""
        hits = {f"tests.{n.removesuffix('.py')}" for n, text in self.sources.items()
                if re.search(pattern, text)}
        return frozenset(name for name in self.test_files
                         if hits & self._closure(f"tests.{name.removesuffix('.py')}"))

    @cached_property
    def runners(self) -> frozenset[str]:
        own = {n for n in self.test_files if RUNS_A_STAMP.search(self.sources[n])}
        return frozenset(own) | self.reaching("tests.fake_cockpit_run")

    def naming(self, path: str) -> frozenset[str]:
        """Test files that read `path` by name: a string constant that is the
        path, ends in it, or is its file name beside one that is its folder's
        (`REPO_ROOT / ".github" / "workflows" / "release.yml"`). A root-level
        file's name is too common to count — fixtures write a README.md and a
        CLAUDE.md of their own — so the rules name the root's files outright."""
        parts = path.split("/")
        if len(parts) < 2:
            return frozenset()
        found = set()
        for name in self.test_files:
            constants = self._constants_reaching(name)
            if any(c == path or c.endswith("/" + path) for c in constants) or \
                    (parts[-1] in constants and parts[-2] in constants):
                found.add(name)
        return frozenset(found)

    def _constants_reaching(self, name: str) -> set[str]:
        closure = self._closure(f"tests.{name.removesuffix('.py')}")
        return {c for module, constants in self.constants.items() if module not in SELF
                and f"tests.{module.removesuffix('.py')}" in closure for c in constants}

    @cached_property
    def constants(self) -> dict[str, set[str]]:
        return {name: _constants(tree) for name, tree in self.trees.items()}


# ── the rules ───────────────────────────────────────────────────────────────

Select = Callable[[Suite, str], "tuple[frozenset[str] | None, dict[str, frozenset[str]]]"]


@dataclass(frozen=True)
class Rule:
    name: str
    patterns: tuple[str, ...]
    select: Select
    why: str
    also_named: bool = True          # add the tests that read the path by name

    def matches(self, path: str) -> bool:
        return any(fnmatchcase(path, pattern) for pattern in self.patterns)


def everything(suite, path):
    return None, {}


def nothing(suite, path):
    return frozenset(), {}


def golden_readers(suite, path):
    """The tests that name `golden` and this fixture's kind (`events`,
    `sessions`, `factory-yaml`, …) in one module."""
    kind = path.split("/")[2] if path.count("/") > 2 else ""
    return suite.matching(rf"(?s)\A(?=.*\bgolden\b)(?=.*{re.escape(kind)})"), {}


def this_test(suite, path):
    name = path.removeprefix("tests/")
    return frozenset({name} & suite.test_files) | suite.reaching(
        f"tests.{name.removesuffix('.py')}"), {}


def helper_dependents(suite, path):
    return suite.reaching(f"tests.{path.removeprefix('tests/').removesuffix('.py')}"), {}


def docs_tests(suite, path):
    return frozenset({"test_asf_docs.py"}), {"test_asf_install.py": frozenset(RELEASE_TESTS)}


def engine_tests(suite, path):
    return suite.reaching(engine_module(path)) | suite.runners, {}


RULES = (
    Rule("suite", ("tests/conftest.py", "tests/asf_helpers.py", "tests/__init__.py",
                   "pyproject.toml"), everything,
         "every test runs through it"),
    Rule("golden", ("tests/golden/*",), golden_readers,
         "the tests that read that kind of recorded fixture"),
    Rule("test", ("tests/test_*.py",), this_test,
         "the file itself, and any test that imports it"),
    Rule("test helper", ("tests/*.py",), helper_dependents,
         "the tests that import it or run it"),
    Rule("cockpit", ("apps/cockpit/*",), nothing,
         "the cockpit has its own `bun run test`"),
    Rule("skill prose", (f"{SKILL}/CHANGELOG.md", f"{SKILL}/SKILL.md", f"{SKILL}/cookbooks/*",
                         f"{SKILL}/references/*", "README.md"), docs_tests,
         "the docs tests, and the release tests that read the changelog", also_named=False),
    Rule("repository prose", ("CLAUDE.md", "CONTEXT.md", "LICENSE", "docs/*", ".claude/*",
                              ".agents/*", ".github/*"), nothing,
         "read by agents and CI, not imported by a test"),
    Rule("release metadata", (".claude-plugin/*",), nothing,
         "the tests that read the version by name"),
    Rule("engine", (f"{ENGINE}/*.py",), engine_tests,
         "the tests that import it, and every test that runs a stamped factory"),
    Rule("stamped", (f"{SKILL}/templates/*", f"{SKILL}/scripts/*"), everything,
         "a stamp copies or runs it in nearly every test"),
)
UNKNOWN = Rule("unknown", ("*",), everything, "no rule knows the path, so it may affect anything")


def choose(suite: Suite, path: str) -> Choice:
    rule = next((rule for rule in RULES if rule.matches(path)), UNKNOWN)
    files, only = rule.select(suite, path)
    if files is not None and rule.also_named:
        files |= suite.naming(path)
    return Choice(path, rule.name, rule.why, files, only)


@dataclass(frozen=True)
class Selection:
    choices: tuple[Choice, ...]

    @property
    def everything(self) -> bool:
        return any(choice.files is None for choice in self.choices)

    @property
    def files(self) -> frozenset[str]:
        return frozenset().union(*(c.files for c in self.choices if c.files is not None))

    @property
    def only(self) -> dict[str, frozenset[str]]:
        """File → the tests selected in it, for files not selected whole."""
        merged: dict[str, frozenset[str]] = {}
        for choice in self.choices:
            for name, tests in choice.only.items():
                merged[name] = merged.get(name, frozenset()) | tests
        return {name: tests for name, tests in merged.items() if name not in self.files}

    def keeps_file(self, name: str) -> bool:
        return self.everything or name in self.files or name in self.only

    def keeps(self, name: str, test: str) -> bool:
        return self.everything or name in self.files or test in self.only.get(name, ())


def select(paths: list[str], suite: Suite | None = None) -> Selection:
    suite = suite or Suite()
    return Selection(tuple(choose(suite, path) for path in paths))


def changed_paths(base: str, root: Path = REPO_ROOT) -> list[str]:
    """Paths changed on `base...HEAD`, in the index or work tree, or new and
    untracked. `--no-renames` lists a rename's old path too: a test may still
    read it by that name."""
    def git(*args: str) -> list[str]:
        result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
        if result.returncode != 0:
            said = next(iter(result.stderr.strip().splitlines()), "")
            raise ValueError(f"`git {' '.join(args)}` failed: {said} — "
                             f"name a base that exists, e.g. `pytest --affected origin/main`")
        return result.stdout.splitlines()
    return sorted({path for path in (
        git("diff", "--name-only", "--no-renames", f"{base}...HEAD")
        + git("diff", "--name-only", "--no-renames", "HEAD")
        + git("ls-files", "--others", "--exclude-standard")) if path})


def report(selection: Selection, base: str, total: int) -> list[str]:
    lines = [f"affected tests since {base}: {len(selection.choices)} changed path(s)"]
    for choice in selection.choices:
        if choice.files is None:
            chosen = "everything"
        else:
            named = sorted(choice.files) + [f"{name}::{{{', '.join(sorted(tests))}}}"
                                            for name, tests in sorted(choice.only.items())]
            chosen = ", ".join(named) if named else "no tests"
            if len(choice.files) > 6:
                chosen = f"{len(choice.files)} files"
        lines.append(f"  {choice.path}\n      {choice.rule} ({choice.why}): {chosen}")
    if selection.everything:
        lines.append(f"running all {total} test files")
    else:
        lines.append(f"running {len(selection.files) + len(selection.only)} of {total} "
                     f"test files; CI runs them all")
    return lines


# ── reading a module ────────────────────────────────────────────────────────

def engine_module(path: str) -> str:
    """`…/templates/asf/engine/forge/fake.py` → `engine.forge.fake`."""
    dotted = path.removeprefix(f"{SKILL}/templates/asf/").removesuffix(".py").replace("/", ".")
    return dotted.removesuffix(".__init__")


def _imports(tree: ast.Module, module: str, is_package: bool) -> set[str]:
    """Every module `tree` imports, anywhere in it, as an absolute name. A
    `from m import n` counts both `m` and `m.n`: `n` may be a submodule."""
    package = module if is_package else module.rpartition(".")[0]
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".")
                base = base[:len(base) - node.level + 1]
                origin = ".".join(base + ([node.module] if node.module else []))
            else:
                origin = node.module or ""
            found.add(origin)
            found |= {f"{origin}.{alias.name}" for alias in node.names}
    return found


def _with_parents(module: str) -> list[str]:
    """Importing `engine.forge.fake` runs `engine.forge` first."""
    parts = module.split(".")
    return [".".join(parts[:i]) for i in range(len(parts), 0, -1)]


def _constants(tree: ast.Module) -> set[str]:
    return {node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)}

"""Guess this repository's real quality commands, so the stamp is not a stub.

WHY THIS EXISTS. `quality.py` ships four blocks — test, lint, typecheck, build —
and an opt-in fifth, e2e. A stamped repo cannot know any of them, so they land as placeholders that
now fail rather than pass. That is honest, but it makes the first `adw_*_test`
run fail for a reason that has nothing to do with the work: nobody had written
the command down yet.

Most repositories already answered the question somewhere a file can see:
`package.json` names its own scripts, a lockfile names the package manager, a
`pyproject.toml` names its test runner. So the installer reads those and writes
what it finds into the stamped `quality.py`, marking every line it filled in.

Two rules, because a wrong command that runs is worse than no command:

1. **A repository's own declaration beats an inference.** A `test` script in
   package.json is the author saying what testing this project means; `pytest`
   being importable is not. Declarations are taken first, always.
2. **Nothing is guessed twice.** A block nothing can answer for stays a
   placeholder — which fails loudly, names itself in `just doctor`, and is
   therefore impossible to mistake for a wired-up check.

Detection only ever runs against a `quality.py` this install just stamped. A
file that already existed is never rewritten, whatever it contains.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import NamedTuple

# Which lockfile means which JavaScript package manager, most specific first.
# The runner matters: `bun run test` and `npm run test` are not interchangeable
# in a repo whose scripts assume one of them.
JS_MANAGERS = [
    ("bun.lock", ["bun", "run"]),
    ("bun.lockb", ["bun", "run"]),
    ("pnpm-lock.yaml", ["pnpm", "run"]),
    ("yarn.lock", ["yarn", "run"]),
    ("package-lock.json", ["npm", "run"]),
]

# How each of them runs a package's binary without a script naming it.
JS_EXEC = {"bun": ["bunx"], "pnpm": ["pnpm", "exec"], "yarn": ["yarn"], "npm": ["npx"]}

# What `run_quality` runs, and the opt-in block that only a workflow naming it
# runs — `quality.DEFAULT` and `quality.BLOCKS`, as the installer knows them.
DEFAULT = ("test", "lint", "typecheck", "build")
BLOCKS = DEFAULT + ("e2e",)

# Every name Playwright reads its config from.
PLAYWRIGHT_CONFIGS = [f"playwright.config.{ext}"
                      for ext in ("ts", "js", "mjs", "cjs", "mts", "cts")]
# Where Playwright writes by default, in the worktree a commit stage stages with
# `git add -A`. The e2e block points both elsewhere; a config that names its
# own folder wins over that, so they are ignored as well.
PLAYWRIGHT_IGNORES = ["test-results/", "playwright-report/"]

class Expression(NamedTuple):
    """An argv element that is Python source rather than a string: a value
    only the block knows when it runs. `shown` is how the install note says it."""

    source: str
    shown: str


# The one such element: the e2e block's own evidence directory, a local there.
EVIDENCE = Expression("str(evidence)", "<the check's evidence directory>")


class Detected:
    """One block's answer: the argv, and the evidence it came from. `tail`, when
    there is one, is the argv's last element — see EVIDENCE."""

    def __init__(self, argv: list[str], because: str, tail: Expression | None = None):
        self.argv = argv
        self.because = because
        self.tail = tail

    @property
    def literal(self) -> str:
        """The argv as it should read in the source — a list, never a string."""
        parts = [json.dumps(part) for part in self.argv]
        return "[" + ", ".join(parts + ([self.tail.source] if self.tail else [])) + "]"

    @property
    def shown(self) -> str:
        return " ".join(self.argv + ([self.tail.shown] if self.tail else []))


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _js(root: Path) -> tuple[list[str], dict]:
    """This repo's JS runner prefix and its declared scripts, if it is one."""
    package = _read_json(root / "package.json")
    if not package:
        return [], {}
    runner = next((prefix for lockfile, prefix in JS_MANAGERS
                   if (root / lockfile).is_file()), ["npm", "run"])
    scripts = package.get("scripts") or {}
    return runner, scripts if isinstance(scripts, dict) else {}


def _python(root: Path) -> tuple[list[str], str]:
    """This repo's Python runner prefix, and the text of its pyproject."""
    pyproject = root / "pyproject.toml"
    text = pyproject.read_text() if pyproject.is_file() else ""
    # `uv run` only makes sense where uv is what manages the project; elsewhere
    # the bare binary is what the engineer's own shell would resolve.
    prefix = ["uv", "run"] if (root / "uv.lock").is_file() or "[tool.uv]" in text else []
    return prefix, text


def detect(root: Path) -> dict[str, Detected]:
    """Everything this repository says about how it is checked. Never guesses
    a block it has no evidence for — an unanswered block stays a placeholder."""
    found: dict[str, Detected] = {}
    js_runner, scripts = _js(root)
    py_runner, pyproject = _python(root)

    # 1. Declared scripts. The repository's own words, so they win outright.
    for block, names in (("test", ("test",)),
                         ("lint", ("lint",)),
                         ("typecheck", ("typecheck", "check-types", "tsc")),
                         ("build", ("build",))):
        for name in names:
            if name in scripts:
                found[block] = Detected(js_runner + [name],
                                        f"package.json scripts.{name}")
                break

    # 2. Inference, only where nothing was declared.
    def offer(block: str, argv: list[str], because: str,
              tail: Expression | None = None) -> None:
        if block not in found:
            found[block] = Detected(argv, because, tail)

    if (root / "bun.lock").is_file() or (root / "bun.lockb").is_file():
        offer("test", ["bun", "test"], "bun.lock")
    if (root / "tsconfig.json").is_file():
        offer("typecheck", (["bunx"] if js_runner[:1] == ["bun"] else ["npx"])
              + ["tsc", "--noEmit"], "tsconfig.json")

    if pyproject or (root / "pytest.ini").is_file() or (root / "tox.ini").is_file():
        if "pytest" in pyproject or (root / "pytest.ini").is_file():
            offer("test", py_runner + ["pytest", "-q"], "pytest in pyproject.toml")
        if "[tool.ruff]" in pyproject or (root / "ruff.toml").is_file():
            offer("lint", py_runner + ["ruff", "check", "."], "ruff config")
        if "[tool.mypy]" in pyproject or (root / "mypy.ini").is_file():
            offer("typecheck", py_runner + ["mypy", "."], "mypy config")

    # A Playwright config is the repository saying it has browser tests. Run
    # through the binary rather than a script: the block appends `--output`,
    # which `npm run` would swallow without a `--`, and a script may start a
    # server of its own beside the one `webServer` starts.
    config = playwright_config(root)
    if config and js_runner:
        offer("e2e", JS_EXEC[js_runner[0]] + ["playwright", "test", "--output"], config,
              tail=EVIDENCE)

    if (root / "Cargo.toml").is_file():
        offer("test", ["cargo", "test"], "Cargo.toml")
        offer("lint", ["cargo", "clippy"], "Cargo.toml")
        offer("build", ["cargo", "build"], "Cargo.toml")
    if (root / "go.mod").is_file():
        offer("test", ["go", "test", "./..."], "go.mod")
        offer("lint", ["go", "vet", "./..."], "go.mod")
        offer("build", ["go", "build", "./..."], "go.mod")

    return {block: found[block] for block in BLOCKS if block in found}


def playwright_config(root: Path) -> str:
    """The name of this repository's Playwright config, "" when it has none."""
    return next((name for name in PLAYWRIGHT_CONFIGS if (root / name).is_file()), "")


def gitignore(root: Path) -> list[str]:
    """What this repository's tools write into a worktree that a commit stage's
    `git add -A` must not carry — beyond the factory's own runtime."""
    return PLAYWRIGHT_IGNORES if playwright_config(root) else []


def apply(quality_py: Path, found: dict[str, Detected]) -> list[str]:
    """Write the detected argv into a freshly stamped quality.py.

    Rewrites exactly the `_placeholder("<block>")` call and the `# e.g. …` hint
    beside it, and nothing else — the marker is unique per block, so there is no
    way to hit a line that was not the placeholder. Returns one line per
    substitution, for the installer to print.

    Every rewritten line is marked as detected rather than authored, because a
    guess the engineer never read is the same trap the placeholders were.
    """
    if not found or not quality_py.is_file():
        return []
    source = quality_py.read_text()
    notes = []
    for block, detected in found.items():
        pattern = re.compile(rf'_placeholder\("{block}"\)(,)?([ \t]*#[^\n]*)?')
        replacement = (f"{detected.literal},"
                       f"   # detected at install ({detected.because}) — verify it")
        # A lambda, not a string: a replacement that goes through re's escape
        # processing would mangle any backslash a real command carries.
        source, count = pattern.subn(lambda _match: replacement, source, count=1)
        if count:
            notes.append(f"{block}: {detected.shown}   ({detected.because})")
    quality_py.write_text(source)
    return notes


# ── a session's worktree: what to copy into it, and how to install into it ──
#
# The same two rules, for factory.yaml's `worktree.copy` and `worktree.setup`.
# A file is offered only when this repository has it AND ignores it: the
# factory refuses to copy anything a commit stage's `git add -A` could carry,
# and an installer that wrote such an entry would stamp a factory that refuses
# itself. `.env` is the default either way, unless git tracks it.

COPY_CANDIDATES = [
    ".env.local", ".env.development.local",      # Next.js, Vite; the one Convex writes
    ".dev.vars",                                  # Cloudflare Wrangler
    "config/master.key",                          # Rails
    "serviceAccountKey.json",                     # a Firebase service account
    "google-services.json", "GoogleService-Info.plist",
    ".vercel/project.json",                       # the Vercel CLI's link
    "playwright/.auth/*.json",                    # Playwright's saved logins
    ".npmrc",                                     # a registry token, when ignored
]

# Which lockfile means which install, one per ecosystem, most specific first.
SETUP_BY_LOCKFILE = [
    [("bun.lock", ["bun", "install"]), ("bun.lockb", ["bun", "install"]),
     ("pnpm-lock.yaml", ["pnpm", "install"]), ("yarn.lock", ["yarn", "install"]),
     ("package-lock.json", ["npm", "ci"])],
    [("uv.lock", ["uv", "sync"]), ("poetry.lock", ["poetry", "install"])],
    [("Gemfile.lock", ["bundle", "install"])],
]


def _git_lines(root: Path, *args: str) -> set[str]:
    """What a git question prints, line by line — nothing outside a repository."""
    try:
        result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    except OSError:
        return set()
    return {line for line in result.stdout.splitlines() if line}


def detect_worktree(root: Path) -> tuple[list[str], list[list[str]]]:
    """`worktree.copy` and `worktree.setup` as this repository answers them."""
    present = [each for each in COPY_CANDIDATES
               if (any(root.glob(each)) if "*" in each else (root / each).exists())]
    ignored = _git_lines(root, "check-ignore", "--", ".env", *present)
    tracked_env = _git_lines(root, "ls-files", "--", ".env")
    copy = ([] if tracked_env else [".env"]) + [each for each in present if each in ignored]
    setup = [next(argv for lockfile, argv in ecosystem if (root / lockfile).is_file())
             for ecosystem in SETUP_BY_LOCKFILE
             if any((root / lockfile).is_file() for lockfile, _ in ecosystem)]
    return copy, setup


def apply_worktree(config: Path, copy: list[str], setup: list[list[str]]) -> list[str]:
    """Write them into a factory.yaml this install just rendered, over the two
    lines the template ships — `copy: [".env"]` and `setup: []`, each unique in
    the file — and return what to print. JSON is YAML, and quoted, a glob's
    leading `*` is not read as an alias."""
    if not config.is_file():
        return []
    text = config.read_text()
    lines = {"copy": f"  copy: {json.dumps(copy)}", "setup": f"  setup: {json.dumps(setup)}"}
    for key, line in lines.items():
        text = re.sub(rf'^  {key}: .*$', lambda _match: line, text, count=1, flags=re.M)
    config.write_text(text)
    notes = [f"worktree.copy: {', '.join(copy) or '(nothing)'}"]
    if setup:
        notes.append(f"worktree.setup: {' · '.join(' '.join(argv) for argv in setup)}")
    return notes


# ── what the installer suggests, and never wires ─────────────────────────────

# A dependency that says the repository serves a web app.
WEB_FRAMEWORKS = ("next", "vite", "nuxt", "@sveltejs/kit", "astro", "@remix-run/dev",
                  "react-scripts", "@angular/core", "gatsby")
# Where a repository checks in MCP servers: Claude Code's project file, Cursor's,
# VS Code's (which says `servers`, not `mcpServers`).
MCP_FILES = (".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json")


def web_app(root: Path) -> str:
    """The evidence that this repository is a web app the `accept` stage could
    drive, "" when there is none."""
    config = playwright_config(root)
    if config:
        return config
    package = _read_json(root / "package.json")
    scripts = package.get("scripts") or {}
    if isinstance(scripts, dict) and "dev" in scripts:
        return "package.json scripts.dev"
    deps = {**(package.get("dependencies") or {}), **(package.get("devDependencies") or {})}
    return next((f"package.json depends on {name}" for name in WEB_FRAMEWORKS if name in deps),
                "")


def mcp_servers(root: Path) -> list[tuple[str, str]]:
    """(file, server) for every MCP server this repository checks in."""
    found = []
    for name in MCP_FILES:
        config = _read_json(root / name)
        servers = config.get("mcpServers") or config.get("servers") or {}
        if isinstance(servers, dict):
            found += [(name, server) for server in servers]
    return found

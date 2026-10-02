#!/usr/bin/env -S uv run
# /// script
# dependencies = []
# ///
"""install — stamp the agentic-sf factory from the skill into the cwd. Idempotent.

Usage:
    uv run <skill>/scripts/install.py [--harness claude_code|pi] [--force]
                                     [--no-detect-quality] [--ci | --no-ci]

Stamps `asf/` — the engine, the stage vocabulary, the starter agents and
workflows, the runner, and `.skill-version`, the release they came from — plus
a factory.yaml assembled for the chosen harness, that harness's `.env.sample`,
the justfile, and the .gitignore entries — and, when taken (`--ci`, or yes when
asked), `.github/workflows/asf-check.yml`. Existing files are skipped unless
--force. ONE FILE IS NEVER OVERWRITTEN even then: factory.yaml is the
operator's; under --force a changed render lands beside it as `.new`.

Stdlib only: this runs under `uv run` with no dependencies.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _detect                                     # noqa: E402  (path set above)

SKILL_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = SKILL_ROOT / "templates"
HARNESSES = TEMPLATES / "harnesses"

# The release this skill is, as a stamp records it. It lives in the templates
# so that `stamp()` copies it like any other file — skipped on a re-run,
# overwritten by --force, deleted with `asf/` — and it is a MIRROR of
# `.claude-plugin/plugin.json`, the version a release bumps, because
# `npx skills add` copies this directory and nothing above it. A test pins the
# two together; nobody edits the stamped copy.
VERSION_FILE = Path("asf") / ".skill-version"

# The optional CI workflow: `asf check --json --ship` on every pull request and
# default-branch push, reported as a normal check and shipped to the cockpit as
# a CI station. Offered, never imposed — a repository's CI is its own. Once it
# is there, it is stamped like everything else: skipped on a re-run, refreshed
# by --force. Taking it is a flag or a question; leaving it is deleting it.
CI_TEMPLATE = TEMPLATES / "ci" / "asf-check.yml"
CI_WORKFLOW = Path(".github") / "workflows" / "asf-check.yml"

# What an operator's factory.yaml may still say that a later release drops,
# and what to tell them. A re-stamp never rewrites that file, so this is how a
# stamp from an older release hears about it: NAMED, never refused — refusing
# would block the very `--force` that brings the code the fix needs. A key
# matches by its path, and by its value where one is given.
OBSOLETE = (
    (("observability",), None,
     "ignored from 1.2, and can be deleted: until then it only moves the legacy trace db "
     "from asf/data/asf.db, the default without it"),
    (("worktree", "integration", "mode"), "none",
     "refused from 1.2: set `pr` (with `open_pr: false` to push and open nothing), and "
     "`worktree.publish: on_integrate` to keep a branch off the remote until it is "
     "integrated; a workflow that should land nothing drops its `integrate` stage"),
)

GITIGNORE_ENTRIES = [
    "asf/data/",
    ".env",
    ".asf-worktrees/",
    "__pycache__/",
    "*.pyc",
]


def harness_names() -> list[str]:
    return sorted(d.name for d in HARNESSES.iterdir()
                  if d.is_dir() and (d / "defaults.yaml").is_file())


def about(harness: str) -> tuple[str, str]:
    path = HARNESSES / harness / "about.md"
    if not path.is_file():
        return harness, ""
    head, _, body = path.read_text().partition("\n")
    return head.strip(), body.strip()


def choose(requested: str | None) -> str:
    available = harness_names()
    if requested:
        if requested not in available:
            sys.exit(f"unknown harness {requested!r} — this skill ships: "
                     f"{' | '.join(available)}")
        return requested
    if not sys.stdin.isatty():
        sys.exit("which harness? pass --harness <name> — this skill ships: "
                 f"{' | '.join(available)}\n(nothing to ask on: stdin is not a terminal)")
    print("Which coding-agent harness should this factory's agents run on?\n")
    for index, name in enumerate(available, start=1):
        print(f"  {index}. {about(name)[0]}")
    print()
    while True:
        try:
            answer = input(f"harness [{'/'.join(available)}]: ").strip()
        except EOFError:
            sys.exit("\nno answer — nothing was stamped")
        if answer in available:
            return answer
        if answer.isdigit() and 1 <= int(answer) <= len(available):
            return available[int(answer) - 1]
        print(f"  not one of {' | '.join(available)} — try again, or Ctrl-C to abort")


def skill_version() -> str:
    return (TEMPLATES / VERSION_FILE).read_text().strip()


def stamped_before_the_record(root: Path) -> bool:
    """A factory is here, and it records no version: stamped before 1.1."""
    return (root / "asf" / "asf.py").is_file() and not (root / VERSION_FILE).exists()


def keep_unrecorded(root: Path, stamped: list) -> None:
    """Undo the one file a plain re-run must not add to a pre-1.1 factory.

    Without --force every file that exists is kept, so what stays is still
    the old release's code; a record written beside it would claim today's,
    and erase the "before 1.1" that doctor and an upgrade go by. Only a run
    that refreshed the files — --force — may say which release they are."""
    record = root / VERSION_FILE
    if str(record) in stamped:
        record.unlink()
        stamped.remove(str(record))


def version_note(root: Path, stamped: list) -> str:
    """What the stamp records, and — when this run left an older record in
    place, or none — that it is older. A re-run without --force stamps the
    files a release added and keeps every one that exists, the record
    included, so the record still says which release the rest of `asf/`
    came from."""
    version = skill_version()
    record = root / VERSION_FILE
    changelog = f"    the upgrade steps are in {SKILL_ROOT / 'CHANGELOG.md'}"
    if str(record) in stamped:
        return f"skill version {version}  ({VERSION_FILE})"
    if not record.exists():
        return (f"this factory was stamped before 1.1 and records no version, and this "
                f"skill is {version} — left that way:\n    the files already here were not "
                f"refreshed (--force refreshes them, and records the version).\n{changelog}")
    recorded = record.read_text().strip()
    if recorded == version:
        return f"skill version {version}  ({VERSION_FILE}, already there)"
    return f"{VERSION_FILE} says {recorded}, and this skill is {version} — kept.\n{changelog}"


def wants_ci(root: Path, asked: bool | None) -> bool:
    """Whether to stamp the CI workflow: `--ci`/`--no-ci` when given; yes when
    it is already there, so --force refreshes it; else asked on a terminal,
    and no without one — `main()` says how to take it."""
    if asked is not None:
        return asked
    if (root / CI_WORKFLOW).exists():
        return True
    if not sys.stdin.isatty():
        return False
    print("\nStamp .github/workflows/asf-check.yml? It runs `asf check` on every pull request "
          "and\ndefault-branch push, and ships the factory's self-description to a cockpit.")
    try:
        return input("CI workflow [y/N]: ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def render_config(harness: str) -> str:
    head = (HARNESSES / harness / "defaults.yaml").read_text().rstrip() + "\n"
    rest = (TEMPLATES / "factory.yaml").read_text().rstrip() + "\n"
    return head + rest


def stamp(src: Path, dest: Path, force: bool, stamped: list, skipped: list) -> None:
    if src.is_dir():
        for child in sorted(src.iterdir()):
            if child.name == "__pycache__":
                continue
            stamp(child, dest / child.name, force, stamped, skipped)
        return
    if dest.exists() and not force:
        skipped.append(str(dest))
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    stamped.append(str(dest))


def write_config(harness: str, dest: Path, force: bool,
                 stamped: list, skipped: list, notes: list) -> None:
    fresh = render_config(harness)
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(fresh)
        stamped.append(str(dest))
        return
    if not force or dest.read_text() == fresh:
        skipped.append(str(dest))
        return
    proposed = dest.with_name(dest.name + ".new")
    proposed.write_text(fresh)
    notes.append((str(dest), str(proposed)))


# `key: value`, indented by spaces; a comment, a list item or a block scalar's
# text never starts like this, and a `#` after the value is a comment.
KEY_LINE = re.compile(r"^( *)([A-Za-z_][\w-]*)\s*:(?:\s+(.*?))?\s*(?:\s#.*)?$")
FLOW_PAIR = re.compile(r"([A-Za-z_][\w-]*)\s*:\s*([^,{}]*)")


def config_keys(text: str):
    """(path, value, line number) for every key of a YAML mapping, without a
    YAML parser — this script has no dependencies. Block style, and one level
    of flow style (`integration: {mode: none}`), which is all a factory.yaml
    says; anything stranger yields nothing rather than a guess."""
    stack: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        match = KEY_LINE.match(line)
        if not match:
            continue
        indent, key, value = len(match[1]), match[2], (match[3] or "").strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        path = tuple(name for _, name in stack)
        yield path, value.strip("\"'"), number
        if value.startswith("{") and value.endswith("}"):
            for child, child_value in FLOW_PAIR.findall(value[1:-1]):
                yield (*path, child), child_value.strip().strip("\"'"), number


def lint_config(config: Path) -> list[str]:
    """Each obsolete key the operator's config still says, where, and what
    to do about it — the installer's only say in a file it never rewrites."""
    if not config.is_file():
        return []
    found = []
    for path, value, number in config_keys(config.read_text()):
        for obsolete, expected, why in OBSOLETE:
            if path == obsolete and expected in (None, value):
                key = ".".join(path) + (f": {value}" if expected else ":")
                found.append(f"{config.parent.name}/{config.name}:{number} `{key}` — {why}")
    return found


JUSTFILE_MARK = "# agentic-sf recipes."


def stamp_justfile(root: Path, force: bool, stamped: list, skipped: list) -> str:
    """`justfile` when the repo has none or ours; `asf.justfile` beside a
    foreign one — a repository's own recipes are not the factory's to overwrite."""
    target = root / "justfile"
    if target.exists() and not target.read_text().startswith(JUSTFILE_MARK):
        target = root / "asf.justfile"
        stamp(TEMPLATES / "justfile", target, force, stamped, skipped)
        return (f"this repo already has a justfile, so the recipes went to {target.name}: "
                f"`just -f {target.name} <recipe>`, or import it from the other one")
    stamp(TEMPLATES / "justfile", target, force, stamped, skipped)
    return ""


def ensure_gitignore(root: Path, stamped: list) -> None:
    gitignore = root / ".gitignore"
    existing = gitignore.read_text().splitlines() if gitignore.exists() else []
    missing = [e for e in GITIGNORE_ENTRIES if e not in existing]
    if missing:
        with gitignore.open("a") as f:
            f.write("\n# agentic-sf runtime\n" + "\n".join(missing) + "\n")
        stamped.append(f"{gitignore} (+{len(missing)} entries)")


def ensure_env(root: Path, sample: Path, stamped: list, notes: list) -> bool:
    """Whether `.env` ends up carrying a usable ASF_SKILL.

    False is not cosmetic: unset, `just obs` starts without the legacy trace
    UI and `just uninstall` cannot find the skill at all — so main()
    says it loudly rather than leaving it to `doctor`.
    """
    env = root / ".env"
    if not env.exists() and sample.exists():
        env.write_text(sample.read_text())
        stamped.append(str(env))
    if not env.exists():
        return False
    lines = env.read_text().splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("ASF_SKILL="):
            continue
        current = line.split("=", 1)[1].strip().strip("\"'")
        if not current:
            lines[index] = f"ASF_SKILL={SKILL_ROOT}"
            env.write_text("\n".join(lines) + "\n")
            notes.append(f"ASF_SKILL={SKILL_ROOT}  (written into .env)")
        elif Path(current).resolve() != SKILL_ROOT:
            notes.append(f"ASF_SKILL in .env is {current}, but this install ran from "
                         f"{SKILL_ROOT} — left as it is")
        return True
    with env.open("a") as f:
        f.write(f"\nASF_SKILL={SKILL_ROOT}\n")
    notes.append(f"ASF_SKILL={SKILL_ROOT}  (appended to .env)")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--harness", help="which coding-agent harness the agents run on; "
                                          "asked interactively if omitted")
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    parser.add_argument("--no-detect-quality", action="store_true",
                        help="leave every quality.py block a placeholder")
    ci = parser.add_mutually_exclusive_group()
    ci.add_argument("--ci", dest="ci", action="store_true", default=None,
                    help=f"stamp {CI_WORKFLOW}: `asf check --json` on pull requests and "
                         f"default-branch pushes, shipped to a cockpit as a CI station")
    ci.add_argument("--no-ci", dest="ci", action="store_false",
                    help="do not stamp it, and do not ask")
    args = parser.parse_args()
    harness = choose(args.harness)
    root = Path.cwd()
    stamped, skipped, notes, config_notes = [], [], [], []

    unrecorded = stamped_before_the_record(root)
    stamp(TEMPLATES / "asf", root / "asf", args.force, stamped, skipped)
    if unrecorded and not args.force:
        keep_unrecorded(root, stamped)
    write_config(harness, root / "asf" / "factory.yaml", args.force, stamped, skipped,
                 config_notes)
    obsolete = lint_config(root / "asf" / "factory.yaml")
    stamp(HARNESSES / harness / "env.sample", root / ".env.sample", args.force, stamped, skipped)
    justfile_note = stamp_justfile(root, args.force, stamped, skipped)
    ci_taken = wants_ci(root, args.ci)
    if ci_taken:
        stamp(CI_TEMPLATE, root / CI_WORKFLOW, args.force, stamped, skipped)
    ensure_gitignore(root, stamped)
    skill_in_env = ensure_env(root, root / ".env.sample", stamped, notes)

    quality_py = root / "asf" / "engine" / "quality.py"
    detecting = not args.no_detect_quality and str(quality_py) in stamped
    detected = _detect.apply(quality_py, _detect.detect(root)) if detecting else []

    print(f"agentic-sf installed into {root} on the {harness} harness")
    print(f"  {version_note(root, stamped)}")
    print(f"  stamped: {len(stamped)} file(s)")
    for s in stamped:
        print(f"    + {s}")
    if skipped:
        print(f"  skipped (already exist, use --force to overwrite): {len(skipped)}")
    for mine, proposed in config_notes:
        print("\n  YOUR CONFIG WAS NOT TOUCHED — a fresh render is beside it:")
        print(f"    yours: {mine}\n    new:   {proposed}")
    if obsolete:
        print("\n  YOUR CONFIG NAMES OBSOLETE KEYS — named, not changed, and nothing was "
              "refused:")
        for line in obsolete:
            print(f"    {line}")
    print(f"\nthe skill is here: {SKILL_ROOT}")
    for note in notes:
        print(f"  {note}")
    if justfile_note:
        print(f"  {justfile_note}")
    if ci_taken:
        print(f"  {CI_WORKFLOW}: set vars.ASF_COCKPIT_URL and secrets.ASF_COCKPIT_TOKEN (the "
              f"factory's ingest token) for it to ship to a cockpit")
    else:
        print(f"  no CI workflow: re-run with --ci to stamp {CI_WORKFLOW}, which runs "
              f"`asf check --json` on pull requests and ships it to a cockpit")
    _, steps = about(harness)
    if steps:
        print(f"\nbefore the first run ({harness}):\n\n{steps}")
    if detected:
        print("\nquality commands detected from this repo — check them in asf/engine/quality.py:")
        for note in detected:
            print(f"    {note}")
    if detecting:
        unwired = [b for b in _detect.BLOCKS if b not in {n.split(':')[0] for n in detected}]
        if unwired:
            print(f"\nstill unwired: {', '.join(unwired)} — a verify stage that names one "
                  f"of these FAILS rather than passing.\n    write the real argv into "
                  f"asf/engine/quality.py")
    if not skill_in_env:
        print(f"\n  ! NO .env, SO ASF_SKILL IS UNSET — `just obs` will start without the "
              f"legacy trace UI,\n    and `just uninstall` cannot find "
              f"the skill.\n    write it yourself:  echo 'ASF_SKILL={SKILL_ROOT}' >> .env")
    # `just labels --create` and not a label call from here: the labels a repo
    # needs come from its RESOLVED config, and this script never reads one — it
    # renders factory.yaml from the templates and, on a re-install, skips the
    # one the operator owns. So on the upgrade path, which is the path a release
    # that adds a label actually travels, anything created here would be created
    # from the wrong list. `doctor` asks the right question every time.
    print("\nnext:  just doctor        is this repo ready? it names what is missing"
          "\n       just labels       the forge labels this config applies "
          "(--create defines them)"
          "\n       just do \"<prompt>\"                       (or: uv run asf/asf.py …)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

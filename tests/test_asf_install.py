"""The installer, as a subprocess, into a fresh repository."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from .asf_helpers import SKILL_ROOT, asf, fake_roster, git, install

STAMPED = ["asf/asf.py", "asf/factory.yaml", "asf/engine/session.py", "asf/engine/workflow.py",
           "asf/stages/plan/stage.py", "asf/stages/plan/task.md", "asf/stages/verify/fix.md",
           "asf/agents/planner/agent.md", "asf/engine/frontmatter.py",
           "asf/workflows/sdlc/workflow.yaml", "asf/workflows/ship/workflow.yaml",
           "asf/stages/review/revise.md", "asf/agents/reviewer/agent.md",
           "asf/stages/scout/stage.py", "asf/stages/scout/task.md", "asf/agents/scout/agent.md",
           "asf/workflows/issue/workflow.yaml", "asf/workflows/pr-review/tasks/implement.md",
           "asf/engine/inputs.py", "asf/engine/watch.py", "asf/engine/supervise.py",
           "asf/engine/labels.py", "asf/engine/cockpit.py", "asf/cockpit/compose.yaml",
           "asf/cockpit/min-version",
           ".env.sample", ".env", "justfile"]


def test_a_fresh_repo_is_stamped_and_its_workflows_check(repo: Path):
    result = install(repo, "--harness", "claude_code")
    assert result.returncode == 0, result.stdout + result.stderr
    for relative in STAMPED:
        assert (repo / relative).is_file(), relative
    assert "harness: claude_code" in (repo / "asf" / "factory.yaml").read_text()
    assert "ASF_SKILL=" in (repo / ".env").read_text()
    # Detected from the fixture's pyproject, written into the stamped quality.py.
    assert '"pytest"' in (repo / "asf" / "engine" / "quality.py").read_text()

    listed = asf(repo, "list")
    assert listed.returncode == 0 and "sdlc" in listed.stdout and "quick" in listed.stdout
    checked = asf(repo, "check")
    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert "✓ sdlc: plan -> implement -> verify -> commit" in checked.stdout
    assert "✓ pr-review: implement -> verify -> commit" in checked.stdout


def test_the_runtime_and_the_worktrees_are_gitignored(repo: Path):
    install(repo, "--harness", "pi")
    ignored = (repo / ".gitignore").read_text().splitlines()
    for entry in ("asf/data/", ".asf-worktrees/", ".env"):
        assert entry in ignored
    git(repo, "add", "-A")
    staged = git(repo, "diff", "--cached", "--name-only").splitlines()
    assert not [p for p in staged if p.startswith("asf/data/") or p == ".env"]


def test_a_vendored_skill_keeps_its_visualizer_s_node_modules_out_of_the_host(repo: Path):
    """`up` runs `bun install` inside the SKILL, and a repo that VENDORS the
    skill (`.agents/skills/…`) has that tree in its own working copy.

    A run on a worktree never sees it — a fresh checkout does not carry main's
    untracked files. Under `worktree.enabled: false` it does: the commit stage
    stages `run.repo_root`, which is then the main checkout, and `git add -A`
    sweeps up every package. One flag is not an invariant, and the rule ships
    with the directory, so it holds wherever the skill is checked out and
    whether or not install.py ever touched the host .gitignore.
    """
    install(repo, "--harness", "claude_code")
    vendored = repo / ".agents" / "skills" / "agentic-sf" / "apps" / "visualizer"
    vendored.parent.mkdir(parents=True)
    shutil.copytree(SKILL_ROOT / "apps" / "visualizer", vendored)
    (vendored / "node_modules" / "vue").mkdir(parents=True)
    (vendored / "node_modules" / "vue" / "package.json").write_text("{}\n")

    git(repo, "add", "-A")
    staged = git(repo, "diff", "--cached", "--name-only").splitlines()
    assert not [path for path in staged if "node_modules" in path]
    assert f"{vendored.relative_to(repo).as_posix()}/.gitignore" in staged   # and it travels


def test_a_second_install_skips_and_force_keeps_the_operator_s_config(repo: Path):
    install(repo, "--harness", "claude_code")
    again = install(repo, "--harness", "claude_code")
    assert "skipped" in again.stdout and "stamped: 0 file" in again.stdout

    config = repo / "asf" / "factory.yaml"
    config.write_text(config.read_text() + "\n# mine\n")
    engine = repo / "asf" / "engine" / "utils.py"
    engine.write_text("# clobbered\n")
    forced = install(repo, "--harness", "claude_code", "--force")
    assert forced.returncode == 0
    assert "# clobbered" not in engine.read_text()          # skill code is replaced
    assert config.read_text().endswith("# mine\n")          # the operator's file is not
    assert (repo / "asf" / "factory.yaml.new").is_file()    # the fresh render sits beside it


def test_an_unknown_or_unstampable_harness_is_refused(repo: Path):
    assert "unknown harness 'codex'" in install(repo, "--harness", "codex").stderr
    assert "unknown harness 'fake'" in install(repo, "--harness", "fake").stderr
    assert "pass --harness" in install(repo).stderr          # no terminal to ask on


def test_a_foreign_justfile_is_left_alone_and_ours_lands_beside_it(repo: Path):
    (repo / "justfile").write_text("# my own recipes\ndefault:\n    @just --list\n")
    result = install(repo, "--harness", "claude_code")
    assert result.returncode == 0
    assert (repo / "justfile").read_text().startswith("# my own recipes")
    assert (repo / "asf.justfile").read_text().startswith("# agentic-sf recipes.")
    assert "just -f asf.justfile" in result.stdout


# ── the optional CI workflow: `asf check --json` on every pull request ─────

CI_WORKFLOW = Path(".github") / "workflows" / "asf-check.yml"


def test_the_ci_workflow_is_offered_and_stamped_only_when_taken(repo: Path):
    plain = install(repo, "--harness", "claude_code")
    assert not (repo / CI_WORKFLOW).exists()
    assert "--ci" in plain.stdout                            # offered, not imposed

    taken = install(repo, "--harness", "claude_code", "--ci")
    assert taken.returncode == 0, taken.stdout + taken.stderr
    workflow = (repo / CI_WORKFLOW).read_text()
    assert f"+ {repo / CI_WORKFLOW}" in taken.stdout
    assert "pull_request" in workflow and "push" in workflow
    assert "asf/asf.py check --json --ship" in workflow
    assert "secrets.ASF_COCKPIT_TOKEN" in workflow           # the ingest token, and only it
    assert "ASF_STATION_TOKEN" not in workflow and "register" not in workflow


def test_the_ci_workflow_follows_the_installer_s_rules(repo: Path):
    install(repo, "--harness", "claude_code", "--ci")
    stamped = repo / CI_WORKFLOW
    stamped.write_text(stamped.read_text() + "# mine\n")

    again = install(repo, "--harness", "claude_code", "--ci")
    assert "stamped: 0 file" in again.stdout                  # skipped, and said so
    assert stamped.read_text().endswith("# mine\n")

    forced = install(repo, "--harness", "claude_code", "--force")   # taken once: still taken
    assert forced.returncode == 0
    assert not stamped.read_text().endswith("# mine\n")

    stamped.unlink()
    install(repo, "--harness", "claude_code", "--force")             # never taken: never added
    assert not stamped.exists()


def test_the_stamped_ci_workflow_s_command_is_one_check_accepts(stamped: Path):
    """The step is `check --json --ship`: on a checkout with no cockpit set it
    prints the description and passes, which is what a fork's pull request gets."""
    install(stamped, "--harness", "claude_code", "--ci")
    step = next(line for line in (stamped / CI_WORKFLOW).read_text().splitlines()
                if "asf/asf.py check" in line)
    argv = step.split("asf/asf.py", 1)[1].split()
    result = asf(stamped, *argv, env={"ASF_COCKPIT_URL": "", "ASF_COCKPIT_TOKEN": ""})
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["ok"] is True


# ── releases: one version, stamped into every factory ────────────────────────

REPO_ROOT = SKILL_ROOT.parent.parent
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def plugin_version() -> str:
    return json.loads((REPO_ROOT / ".claude-plugin" / "plugin.json").read_text())["version"]


def test_every_version_this_repo_carries_is_plugin_json_s():
    """`plugin.json` is the one a release bumps. The rest are mirrors: the
    marketplace entry, and the stamp template — which is what an install
    through `npx skills add` reads, because that copies the skill directory
    and nothing above it. A mirror nobody bumped is a factory stamped with
    the wrong release, so a stale one is named here, not discovered there."""
    version = plugin_version()
    assert SEMVER.match(version), f"plugin.json version {version!r} is not X.Y.Z"
    marketplace = json.loads((REPO_ROOT / ".claude-plugin" / "marketplace.json").read_text())
    mirrors = {
        "marketplace.json metadata.version": marketplace["metadata"]["version"],
        **{f"marketplace.json plugins[{p['name']}].version": p["version"]
           for p in marketplace["plugins"]},
        "templates/asf/.skill-version": (SKILL_ROOT / "templates" / "asf" / ".skill-version")
        .read_text().strip(),
    }
    stale = {where: value for where, value in mirrors.items() if value != version}
    assert not stale, f"plugin.json says {version}; these say otherwise: {stale}"


def test_the_changelog_names_upgrade_steps_for_every_release():
    """It ships in the skill directory, so the agent doing an upgrade has it
    whichever way the skill was installed."""
    changelog = (SKILL_ROOT / "CHANGELOG.md").read_text()
    entries = re.split(r"^## ", changelog, flags=re.MULTILINE)[1:]
    headings = [entry.splitlines()[0] for entry in entries]
    for heading, entry in zip(headings, entries):
        assert re.match(r"^(Unreleased|\d+\.\d+\.\d+( — \d{4}-\d{2}-\d{2})?)$", heading), \
            f"changelog heading {heading!r} is not `Unreleased` or `X.Y.Z — YYYY-MM-DD`"
        assert "\n### Upgrade\n" in entry, f"changelog entry {heading!r} names no upgrade steps"
    assert any(h.split(" ")[0] == plugin_version() for h in headings), \
        f"the changelog has no entry for {plugin_version()}, the version plugin.json names"


def test_the_stamp_records_the_skill_version_and_only_force_rewrites_it(repo: Path):
    stamp = repo / "asf" / ".skill-version"
    first = install(repo, "--harness", "claude_code")
    assert stamp.read_text() == f"{plugin_version()}\n"
    assert f"skill version {plugin_version()}" in first.stdout

    again = install(repo, "--harness", "claude_code")
    assert f"skill version {plugin_version()}" in again.stdout and "already there" in again.stdout

    stamp.write_text("1.0.0-old\n")                           # an older stamp's record
    again = install(repo, "--harness", "claude_code")
    assert stamp.read_text() == "1.0.0-old\n"                 # skipped, like any file
    assert "asf/.skill-version says 1.0.0-old" in again.stdout
    assert f"this skill is {plugin_version()}" in again.stdout and "CHANGELOG.md" in again.stdout

    forced = install(repo, "--harness", "claude_code", "--force")
    assert forced.returncode == 0
    assert stamp.read_text() == f"{plugin_version()}\n"


def test_a_re_run_over_a_factory_stamped_before_the_record_does_not_invent_one(repo: Path):
    """A re-run without --force keeps every file that exists, so what it
    leaves is still the old release's code. Writing today's version beside
    it would claim otherwise, and erase the "before 1.1" an upgrade routes on."""
    stamp = repo / "asf" / ".skill-version"
    install(repo, "--harness", "claude_code")
    stamp.unlink()                                            # as every stamp before 1.1

    again = install(repo, "--harness", "claude_code")
    assert again.returncode == 0, again.stdout + again.stderr
    assert not stamp.exists()
    assert "before 1.1" in again.stdout and "CHANGELOG.md" in again.stdout

    install(repo, "--harness", "claude_code", "--force")      # refreshed: now it is true
    assert stamp.read_text() == f"{plugin_version()}\n"


# ── the upgrade path: an old stamp is named, never refused ───────────────────

PRE_1_1_KEYS = """
# The trace: every run streams into this SQLite db, and `just obs` shows it.
observability:
  db: asf/data/asf.db
  poll_ms: 500
"""


def line_of(text: str, needle: str) -> int:
    return next(number for number, line in enumerate(text.splitlines(), 1) if needle in line)


def test_force_over_a_pre_1_1_stamp_names_each_obsolete_key_and_still_stamps(repo: Path):
    """The file the operator owns is linted, never rewritten and never a
    reason to refuse: refusing would block the very step that fixes it."""
    install(repo, "--harness", "claude_code")
    (repo / "asf" / ".skill-version").unlink()                # as every stamp before 1.1
    config = repo / "asf" / "factory.yaml"
    old = config.read_text().replace("mode: pr ", "mode: none", 1) + PRE_1_1_KEYS
    config.write_text(old)

    forced = install(repo, "--harness", "claude_code", "--force")
    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert (repo / "asf" / ".skill-version").read_text() == f"{plugin_version()}\n"
    assert config.read_text() == old                          # linted, not touched
    assert (repo / "asf" / "factory.yaml.new").is_file()

    named = forced.stdout
    observability = next(line for line in named.splitlines() if "`observability:`" in line)
    assert f"asf/factory.yaml:{line_of(old, 'observability:')}" in observability
    assert "ignored" in observability and "can be deleted" in observability
    integration = next(line for line in named.splitlines() if "`worktree.integration.mode: "
                       "none`" in line)
    assert f"asf/factory.yaml:{line_of(old, 'mode: none')}" in integration
    assert "refused from 1.2" in integration and "`pr`" in integration


def test_the_lint_reads_a_flow_mapping_too(repo: Path):
    """`integration: {mode: none}` is how the changelog itself spells it."""
    install(repo, "--harness", "claude_code")
    (repo / "asf" / "factory.yaml").write_text(
        "observability: {db: asf/data/asf.db}\n"
        "worktree:\n  integration: {mode: none, remote: origin}  # landed nothing\n")
    forced = install(repo, "--harness", "claude_code", "--force")
    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert "asf/factory.yaml:1 `observability:`" in forced.stdout
    assert "asf/factory.yaml:3 `worktree.integration.mode: none`" in forced.stdout


def test_a_config_this_release_rendered_names_nothing_obsolete(repo: Path):
    """The lint names what a LATER release drops, so the render this one
    writes must not trip it — or every re-run would cry wolf."""
    install(repo, "--harness", "claude_code")
    for args in ((), ("--force",)):
        again = install(repo, "--harness", "claude_code", *args)
        assert "OBSOLETE" not in again.stdout and "`observability:`" not in again.stdout


def doctor_line(repo: Path, **env: str) -> tuple[str, str]:
    """The `skill version` line `doctor` prints, and the one after it (its fix)."""
    result = asf(repo, "doctor", env={"ASF_SKILL": str(SKILL_ROOT), **env})
    assert result.returncode == 0, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    at = next(index for index, line in enumerate(lines) if "skill version" in line)
    return lines[at], lines[at + 1]


def test_doctor_compares_the_stamp_with_the_skill_and_points_an_old_one_at_the_cookbook(
        stamped: Path):
    fake_roster(stamped)
    record = stamped / "asf" / ".skill-version"
    version = plugin_version()

    line, _ = doctor_line(stamped)
    assert f"stamped at {version} · skill is {version}" in line and "✓" in line

    record.write_text("0.9.0\n")
    line, fix = doctor_line(stamped)
    assert f"stamped at 0.9.0 · skill is {version}" in line and "✓" not in line
    assert str(SKILL_ROOT / "cookbooks" / "upgrade.md") in fix

    record.unlink()
    line, fix = doctor_line(stamped)
    assert f"stamped before 1.1 · skill is {version}" in line
    assert str(SKILL_ROOT / "cookbooks" / "upgrade.md") in fix

    record.write_text("99.0.0\n")                             # a skill checkout left behind
    line, fix = doctor_line(stamped)
    assert f"stamped at 99.0.0 · skill is {version}" in line
    assert "older than the stamp" in line and "--force" in fix

    record.write_text(f"{version}\n")
    line, _ = doctor_line(stamped, ASF_SKILL="")              # no skill to compare with
    assert f"stamped at {version}" in line and "ASF_SKILL" in line

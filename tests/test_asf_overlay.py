"""`asf/factory.yaml` is an overlay on the skill-owned `asf/factory-defaults.yaml`.

The defaults file holds every key, its default and its prose, and is the one
source of defaults: the models in `data_types.py` carry none, so a key missing
from it is a load error rather than drift. The overlay says only what differs.
A re-stamp rewrites the defaults file whenever it differs, so a newer release's
default reaches an existing stamp; it never rewrites the overlay (ADR 0007).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from engine import factory

from .asf_helpers import SKILL_ROOT, asf, fake_roster, git, install, new_repo

GOLDEN = Path(__file__).resolve().parent / "golden" / "factory-yaml"
CONFIG = Path("asf") / "factory.yaml"
DEFAULTS = Path("asf") / "factory-defaults.yaml"


@pytest.fixture
def here(stamped: Path, monkeypatch) -> Path:
    monkeypatch.chdir(stamped)
    return stamped


def overlay(repo: Path, text: str) -> None:
    (repo / CONFIG).write_text((repo / CONFIG).read_text() + text)


def refused() -> str:
    with pytest.raises(SystemExit) as stop:
        factory.load()
    return str(stop.value)


def described(repo: Path) -> dict:
    result = asf(repo, "check", "--json")
    assert result.returncode == 0, result.stdout + result.stderr
    description = json.loads(result.stdout)
    description.pop("checked")                 # the commit and the files' hash, not settings
    return description


# ── what a stamp is given ────────────────────────────────────────────────────

def test_a_fresh_stamp_s_config_is_a_pointer_and_what_install_chose(repo: Path):
    result = install(repo, "--harness", "claude_code")
    assert result.returncode == 0, result.stdout + result.stderr

    text = (repo / CONFIG).read_text()
    first, *rest = text.splitlines()
    assert first.startswith("#") and "asf/factory-defaults.yaml" in first
    assert not any(line.lstrip().startswith("#") for line in rest)      # no prose of its own
    # The commands a station obeys are written into the repo's own file: a
    # permission never arrives through an upgrade of the defaults.
    assert yaml.safe_load(text) == {"cockpit": {"commands": ["answer", "abort", "kill",
                                                             "resume"]}}
    defaults = (repo / DEFAULTS).read_text()
    assert "harness:\n  name: claude_code" in defaults
    assert "asf/factory-defaults.yaml" in (repo / "asf" / ".skill-files").read_text()
    assert asf(repo, "list").returncode == 0
    checked = asf(repo, "check")
    assert checked.returncode == 0, checked.stdout + checked.stderr


def test_the_defaults_file_is_rendered_for_the_chosen_harness(repo: Path):
    install(repo, "--harness", "pi")
    defaults = yaml.safe_load((repo / DEFAULTS).read_text())
    assert defaults["harness"]["name"] == "pi"
    assert defaults["harness"]["model"] == "google/gemini-3.6-flash"
    assert "asf/factory-defaults.yaml" in defaults["protected_files"]


# The whole factory.yaml as the installer rendered it just before the overlay
# (main at 5bc09c3), recorded and never edited: what a stamp upgraded from
# then is left holding, since a re-stamp never rewrites that file.
FULL = GOLDEN / "before-overlay-claude_code.yaml"


def test_a_stamp_holding_the_whole_config_resolves_as_a_fresh_one(tmp_path: Path):
    """Every key a full factory.yaml carries is still a key, and it resolves to
    what the overlay does — the deliberate default changes are ones the full
    file already said."""
    fresh = new_repo(tmp_path / "fresh")
    full = new_repo(tmp_path / "full")
    for repo in (fresh, full):
        assert install(repo, "--harness", "claude_code").returncode == 0
    (full / CONFIG).write_text(FULL.read_text())

    assert described(full) == described(fresh)


def test_a_re_run_rewrites_the_defaults_file_and_never_the_config(stamped: Path):
    defaults = stamped / DEFAULTS
    shipped = defaults.read_text()
    defaults.write_text(shipped.replace("usd_per_day: 5", "usd_per_day: 50"))
    config = stamped / CONFIG
    config.write_text(config.read_text() + "data_dir: asf/runtime\n")
    mine = config.read_text()

    again = install(stamped, "--harness", "claude_code")            # no --force

    assert again.returncode == 0, again.stdout + again.stderr
    assert defaults.read_text() == shipped
    assert config.read_text() == mine


# ── how the overlay merges ───────────────────────────────────────────────────

def test_an_overlay_adds_a_route_and_deletes_a_default_one_with_null(here: Path):
    overlay(here, "issues:\n  route:\n    'asf:go': quick\n    'asf:bugfix': null\n")

    route = factory.load().issues.route

    assert route == {"asf:ship": "issue", "asf:refine": "refine",
                     "asf:refine-ship": "refine-ship", "asf:go": "quick"}


def test_a_whole_config_s_routes_join_the_defaults_rather_than_narrow_them(here: Path):
    """The one thing a full factory.yaml says that now means something else:
    its `route:` is merged like any map, so a narrowed one — or `route: {}`,
    which used to launch nothing — gets the defaults' routes back. `null`
    is how an overlay keeps one off (CHANGELOG, upgrade step 13)."""
    whole = yaml.safe_load(FULL.read_text())
    whole["issues"]["route"] = {}
    (here / CONFIG).write_text(yaml.safe_dump(whole))

    assert set(factory.load().issues.route) == {"asf:ship", "asf:refine", "asf:refine-ship",
                                                "asf:bugfix"}


def test_a_map_merges_key_by_key_and_a_list_replaces(here: Path):
    overlay(here, "hitl:\n  wait_seconds: 30\n  notify_command: [notify-send]\n"
                  "worktree:\n  integration:\n    mode: merge\n")

    cfg = factory.load()

    assert cfg.hitl.wait_seconds == 30 and cfg.hitl.when_unattended == "suspend"
    assert cfg.hitl.notify_command == ["notify-send"]
    assert cfg.worktree.integration.mode == "merge"
    assert cfg.worktree.integration.merge_flags == ["--no-ff"]


def test_protected_files_in_the_overlay_only_ever_add(here: Path):
    overlay(here, "protected_files: [docs/]\n")
    protected = factory.load().protected_files
    assert "docs/" in protected
    assert {"asf/engine/", "asf/factory.yaml", "asf/factory-defaults.yaml"} <= set(protected)

    (here / CONFIG).write_text("protected_files: null\n")
    assert "asf/engine/" in factory.load().protected_files


def test_another_harness_in_the_overlay_inherits_only_what_crosses_harnesses(here: Path):
    """As an agent.md on another harness: the factory block's tools, options and
    model are claude_code's vocabulary, and never reach a pi block."""
    overlay(here, "harness:\n  name: pi\n  thinking: high\n")

    block = factory.load().harness

    assert (block.name, block.model, block.thinking) == ("pi", "google/gemini-3.6-flash", "high")
    assert block.tools is None and block.options == {} and block.timeout_seconds == 1800


# ── what is refused, by name ─────────────────────────────────────────────────

def test_a_misspelled_key_fails_check_with_the_key_named(stamped: Path):
    overlay(stamped, "issues:\n  trusted_author: [me]\n")

    checked = asf(stamped, "check")

    assert checked.returncode == 1
    assert "issues.trusted_author" in checked.stdout + checked.stderr


def test_a_key_missing_from_the_defaults_file_is_a_load_error(here: Path):
    defaults = here / DEFAULTS
    defaults.write_text(defaults.read_text().replace("data_dir: asf/data", ""))

    said = refused()

    assert "data_dir" in said and "factory-defaults.yaml" in said


def test_a_stamp_without_its_defaults_file_is_told_to_re_run_the_installer(here: Path):
    (here / DEFAULTS).unlink()
    assert "install.py" in refused()


def test_an_obsolete_key_is_refused_with_what_became_of_it(here: Path):
    overlay(here, "observability:\n  db: asf/data/asf.db\n")
    said = refused()
    assert "observability" in said and "delete" in said


# ── doctor ───────────────────────────────────────────────────────────────────

def doctor_line(repo: Path) -> tuple[str, str]:
    """The `factory defaults` line `doctor` prints, and the one after it."""
    result = asf(repo, "doctor", env={"ASF_SKILL": str(SKILL_ROOT)})
    assert result.returncode == 0, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    at = next(index for index, line in enumerate(lines) if "factory defaults" in line)
    return lines[at], lines[at + 1]


def test_doctor_warns_when_the_defaults_file_was_edited(stamped: Path):
    fake_roster(stamped)
    git(stamped, "add", "-A")

    line, _ = doctor_line(stamped)
    assert "✓" in line

    defaults = stamped / DEFAULTS
    defaults.write_text(defaults.read_text().replace("max_concurrent: 2", "max_concurrent: 9", 1))
    line, fix = doctor_line(stamped)
    assert "✓" not in line and "edited" in line
    assert "asf/factory.yaml" in fix


# ── shrinking a whole config to what differs ─────────────────────────────────

def shrunk(repo: Path) -> tuple[str, str]:
    """`asf config --non-default`: the overlay on stdout, its notes on stderr."""
    result = asf(repo, "config", "--non-default")
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout, result.stderr


def test_a_whole_config_shrinks_to_what_a_fresh_stamp_says(tmp_path: Path):
    """The full file a stamp was given before the overlay, with what detection
    found here, shrinks to exactly the factory.yaml a fresh stamp writes — and
    it resolves to the same settings."""
    fresh = new_repo(tmp_path / "fresh")
    (fresh / ".gitignore").write_text(".env.local\n")
    (fresh / ".env.local").write_text("CONVEX_DEPLOYMENT=dev:x\n")
    (fresh / "bun.lock").write_text("{}\n")
    git(fresh, "add", ".gitignore", "bun.lock")
    git(fresh, "commit", "-q", "-m", "a repo with things to copy")
    assert install(fresh, "--harness", "claude_code").returncode == 0
    written = (fresh / CONFIG).read_text()
    full = yaml.safe_load(FULL.read_text())
    full["worktree"].update(yaml.safe_load(written)["worktree"])
    (fresh / CONFIG).write_text(yaml.safe_dump(full, sort_keys=False))
    before = described(fresh)

    text, notes = shrunk(fresh)

    assert text == written and notes == ""
    (fresh / CONFIG).write_text(text)
    assert described(fresh) == before


def test_shrinking_keeps_exactly_the_keys_a_person_changed(here: Path):
    full = yaml.safe_load(FULL.read_text())
    full["harness"]["model"] = "opus"
    full["harness"]["options"]["max_budget_usd"] = 3
    full["protected_files"].append("docs/")
    full["hitl"]["wait_seconds"] = 30
    full["worktree"]["integration"]["mode"] = "merge"
    full["issues"]["route"]["asf:bugfix"] = None
    (here / CONFIG).write_text(yaml.safe_dump(full, sort_keys=False))
    before = described(here)

    text, _ = shrunk(here)

    assert text.startswith("# Overlay on asf/factory-defaults.yaml")
    assert yaml.safe_load(text) == {
        "harness": {"model": "opus", "options": {"max_budget_usd": 3}},
        "protected_files": ["docs/"],                 # what it adds, never the defaults'
        "hitl": {"wait_seconds": 30},
        "cockpit": {"commands": ["answer", "abort", "kill", "resume"]},
        "worktree": {"integration": {"mode": "merge"}},
        "issues": {"route": {"asf:bugfix": None}},    # a default deleted stays deleted
    }
    (here / CONFIG).write_text(text)
    assert described(here) == before


def test_an_overlay_on_another_harness_keeps_its_name(here: Path):
    overlay(here, "harness:\n  name: pi\n  thinking: high\n")

    text, _ = shrunk(here)

    assert yaml.safe_load(text)["harness"] == {"name": "pi", "thinking": "high"}


def test_a_key_that_is_not_a_setting_is_left_out_and_named(here: Path):
    """What a full file may still say that the defaults no longer hold — a
    retired `*_command`, `observability:`, a typo — goes, each named with the
    value it held, so the person reading the diff knows what it said."""
    overlay(here, "issues:\n  view_command: [glab, issue, view]\n"
                  "observability:\n  db: asf/data/asf.db\n")

    text, notes = shrunk(here)

    assert "view_command" not in text and "observability" not in text
    assert "issues.view_command" in notes and "glab" in notes
    assert "observability" in notes
    (here / CONFIG).write_text(text)
    assert asf(here, "check").returncode == 0


def test_config_prints_the_settings_as_the_engine_runs_them(here: Path):
    overlay(here, "hitl:\n  wait_seconds: 30\n")

    result = asf(here, "config")

    assert result.returncode == 0, result.stderr
    settings = yaml.safe_load(result.stdout)
    assert settings["hitl"]["wait_seconds"] == 30 and settings["data_dir"] == "asf/data"


def test_a_key_yaml_would_read_as_a_boolean_is_quoted(here: Path):
    """`yes`, `on`, `null` — YAML 1.1 reads them unquoted as something other than
    the label they are, and the shrunk config would not load."""
    overlay(here, "issues:\n  route:\n    'yes': issue\n    'on': refine\n")

    text, _ = shrunk(here)

    assert set(yaml.safe_load(text)["issues"]["route"]) == {"yes", "on"}
    (here / CONFIG).write_text(text)
    checked = asf(here, "check")
    assert checked.returncode == 0, checked.stdout + checked.stderr

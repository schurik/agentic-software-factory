"""The labels a config NAMES, and whether the forge defines them.

WHY THIS FILE EXISTS. Every label in `issues.route`, `issues.states`,
`issues.refined_label` and `pull_requests.states.failed` is a name the factory
will one day hand to `--add-label`, and a forge answers that with an error when
nothing ever defined the name. Both halves fail silently until they matter: an
undefined route label cannot be applied, so the workflow behind it looks
configured and is inert; an undefined `refined_label` kills a `refine` run at
its last write, an hour in.

That is a REGRESSION SHAPE, not a one-off — the labels grew from three to nine
across two releases and nothing noticed. So the checked set is derived from the
resolved config rather than written down anywhere, and the first test here is
the one that keeps the NEXT added label from repeating it.
"""

from __future__ import annotations

from pathlib import Path

from engine import factory, labels, preflight

from .asf_helpers import asf, forge, forge_calls, forge_data, set_config

# What the shipped defaults name, and therefore the least a gh repo must define.
SHIPPED = ["asf:ship", "asf:refine", "asf:refine-ship", "asf:queued", "asf:running",
           "asf:done", "asf:failed", "asf:refined", "asf:pr-failed"]


def tracked(repo: Path, defined: list[str] | None = None, **issues) -> list[str]:
    """Point both forge paths at the stand-in, and tell it which labels exist."""
    base = forge(repo)
    set_config(repo, issues={
        "enabled": True, "project": "acme/widgets",
        "list_command": [*base, "list"], "state_command": [*base, "edit"],
        "labels_list_command": [*base, "label-list"],
        "labels_create_command": [*base, "label-create"],
        **issues})
    set_config(repo, pull_requests={"enabled": True, "project": "acme/widgets",
                                    "list_command": [*base, "list"]})
    forge_data(repo, "labels.json", [{"name": name} for name in (defined or [])])
    return base


def survey(repo: Path):
    return labels.survey(factory.load(repo / "asf" / "factory.yaml"), repo)


def names(found) -> list[str]:
    return sorted(label.name for label in found)


def created(repo: Path) -> list[str]:
    """The label names the forge was actually asked to define."""
    return sorted(call[1] for call in forge_calls(repo) if call[0] == "label-create")


# ── derivation: the set comes from the config, never from a list in the code ──

def test_every_label_the_shipped_config_names_is_in_the_checked_set(stamped: Path):
    tracked(stamped)
    assert names(survey(stamped).referenced) == sorted(SHIPPED)


def test_a_route_added_to_the_config_joins_the_checked_set_on_its_own(stamped: Path):
    """The regression guard. A new route must not need a second edit somewhere
    else to be checked — that second edit is exactly what nobody made."""
    tracked(stamped, route={"asf:ship": "issue", "asf:hotfix": "quick"})
    referenced = names(survey(stamped).referenced)
    assert "asf:hotfix" in referenced and "asf:refine" not in referenced


def test_a_path_that_is_off_contributes_no_labels(stamped: Path):
    tracked(stamped)
    set_config(stamped, pull_requests={"enabled": False})
    assert "asf:pr-failed" not in names(survey(stamped).referenced)

    set_config(stamped, issues={"enabled": False})
    assert survey(stamped).referenced == []


def test_a_renamed_state_is_checked_under_its_new_name(stamped: Path):
    tracked(stamped, states={"queued": "todo", "running": "wip",
                             "done": "shipped", "failed": "broken"})
    referenced = names(survey(stamped).referenced)
    assert "todo" in referenced and "asf:queued" not in referenced


def test_a_label_blanked_out_in_the_config_is_not_a_label_to_define(stamped: Path):
    """`refined_label: ""` is how a repo says it does not want that mark. An
    empty name is not one the forge can define, and asking it to would fail in a
    way nobody could read."""
    tracked(stamped, refined_label="")
    assert "" not in names(survey(stamped).referenced)


# ── the check: doctor's answer, and what it refuses to guess ─────────────────

def test_the_check_names_every_label_the_forge_does_not_define(stamped: Path):
    tracked(stamped, defined=["asf:ship", "asf:queued", "asf:running",
                              "asf:done", "asf:failed", "asf:refine"])
    found = preflight.labels(factory.load(stamped / "asf" / "factory.yaml"), stamped)
    warned = [finding for finding in found if finding.level == "warn"]
    assert len(warned) == 1
    detail = warned[0].detail
    for missing in ("asf:refine-ship", "asf:refined", "asf:pr-failed"):
        assert missing in detail
    assert "asf:ship" not in detail                       # only what is absent
    assert "asf/asf.py labels --create" in warned[0].fix


def test_a_forge_that_defines_them_all_is_green(stamped: Path):
    tracked(stamped, defined=SHIPPED)
    found = preflight.labels(factory.load(stamped / "asf" / "factory.yaml"), stamped)
    assert [finding.level for finding in found] == ["ok"]


def test_a_forge_that_cannot_be_asked_warns_and_never_fails_the_run(stamped: Path):
    """No auth, no remote, offline — all the same answer: say so, refuse to
    guess, and stay out of `before_run`, which is where a fatal would bite."""
    tracked(stamped)
    forge_data(stamped, "refuse.json", ["label-list"])
    cfg = factory.load(stamped / "asf" / "factory.yaml")
    found = preflight.labels(cfg, stamped)
    assert [finding.level for finding in found] == ["warn"]
    assert "could not" in found[0].detail
    assert preflight.before_run(cfg, stamped) is not None      # no SystemExit


def test_an_empty_labels_command_skips_the_check_entirely(stamped: Path):
    """A tracker that is not the forge does not define labels with a fifth verb.
    Silence is the honest answer there — inventing `gh` would be worse."""
    tracked(stamped, labels_list_command=[])
    assert preflight.labels(factory.load(stamped / "asf" / "factory.yaml"), stamped) == []


def test_a_label_the_config_no_longer_names_is_reported_and_never_deleted(stamped: Path):
    tracked(stamped, defined=[*SHIPPED, "asf:hotfix", "bug"])
    found = survey(stamped)
    assert found.stale == ["asf:hotfix"]                  # ours by prefix; `bug` is not
    result = asf(stamped, "labels", "--create")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "asf:hotfix" in result.stdout and "named by nothing" in result.stdout
    assert [call for call in forge_calls(stamped) if "delete" in call[0]] == []


# ── the command: one fix for a fresh install and an upgrade alike ────────────

def test_create_defines_exactly_the_missing_labels_with_a_colour_and_a_reason(stamped: Path):
    tracked(stamped, defined=["asf:ship", "asf:queued", "asf:running",
                              "asf:done", "asf:failed", "asf:refine"])
    result = asf(stamped, "labels", "--create")
    assert result.returncode == 0, result.stdout + result.stderr
    assert created(stamped) == ["asf:pr-failed", "asf:refine-ship", "asf:refined"]
    call = next(c for c in forge_calls(stamped) if c[:2] == ["label-create", "asf:refined"])
    assert "--color" in call and "--description" in call
    assert "requirements were settled" in call[call.index("--description") + 1]
    assert call[call.index("--repo") + 1] == "acme/widgets"


def test_create_is_a_no_op_once_the_forge_defines_them_all(stamped: Path):
    tracked(stamped, defined=SHIPPED)
    result = asf(stamped, "labels", "--create")
    assert result.returncode == 0, result.stdout + result.stderr
    assert created(stamped) == []


def test_listing_without_create_writes_nothing_and_reports_what_is_missing(stamped: Path):
    tracked(stamped, defined=["asf:ship"])
    result = asf(stamped, "labels")
    assert result.returncode == 1                          # usable as a gate
    assert "asf:refined" in result.stdout
    assert forge_calls(stamped) == []

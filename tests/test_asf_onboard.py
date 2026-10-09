"""Onboarding as code: `asf onboard` judges each step by its evidence, in order.

The order is what the user hit: a station registered before the factory was
on the forge's default branch had a code to approve and a Stations tab nobody
could find. So `published` comes before `cockpit`, and every step after it is
`todo` until it is done. A step is done by what git, `.env`, the kept station
token, the forge and the session directory say — only the three decisions
that leave no trace are recorded, in `<data_dir>/onboarding.json`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine import factory, onboarding, station
from engine.data_types import Finding, StationCredential

from .asf_helpers import asf, git, install, with_origin

DATA_DIR = "asf/data"
URL = "http://cockpit.test:3211"


@pytest.fixture(autouse=True)
def no_cockpit(monkeypatch):
    for name in ("ASF_COCKPIT_URL", "ASF_COCKPIT_TOKEN", "CI"):
        monkeypatch.delenv(name, raising=False)


def clean(_cfg, _root) -> list[Finding]:
    """A doctor with nothing fatal, and every label the config names defined."""
    return [Finding(check="forge labels", detail="7 label(s) the config names are all defined")]


def judged(repo: Path, monkeypatch, doctor=clean) -> dict[str, tuple[str, str]]:
    monkeypatch.chdir(repo)
    found = onboarding.progress(factory.load(), repo, doctor)
    return {step.step: (step.state, step.detail) for step in found.steps} | {"": (found.next, "")}


def states(found: dict[str, tuple[str, str]]) -> dict[str, str]:
    return {name: state for name, (state, _) in found.items() if name}


def test_a_fresh_stamp_starts_at_the_settings_and_everything_after_waits_for_them(repo: Path,
                                                                                  monkeypatch):
    assert install(repo, "--harness", "claude_code").returncode == 0

    found = judged(repo, monkeypatch)

    assert found[""][0] == "settings"
    assert states(found) == {"installed": "done", "ready": "done", "settings": "next",
                             "committed": "todo", "published": "todo", "cockpit": "todo",
                             "connected": "todo", "ci": "todo", "labels": "done",
                             "first_run": "todo"}


def test_the_factory_is_committed_and_published_before_a_cockpit_is_chosen(repo: Path,
                                                                           monkeypatch):
    assert install(repo, "--harness", "claude_code").returncode == 0
    monkeypatch.chdir(repo)
    cfg = factory.load()
    onboarding.mark(cfg, repo, "settings")

    assert judged(repo, monkeypatch)[""][0] == "committed"

    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "stamp the factory")
    found = judged(repo, monkeypatch)
    assert found[""][0] == "published" and "no remote `origin`" in found["published"][1]

    with_origin(repo)                                      # pushes main, factory and all
    assert judged(repo, monkeypatch)[""][0] == "cockpit"

    # A change to the factory that is not on the default branch is not published.
    (repo / "asf" / "factory.yaml").write_text(
        (repo / "asf" / "factory.yaml").read_text() + "\n# tuned\n")
    git(repo, "commit", "-qam", "tune the factory")
    found = judged(repo, monkeypatch)
    assert found[""][0] == "published"
    assert "1 commit(s) to asf/ are not on origin/main" in found["published"][1]
    git(repo, "push", "-q", "origin", "main")
    assert judged(repo, monkeypatch)[""][0] == "cockpit"


def test_the_record_holds_only_the_decisions_that_leave_no_trace(stamped: Path, monkeypatch):
    with_origin(stamped)
    monkeypatch.chdir(stamped)
    cfg = factory.load()

    onboarding.mark(cfg, stamped, "cockpit=local")
    found = judged(stamped, monkeypatch)
    assert found["cockpit"][0] == "done" and found["connected"][0] == "done"
    assert found[""][0] == "ci"

    onboarding.mark(cfg, stamped, "ci=declined")
    found = judged(stamped, monkeypatch)
    assert found[""][0] == "first_run"

    (stamped / DATA_DIR / "sessions" / "a1b2c3d4").mkdir(parents=True)
    (stamped / DATA_DIR / "sessions" / "a1b2c3d4" / "run.json").write_text("{}")
    found = judged(stamped, monkeypatch)
    assert found[""][0] == "" and all(state in ("done", "skipped") for state in states(found).values())

    record = json.loads((stamped / DATA_DIR / "onboarding.json").read_text())
    assert set(record["marks"]) == {"cockpit", "ci"}
    assert record["started"] and record["finished"]      # what the skill's startup reads
    assert "onboarding.json" not in git(stamped, "status", "--porcelain")    # gitignored

    with pytest.raises(SystemExit, match="one of"):
        onboarding.mark(cfg, stamped, "published")         # evidence, never a mark
    onboarding.forget(cfg, stamped, "ci")
    assert judged(stamped, monkeypatch)[""][0] == "ci"
    assert json.loads((stamped / DATA_DIR / "onboarding.json").read_text())["finished"] == ""


def test_a_teammate_s_clone_finds_the_settings_decided_on_the_default_branch(stamped: Path,
                                                                            monkeypatch, tmp_path):
    origin = with_origin(stamped)
    clone = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(origin), str(clone))

    found = judged(clone, monkeypatch)

    assert found["settings"] == ("done", "decided before this checkout: the factory is on main")
    assert found["published"][0] == "done" and found[""][0] == "cockpit"


def test_a_team_cockpit_waits_on_registering_and_on_the_ci_check_reaching_the_default_branch(
        stamped: Path, monkeypatch):
    with_origin(stamped)
    monkeypatch.setenv("ASF_COCKPIT_URL", URL)

    found = judged(stamped, monkeypatch)
    assert found["cockpit"] == ("done", f"the team's: {URL}")
    assert found[""][0] == "connected"

    here = station.identify(stamped, DATA_DIR)
    station.keep(stamped, DATA_DIR, StationCredential(cockpit=URL, station=here.id,
                                                      token="asf_station_x", owner="alex"))
    found = judged(stamped, monkeypatch)
    assert found["connected"] == ("done", "registered, approved by alex")
    assert found[""][0] == "ci"

    # Declining is no answer with a team cockpit: it brings the check.
    onboarding.mark(factory.load(), stamped, "ci=declined")
    assert judged(stamped, monkeypatch)[""][0] == "ci"

    assert install(stamped, "--harness", "claude_code", "--ci").returncode == 0
    found = judged(stamped, monkeypatch)
    assert "stamped and not yet on main" in found["ci"][1]
    git(stamped, "add", "-A")
    git(stamped, "commit", "-q", "-m", "the CI check")
    git(stamped, "push", "-q", "origin", "main")
    found = judged(stamped, monkeypatch)
    assert found["ci"][0] == "done" and "secrets.ASF_COCKPIT_TOKEN" in found["ci"][1]


def test_a_fatal_doctor_finding_and_missing_labels_hold_their_steps(stamped: Path, monkeypatch):
    def broken(_cfg, _root) -> list[Finding]:
        return [Finding(check="git", level="fatal", detail="no commit", fix="commit"),
                Finding(check="forge labels", level="warn", detail="2 label(s) missing",
                        fix="uv run asf/asf.py labels --create")]

    found = judged(stamped, monkeypatch, broken)

    assert found[""][0] == "ready" and found["ready"][1] == "1 fatal: git"
    assert found["labels"] == ("todo", "2 label(s) missing")


def test_labels_are_skipped_when_nothing_starts_runs_from_the_tracker(stamped: Path,
                                                                     monkeypatch):
    from .asf_helpers import set_config
    set_config(stamped, issues={"enabled": False}, pull_requests={"enabled": False})

    assert judged(stamped, monkeypatch)["labels"][0] == "skipped"


def test_onboard_prints_the_checklist_and_its_next_step_and_json_for_an_agent(stamped: Path):
    shown = asf(stamped, "onboard", "--mark", "settings")
    assert shown.returncode == 0, shown.stdout + shown.stderr
    assert "✓ settings" in shown.stdout and "next: " in shown.stdout

    as_json = json.loads(asf(stamped, "onboard", "--json").stdout)
    assert [step["step"] for step in as_json["steps"]][:5] == [
        "installed", "ready", "settings", "committed", "published"]
    assert as_json["next"] in {step["step"] for step in as_json["steps"]}

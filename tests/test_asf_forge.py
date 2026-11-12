"""`forge:` and `tracker:` select an implementation in Python that owns the argv
and the parsing (`engine/forge/`); the `*_command` keys that only ever worked
with `gh` are gone.

A key that only works with one value is a promise the code cannot keep: the
engine appended gh's flags, parsed gh's JSON and sent GitHub's graphql whatever
the prefix said. So the CLI is named in exactly one module, and the suite meets
it through a stand-in `gh` on PATH — or, where the question is what the engine
does with a tracker that cannot do something, through the fake.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from engine import forge, issues, labels, preflight
from engine.data_types import IssueRef, IssueUpdate, NewIssue
from engine.forge import fake

from .asf_helpers import (SKILL_ROOT, asf, defaults, forge_calls, forge_data, issue_json,
                          stand_in_gh, token_answers)

ENGINE = SKILL_ROOT / "templates" / "asf" / "engine"
GITHUB = ENGINE / "forge" / "github.py"
CONFIG = Path("asf") / "factory.yaml"


# ── the CLI is named in one module ───────────────────────────────────────────

def test_the_engine_names_gh_and_github_s_environment_only_in_the_github_module():
    named = re.compile(r"\bgh\b|GITHUB_")
    found = [f"{path.relative_to(ENGINE)}:{number}: {line.strip()}"
             for path in sorted(ENGINE.rglob("*.py")) if path != GITHUB
             for number, line in enumerate(path.read_text().splitlines(), start=1)
             if named.search(line)]
    assert found == []
    assert named.search(GITHUB.read_text())


def test_no_setting_names_a_forge_command_any_more():
    cfg = defaults()
    assert (cfg.forge, cfg.tracker) == ("github", "github")
    said = cfg.model_dump_json()
    assert "_command" not in said.replace("notify_command", "")


def test_an_unknown_forge_is_refused_by_name(stamped: Path):
    (stamped / CONFIG).write_text((stamped / CONFIG).read_text() + "tracker: jira\n")

    checked = asf(stamped, "check")

    assert checked.returncode == 1
    assert "tracker" in checked.stdout + checked.stderr


# ── the GitHub implementation, through a `gh` on PATH ────────────────────────

def test_github_reads_an_issue_and_moves_its_labels_with_gh(stamped: Path):
    stand_in_gh(stamped)
    forge_data(stamped, "issue.json", issue_json(number=7, labels=("asf:queued",)))
    cfg = defaults()

    tracker = forge.tracker_of(cfg)
    read = tracker.issue(stamped, "acme/widgets", 7)
    issues.set_state(stamped, cfg, IssueUpdate(number=7, project="acme/widgets",
                                               add_labels=["asf:running"],
                                               remove_labels=["asf:queued"]))

    assert (read.number, read.labels, read.author) == (7, ["asf:queued"], "someone")
    assert forge_calls(stamped)[-1] == ["edit", "7", "--repo", "acme/widgets",
                                        "--add-label", "asf:running",
                                        "--remove-label", "asf:queued"]


def test_a_rejected_write_is_evidence_naming_the_command(stamped: Path):
    stand_in_gh(stamped)
    forge_data(stamped, "refuse.json", ["comment"])

    result = issues.comment(stamped, defaults(),
                            IssueUpdate(number=7, project="acme/widgets", comment="hi"))

    assert not result.ok
    assert "gh issue comment" in result.notes[0] and "not something this forge" in \
        result.notes[0]


# ── when the forge's token stops working ─────────────────────────────────────
#
# GitHub sends `github-authentication-token-expiration` on every answer to a
# token that expires — a fine-grained token in a server station's
# asf/station/.env, say. The forge reads it off one `gh api --include
# rate_limit`, which costs no rate limit; doctor judges it (14 days a warning,
# 3 a fatal), and the station loop reports it to the cockpit with its poll.

def test_github_reads_when_its_token_expires_off_the_header_in_utc(stamped: Path):
    stand_in_gh(stamped)
    the_forge = forge.forge_of(defaults())

    token_answers(stamped, expires="2026-11-26 09:30:00 UTC")
    assert the_forge.token_expires() == "2026-11-26T09:30:00+00:00"
    token_answers(stamped, expires="2026-11-26 00:00:00 -0800")
    assert the_forge.token_expires() == "2026-11-26T08:00:00+00:00"
    assert forge_calls(stamped) == []                    # a question, not a call to keep


def test_a_token_whose_answer_names_no_expiry_carries_none(stamped: Path):
    stand_in_gh(stamped)
    token_answers(stamped)

    assert forge.forge_of(defaults()).token_expires() == ""


def test_a_refused_token_is_its_own_answer_and_no_answer_at_all_is_an_error(stamped: Path):
    stand_in_gh(stamped)
    the_forge = forge.forge_of(defaults())

    with pytest.raises(forge.ForgeError, match="could not ask") as unasked:
        the_forge.token_expires()                        # signed in to nothing
    assert not isinstance(unasked.value, forge.TokenRefused)

    token_answers(stamped, status=401, reason="Bad credentials")
    with pytest.raises(forge.TokenRefused, match="Bad credentials"):
        the_forge.token_expires()


NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


def judged(faked: fake.Fake, expiry, now: datetime = NOW) -> list:
    faked.expiry = expiry
    return preflight.token(defaults(forge="fake"), now=now)


@pytest.mark.parametrize("left, level", [(timedelta(days=30), "ok"),
                                          (timedelta(days=14, hours=1), "ok"),
                                          (timedelta(days=13, hours=23), "warn"),
                                          (timedelta(days=3, hours=1), "warn"),
                                          (timedelta(days=2, hours=23), "fatal"),
                                          (timedelta(hours=-1), "fatal")])
def test_doctor_warns_two_weeks_before_the_token_expires_and_fails_three_days_before(
        faked, left: timedelta, level: str, monkeypatch):
    monkeypatch.delenv("CI", raising=False)

    found, = judged(faked, (NOW + left).isoformat())

    assert (found.check, found.level) == ("forge token", level)
    assert (NOW + left).strftime("%Y-%m-%d") in found.detail
    assert ("expired" in found.detail) == (left < timedelta(0))
    assert (level == "ok") == (found.fix == "")
    assert level == "ok" or ("asf/station/.env" in found.fix and faked.sign_in in found.fix)


def test_doctor_says_when_the_forge_names_no_expiry_and_a_refused_token_is_fatal(
        faked, monkeypatch):
    monkeypatch.delenv("CI", raising=False)

    lasting, = judged(faked, "")
    refused, = judged(faked, forge.TokenRefused("Bad credentials (HTTP 401)"))

    assert lasting.level == "ok" and "no expiry" in lasting.detail
    assert refused.level == "fatal" and "Bad credentials" in refused.detail


def test_doctor_says_nothing_of_a_token_it_could_not_ask_about_nor_of_a_ci_job_s(
        faked, monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    assert judged(faked, forge.ForgeError("signed in to nothing")) == []

    monkeypatch.setenv("CI", "true")                     # a job's token lives for the job
    assert judged(faked, (NOW + timedelta(hours=1)).isoformat()) == []


def test_asf_doctor_fails_on_a_token_that_expires_in_two_days(stamped: Path, monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    stand_in_gh(stamped)
    soon = datetime.now(timezone.utc) + timedelta(days=2)
    token_answers(stamped, expires=soon.strftime("%Y-%m-%d %H:%M:%S UTC"))

    doctor = asf(stamped, "doctor")

    assert doctor.returncode == 1
    assert re.search(rf"✗ forge token +expires {soon:%Y-%m-%d} .*, in 1 day", doctor.stdout)
    assert "asf/station/.env" in doctor.stdout


# ── what the engine does with a tracker that cannot do something ─────────────

@pytest.fixture
def faked(monkeypatch) -> fake.Fake:
    forge_ = fake.Fake()
    monkeypatch.setattr(fake, "FAKE", forge_)
    return forge_


def test_a_tracker_that_defines_no_labels_is_not_asked_about_them(faked, tmp_path: Path):
    faked.defines_labels = False
    cfg = defaults(tracker="fake")

    found = labels.survey(cfg, tmp_path)

    assert not found.applicable
    assert "does not define labels" in found.note


def test_a_tracker_that_cannot_say_who_labelled_records_nobody(faked, tmp_path: Path):
    faked.knows_labellers = False
    cfg = defaults(tracker="fake")

    assert issues.labeller(tmp_path, cfg, IssueRef(number=1, project="a/b"), ["x"]) == ""


def test_the_fake_tracker_files_and_finds_an_issue(faked, tmp_path: Path):
    cfg = defaults(tracker="fake")

    filed = issues.create(tmp_path, cfg, NewIssue(project="a/b", title="t", body="b",
                                                  labels=["asf:improve:x"]))
    found = issues.labelled(tmp_path, cfg, "asf:improve:x")

    assert filed.ok and filed.number == found[0].number

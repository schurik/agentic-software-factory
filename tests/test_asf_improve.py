"""Self-improvement: one scorer's repeated failing scores, filed as one issue (ADR 0006).

When a scorer has failed on `failures` of the last `of_last` distinct sessions
it judged, the station files an issue on the factory's own tracker, labelled
`asf:improve:<scorer>` and queued for the `issue` workflow — at most one open
per scorer, found by its label, so new evidence joins it as a comment. Through
the seams a person meets it by, on a forge that records (`asf_helpers.forge`):

  * `asf run`: the chapter's failing score is the one that crosses the
    threshold, and the issue is filed by the process that ended the chapter;
  * `asf score`: a baseline's failing scores count the same way.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from engine import events, factory, forge, improve, scorers, watch
from engine.data_types import EventLine, ScorerClass, ScorerSpec

from .asf_helpers import (PY_CHECK, adw_id_of, asf, commit_all, defaults, envelope, fake_roster,
                          forge_calls, forge_data, git, pr_json, scorer, session_dir, set_config,
                          stand_in_gh, wire, with_origin, write_workflow)

CONFIG = "asf/factory.yaml"
CRITERIA = "A chapter the workflow refused is work a person has to pick up by hand.\n"
REFUSED = {"workflow": "quick", "kind": "code", "predicate": "not_accepted",
           "improve_after": {"failures": 2, "of_last": 3}}


def build_reply(content: str, message: str) -> dict:
    return {"writes": {"app.py": content}, "tokens": 50, "cost": 0.02,
            "envelope": envelope(changed_files=["app.py"], commit_message=message)}


def on_the_forge(repo: Path) -> None:
    """The stand-in `gh` on PATH, and the tracker aimed at its project."""
    stand_in_gh(repo)
    set_config(repo, issues={"enabled": True, "project": "acme/widgets"})


def prepared(repo: Path) -> None:
    wire(repo, "test", PY_CHECK)
    if git(repo, "status", "--porcelain"):
        commit_all(repo)


def refuse(repo: Path) -> subprocess.CompletedProcess:
    """One session of `quick` its workflow refused (max_fix_loops 2)."""
    fake_roster(repo, builder=[build_reply("1/0\n", "feat: broken"),
                               build_reply("2/0\n", "feat: still broken")])
    prepared(repo)
    result = asf(repo, "run", "quick", "add app.py")
    assert result.returncode == 1, result.stdout + result.stderr
    return result


def refused_run(repo: Path) -> str:
    return adw_id_of(refuse(repo))


def accepted_run(repo: Path) -> str:
    fake_roster(repo, builder=[build_reply("ok = 1\n", "feat: app")])
    prepared(repo)
    result = asf(repo, "run", "quick", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    return adw_id_of(result)


def filed(repo: Path) -> list[dict]:
    path = repo / ".forge" / "created.json"
    return json.loads(path.read_text()) if path.exists() else []


def calls(repo: Path, verb: str) -> list[list[str]]:
    return [call[1:] for call in forge_calls(repo) if call[0] == verb]


def labels_of(issue: dict) -> set[str]:
    return {label["name"] for label in issue["labels"]}


def ended_seq(repo: Path, adw_id: str) -> int:
    [ended] = [line.seq for line in events.read(session_dir(repo, adw_id))
               if line.kind == "workflow_finished"]
    return ended


# ── the threshold ────────────────────────────────────────────────────────────

def test_below_the_threshold_nothing_is_filed_and_at_it_one_labelled_issue_is(stamped: Path):
    on_the_forge(stamped)
    first = refused_run(stamped)                         # before the scorer: scored by `asf score`
    scorer(stamped, "refused", REFUSED, CRITERIA)
    commit_all(stamped)

    baseline = asf(stamped, "score")

    assert baseline.returncode == 0, baseline.stdout + baseline.stderr
    assert filed(stamped) == [] and calls(stamped, "label-create") == []
    assert "1 of the last 1" in baseline.stdout and "2 of the last 3" in baseline.stdout

    second = refused_run(stamped)                        # scored by the run that ended it

    [issue] = filed(stamped)
    assert labels_of(issue) == {"asf:improve:refused", "asf:ship", "asf:queued"}
    assert issue["title"] == ("Self-improvement: scorer refused failed on 2 of the last 2 "
                              "sessions it judged")
    body = issue["body"]
    # The failing scores, newest first, with the events they cite...
    assert body.index(f"Session `{second}`") < body.index(f"Session `{first}`")
    for adw_id in (first, second):
        assert f"seq {ended_seq(stamped, adw_id)} · `workflow_finished`" in body
    assert "`not_accepted` (failing)" in body
    # ...and the scorer's criteria, as its file has them.
    assert "`not_accepted`" in body and CRITERIA.strip() in body
    assert "asf/scorers/refused/scorer.md" in body
    # The label is defined before it is applied: a forge refuses an unknown one.
    [defined] = calls(stamped, "label-create")
    assert defined[0] == "asf:improve:refused"
    assert calls(stamped, "comment") == []


def test_the_issue_is_queued_for_the_issue_workflow_like_any_other(stamped: Path,
                                                                   monkeypatch):
    on_the_forge(stamped)
    scorer(stamped, "refused", REFUSED, CRITERIA)
    refused_run(stamped)
    refused_run(stamped)

    [issue] = filed(stamped)
    monkeypatch.chdir(stamped)
    cfg = factory.load(CONFIG)
    labels = issue["labels"]
    assert watch.route(cfg, labels) == "issue"
    assert cfg.issues.states.queued in labels_of(issue)
    # ...and the issues watcher lists it with the rest of the queue.
    forge_data(stamped, "listing.json", [])
    listed = forge.tracker_of(cfg).queued(stamped, "acme/widgets", cfg.issues.states.queued)
    assert [entry.number for entry in listed] == [issue["number"]]


def test_a_passing_score_asks_nothing_of_the_forge(stamped: Path):
    on_the_forge(stamped)
    scorer(stamped, "refused", {**REFUSED, "improve_after": {"failures": 1, "of_last": 3}},
           CRITERIA)

    accepted_run(stamped)

    assert forge_calls(stamped) == [] and filed(stamped) == []


# ── one open issue per scorer ────────────────────────────────────────────────

def test_an_open_issue_gets_the_new_evidence_as_a_comment_never_a_second_issue(stamped: Path):
    on_the_forge(stamped)
    scorer(stamped, "refused", REFUSED, CRITERIA)
    first, second = refused_run(stamped), refused_run(stamped)
    [issue] = filed(stamped)

    third = refused_run(stamped)

    assert len(filed(stamped)) == 1
    [said] = calls(stamped, "comment")
    assert said[0] == str(issue["number"])
    comment = said[said.index("--body") + 1]
    assert f"Session `{third}`" in comment
    assert f"`{first}`" not in comment and f"`{second}`" not in comment
    assert "3 of the last 3" in comment
    assert len(calls(stamped, "label-create")) == 1      # the label already exists by then

    # A second look with nothing new to say says nothing.
    again = asf(stamped, "score")
    assert again.returncode == 0, again.stdout + again.stderr
    assert len(calls(stamped, "comment")) == 1 and len(filed(stamped)) == 1


def test_an_issue_another_station_filed_is_found_by_its_label(stamped: Path):
    on_the_forge(stamped)
    # The factory's own threshold, for a scorer that sets none.
    set_config(stamped, self_improvement={"failures": 2, "of_last": 3})
    scorer(stamped, "refused", {key: value for key, value in REFUSED.items()
                                if key != "improve_after"}, CRITERIA)
    elsewhere = {"number": 7, "url": "https://forge/acme/widgets/issues/7", "title": "theirs",
                 "body": "<!-- asf:improve scorer=refused sessions=0badc0de -->\nfiled elsewhere",
                 "labels": [{"name": "asf:improve:refused"}], "state": "OPEN", "comments": []}
    (stamped / ".forge" / "created.json").write_text(json.dumps([elsewhere]))

    first, second = refused_run(stamped), refused_run(stamped)

    assert [issue["number"] for issue in filed(stamped)] == [7]
    [said] = calls(stamped, "comment")
    assert said[0] == "7"
    comment = said[said.index("--body") + 1]
    assert f"Session `{first}`" in comment and f"Session `{second}`" in comment
    assert "2 of the last 2 sessions it judged" in comment


# ── counting ─────────────────────────────────────────────────────────────────

REVIEWED = "5c0be7ed"


def test_failing_chapters_of_one_session_count_once(stamped: Path):
    on_the_forge(stamped)
    set_config(stamped, pull_requests={"enabled": True, "project": "acme/widgets"})
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    wire(stamped, "test", PY_CHECK)
    scorer(stamped, "review-rounds", {"workflow": "pr-review", "kind": "code",
                                      "predicate": "review_chapters_above(0)",
                                      "improve_after": {"failures": 2, "of_last": 10}})
    with_origin(stamped)
    commit_all(stamped)
    first = asf(stamped, "run", "quick", "add app.py", "--adw-id", REVIEWED)
    assert first.returncode == 0, first.stdout + first.stderr
    git(stamped, "push", "-q", "-u", "origin", f"asf/{REVIEWED}")

    for value, asked in enumerate(("make ok 2", "make ok 3"), start=2):
        fake_roster(stamped, builder=[build_reply(f"ok = {value}\n", f"fix: ok is {value}")])
        forge_data(stamped, "pr.json", pr_json(72, f"asf/{REVIEWED}", [{"body": asked}]))
        commit_all(stamped)
        result = asf(stamped, "run", "pr-review", "72")
        assert result.returncode == 0, result.stdout + result.stderr

    failing = [line for line in events.read(session_dir(stamped, REVIEWED))
               if line.kind == "chapter_scored" and line.payload["failing"]]
    assert [line.payload["chapter"] for line in failing] == [2, 3]
    assert filed(stamped) == []                          # two chapters, one session
    assert "1 of the last 1" in result.stdout


# ── after a merge ────────────────────────────────────────────────────────────

IMPROVER = "1a2b3c4d"


def improved(repo: Path, issue: dict) -> str:
    """The issue worked by a session of its own — a small workflow taking an
    issue, as the `issue` workflow would — whose pull request (#9, as the
    stand-in opens every one) the PR watcher then reaps merged, now. The
    forge closes the issue with it. Returns when it merged."""
    stand_in_gh(repo)
    set_config(repo, pull_requests={"enabled": True, "project": "acme/widgets"},
               worktree={"integration": {"mode": "pr", "open_pr": True}})
    write_workflow(repo, "fix", {
        "description": "implement an issue, verify, commit and open a pull request",
        "input": "issue",
        "stages": [{"implement": {"agent": "builder"}}, {"verify": {"blocks": ["test"]}},
                   {"commit": {"of": "implement"}}, {"integrate": {}}]})
    fake_roster(repo, builder=[build_reply("ok = 1\n", "fix: what the scorer found")])
    forge_data(repo, "issue.json", issue)
    if not git(repo, "remote"):
        with_origin(repo)
    prepared(repo)
    result = asf(repo, "run", "fix", str(issue["number"]), "--adw-id", IMPROVER)
    assert result.returncode == 0, result.stdout + result.stderr
    [made] = [line.payload["sha"] for line in events.read(session_dir(repo, IMPROVER))
              if line.kind == "committed"]
    merged_at = datetime.now(timezone.utc).isoformat()
    forge_data(repo, "listing.json", [])
    forge_data(repo, "pr.json", pr_json(9, f"asf/{IMPROVER}", state="MERGED",
                                        merged_at=merged_at, commits=[(made, ["a" * 40])]))
    reaped = asf(repo, "prs", "once")
    assert reaped.returncode == 0, reaped.stdout + reaped.stderr
    issues = [{**each, "state": "CLOSED"} if each["number"] == issue["number"] else each
              for each in filed(repo)]
    (repo / ".forge" / "created.json").write_text(json.dumps(issues))
    return merged_at


def test_failures_before_a_self_improvement_merge_do_not_count_after_it(stamped: Path):
    on_the_forge(stamped)
    scorer(stamped, "refused", REFUSED, CRITERIA)
    before = [refused_run(stamped), refused_run(stamped)]
    [issue] = filed(stamped)

    improved(stamped, issue)
    [learned] = [line.payload for line in events.read(session_dir(stamped, IMPROVER))
                 if line.kind == "provenance_recorded" and line.payload.get("issue_number")]
    assert learned["improves"] == "refused"

    # One failure since the merge is not the pattern the two before it were...
    first = refuse(stamped)
    assert len(filed(stamped)) == 1
    assert "failed on 1 of the last 1 sessions it judged since #9 merged" in first.stdout
    # ...two are, and the issue they file cites them alone.
    second = refuse(stamped)
    [again] = [each for each in filed(stamped) if each["number"] != issue["number"]]
    assert again["title"] == ("Self-improvement: scorer refused failed on 2 of the last 2 "
                              "sessions it judged since #9 merged")
    for adw_id in (adw_id_of(first), adw_id_of(second)):
        assert f"Session `{adw_id}`" in again["body"]
    for adw_id in before:
        assert adw_id not in again["body"]
    assert not [call for call in calls(stamped, "comment") if improve.MARK in call[-1]]


# ── what the record says it filed ────────────────────────────────────────────

def test_filing_and_adding_to_an_issue_are_on_the_newest_failing_session_s_record(
        stamped: Path):
    on_the_forge(stamped)
    scorer(stamped, "refused", REFUSED, CRITERIA)
    first, second = refused_run(stamped), refused_run(stamped)
    [issue] = filed(stamped)
    third = refused_run(stamped)

    def told(adw_id: str) -> list[dict]:
        return [line.payload for line in events.read(session_dir(stamped, adw_id))
                if line.kind == "improvement_filed"]

    assert told(first) == []
    [filing] = told(second)
    assert filing == {
        "scorer": "refused", "number": issue["number"], "url": issue["url"],
        "title": issue["title"], "commented": False, "sessions": [second, first],
        "cause": "", "surface": "", "not_diagnosed": filing["not_diagnosed"]}
    assert filing["not_diagnosed"]                       # the fake roster has no diagnostician
    [added] = told(third)
    assert added == {"scorer": "refused", "number": issue["number"], "url": issue["url"],
                     "title": issue["title"], "commented": True, "sessions": [third],
                     "cause": "", "surface": "", "not_diagnosed": ""}


# ── what stops it ────────────────────────────────────────────────────────────

def test_a_forge_that_cannot_be_searched_is_never_filed_on(stamped: Path):
    on_the_forge(stamped)
    forge_data(stamped, "refuse.json", ["list"])
    scorer(stamped, "refused", REFUSED, CRITERIA)
    refused_run(stamped)

    result = refuse(stamped)

    assert filed(stamped) == [] and calls(stamped, "label-create") == []
    assert "could not search" in result.stdout and "asf:improve:refused" in result.stdout
    # The chapter still ends the way it ended: a scorer measures, it never decides.
    assert "scored by refused: not_accepted (failing)" in result.stdout


def test_a_factory_off_the_tracker_files_nothing(stamped: Path):
    on_the_forge(stamped)
    set_config(stamped, issues={"enabled": False})
    scorer(stamped, "refused", REFUSED, CRITERIA)
    refused_run(stamped)

    result = refuse(stamped)

    assert forge_calls(stamped) == [] and filed(stamped) == []
    assert "failed on 2 of the last 2 sessions it judged, and no issue is filed: " \
           "`issues.enabled` is false" in result.stdout


def test_a_tracker_that_will_not_file_is_told_the_pattern_on_the_console(stamped: Path):
    on_the_forge(stamped)
    forge_data(stamped, "refuse.json", ["create"])
    scorer(stamped, "refused", REFUSED, CRITERIA)
    refused_run(stamped)

    result = refuse(stamped)

    assert filed(stamped) == []
    assert "failed on 2 of the last 2 sessions it judged, and the issue was not filed: " \
           "`gh issue create` failed" in result.stdout


# ── what never reaches the tracker ───────────────────────────────────────────

def test_the_issue_never_quotes_a_transcript_or_a_judge_s_reasoning(tmp_path: Path):
    # A tracker may be public; the transcripts opt-in is a cockpit's, not a tracker's.
    prompt = EventLine(seq=4, ts="t", kind="prompt_rendered", v=1,
                       payload={"text": "SECRET PROMPT TEXT"})
    finished = EventLine(seq=9, ts="t", kind="workflow_finished", v=2,
                         payload={"chapter": 1, "accepted": True})
    score = EventLine(seq=11, ts="t", kind="chapter_scored", v=2, payload={
        "chapter": 1, "scorer": "scope", "kind": "judge", "class": "lost", "failing": True,
        "evidence": [4, 9], "reasoning": "THE JUDGE'S OWN WORDS"})
    judge = scorers.Scorer("scope", tmp_path / "asf" / "scorers" / "scope" / "scorer.md",
                           ScorerSpec(workflow="quick", kind="judge",
                                      classes=[ScorerClass(name="lost", fail=True)]),
                           "Did it stay on the prompt?\n")
    counted = improve.Window(judge.threshold(defaults()), judged=["0badc0de"],
                             failing=[improve.Failing("0badc0de", [score],
                                                      {4: prompt, 9: finished, 11: score})])

    body = improve.issue_body(defaults(), judge, counted)

    assert "seq 4 · `prompt_rendered` · a transcript" in body
    assert "SECRET PROMPT TEXT" not in body and "THE JUDGE'S OWN WORDS" not in body
    assert "seq 9 · `workflow_finished` · `{\"accepted\": true" in body

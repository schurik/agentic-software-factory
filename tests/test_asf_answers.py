"""A gate answered on its work item: the verdict a comment carries, and who may give it.

A question round has always been answerable on the issue it asked on — any
reply after the questions is the answer. A GATE was not: the answers watcher
read every reply as an `answer`, which a gate refuses, so a plan gate on a
tracked issue waited for somebody to type `asf approve` at a terminal. A
cockpit answers a gate as the person who is signed in, by posting a comment on
that issue (spec #40), so the comment has to be able to say which verdict it is.

It says so on its first line — `/approve`, `/reject`, `/abort` — and a comment
the cockpit posts also names the session, gate, round and subject digest it
answered, so a reply to a round that has since moved on answers nothing.
`tests/golden/answers/` holds the comments the cockpit renders: its own suite
renders each byte for byte, and this one proves the factory hears each as it
was meant. That corpus is the only place the two ends of the comment meet.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine import factory, watch
from engine.data_types import IssueComment, Question, WaitingFor

from .asf_helpers import (asf, comment_json, commit_all, fake_roster, forge_data, issue_json,
                          run_state, session_dir, set_config)
from .test_asf_requirements import CONFIG, REFINE_ID, suspended_on_42, tracked  # noqa: F401
from .test_asf_slice2 import plan_reply

ANSWERS = Path(__file__).resolve().parent / "golden" / "answers"
FIXTURES = sorted(path.stem for path in ANSWERS.glob("*.json"))
LATER = "2099-01-01T00:00:00Z"


def golden(name: str) -> dict:
    return json.loads((ANSWERS / f"{name}.json").read_text())


def waiting_of(asked: dict) -> WaitingFor:
    return WaitingFor(gate=asked["gate"], round=asked["round"], kind=asked["kind"],
                      subject_digest=asked["subject_digest"], channel="issue", issue_number=42)


def said(*bodies: str, author: str = "schurik") -> list[IssueComment]:
    return [IssueComment(id=f"IC_{i}", author=author, body=body, created_at=LATER)
            for i, body in enumerate(bodies)]


# ── what a comment says ──────────────────────────────────────────────────────

def test_the_corpus_holds_the_comments_a_cockpit_renders():
    assert {"gate-approve", "gate-reject", "gate-abort",
            "questions-answer", "questions-take-all", "questions-abort"} <= set(FIXTURES)


@pytest.mark.parametrize("name", FIXTURES)
def test_every_comment_a_cockpit_renders_is_heard_as_it_was_meant(name: str):
    fixture = golden(name)
    asked, heard = fixture["asked"], fixture["heard"]

    reply = watch.reply_to(said(fixture["body"]), waiting_of(asked), asked["session"])

    assert reply is not None
    assert reply.verdict == heard["verdict"]
    assert reply.channel == "issue" and reply.by == "schurik"
    # An answer is prose the analyst weighs, so it keeps who said it; a verdict's
    # words are the person's remark, filed under their name by the decision.
    words = f"schurik: {heard['words']}" if heard["verdict"] == "answer" else heard["words"]
    assert reply.notes == words


def test_a_reply_without_a_verdict_is_discussion_at_a_gate():
    asked = golden("gate-approve")["asked"]

    assert watch.reply_to(said("looks fine to me, but I'd wait for Dana"),
                          waiting_of(asked), asked["session"]) is None


def test_a_person_on_the_forge_can_type_the_verdict_themselves():
    asked = golden("gate-approve")["asked"]

    reply = watch.reply_to(said("/Reject the probe should time out after 2s"),
                           waiting_of(asked), asked["session"])

    assert reply is not None and reply.verdict == "reject"
    assert reply.notes == "the probe should time out after 2s"


def test_the_latest_verdict_is_the_one_heard():
    asked = golden("gate-approve")["asked"]

    reply = watch.reply_to(said("/reject more detail", "/approve actually, fine"),
                           waiting_of(asked), asked["session"])

    assert reply is not None and (reply.verdict, reply.notes) == ("approve", "actually, fine")


@pytest.mark.parametrize("field, other", [("adw", "deadbeef"), ("gate", "integrate"),
                                          ("round", "1"), ("digest", "0" * 64)])
def test_a_cockpit_answer_to_another_wait_answers_nothing(field: str, other: str):
    """The mark is what makes a cockpit's answer safe to post: one written for
    round 1, or for a plan that has since changed, must not settle round 2."""
    fixture = golden("gate-approve")
    asked = fixture["asked"]
    mine = {"adw": asked["session"], "gate": asked["gate"], "round": str(asked["round"]),
            "digest": asked["subject_digest"]}
    body = fixture["body"].replace(f"{field}={mine[field]}", f"{field}={other}")

    assert watch.reply_to(said(body), waiting_of(asked), asked["session"]) is None


def test_a_question_round_still_hears_plain_replies_and_a_verdict_settles_it():
    asked = golden("questions-answer")["asked"]
    waiting = waiting_of(asked)

    plain = watch.reply_to(said("the refresh path", author="dana"), waiting, asked["session"])
    assert plain is not None and plain.verdict == "answer" and plain.notes == "dana: the refresh path"

    settled = watch.reply_to(said("the refresh path", "/approve"), waiting, asked["session"])
    assert settled is not None and settled.verdict == "approve"


# ── a gate on a tracked issue, end to end ────────────────────────────────────

def plan_gate_on_42(repo: Path) -> str:
    """An issue run stopped at its plan gate on #42, as a watcher would leave it."""
    unspent = [{"envelope": {"status": "success", "summary": "never reached"}}]
    fake_roster(repo, scout=[{"envelope": {"status": "success", "summary": "scouted"}}],
                planner=[plan_reply(), plan_reply("# Plan, revised\n")],
                builder=unspent, reviewer=unspent, documenter=unspent)
    forge_data(repo, "issue.json", issue_json(author="schurik"))
    commit_all(repo)
    result = asf(repo, "run", "issue", "42", "--hitl", "plan", "--adw-id", "a9f259f0",
                 env={"ASF_UNATTENDED": "1"})
    assert result.returncode == 75, result.stdout + result.stderr
    return "a9f259f0"


def cockpit_comment(repo: Path, adw_id: str, name: str, author: str = "schurik") -> None:
    """Post the cockpit's rendering of `name` on #42, for the wait this run is in.

    The fixture was rendered for a recorded session; only the digest is this
    run's own, because it hashes paths on this machine."""
    fixture = golden(name)
    waiting = run_state(repo, adw_id)["waiting_for"]
    body = fixture["body"].replace(f"round={fixture['asked']['round']}",
                                   f"round={waiting['round']}")
    body = body.replace(fixture["asked"]["subject_digest"], waiting["subject_digest"])
    forge_data(repo, "issue.json", issue_json(author="schurik", comments=[
        comment_json(body, author=author, created_at=LATER, id="IC_cockpit")]))


def decision(repo: Path, adw_id: str, gate: str, round: int) -> dict:
    return json.loads((session_dir(repo, adw_id) / "decisions" / f"{gate}_{round}.json").read_text())


def test_a_gate_answered_in_the_cockpit_brings_the_run_back(tracked):  # noqa: F811
    cfg, _ = tracked
    repo = Path.cwd()
    adw_id = plan_gate_on_42(repo)
    cockpit_comment(repo, adw_id, "gate-approve")

    assert watch.answers_once(cfg, CONFIG) == 0

    approved = decision(repo, adw_id, "plan", 1)
    assert (approved["verdict"], approved["channel"], approved["by"]) == ("approve", "issue", "schurik")
    assert approved["notes"] == "keep the prompt in English"
    assert approved["consumed_at"], "the run acted on it"
    assert run_state(repo, adw_id)["status"] != "waiting"


def test_a_reject_from_the_cockpit_is_revised_and_asked_again(tracked):  # noqa: F811
    cfg, _ = tracked
    repo = Path.cwd()
    adw_id = plan_gate_on_42(repo)
    cockpit_comment(repo, adw_id, "gate-reject")

    assert watch.answers_once(cfg, CONFIG) == 0

    assert decision(repo, adw_id, "plan", 1)["verdict"] == "reject"
    waiting = run_state(repo, adw_id)["waiting_for"]
    assert (waiting["gate"], waiting["round"]) == ("plan", 2)


def test_a_reject_with_nothing_to_change_is_not_a_decision(tracked):  # noqa: F811
    cfg, _ = tracked
    repo = Path.cwd()
    adw_id = plan_gate_on_42(repo)
    forge_data(repo, "issue.json", issue_json(comments=[
        comment_json("/reject", created_at=LATER, id="IC_bare")]))

    assert watch.answers_once(cfg, CONFIG) == 0

    # The same refusal `asf reject` without -m gets: an agent told to change nothing.
    assert run_state(repo, adw_id)["status"] == "waiting"
    assert not (session_dir(repo, adw_id) / "decisions" / "plan_1.json").exists()


def test_who_may_answer_a_gate_is_who_trusted_authors_names(tracked):  # noqa: F811
    repo = Path.cwd()
    adw_id = plan_gate_on_42(repo)
    set_config(repo, issues={"trusted_authors": ["schurik"]})
    cockpit_comment(repo, adw_id, "gate-approve", author="drive-by")

    assert watch.answers_once(factory.load(CONFIG), CONFIG) == 0

    assert run_state(repo, adw_id)["status"] == "waiting"


# ── what a suspend tells a cockpit about who may answer ──────────────────────

def suspended_events(repo: Path, adw_id: str) -> list[dict]:
    lines = [json.loads(line) for line in
             (session_dir(repo, adw_id) / "events.jsonl").read_text().splitlines()]
    return [line for line in lines if line["kind"] == "suspended"]


def test_a_suspend_names_who_the_factory_will_hear_and_asks_nothing_at_a_gate(tracked):  # noqa: F811
    repo = Path.cwd()
    set_config(repo, issues={"trusted_authors": ["schurik", "dana"]})
    adw_id = plan_gate_on_42(repo)

    event = suspended_events(repo, adw_id)[-1]

    assert event["v"] == 2
    assert event["payload"]["trusted"] == ["schurik", "dana"]
    assert event["payload"]["questions"] == []


def test_a_question_round_s_suspend_carries_its_questions(tracked):  # noqa: F811
    repo = Path.cwd()
    suspended_on_42(repo)

    payload = suspended_events(repo, REFINE_ID)[-1]["payload"]

    assert [Question(**question).question for question in payload["questions"]] == ["Which endpoint?"]
    assert payload["trusted"] == []                 # nobody named: whoever the forge lets comment

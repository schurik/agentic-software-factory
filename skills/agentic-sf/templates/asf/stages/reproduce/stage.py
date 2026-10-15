"""reproduce — a bug report becomes a failing test before anyone fixes it.

An agent stage that OWNS A LOOP, the way `refine` owns its question rounds and
for the same reason: whether another round is needed is the builder's answer,
not policy, and the YAML has no way to say it (rule 7).

    round 1..max_rounds:
        reproduce — the builder writes a test that fails BECAUSE of the bug,
                    or says it could not, what it tried, and what it needs
        reproduced?  -> frozen, handed on
        ask          — the questions on the work item; suspend; the answer back
    not reproduced after the last round -> what was tried, on the item; stop

WHAT IT PROVES. Without it, the builder's own summary is the only evidence a
fix addresses what the person saw. With it, a gate ran the test and watched it
fail the way the agent said the bug fails (`reproduction.reproduces`); from
then on no agent in the run may change that test (`reproduction.freeze`), and
`verify` runs it until it passes. The fix is proven against the report, and
the test keeps the bug from coming back.

NOTHING RED LANDS. The test stays uncommitted until `commit: {of: implement}`
lands it with the fix, after the checks are green and the reviewer approved —
so every commit on the branch is green, and `git bisect` still works. That it
was red first is in the session's record (the gate's checks, the `repro`
command's output) and in the pull request's description. One way round it: a
gate that suspends on a branch published `on_create` commits the tree as it
stands, so `--hitl every` (a checkpoint after this stage) puts the red test on
the branch. That is what a person asking to see every agent's work asked for.

NOT REPRODUCED IS AN OUTCOME, not a crash. The questions go where `refine`'s
go (`hitl.channel_of`, the work item first), and an answer brings the run back
to try again. After the last round nothing is built — `implement` never runs on
a bug nobody could show — and the run ends not accepted, with a reason that
says so and a comment on the item listing what every round tried.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from engine import artifacts, gates, hitl, issues, pull_requests, reproduction
from engine.data_types import (AgentCall, EnvelopeBase, GenericOutput, IssueComment,
                               IssueUpdate, PhaseParams, ReproOutput, Subject)
from engine.stage import StageStop

NAME = "reproduce"
KIND = "agent"
OUTPUT = ReproOutput                 # with the material it was given appended — see run()
NEEDS = ()
TASKS = {"reproduce": ("task.md", ReproOutput)}

GATE = "reproduction"
GATE_KIND = "questions"

# What the builder after this stage is told about the envelope it is handed.
# The line it holds is the one the stage exists to draw: the test is the
# report, as code, and it is fixed by changing the code — never the test.
REPRO_NOTES = ("This run turned the report into a test and SHOWED it failing, the way the "
               "report says the bug behaves: `repro_command` runs `repro_test`, and it "
               "fails printing `expected_failure`. That test is the spec for the fix. It is "
               "frozen — a gate refuses any change to it — so make it pass by changing the "
               "code, and do not touch the test.")

ANSWERS_NOTES = ("The answers file appended above holds what a person said when this run "
                 "asked how to reproduce the bug, with this run's own record of what was "
                 "asked. Read both halves: a reply overrides the questions it addresses, "
                 "and every other question stands at its recommendation.")


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent: str = "builder"
    # Tries, each but the last followed by a round of questions. Exhausting
    # them stops the run as not reproduced.
    max_rounds: int = Field(default=2, ge=1)
    retries: int = 1                # gate-correction rounds into the same session


def _joined(material: Optional[EnvelopeBase], paths: list[str], notes: str,
            summary: str) -> EnvelopeBase:
    """Material for the next try: what this one was handed, with `paths`
    appended and said what they are — the trick `scout` and `refine` use, for
    an agent call's one `previous` slot."""
    if material is None:
        return GenericOutput(status="success", summary=summary, artifacts=list(paths),
                             notes_for_next_agent=notes)
    return material.model_copy(update={
        "summary": f"{material.summary} · {summary}" if material.summary else summary,
        "artifacts": [*material.artifacts, *paths],
        "notes_for_next_agent": f"{material.notes_for_next_agent}\n\n{notes}".strip(),
    })


def _attempt(ctx, opts: Options, material, round: int) -> ReproOutput:
    name = "reproduce" if round == 1 else f"reproduce_{round}"
    with ctx.run.phase(PhaseParams(
            name=name, kind="agent", owner=opts.agent, retries=opts.retries,
            description="Turn the report into a test that fails because of the bug, "
                        "before anyone fixes it — or say what is missing to show it")) as ph:
        return ph.call(AgentCall(
            output_type=ReproOutput, prompt=ctx.prompt, previous=material,
            task=ctx.task("reproduce"),
            gates=[gates.artifacts_exist, gates.questions_are_answerable,
                   reproduction.reproduces]))


def _answers(ctx, attempt: ReproOutput, decision, round: int) -> str:
    """Write what the person said where the next try will read it, framed."""
    path = ctx.run.context_handoff_dir / f"reproduction_answers_{round}.md"
    said = decision.notes.strip()
    heard = [IssueComment(body=said, author=decision.by or "someone",
                          created_at=decision.decided_at)] if said else []
    issues.write_answers(path, heard, attempt.open_questions, agreed=decision.approved)
    artifacts.record_artifacts(ctx.run, "request", [str(path)])
    return str(path)


def _tried(adw_id: str, tried: list[ReproOutput]) -> str:
    """What the reporter reads when nobody could show the bug: every round."""
    lines = [f"{pull_requests.MARKER} · `{adw_id}` — could not reproduce this", "",
             f"{len(tried)} round(s) tried to turn this report into a test that fails "
             f"because of the bug, and none could. Nothing was built: a fix for a bug "
             f"nobody could show would be a guess.", ""]
    for round, attempt in enumerate(tried, start=1):
        lines += [f"**Round {round}** — {attempt.tried.strip()}", ""]
    lines += ["What would let the next run show it:", ""]
    lines += [f"- {question.question}" for question in tried[-1].open_questions]
    lines += ["", "Add what is missing here, and queue the item again."]
    return "\n".join(lines)


def _give_up(ctx, tried: list[ReproOutput]) -> None:
    """Tell the work item what every round tried. Code, never the agent."""
    run = ctx.run
    with run.phase(PhaseParams(
            name="reproduce_report", kind="code", owner="tracker",
            description="Tell the reporter the bug could not be shown as a failing test, "
                        "and what every round tried")) as ph:
        if not run.issue_number:
            ph.log(ok=True, notes="no work item — what was tried is in this run's record")
            return
        if run.benchmark is not None:
            ph.log(ok=True, notes="a benchmark's session writes nothing to the tracker")
            return
        posted = issues.comment(run.main_root, run.cfg.issues, IssueUpdate(
            number=run.issue_number, comment=_tried(run.adw_id, tried)))
        ph.log(ok=posted.ok, number=run.issue_number, notes=" · ".join(posted.notes))


def run(ctx, opts: Options):
    material: Optional[EnvelopeBase] = ctx.previous
    tried: list[ReproOutput] = []
    for round in range(1, opts.max_rounds + 1):
        attempt = _attempt(ctx, opts, material, round)
        if attempt.reproduced:
            reproduction.freeze(ctx.run, attempt)
            # The builder after this needs the reporter's words and the scout's
            # map as much as the test, so they travel on in the one envelope —
            # the material first, because `issues.HANDOFF_NOTES` names
            # artifacts[0] as the reporter's text.
            if material is None:
                return attempt.model_copy(update={"notes_for_next_agent": (
                    f"{REPRO_NOTES}\n\n{attempt.notes_for_next_agent}").strip()})
            return attempt.model_copy(update={
                "summary": f"{material.summary} · reproduced: {attempt.summary}",
                "artifacts": [*material.artifacts, *attempt.artifacts],
                "notes_for_next_agent": "\n\n".join(part for part in (
                    material.notes_for_next_agent, REPRO_NOTES,
                    attempt.notes_for_next_agent) if part)})
        tried.append(attempt)
        if round == opts.max_rounds:
            # Checked BEFORE asking, as `refine` does: a round that waits a day
            # for an answer and then stops without trying against it has spent
            # the one thing this loop is careful with.
            _give_up(ctx, tried)
            raise StageStop(
                f"not reproduced: {len(tried)} round(s) tried to show the reported bug as "
                f"a failing test and none could, so nothing was built. What each round "
                f"tried is on the work item and in this run's record; add what is "
                f"missing there and queue it again.")
        decision = hitl.asked(ctx.run, Subject(
            gate=GATE, round=round, summary=attempt.summary, paths=attempt.artifacts,
            notes=attempt.tried, questions=attempt.open_questions))
        material = _joined(material, [_answers(ctx, attempt, decision, round)],
                           ANSWERS_NOTES, f"round {round} answered by {decision.by}")

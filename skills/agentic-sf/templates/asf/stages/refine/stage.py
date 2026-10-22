"""refine — settle what the request actually asks for, with a person, before anyone plans.

An agent stage that OWNS A LOOP, the way `verify` owns its fix loop and for the
same reason: the shape cannot be written in the YAML (rule 7), and what decides
whether another round is needed is not policy but the analyst's own answer.

    round 1..max_rounds:
        recon    — the scout, on round 1 always; later only when ORDERED
        draft    — the analyst: requirements so far, plus what it cannot settle
        no blocking questions?  -> done
        ask      — publish the questions, suspend, come back with the answer
    then, in code: the requirements block onto the work item, and the mark

RECON IS INSIDE THE LOOP, and that is the whole reason this stage does its own
rather than sitting after `scout`. A single pass before the loop searches
against the REPORTER'S GUESS: the moment a person says "it is the OAuth refresh
path, not the login form", those findings describe the wrong code. Round 1 is
untargeted because nothing better is known yet; every later round is steered by
what the analyst asks for, which is the round that actually pays.

The analyst ORDERS recon and code decides whether to spend it (`needs_recon`,
`recon_focus`). The scout does it because it exists, is cheap by design and is
already read-only — and because that keeps the analyst a requirements thinker
with no `Bash` and no `Grep`, which is a boundary worth having when the same
agent is the one allowed to fetch a stranger's URL.

WHETHER A ROUND IS ASKED is the analyst's answer and, for one thing only, the
hitl policy's: a blocking question is always asked, and the policy decides
whether a round whose questions are all nice to have is asked too
(`hitl.asks_every_question`) — it can add a round, never take one away.

WHERE THE QUESTIONS GO is not an option here: `hitl.channel_of` derives it from
the run, work item first. A workflow cannot get that wrong because it cannot
say anything about it.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from engine import artifacts, gates, hitl, issues
from engine.data_types import (AgentCall, EnvelopeBase, IssueComment, IssueOutput, IssueRef,
                               PhaseParams, Question, RequirementsOutput, ScoutOutput, Subject)
from engine.stage import StageStop
from engine.utils import anchor, write_atomic

NAME = "refine"
KIND = "agent"
OUTPUT = RequirementsOutput          # or the IssueOutput it enriched — see run()
NEEDS = ()
TASKS = {"recon": ("recon.md", ScoutOutput),
         "ask": ("ask.md", RequirementsOutput),
         "refine": ("refine.md", RequirementsOutput)}

GATE = "requirements"
# Where the rendered requirements live in the handoff — the path the analyst
# reads its last draft from (refine.md), and the file the planner is handed.
REQUIREMENTS_FILE = "requirements.md"
GATE_KIND = "questions"

# What the planner is told about what this stage appended, beside
# `issues.HANDOFF_NOTES` (which frames artifacts[0], the reporter's own text)
# and `scout.BRIEFING_NOTES`. The line these hold is the one this stage exists
# to draw: the requirements were SETTLED WITH A PERSON, so they outrank the
# reporter's phrasing wherever the two disagree — and they are still not a plan.
BRIEFING_NOTES = ("The requirements file appended above was written by this factory and "
                  "agreed with a person, round by round. Where it and the reporter's "
                  "original text disagree, the requirements are the ones somebody "
                  "confirmed. They say what must be TRUE when the work is done — not how "
                  "to build it, and not which files to touch. Read the assumptions it "
                  "lists as carefully as the requirements: they are what nobody was "
                  "asked about.")

RECON_NOTES = ("The findings appended above are the scout's, in THIS repository. They are "
               "recon, not a decision: where the relevant code lives and what it does "
               "today. If they contradict the reporter's guess about which code is "
               "involved, the findings are the ones that looked.")

ANSWERS_NOTES = ("The answers file appended above holds what a person said when this run "
                 "asked, together with this run's own record of what was asked and what "
                 "each question stands at. Read both halves: a reply overrides the "
                 "questions it addresses, and every other question stands at its "
                 "recommendation.")


class Recon(BaseModel):
    """Who goes and looks when the analyst orders it, and how often it may.

    A NESTED MODEL WITH `agent:` IN IT, the shape `verify.fix` and
    `review.revise` already use, and not a flat `scout:` — `workflow.agent_fields`
    walks for a field called `agent`, so a flat one would sail past `check` and
    fail mid-run instead, which is the one thing `check` exists to prevent.
    """

    model_config = ConfigDict(extra="forbid")

    agent: str = "scout"
    # Round 1 always scouts, so this is never below 1. The ceiling is on the
    # ORDERED passes that follow: an analyst that keeps asking to look again is
    # one the answers are not reaching, and another sweep will not fix that.
    max_passes: int = Field(default=2, ge=1)


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent: str = "analyst"
    max_rounds: int = Field(default=3, ge=1)   # question rounds; exhausting them stops the run
    recon: Recon = Field(default_factory=Recon)
    retries: int = 1                # gate-correction rounds into the same session
    # Whether a person also sees the NICE-TO-HAVE questions: on, a round with
    # nothing blocking is asked too, and its recommendations are agreed rather
    # than dropped. Blocking questions are asked either way. None: factory.yaml's
    # `hitl.gates.requirements` decides, and `--hitl` beats both.
    hitl: Optional[bool] = None


def _joined(envelope: Optional[EnvelopeBase], artifacts: list[str], notes: str,
            summary: str) -> EnvelopeBase:
    """Hand the next agent ONE envelope carrying everything it must read.

    Every agent handoff has exactly one `previous` slot, and by the second round
    the analyst needs four things in it: the reporter's words, the scout's map,
    its own draft, and what a person answered. So they travel appended to the
    envelope that started the chain, each with a note saying what it is — the
    trick `scout` already uses, because WHERE a piece of text came from decides
    how much of it to believe, and a bare list of paths says nothing about that.
    """
    if envelope is None:
        return RequirementsOutput(status="success", summary=summary, artifacts=list(artifacts),
                                  notes_for_next_agent=notes)
    return envelope.model_copy(update={
        "summary": f"{envelope.summary} · {summary}" if envelope.summary else summary,
        "artifacts": [*envelope.artifacts, *artifacts],
        "notes_for_next_agent": f"{envelope.notes_for_next_agent}\n\n{notes}".strip(),
    })


def _recon(ctx, opts: Options, material, focus: str, round: int) -> EnvelopeBase:
    """One scouting pass, appended to the material. Round 1's has no focus."""
    name = "refine_recon" if round == 1 else f"refine_recon_{round}"
    aim = (f"Find what the analyst says it must know before this request can become "
           f"requirements: {focus}" if focus
           else "Find the code this request is about, so the requirements are written "
                "against the repository and not against the reporter's guess")
    with ctx.run.phase(PhaseParams(name=name, kind="agent", owner=opts.recon.agent,
                                   retries=opts.retries, description=aim)) as ph:
        found = ph.call(AgentCall(output_type=ScoutOutput, prompt=f"{ctx.prompt}\n\n{aim}",
                                  previous=material, task=ctx.task("recon"),
                                  gates=[gates.artifacts_exist, gates.files_non_empty]))
    return _joined(material, found.artifacts, RECON_NOTES, f"scouted: {found.summary}")


def _draft(ctx, opts: Options, material, round: int, asked: list[str]) -> RequirementsOutput:
    """The analyst: the requirements as they stand, plus what it still cannot settle."""
    name = "refine_draft" if round == 1 else f"refine_draft_{round}"
    with ctx.run.phase(PhaseParams(
            name=name, kind="agent", owner=opts.agent, retries=opts.retries,
            description="Turn the request into requirements a planner can work from, and "
                        "name what cannot be settled without asking somebody")) as ph:
        return ph.call(AgentCall(
            output_type=RequirementsOutput, prompt=ctx.prompt, previous=material,
            task=ctx.task("ask" if round == 1 else "refine"),
            gates=[gates.artifacts_exist, gates.files_non_empty,
                   gates.questions_are_answerable, gates.requirements_hold,
                   gates.every_question_decided(asked)]))


def _written(ctx, draft: RequirementsOutput,
             asked: list[Question]) -> tuple[RequirementsOutput, str]:
    """Render the draft into the requirements file, and hand back both.

    CODE WRITES THE DOCUMENT, every draft, at the one path the analyst is told
    to read it from in the next round: what it returned, in the shape a person
    will see on the item. The file leads the draft's artifacts, so the planner
    is handed it exactly as the briefing describes; anything else the analyst
    declared rides behind it.
    """
    draft = draft.model_copy(update={
        "requirements": issues.numbered_requirements(draft.requirements)})
    text = issues.render_requirements(draft, asked)
    path = ctx.run.context_handoff_dir / REQUIREMENTS_FILE
    write_atomic(path, text)
    artifacts.record_artifacts(ctx.run, "output", [str(path)])
    others = [a for a in draft.artifacts
              if anchor(ctx.run.repo_root, str(a)).resolve() != path.resolve()]
    return draft.model_copy(update={"artifacts": [str(path), *others]}), text


def _answers(ctx, draft: RequirementsOutput, decision, round: int) -> str:
    """Write what the person said where the analyst will read it, framed."""
    path = ctx.run.context_handoff_dir / f"answers_{round}.md"
    said = decision.notes.strip()
    heard = [IssueComment(body=said, author=decision.by or "someone",
                          created_at=decision.decided_at)] if said else []
    issues.write_answers(path, heard, draft.open_questions, agreed=decision.approved)
    # What the person answered is part of what this workflow is asked, like the
    # item itself — so a cockpit is told it the same way.
    artifacts.record_artifacts(ctx.run, "request", [str(path)])
    return str(path)


def _record(ctx, number: int, block: str) -> None:
    """Put the requirements on the work item and mark it refined. Code, not the agent.

    The analyst's `writes: []` covers the REPOSITORY; the tracker is outside
    that boundary entirely, so an agent able to call `gh issue edit` would have
    no boundary at all. Code renders the block from the envelope's fields
    (`_written`) and puts exactly that between the marks — idempotent across
    rounds, and the reporter's own text, outside the marks, out of reach.
    """
    config = ctx.run.cfg.issues
    ref = IssueRef(number=number)
    with ctx.run.phase(PhaseParams(
            name="refine_record", kind="code", owner="tracker",
            description="Put the settled requirements where the people who asked for the "
                        "work will read them, and mark the item refined")) as ph:
        if ctx.run.benchmark is not None:
            ph.log(ok=True, number=number, notes="a benchmark's session writes nothing to "
                                                 "the tracker — the requirements stay here")
            return
        written = issues.set_body(ctx.run.main_root, ctx.run.cfg, ref, block)
        marked = issues.mark_refined(ctx.run.main_root, ctx.run.cfg, ref)
        ph.log(ok=written.ok and marked.ok, number=number,
               label=config.refined_label,
               notes=" · ".join([*written.notes, *marked.notes]))


def run(ctx, opts: Options):
    number = ctx.previous.number if isinstance(ctx.previous, IssueOutput) else 0
    material: Optional[EnvelopeBase] = ctx.previous
    recon_spent = 0
    asked: list[Question] = []      # every question put to a person so far, in order
    focus = ""

    for round in range(1, opts.max_rounds + 1):
        # Round 1 always scouts: nothing is known about this repository yet, and
        # the analyst cannot order what it cannot see. Later rounds only when it
        # asked, because by then a blind second pass would find what the first
        # one already did.
        if (round == 1 or focus) and recon_spent < opts.recon.max_passes:
            material = _recon(ctx, opts, material, focus, round)
            recon_spent += 1
        elif focus:
            ctx.run.console.note(f"the analyst asked for recon on {focus!r}, but "
                                 f"recon.max_passes ({opts.recon.max_passes}) is spent — it works from "
                                 f"what the earlier passes found")
        focus = ""

        draft = _draft(ctx, opts, material, round, [question.id for question in asked])
        draft = draft.model_copy(update={
            "open_questions": issues.numbered(draft.open_questions, len(asked) + 1)})
        draft, block = _written(ctx, draft, asked)
        if not draft.blocking_questions and not (
                draft.open_questions and hitl.asks_every_question(ctx.run, GATE)):
            # Non-blocking questions are dropped here on purpose: they were
            # worth asking on a round that was going to happen anyway, and they
            # are not worth a day of somebody's time on their own — unless the
            # hitl policy says this gate is on, and a person sees every one.
            break
        if round == opts.max_rounds and not draft.blocking_questions:
            # The policy wanted them asked, but a round asked now would wait
            # for an answer no draft is left to fold in. The requirements hold
            # without them, so they stand at their recommendations — said here,
            # because nobody was asked.
            ctx.run.console.note(
                f"{len(draft.open_questions)} nice-to-have question(s) not asked: round "
                f"{round} is the last (max_rounds), so they stand at their recommendations")
            break
        if round == opts.max_rounds:
            # Checked BEFORE asking, not after the loop: a round that asks,
            # waits a day for an answer and then stops without drafting against
            # it has spent the one thing this loop is careful with.
            raise StageStop(
                f"{opts.max_rounds} round(s) in, the analyst still cannot settle "
                f"{len(draft.blocking_questions)} thing(s), so the requirements are not "
                f"agreed and nothing after this stage may act as if they were. Every "
                f"draft and answer is in this run's own directory; raise max_rounds, or "
                f"say what is missing on the item and start it again.")

        # EVERY open question, not only the blocking ones. Blocking (or the
        # policy) decides WHETHER a round is asked; once it is, the rest ride
        # along — and they have to be on the page to ride: `_answers` records
        # each of them as standing at its recommendation, which is only honest
        # about a question somebody was shown.
        decision = hitl.asked(ctx.run, Subject(
            gate=GATE, round=round, summary=draft.summary,
            paths=draft.artifacts, notes=draft.notes_for_next_agent,
            questions=draft.open_questions))
        asked += draft.open_questions
        material = _joined(material, [_answers(ctx, draft, decision, round)],
                           ANSWERS_NOTES, f"round {round} answered by {decision.by}")
        focus = draft.recon_focus.strip() if draft.needs_recon else ""

    if number:
        _record(ctx, number, block)

    # Same handoff as `scout`: an issue-triggered run gives the planner ONE
    # envelope, the issue's, with the requirements appended to what it is told
    # to read. The reporter's text stays at artifacts[0] because
    # `issues.HANDOFF_NOTES` names that index.
    if isinstance(ctx.previous, IssueOutput):
        return _joined(ctx.previous, draft.artifacts, BRIEFING_NOTES,
                       f"refined: {draft.summary}")
    return draft

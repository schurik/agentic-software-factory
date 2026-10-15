"""Judge, revise, retest: the loop a stage runs when an agent rules on the build
and the builder answers the ruling.

Two stages ask that kind of question. `review` asks "is this what was asked",
from the code; `accept` asks "does the running app do it", from a browser.
The loop around the question is the same, and it is written once, here: a
judge phase, the builder's revision in the same session that built it only
when the judge withheld approval, the judge again, at most `max_rounds`
times — then the `retest:` blocks once, only if a revision changed code, so
the tree that is handed on is the tree that was both tested and approved. A
judge that still withholds approval after the last round stops the run: what
it rejected must not land.

What differs is said by the stage, in a `Judging`: which task the judge is
given, what its phases are called and described, the gates its envelope
must clear, and anything its task file renders beyond the usual variables
(`accept`'s URL). A later change to how rounds work — how a withheld
approval is reported, when the retest runs — reaches both stages at once.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from pydantic import BaseModel, ConfigDict

from . import gates, quality, reproduction
from .data_types import AgentCall, BuildOutput, PhaseParams, ReviewOutput
from .stage import StageStop


class Revise(BaseModel):
    """`revise:` in a judging stage's options: who answers a withheld approval."""

    model_config = ConfigDict(extra="forbid")

    agent: str = "builder"
    retries: int = 1


@dataclass(frozen=True)
class Judging:
    """What one judging stage says about its own loop."""

    task: str                       # the judge's task key in the stage's TASKS
    phase: str                      # judge phases are `<phase>_1`, `<phase>_2`, …
    description: str                # each judge phase's
    revise_description: str         # each revise phase's
    judge: str                      # who withholds approval, as a stop says it: "the reviewer"
    output_type: type[ReviewOutput] = ReviewOutput
    gates: list[Callable] = field(default_factory=list)
    variables: dict[str, str] = field(default_factory=dict)


def judge_and_revise(ctx, opts, judging: Judging) -> BuildOutput:
    """Run the loop over `ctx.previous`, the build. Returns the build as the last
    revision left it. `opts` carries `agent`, `max_rounds`, `revise` and `retest`.

    Shape: <phase>_1, then revise_1 only if not approved, then <phase>_2, …
    then `retest` once, only if a revision changed code.
    """
    build = ctx.previous
    revised = False
    for round_ in range(1, opts.max_rounds + 1):
        with ctx.run.phase(PhaseParams(name=f"{judging.phase}_{round_}", kind="agent",
                                       owner=opts.agent,
                                       description=judging.description)) as ph:
            verdict = ph.call(AgentCall(output_type=judging.output_type, prompt=ctx.prompt,
                                        previous=build, gates=list(judging.gates),
                                        task=ctx.task(judging.task),
                                        variables=dict(judging.variables)))
        if verdict.approved:
            break
        if round_ == opts.max_rounds:
            blocking = "; ".join(verdict.blocking)[:300]
            raise StageStop(f"{judging.judge} withheld approval after {opts.max_rounds} "
                            f"round(s): {blocking or verdict.summary}")
        with ctx.run.phase(PhaseParams(name=f"revise_{round_}", kind="agent",
                                       owner=opts.revise.agent, retries=opts.revise.retries,
                                       description=judging.revise_description)) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=ctx.prompt,
                                      previous=verdict, gates=[gates.diff_matches_claims],
                                      task=ctx.task("revise")))
            revised = True
    if revised and opts.retest:
        # The run's repro test too, when it has one: a revision that makes it
        # red again has undone the fix the checks before it accepted.
        repro_checks = reproduction.checks(ctx.latest)
        what = ", ".join([*opts.retest, *([reproduction.NAME] if repro_checks else [])])
        with ctx.run.phase(PhaseParams(name="retest", kind="code", owner="quality",
                                       description=f"Re-run {what} — the revision changed code "
                                                   f"after the last green result")) as ph:
            result = quality.run_blocks(ctx.run, opts.retest, also=repro_checks)
            passed = sum(1 for check in result.checks if check.passed)
            ph.log(passed=result.passed, checks=f"{passed}/{len(result.checks)}",
                   artifacts=", ".join(result.artifacts))
        if not result.passed:
            raise StageStop(f"the revision {judging.judge} asked for broke {what}")
    return build

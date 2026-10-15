"""review — confirm that what was built is what was asked for, and send the
builder back a bounded number of times when it is not.

An agent stage that owns a loop, and asks a different question from verify:
the suite asks "does it run", the reviewer asks "is this what was asked",
against the plan when there is one and the prompt otherwise. Neither answers
the other's question. A revision that closes a finding re-enters the checks
named in `retest:`, so the tree that gets committed is the tree that was both
tested and approved. A reviewer that still withholds approval after
`max_rounds` stops the run here: nothing after a rejected review may land.

Shape: review_1, then revise_1 only if not approved, then review_2, … then
`retest` once, only if a revision changed code — the loop `accept` runs too,
written once in `engine/judging.py`.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from engine import gates, quality
from engine.data_types import BuildOutput, ReviewOutput
from engine.judging import Judging, Revise, judge_and_revise

NAME = "review"
KIND = "agent"
OUTPUT = BuildOutput                # the build as it stands after the last revision
NEEDS = (BuildOutput,)
TASKS = {"review": ("task.md", ReviewOutput), "revise": ("revise.md", BuildOutput)}


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent: str = "reviewer"
    max_rounds: int = Field(default=2, ge=1)
    revise: Revise = Field(default_factory=Revise)
    # Blocks to re-run after a revision changed code; [] skips the retest.
    retest: list[str] = Field(default_factory=lambda: ["test"])


def check(opts: Options, earlier: dict) -> list[str]:
    return quality.refused(opts.retest)


REVIEW = Judging(task="review", phase="review", judge="the reviewer",
                 description="Confirm the build matches what was asked, against the plan "
                             "or the prompt",
                 revise_description="Close the reviewer's blocking findings, in the same "
                                    "session that built it",
                 output_type=ReviewOutput,
                 gates=[gates.artifacts_exist, gates.verdict_consistent])


def run(ctx, opts: Options):
    return judge_and_revise(ctx, opts, REVIEW)

"""accept — drive the running app in a browser, judge it against what was asked,
and send the builder back a bounded number of times when it falls short.

The third question about a build. `verify` asks "does it run", `review` asks
"is this what was asked" from the code, and this asks "does the running app
do what was asked": clicking through the feature against the plan, which is
judgement work, so an agent does it — the `qa` agent, read-only, with a
browser given as an MCP server. Its verdict travels the loop `review` runs
(`engine/judging.py`): findings to the builder through `revise`, `retest:`
after a revision, at most `max_rounds` rounds, and a withheld approval stops
the run.

The only part of its own is the server. Code starts the app — factory.yaml's
`serve.commands`, the repository's own — on a free port once the agent's
browser answers, hands the agent the URL, and stops it however the stage ends
(`engine/serve.py`). An app or a browser that does not come up ends the
session as an environment failure, before an agent turn is spent.

Off by default: no shipped workflow runs it. `asf/examples/workflows/ship-accept/`
places it between `verify` and `review` — acceptance runs on a green suite, and
the reviewer, the last judge before the code is committed, sees the fixes made
for it. Claude Code only, by its MCP flag (`HARNESS_NEEDS`).

Shape: serve, accept_1, then revise_1 only if not approved, then accept_2, …
then `retest` once, only if a revision changed code.
"""

from __future__ import annotations

import dataclasses

from pydantic import BaseModel, ConfigDict, Field

from engine import agents, gates, quality, serve
from engine.data_types import AcceptanceOutput, BuildOutput
from engine.judging import Judging, Revise, judge_and_revise
from engine.serve import Serve

NAME = "accept"
KIND = "agent"
OUTPUT = BuildOutput                # the build as it stands after the last revision
NEEDS = (BuildOutput,)
TASKS = {"accept": ("task.md", AcceptanceOutput), "revise": ("revise.md", BuildOutput)}
HARNESS_NEEDS = ("MCP",)            # the browser is an MCP server


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent: str = "qa"
    max_rounds: int = Field(default=2, ge=1)
    revise: Revise = Field(default_factory=Revise)
    # Blocks to re-run after a revision changed code; [] skips the retest.
    retest: list[str] = Field(default_factory=lambda: ["test"])
    serve: Serve = Field(default_factory=Serve)
    # How long each of the agent's MCP servers gets to answer — the first
    # `npx` of a pinned server downloads it.
    browser_seconds: int = Field(default=120, ge=1)


def check(opts: Options, earlier: dict, cfg) -> list[str]:
    return quality.refused(opts.retest) + serve.refused(cfg)


ACCEPT = Judging(task="accept", phase="accept", judge="acceptance",
                 description="Drive the running app in a browser and judge it against the "
                             "plan or the prompt",
                 revise_description="Close what acceptance found not met in the running app, "
                                    "in the same session that built it",
                 output_type=AcceptanceOutput,
                 gates=[gates.artifacts_exist, gates.verdict_consistent,
                        gates.screenshots_handed_off])


def run(ctx, opts: Options):
    agent = agents.resolve(ctx.run.cfg, opts.agent)
    with serve.running(ctx.run, agent, opts.serve, opts.browser_seconds) as app:
        return judge_and_revise(ctx, opts, dataclasses.replace(
            ACCEPT, variables={"app_url": app.url, "server_log": app.log}))

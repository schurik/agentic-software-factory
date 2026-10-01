"""The factory, describing itself: what `asf check --json` prints.

A cockpit never interprets workflow files (spec #40). What it shows of a
factory — each workflow's purpose, trigger, stages, agents and gates, and the
per-session budget — is THIS: the workflows loaded by the same
`workflow.load` that `run` calls, written out as a `SelfDescription`. So a
cockpit and a run cannot disagree about what a workflow is, and a cockpit
upgrade never has to learn a new stage option.

The description names the checkout it describes (`CheckedCheckout`): its
HEAD, its branch, and `commands.config_hash` over its `asf/` files — the same
hash every station's command poll reports. Checked on the default branch, by
the optional CI workflow the installer stamps, it is what a cockpit measures
each station's config drift against.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from . import commands, factory, git_helper, station, workflow
from .data_types import (CheckedCheckout, DescribedAgent, DescribedGate, DescribedStage,
                         DescribedTrigger, DescribedWorkflow, FactoryConfig, SelfDescription,
                         WorkflowProblem)

VERSION_FILE = Path("asf") / ".skill-version"


def build(config_path: str | Path = factory.DEFAULT_CONFIG) -> SelfDescription:
    """Load every workflow, as `check` does, and describe what loaded.

    A workflow that does not load is a problem, not a hole in the description:
    the rest are still described, and `ok` is what `check` exits on.
    """
    cfg = factory.load(config_path)
    main_root = git_helper.main_root()
    described, problems = [], []
    for name, _ in workflow.available(config_path):
        try:
            loaded = workflow.load(name, config_path)
        except SystemExit as error:
            problems.append(WorkflowProblem(workflow=name, error=str(error)))
            continue
        described.append(_workflow(loaded, cfg))
    return SelfDescription(
        skill_version=_skill_version(main_root),
        checked=CheckedCheckout(head=_head(main_root), ref=_ref(main_root),
                                config_hash=commands.config_hash(main_root,
                                                                 cfg.defaults.data_dir)),
        ok=not problems, budget=cfg.budget, workflows=described, problems=problems)


def dumps(description: SelfDescription) -> str:
    """The description as `check --json` prints it, and as the fixture holds it."""
    return description.model_dump_json(indent=2) + "\n"


def _workflow(loaded: workflow.Workflow, cfg: FactoryConfig) -> DescribedWorkflow:
    """`cfg` is factory.yaml as written; `loaded.cfg` is it as this workflow
    binds it — its agent aliases, and the gates its stages switch."""
    stages, gates = [], []
    for step in loaded.steps:
        stage = step.stage
        stages.append(DescribedStage(stage=stage.name, kind=stage.kind,
                                     agents=_unique(workflow.agent_fields(step.opts)),
                                     gate=stage.gate))
        if stage.gate and stage.gate not in {gate.name for gate in gates}:
            on = (stage.gate_kind == "questions"
                  or bool(loaded.cfg.hitl.gates.get(stage.gate, loaded.cfg.hitl.default)))
            gates.append(DescribedGate(name=stage.gate, stage=stage.name, kind=stage.gate_kind,
                                       on=on))
    bound = {agent.name: agent for agent in loaded.cfg.agents}
    agents = [DescribedAgent(name=agent.name, harness=agent.harness, model=agent.model,
                             thinking=agent.thinking, purpose=agent.purpose, tools=agent.tools,
                             writes=agent.writes)
              for agent in (bound[name] for name in loaded.required_agents if name in bound)]
    return DescribedWorkflow(name=loaded.name, description=loaded.description,
                             input=loaded.input, trigger=_trigger(loaded, cfg), stages=stages,
                             agents=agents, gates=gates, warnings=loaded.warnings)


def _trigger(loaded: workflow.Workflow, cfg: FactoryConfig) -> DescribedTrigger:
    if loaded.input == "issue":
        labels = [label for label, name in cfg.issues.route.items() if name == loaded.name]
        return DescribedTrigger(labels=labels, watched=cfg.issues.enabled and bool(labels))
    if loaded.input == "pr":
        return DescribedTrigger(watched=cfg.pull_requests.enabled
                                and cfg.pull_requests.workflow == loaded.name)
    return DescribedTrigger()


def _unique(names: list[str]) -> list[str]:
    return list(dict.fromkeys(names))


def _skill_version(main_root: Path) -> str:
    try:
        return (main_root / VERSION_FILE).read_text().strip()
    except OSError:
        return ""


def _head(main_root: Path) -> str:
    try:
        return git_helper.rev(main_root)
    except Exception:              # noqa: BLE001 — a repository with no commit yet
        return ""


def _ref(main_root: Path) -> str:
    """The branch described. In a GitHub Actions job the checkout is detached
    — a pull request's merge commit, or the pushed commit — so the job's own
    word for it comes first: the pull request's branch, else the pushed one."""
    for name in ("GITHUB_HEAD_REF", "GITHUB_REF_NAME"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    try:
        branch = git_helper.current_branch(main_root)
    except Exception:              # noqa: BLE001
        return ""
    return "" if branch == "HEAD" else branch


def ship(description: SelfDescription, cfg: FactoryConfig,
         transport: station.Transport | None = None) -> int:
    """Send the description to the configured cockpit, as this checkout's station.

    `/describe`, with the factory's ingest token — the one credential a CI job
    holds, which can add to its own factory and receive nothing. The exit code
    follows `asf station sync`'s rule: non-zero ONLY when the cockpit refuses
    the token, because a check that goes red while the cockpit restarts
    teaches people to delete the step. No cockpit, or no token (a pull request
    from a fork is given no secrets), ships nothing and says so.
    """
    cockpit = station.configured()
    if cockpit is None:
        _say("no cockpit configured (ASF_COCKPIT_URL) — the description was not shipped")
        return 0
    if not cockpit.token:
        _say("no ASF_COCKPIT_TOKEN — the description was not shipped; a pull request from a "
             "fork is given no secrets, and that is all this is")
        return 0
    here = station.identify(git_helper.main_root(), cfg.defaults.data_dir)
    body = {"station": here.model_dump(mode="json"),
            "description": description.model_dump(mode="json")}
    try:
        status, answer = (transport or station.post)(f"{cockpit.url}/describe", cockpit.token,
                                                     body)
    except (OSError, ValueError) as error:
        _say(f"could not reach the cockpit at {cockpit.url} ({error}) — not shipped; the next "
             f"check sends a fresh one")
        return 0
    if status == 401:
        _say(f"the cockpit at {cockpit.url} refused ASF_COCKPIT_TOKEN: it must be a token that "
             f"cockpit issued for this repository")
        return 1
    if status != 200:
        _say(f"the cockpit at {cockpit.url} refused the description: HTTP {status}: "
             f"{answer.get('error') or 'no reason given'}")
        return 0
    _say(f"shipped to {cockpit.url} as station {here.name} ({here.kind})")
    return 0


def _say(text: str) -> None:
    """On stderr: stdout is the description, and a job may keep it."""
    print(f"describe: {text}", file=sys.stderr, flush=True)

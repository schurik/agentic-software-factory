"""The factory, describing itself: what `asf check --json` prints.

A cockpit never interprets workflow files (spec #40). What it shows of a
factory — each workflow's purpose, trigger, stages, agents and gates, the
per-session budget, the factory's settings and the scorers that judge its
chapters — is THIS: the workflows loaded by the same `workflow.load` that `run`
calls, the scorers by the same `scorers.load` a run scores with, and
factory.yaml as `factory.load` reads it, written out as a `SelfDescription`. So a cockpit and
a run cannot disagree about what a workflow is or what a setting left unset
means, and a cockpit upgrade never has to learn a new stage option or default.

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
from typing import Callable

from . import (commands, factory, git_helper, integration, issues, publish, scorers, station,
               workflow)
from .data_types import (CheckedCheckout, Cockpit, DescribedAgent, DescribedForge, DescribedGate,
                         DescribedHitl, DescribedIntake, DescribedLabels, DescribedLanding,
                         DescribedLimits, DescribedMeasure, DescribedReviews, DescribedScorer,
                         DescribedSettings, DescribedStage, DescribedTrigger, DescribedWorkflow,
                         FactoryConfig, ScorerProblem, SelfDescription, Station, WorkflowProblem)

VERSION_FILE = Path("asf") / ".skill-version"
CI_WORKFLOW = Path(".github") / "workflows" / "asf-check.yml"    # what `install.py --ci` stamps


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
    found, refused = scorers.load(factory.root_of(config_path),
                                  {flow.name: [agent.name for agent in flow.agents]
                                   for flow in described})
    return SelfDescription(
        skill_version=_skill_version(main_root),
        checked=CheckedCheckout(head=_head(main_root), ref=_ref(main_root),
                                config_hash=commands.config_hash(main_root,
                                                                 cfg.data_dir)),
        ok=not problems and not refused, budget=cfg.budget,
        settings=_settings(cfg, main_root, described), workflows=described, problems=problems,
        scorers=[_scorer(each, cfg) for each in found],
        scorer_problems=[ScorerProblem(scorer=each.name, error=each.error) for each in refused])


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


def _scorer(scorer: scorers.Scorer, cfg: FactoryConfig) -> DescribedScorer:
    spec = scorer.spec
    return DescribedScorer(
        name=scorer.name, workflow=spec.workflow, focus=spec.focus, kind=spec.kind,
        predicate=spec.predicate, classes=scorer.classes,
        sample_rate=1.0 if spec.sample_rate is None else spec.sample_rate, model=spec.model,
        improve_after=spec.improve_after or cfg.self_improvement)


def _trigger(loaded: workflow.Workflow, cfg: FactoryConfig) -> DescribedTrigger:
    if loaded.input == "issue":
        labels = [label for label, name in cfg.issues.route.items() if name == loaded.name]
        return DescribedTrigger(labels=labels, watched=cfg.issues.enabled and bool(labels))
    if loaded.input == "pr":
        return DescribedTrigger(watched=cfg.pull_requests.enabled
                                and cfg.pull_requests.workflow == loaded.name)
    return DescribedTrigger()


def _settings(cfg: FactoryConfig, main_root: Path,
              described: list[DescribedWorkflow]) -> DescribedSettings:
    """factory.yaml as the code reads it: pydantic has filled every key it
    left out, and what the engine decides from the rest — how an issue run
    lands, when a branch is published, which project a watcher aims at — is
    decided here by the same functions, never restated."""
    hitl, landing, pr = cfg.hitl, cfg.worktree.integration, cfg.pull_requests
    states = cfg.issues.states
    placed = {gate.name for flow in described for gate in flow.gates if gate.kind == "gate"}
    return DescribedSettings(
        intake=DescribedIntake(
            issues=cfg.issues.enabled, routes=cfg.issues.route, queued_label=states.queued,
            trusted_authors=cfg.issues.trusted_authors,
            max_concurrent=cfg.issues.max_concurrent,
            reviews=DescribedReviews(
                watched=pr.enabled, workflow=pr.workflow, trusted_reviewers=pr.trusted_reviewers,
                ignore_authors=pr.ignore_authors, reply_to_threads=pr.reply_to_threads,
                resolve_threads=pr.resolve_threads, max_threads=pr.max_threads,
                max_concurrent=pr.max_concurrent, reap_merged=pr.reap_merged),
            prompt_workflows=[flow.name for flow in described if flow.input == "prompt"]),
        hitl=DescribedHitl(
            default=hitl.default,
            gates={name: hitl.gates.get(name, hitl.default)
                   for name in sorted(placed | set(hitl.gates))},
            wait_seconds=hitl.wait_seconds, when_unattended=hitl.when_unattended,
            max_rounds=hitl.max_rounds, notify_command=hitl.notify_command),
        landing=DescribedLanding(
            mode=landing.mode, issue_mode=integration.lands_as(cfg, "issue", landing.mode)[0],
            open_pr=landing.open_pr, remote=landing.remote,
            branch_prefix=cfg.worktree.branch_prefix, base_ref=cfg.worktree.base_ref,
            publish=publish.mode(cfg, main_root), worktrees=cfg.worktree.enabled,
            worktree_dir=cfg.worktree.dir, keep_on_success=cfg.worktree.keep_on_success),
        limits=DescribedLimits(
            transcripts=cfg.cockpit.transcripts,
            transcript_retention_days=cfg.cockpit.transcript_retention_days or 0,
            commands=cfg.cockpit.commands),
        forge=DescribedForge(
            project=issues.resolve_project(cfg.issues, main_root),
            review_project=issues.resolve_project(pr, main_root),
            labels=DescribedLabels(**states.model_dump(), refined=cfg.issues.refined_label,
                                   pr_failed=pr.states.failed)),
        measure=DescribedMeasure(self_improvement=cfg.self_improvement))


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
    from a fork is given no secrets), ships nothing and says so — and nor does
    a checkout outside CI: the default branch's description is what every
    station's config drift is measured against, and a laptop's edits must not
    become it.
    """
    cockpit = station.configured()
    if cockpit is None:
        _say("no cockpit configured (ASF_COCKPIT_URL) — the description was not shipped")
        return 0
    if not cockpit.token:
        _say("no ASF_COCKPIT_TOKEN — the description was not shipped; a pull request from a "
             "fork is given no secrets, and that is all this is")
        return 0
    here = station.identify(git_helper.main_root(), cfg.data_dir)
    if here.kind != "ci":
        _say(f"{here.name} is a local station — --ship is the CI workflow's step "
             f"({CI_WORKFLOW}); the description was not shipped")
        return 0
    try:
        status, answer = _send(description, cockpit, here, transport or station.post)
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


def first(cockpit: Cockpit, transport: station.Transport,
          say: Callable[[str], None]) -> None:
    """Describe a factory nothing has described yet, once: when this station
    registers it (`commands.register`), with the ingest token it registered by.

    Without it a factory reads "unchecked" in the cockpit until its CI workflow
    first runs on the default branch — and a factory that never stamped one
    reads so for good. After this one, describing it is the CI workflow's job:
    the cockpit refuses a local station's description once it holds any, and
    one from a branch other than the default — the reason `ship` keeps a local
    checkout out. Nothing here fails the registration: it says what happened,
    and what keeps the description current.
    """
    main_root = git_helper.main_root()
    here = station.identify(main_root, factory.load().data_dir)
    try:
        status, answer = _send(build(), cockpit, here, transport)
    except (OSError, ValueError) as error:
        status, answer = 0, {"error": f"could not reach the cockpit: {error}"}
    if status == 200:
        say("  described the factory to the cockpit: nothing had yet, so this registration did")
    else:
        say(f"  the factory was not described: {answer.get('error') or f'HTTP {status}'}")
    if (main_root / CI_WORKFLOW).is_file():
        say(f"  from now on {CI_WORKFLOW} keeps the description current, from the default branch")
    else:
        say(f"  no {CI_WORKFLOW} here to keep it current — stamp it with the installer's --ci "
            f"(cookbooks/connect_cockpit.md#ci)")


def _send(description: SelfDescription, cockpit: Cockpit, here: Station,
          transport: station.Transport) -> tuple[int, dict]:
    body = {"station": here.model_dump(mode="json"),
            "description": description.model_dump(mode="json")}
    return transport(f"{cockpit.url}/describe", cockpit.token, body)


def _say(text: str) -> None:
    """On stderr: stdout is the description, and a job may keep it."""
    print(f"describe: {text}", file=sys.stderr, flush=True)

"""A workflow directory, loaded, checked, and run.

    asf/workflows/<name>/
        workflow.yaml     which stages, with which options, played by which agents
        tasks/<key>.md    optional: a task file that overrides the stage's default
        agents/<x>.md     optional: text a binding appends to an agent's identity

Everything a workflow.yaml can get wrong is found here, before a session
exists: a stage that is not in the vocabulary, an option no stage takes, a
`verify` with no implement before it, an agent the roster does not have, a task
whose report block drifted from the envelope type, a binding that tries to
widen what an agent may write. `asf.py check` is this function and nothing
else, and `asf.py run` calls it first.

The rules a binding lives by, and why:

  * `writes`, and the `tools`, `skills` and `context` of its `harness:` block,
    may only NARROW the roster's, and `deny_tools` only grow — a binding's
    denials join the roster's, so none can be taken back. The roster is reviewed once and is the
    security boundary; a workflow is edited often. If a workflow could widen
    any of them, the file people touch most would be the one where an agent
    gains write access — or a skill nobody reviewed. `model`, `thinking` and
    `timeout_seconds` replace; options and the harness itself are the roster's.
  * `system_append` is allowed, `system` is not. Identity stays shared, or
    five workflows drift into five builders and the roster means nothing. An
    agent that really is different is a new directory under asf/agents/.
  * Loops and conditions live in stages, never here. A workflow gets numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import (agents, benchmark_session, claims, factory, git_helper, harnesses, inputs,
               issues, pull_requests, scorers, session, tasks, worktree)
from .data_types import (AgentConfig, BuildOutput, ChapterInput, ClaimAsk, EnvelopeBase,
                         FactoryConfig, Invocation, PhaseParams, SessionSpec)
from .utils import new_id
from .stage import StageContext, StageModule, StageStop, Step, load_registry


class BindingHarness(BaseModel):
    """A binding's `harness:` block: the keys of the agent.md block a workflow
    may set. The rest (the harness, its options, its extensions) are the
    roster's, and naming one is refused."""

    model_config = ConfigDict(extra="forbid")

    model: Optional[str] = None
    thinking: Optional[str] = None
    timeout_seconds: Optional[int] = None
    tools: Optional[list[str]] = None        # narrows only
    skills: Optional[list[str]] = None       # narrows only
    context: Optional[list[str]] = None      # may only drop entries
    deny_tools: Optional[list[str]] = None   # only ever added to the roster's


class Binding(BaseModel):
    """`agents: {alias: {...}}` — a roster agent as this workflow plays it."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: str = Field(alias="from")
    harness: BindingHarness = Field(default_factory=BindingHarness)
    writes: Optional[list[str]] = None
    system_append: list[str] = Field(default_factory=list)   # paths relative to the workflow dir


# What a binding said flat before 1.3; each now sits in its `harness:` block.
BINDING_FLAT = ("model", "thinking", "tools", "timeout_seconds")


class Spec(BaseModel):
    """workflow.yaml, as written."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    input: ChapterInput = "prompt"
    agents: dict[str, Binding] = Field(default_factory=dict)
    stages: list[dict[str, Any]]


@dataclass
class Workflow:
    name: str
    description: str
    directory: Path
    cfg: FactoryConfig
    steps: list[Step]
    required_agents: list[str] = field(default_factory=list)
    input: ChapterInput = "prompt"         # prompt | issue | pr — see engine.inputs
    # What loads today and will not in a later release, as each stage says it
    # (`stage.warn`). `check` prints them; nothing here refuses a run over one.
    warnings: list[str] = field(default_factory=list)


def workflows_dir(config_path: str | Path) -> Path:
    return factory.root_of(config_path) / "workflows"


def available(config_path: str | Path = factory.DEFAULT_CONFIG) -> list[tuple[str, str]]:
    """(name, description) for every workflow directory, read without loading."""
    found = []
    for directory in sorted(p for p in workflows_dir(config_path).iterdir() if p.is_dir()):
        spec_path = directory / "workflow.yaml"
        if not spec_path.is_file():
            continue
        raw = yaml.safe_load(spec_path.read_text()) or {}
        found.append((directory.name, str(raw.get("description", "")).strip()))
    return found


def load(name: str, config_path: str | Path = factory.DEFAULT_CONFIG) -> Workflow:
    """Load one workflow and refuse it on the first inconsistency."""
    cfg = factory.load(config_path)
    root = factory.root_of(config_path)
    directory = workflows_dir(config_path) / name
    spec_path = directory / "workflow.yaml"
    if not spec_path.is_file():
        names = ", ".join(n for n, _ in available(config_path)) or "(none)"
        raise SystemExit(f"no workflow {name!r} — {directory} has no workflow.yaml. "
                         f"Available: {names}")
    raw = yaml.safe_load(spec_path.read_text()) or {}
    flat = _flat_bindings(raw)
    if flat:
        raise SystemExit(f"{spec_path}: " + "; ".join(flat))
    try:
        spec = Spec(**raw)
    except ValidationError as error:
        raise SystemExit(f"{spec_path}: {_flat(error)}") from None
    problems: list[str] = []
    if spec.name != name:
        problems.append(f"name is {spec.name!r} but the directory is {name!r}")
    if not spec.description.strip():
        problems.append("description is empty — it is the one line the orchestrator shows")

    cfg = _bind_agents(cfg, spec, directory, problems)
    registry = load_registry(root / "stages")
    steps = _steps(spec, registry, cfg, directory, problems)

    if problems:
        raise SystemExit(f"workflow {name!r} ({spec_path}) is not runnable:\n- "
                         + "\n- ".join(problems))
    required = sorted({a for step in steps for a in agent_fields(step.opts)})
    warnings = [f"{step.stage.name}: {warning}"
                for step in steps for warning in step.stage.warn(step.opts)]
    return Workflow(name=name, description=spec.description.strip(), directory=directory,
                    cfg=cfg, steps=steps, required_agents=required, input=spec.input,
                    warnings=warnings)


# ── agents ───────────────────────────────────────────────────────────────────

def _bind_agents(cfg: FactoryConfig, spec: Spec, directory: Path,
                 problems: list[str]) -> FactoryConfig:
    by_name = {agent.name: agent for agent in cfg.agents}
    bound: dict[str, AgentConfig] = dict(by_name)
    for alias, binding in spec.agents.items():
        base = by_name.get(binding.from_)
        if base is None:
            problems.append(f"agents.{alias}: from {binding.from_!r} is not in the roster "
                            f"({', '.join(sorted(by_name)) or 'empty'})")
            continue
        update: dict[str, Any] = {"name": alias}
        harness = binding.harness
        for key in ("model", "thinking", "timeout_seconds"):
            value = getattr(harness, key)
            if value is not None:
                update[key] = value
        for key in ("tools", "skills", "context"):
            narrowed = getattr(harness, key)
            if narrowed is None:
                continue
            widened = _widens(narrowed, getattr(base, key), exact=True)
            if widened:
                problems.append(f"agents.{alias}: {key} {widened} are not in {base.name}'s "
                                f"roster list — a workflow may narrow {key}, never widen them")
            update[key] = narrowed
        refusal = agents.skill_tool_refused(harness.tools)
        if refusal:
            problems.append(f"agents.{alias}: {refusal}")
        if harness.deny_tools:
            update["deny_tools"] = agents.added(base.deny_tools, harness.deny_tools)
            block = factory.block_of(base.model_copy(update=update))
            problems += [f"agents.{alias}: {problem}"
                         for problem in factory.mcp_refused(_main_root(directory), block)]
        if binding.writes is not None:
            widened = _widens(binding.writes, base.writes, exact=False)
            if widened:
                problems.append(f"agents.{alias}: writes {widened} are not covered by "
                                f"{base.name}'s roster writes {base.writes} — a workflow may "
                                f"narrow the boundary, never widen it")
            update["writes"] = binding.writes
        appends = []
        for ref in binding.system_append:
            path = directory / ref
            if not path.is_file():
                problems.append(f"agents.{alias}: system_append {ref} not found under {directory}")
            appends.append(str(path))
        update["prompt_engineering"] = base.prompt_engineering.model_copy(update={
            "system_append": [*base.prompt_engineering.system_append, *appends]})
        bound[alias] = base.model_copy(update=update)
    return cfg.model_copy(update={"agents": list(bound.values())})


def _main_root(directory: Path) -> Path:
    """The main checkout a workflow directory is in, where an `mcp:` file resolves."""
    return git_helper.main_root(directory.resolve())


def _flat_bindings(raw: dict) -> list[str]:
    """Each binding that still says a harness key flat, with the block it goes
    in — read off the YAML, so the refusal is the rewrite and not pydantic's
    list of what a binding accepts."""
    found = []
    for alias, binding in (raw.get("agents") or {}).items():
        if not isinstance(binding, dict):
            continue
        flat = [key for key in BINDING_FLAT if key in binding]
        if flat:
            block = {**(binding.get("harness") or {}), **{key: binding[key] for key in flat}}
            written = yaml.safe_dump(block, default_flow_style=True, sort_keys=False).strip()
            found.append(f"agents.{alias} sets {', '.join(f'`{key}`' for key in flat)} "
                         f"flat — since 1.3 they sit in its harness block: "
                         f"`harness: {written}`")
    return found


def _widens(requested: list[str], allowed: Optional[list[str]], exact: bool) -> list[str]:
    """Entries of `requested` the roster's `allowed` does not already cover.
    `None` in the roster means unrestricted, which anything narrows."""
    if allowed is None:
        return []
    if exact:
        return [item for item in requested if item not in allowed]
    return [item for item in requested
            if not any(item == rule or (rule.endswith("/") and item.startswith(rule))
                       for rule in allowed)]


# ── stages ───────────────────────────────────────────────────────────────────

def _steps(spec: Spec, registry: dict[str, StageModule], cfg: FactoryConfig,
           directory: Path, problems: list[str]) -> list[Step]:
    steps: list[Step] = []
    known_agents = {agent.name for agent in cfg.agents}
    current: Optional[type[EnvelopeBase]] = None
    earlier: dict[str, Optional[type]] = {}
    if not spec.stages:
        problems.append("stages is empty")
    for index, item in enumerate(spec.stages, start=1):
        if not isinstance(item, dict) or len(item) != 1:
            problems.append(f"stages[{index}]: each entry is one `- <stage>: {{options}}`")
            continue
        (stage_name, raw_opts), = item.items()
        stage = registry.get(stage_name)
        if stage is None:
            problems.append(f"stages[{index}]: {stage_name!r} is not a stage — the vocabulary "
                            f"is {', '.join(sorted(registry))}")
            continue
        try:
            opts = stage.options(**(raw_opts or {}))
        except ValidationError as error:
            problems.append(f"stages[{index}] {stage_name}: {_flat(error)}")
            continue
        for agent_name in agent_fields(opts):
            if agent_name not in known_agents:
                problems.append(f"stages[{index}] {stage_name}: agent {agent_name!r} is neither "
                                f"in the roster nor bound under agents: "
                                f"({', '.join(sorted(known_agents))})")
        if stage.needs and (current is None or not issubclass(current, stage.needs)):
            wanted = " | ".join(t.__name__ for t in stage.needs)
            got = current.__name__ if current else "nothing"
            problems.append(f"stages[{index}] {stage_name}: needs a {wanted} from an earlier "
                            f"stage, but what precedes it hands on {got}")
        problems += [f"stages[{index}] {stage_name}: {p}" for p in stage.check(opts, earlier)]
        problems += [f"stages[{index}] {stage_name}: {p}"
                     for p in _harness_lacks(stage, opts, cfg)]
        step = Step(stage=stage, opts=opts)
        for key, (filename, answer_type) in stage.tasks.items():
            path = tasks.resolve(key, stage.directory / filename, directory)
            step.tasks[key] = str(path)
            problems += [f"stages[{index}] {stage_name}: {p}"
                         for p in tasks.check(path, answer_type)]
        _merge_hitl(cfg, stage, opts)
        steps.append(step)
        earlier[stage_name] = stage.output
        if stage.output is not None:
            current = stage.output
    return steps


def _harness_lacks(stage: StageModule, opts: BaseModel, cfg: FactoryConfig) -> list[str]:
    """Each capability the stage needs that the harness of its `agent:` lacks."""
    agent = next((a for a in cfg.agents if a.name == getattr(opts, "agent", None)), None)
    driver = harnesses.HARNESSES.get(agent.harness) if agent else None
    if driver is None:
        return []                   # an unknown agent or harness is said elsewhere
    problems = []
    for flag in stage.harness_needs:
        if not getattr(driver, flag, False):
            able = ", ".join(name for name in harnesses.NAMES
                             if getattr(harnesses.HARNESSES[name], flag, False))
            problems.append(f"agent {agent.name!r} runs on {agent.harness}, which cannot give "
                            f"it {_CAPABILITY.get(flag, flag)} ({flag}) — {stage.name} needs a "
                            f"harness that can: {able}")
    return problems


# What each capability flag gives an agent, as a refusal says it.
_CAPABILITY = {"MCP": "MCP servers", "SKILLS": "skills"}


def agent_fields(opts: BaseModel) -> list[str]:
    """Every `agent:` an options model names, however deep — the stage's fix
    loop nests one under `fix:`."""
    found = []
    for name, value in opts:
        if name == "agent" and isinstance(value, str):
            found.append(value)
        elif isinstance(value, BaseModel):
            found += agent_fields(value)
    return found


def _merge_hitl(cfg: FactoryConfig, stage: StageModule, opts: BaseModel) -> None:
    """A stage's `hitl:` option decides its gate for this workflow. Three
    layers, each overriding the one below: `--hitl` on the command line, this,
    then factory.yaml's `hitl:` block. `None` here means the workflow has no
    opinion and factory.yaml decides."""
    wanted = getattr(opts, "hitl", None)
    if wanted is None:
        return
    cfg.hitl.gates[stage.name] = "on" if wanted else "off"


def _flat(error: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in error.errors())


# ── running ──────────────────────────────────────────────────────────────────

def run(workflow: Workflow, invocation: Invocation) -> int:
    """Play the workflow's stages in order against one session. Returns the
    exit code `run.finish` decided.

    `invocation.request` is what `input:` says it is: the prompt, or an issue
    or pull request number. The input is opened before the first stage and
    reported to after the last; the stages see only `ctx.prompt` and
    `ctx.previous`.

    A work item is claimed before its session is opened (`engine/claims.py`):
    with a shared cockpit, a run another station holds the item for — or a
    resume of a session a writer abandoned — is refused here, having spent
    nothing. `--force` asks for none.
    """
    agents.validate(workflow.cfg, workflow.required_agents)
    cfg = workflow.cfg
    request, adw_id = invocation.request, invocation.adw_id
    context, number = None, 0
    # A benchmark's session works its source's request from the record, and
    # asks neither the forge nor a cockpit for anything (benchmark_session.py).
    benchmark = benchmark_session.of(cfg, git_helper.main_root(), adw_id)
    if benchmark is not None and workflow.input == "pr":
        raise SystemExit(f"workflow {workflow.name!r} takes input: pr, and a benchmark works "
                         f"a session's request again — a prompt or an issue, never a round of "
                         f"review. Nothing was created.")
    if workflow.input != "prompt":
        number = inputs.number_of(request, workflow.input)      # before a session exists
    if workflow.input == "pr":
        # The pull request names its own session, and that is decided before
        # one exists: a refusal costs one forge call and leaves nothing behind.
        adw_id, context = inputs.locate_pr(cfg, number, adw_id)
    if workflow.input != "prompt" and benchmark is None:
        adw_id = adw_id or new_id(8)            # the session the claim is for
        claims.for_run(cfg, ClaimAsk(kind=workflow.input, number=number, session=adw_id,
                                     repo=_project(cfg, workflow.input)), invocation)
    run = session.ensure(cfg, SessionSpec(
        adw_id=adw_id, resume=invocation.resume, hitl=invocation.hitl, name=workflow.name,
        input=workflow.input, request=request if workflow.input == "prompt" else "",
        stages=[step.stage.name for step in workflow.steps]))

    # However the chapter ends — accepted, refused, a phase failed — it is
    # scored once it has, by every scorer bound to this workflow. A chapter
    # stopped at a gate has not ended: the process that ends it scores it.
    try:
        # Before the work item is opened and before any agent: a tree whose
        # dependencies are not installed fails its checks as if the code did.
        worktree.set_up(run)
        if workflow.input == "issue" and run.benchmark is not None:
            opened = inputs.open_recorded_issue(run)
        elif workflow.input == "issue":
            opened = inputs.open_issue(run, cfg, number)
        elif workflow.input == "pr":
            opened = inputs.open_pr(run, cfg, context)
            if opened.nothing_to_do:
                return run.finish(accepted=True)      # "already handled" is the common case
        else:
            with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                                       description="Capture the incoming ask, and which "
                                                   "workflow was asked to carry it")) as ph:
                ph.log(input=request, workflow=workflow.name,
                       stages=" -> ".join(step.stage.name for step in workflow.steps))
            opened = inputs.Opened(prompt=request)

        ctx = StageContext(run, workflow, opened.prompt)
        ctx.previous = opened.previous
        ctx.baseline = run.pin("baseline", lambda: git_helper.rev(run.repo_root, "HEAD"))
        accepted, reason = True, ""
        try:
            for index, step in enumerate(workflow.steps):
                ctx.begin(step)
                with run.stage(index):
                    output = step.stage.run(ctx, step.opts)
                ctx.end(step, output)
        except StageStop as stop:
            accepted, reason = False, str(stop)

        # The tracker hears about the run either way: a run that could not finish
        # is exactly the one whose reporter most needs to know where it stopped.
        # A benchmark's session is no news to anyone there (input is never pr).
        if workflow.input == "issue" and run.benchmark is None:
            inputs.report_issue(run, cfg, opened, accepted)
        elif workflow.input == "pr":
            build = ctx.latest.get(BuildOutput)
            inputs.report_pr(run, cfg, opened, accepted, build.summary if build else "")
        return run.finish(accepted=accepted, reason=reason)
    finally:
        # A benchmark's session is scored by the station that launched it, with
        # the station's scorers — never by the variant's (benchmarks.run).
        if run.benchmark is None:
            scorers.after_chapter(run, workflow)


def _project(cfg: FactoryConfig, kind: str) -> str:
    """The work item's repository, as the watcher that would start it names it."""
    main_root = git_helper.main_root()
    if kind == "pr":
        return pull_requests.resolve_project(cfg.pull_requests, main_root)
    return issues.resolve_project(cfg.issues, main_root)

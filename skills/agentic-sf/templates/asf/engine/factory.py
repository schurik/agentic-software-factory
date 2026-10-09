"""The roster as files and folders: `asf/factory.yaml` plus `asf/agents/<name>/`.

factory.yaml is the manifest — the harness every agent runs on, budget, gates,
what a cockpit is told, how a run's worktree is cut and landed. It holds NO
agents. An agent is a directory with one file, `agent.md`: YAML frontmatter for
what the machinery needs (purpose, writes, and a `harness:` block for whatever
it runs on differently) and, below it, the prose that says who the agent is.
Its name is the directory's name, so it cannot be misspelt in two places, and
its task is not here at all — that belongs to the stage that calls it
(`engine.tasks`).

What this module produces is the same `FactoryConfig` the rest of the engine has
always run on, so nothing downstream — session, worktree, permissions, the
trace — knows the roster changed shape.
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import ValidationError

from . import agents, frontmatter, git_helper, harnesses, integration
from .data_types import AgentConfig, FactoryConfig, HarnessDefaults
from .utils import anchor

DEFAULT_CONFIG = "asf/factory.yaml"
AGENT_FILE = "agent.md"
AGENT_RESERVED = ("name", "prompt_engineering")
# What an agent.md said at the top of its frontmatter before 1.3, and the key
# each became inside its `harness:` block.
AGENT_FLAT = {"harness": "name", "model": "model", "thinking": "thinking", "tools": "tools",
              "timeout_seconds": "timeout_seconds",
              "harness_engineering": "harness_engineering", "harness_options": "options"}


def root_of(config_path: str | Path) -> Path:
    """The `asf/` directory a config lives in — where agents, stages and
    workflows are found relative to it."""
    return Path(config_path).parent


def load(config_path: str | Path = DEFAULT_CONFIG) -> FactoryConfig:
    """factory.yaml + every agents/<name>/agent.md, each merged over the
    factory's `harness:` block."""
    path = Path(config_path)
    if not path.is_file():
        raise SystemExit(f"no config at {path} — is the factory installed here?")
    raw = yaml.safe_load(path.read_text()) or {}
    if "agents" in raw:
        raise SystemExit(f"{path}: `agents:` does not belong in factory.yaml — an agent is "
                         f"a directory under {root_of(path) / 'agents'} with an "
                         f"{AGENT_FILE} in it")
    refused = _refused(raw)
    if refused:
        raise SystemExit(f"{path}: {refused}")
    factory_harness = (raw.get("harness") or {}).get("name") or HarnessDefaults().name
    raw["agents"] = [_agent_entry(directory, factory_harness)
                     for directory in agent_dirs(root_of(path))]
    try:
        cfg = agents.merge_harness(raw)
    except ValidationError as error:
        raise SystemExit(f"{path}: {error}") from None
    problems = _roster_refused(cfg, git_helper.main_root(path.resolve().parent))
    if problems:
        raise SystemExit(f"{path}: the roster is not runnable:\n- " + "\n- ".join(problems))
    return cfg


def _refused(raw: dict) -> str:
    """What this config says that the engine no longer runs, or "".

    Read off the YAML before it is validated, so the refusal names what to say
    instead rather than listing the values a field accepts — and so `check`,
    `doctor` and every run say the same thing.
    """
    if "defaults" in raw:
        return _defaults_refused(raw["defaults"] or {})
    if not isinstance(raw.get("harness") or {}, dict):
        return (f"`harness: {raw['harness']}` is a block, not a name — write "
                f"`harness: {{name: {raw['harness']}}}` and the rest of it beneath")
    worktree = raw.get("worktree") or {}
    integration_block = worktree.get("integration") if isinstance(worktree, dict) else None
    if isinstance(integration_block, dict) and integration_block.get("mode") == "none":
        return integration.none_is_refused("worktree.integration.mode: none")
    return ""


def _roster_refused(cfg: FactoryConfig, root: Path) -> list[str]:
    """What the merged roster names that no run could honour: a removed option,
    `Skill` written as a tool, a skill or a context file that resolves nowhere
    under `root` (the main checkout), skills on a harness that cannot load them.

    factory.yaml's block first, and alone when it is wrong: every agent
    inherits it, and one mistake said once per agent buries it.
    """
    said = _block_refused(root, cfg.harness)
    if said:
        return [f"harness: {problem}" for problem in said]
    return [f"agent {agent.name!r}: {problem}" for agent in cfg.agents
            for problem in _block_refused(root, _block_of(agent))]


def _block_of(agent: AgentConfig) -> HarnessDefaults:
    """An agent's merged settings as the block they were merged from."""
    return HarnessDefaults(name=agent.harness, model=agent.model, thinking=agent.thinking,
                           timeout_seconds=agent.timeout_seconds, tools=agent.tools,
                           skills=agent.skills, context=agent.context,
                           harness_engineering=agent.harness_engineering,
                           options=agent.harness_options)


def _block_refused(root: Path, block: HarnessDefaults) -> list[str]:
    driver = harnesses.HARNESSES.get(block.name)
    problems = [f"harness.options.{key} is gone — {why}"
                for key, why in _removed(block.name).items() if key in block.options]
    problems += [p for p in [agents.skill_tool_refused(block.tools)] if p]
    if block.skills and driver is not None and not driver.SKILLS:
        problems.append(f"the {block.name} harness cannot load skills — give this agent "
                        f"`skills: []` in its harness block (factory.yaml's are inherited "
                        f"across harnesses), or run it on a harness that can")
    for name in block.skills:
        if agents.skill_dir(root, name) is None:
            looked = " or ".join(f"{home}/{name}/SKILL.md" for home in agents.SKILL_HOMES)
            problems.append(f"skill {name!r} resolves nowhere — no {looked} in {root}")
    for ref in block.context:
        path = anchor(root, ref).resolve()
        if root.resolve() not in path.parents:
            problems.append(f"context {ref} is not in the repository — name a file by its "
                            f"path from {root}")
        elif not path.is_file():
            problems.append(f"context {ref} is not a file in {root}")
    return problems


def _removed(harness: str) -> dict[str, str]:
    """The options `harness` no longer takes, each with what replaced it."""
    return getattr(harnesses.HARNESSES.get(harness), "REMOVED_OPTIONS", {})


def _defaults_refused(defaults: dict) -> str:
    """`defaults:` (before 1.3), refused with the literal block that replaces it.

    No loader reads both shapes: one that did would keep the old one alive in
    every stamp nobody re-read, and with it `setting_sources: [project]` —
    which handed an agent the repository's hooks along with its skills.
    """
    name = defaults.get("harness") or HarnessDefaults().name
    block: dict = {"name": name}
    for key in ("model", "thinking", "timeout_seconds", "tools", "harness_engineering"):
        if key in defaults:
            block[key] = defaults[key]
    by_harness = defaults.get("harness_options") or {}
    options, notes = _without_removed(name, dict(by_harness.get(name) or {}))
    block["skills"] = []
    block["context"] = _context_for(by_harness.get(name) or {})
    block["options"] = options
    for other, kept in by_harness.items():
        if other != name and kept:
            notes.append(f"`harness_options.{other}` moves into the agent.md of each agent "
                         f"that runs on {other}, as its own `harness: {{options: …}}`")
    rewrite: dict = {"harness": block}
    for key in ("protected_files", "data_dir"):
        if key in defaults:
            rewrite[key] = defaults[key]
    said = "".join(f"\n- {note}" for note in notes)
    return (f"`defaults:` is the shape before 1.3 — what an agent runs on is now one root "
            f"`harness` block, and `protected_files` and `data_dir` sit at the top level of "
            f"factory.yaml. Replace the whole `defaults` block with the YAML below "
            f"(or take the installer's factory.yaml.new).{said}\n\n"
            + yaml.safe_dump(rewrite, sort_keys=False, default_flow_style=None))


def _context_for(options: dict) -> list[str]:
    """What `setting_sources: [project]` handed an agent that `context:` now
    must: the repository's CLAUDE.md. Its skills are named one by one."""
    return ["CLAUDE.md"] if "project" in (options.get("setting_sources") or []) else []


def _without_removed(harness: str, options: dict) -> tuple[dict, list[str]]:
    """`options` minus the keys this harness no longer takes, and what became
    of each one it dropped."""
    removed = _removed(harness)
    notes = [f"`{key}` is gone — {why}" for key, why in removed.items() if key in options]
    return {key: value for key, value in options.items() if key not in removed}, notes


def _flat_refused(entry: dict, factory_harness: str) -> str:
    """The keys an agent.md still says flat, refused with the block they go
    in — or "" when it says none."""
    flat = [key for key in AGENT_FLAT
            if key in entry and not (key == "harness" and isinstance(entry[key], dict))]
    if not flat:
        return ""
    block = dict(entry["harness"]) if isinstance(entry.get("harness"), dict) else {}
    for key in flat:
        block[AGENT_FLAT[key]] = entry[key]
    notes: list[str] = []
    if "options" in block:
        old = dict(block["options"] or {})
        block["options"], notes = _without_removed(block.get("name") or factory_harness, old)
        if _context_for(old):
            block.setdefault("context", _context_for(old))
    said = "".join(f"\n- {note}" for note in notes)
    return (f"sets {', '.join(f'`{key}`' for key in flat)} at the top of its frontmatter "
            f"— since 1.3 what an agent runs on is one `harness` block, beside `purpose`, "
            f"`color` and `writes`. Write instead:{said}\n\n"
            + yaml.safe_dump({"harness": block}, sort_keys=False, default_flow_style=None))


def agent_dirs(root: Path) -> list[Path]:
    agents_dir = root / "agents"
    if not agents_dir.is_dir():
        raise SystemExit(f"no agents directory at {agents_dir} — is the factory installed?")
    found = sorted(p for p in agents_dir.iterdir() if p.is_dir())
    if not found:
        raise SystemExit(f"{agents_dir} holds no agent — every agent is a directory with "
                         f"an {AGENT_FILE} in it")
    return found


def _agent_entry(directory: Path, factory_harness: str) -> dict:
    """One agent.md → one raw roster entry.

    The frontmatter is the entry; the body is the identity. The engine hands
    `prompt_engineering.system` the same file, and `prompts.render` strips the
    frontmatter again on the way to the model — so the file is read twice, by
    two readers, and each sees only its half.
    """
    spec = directory / AGENT_FILE
    if not spec.is_file():
        raise SystemExit(f"agent {directory.name!r}: {spec} is missing")
    entry, identity = frontmatter.split(spec.read_text(), str(spec))
    if not entry:
        raise SystemExit(f"agent {directory.name!r}: {spec} has no frontmatter — it opens "
                         f"with a `---` block holding purpose, thinking, writes, …")
    reserved = [key for key in AGENT_RESERVED if key in entry]
    if reserved:
        raise SystemExit(f"agent {directory.name!r}: {spec} sets {reserved} — the name is "
                         f"the directory's and the identity is the prose below the "
                         f"frontmatter")
    flat = _flat_refused(entry, factory_harness)
    if flat:
        raise SystemExit(f"agent {directory.name!r}: {spec} {flat}")
    harness = (entry.get("harness") or {}).get("name") or factory_harness
    # A harness-specific identity wins over the neutral one, because the two
    # differ in what they may tell the agent to do (pi's planner fans out to
    # subagent tools; Claude Code has none). It is prose only: the frontmatter
    # stays in agent.md, one boundary per agent whatever runs it. The task
    # files never carry that difference — they describe the job, not the tools.
    system = directory / f"agent.{harness}.md"
    if system.is_file():
        if frontmatter.split(system.read_text(), str(system))[0]:
            raise SystemExit(f"agent {directory.name!r}: {system.name} carries frontmatter "
                             f"— the config lives in {AGENT_FILE}; a harness file is the "
                             f"identity only")
        identity = system.read_text()
    else:
        system = spec
    if not identity.strip():
        raise SystemExit(f"agent {directory.name!r}: {system} says nothing below the "
                         f"frontmatter — who is this agent?")
    entry["name"] = directory.name
    entry["prompt_engineering"] = {"system": str(system), "user": ""}
    return entry

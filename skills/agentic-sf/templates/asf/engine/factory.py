"""The roster as files and folders: `asf/factory.yaml` plus `asf/agents/<name>/`.

factory.yaml is the manifest — the harness every agent runs on, budget, gates,
what a cockpit is told, how a run's worktree is cut and landed — as an OVERLAY
on `asf/factory-defaults.yaml` beside it, which holds every key, its default and
its prose, and is the skill's: a re-stamp rewrites it, so a newer release's
default reaches a stamp that never said that key (ADR 0007). The models carry no
defaults of their own, so a key the defaults file lacks is a load error rather
than drift between two sources. It holds NO agents. An agent is a directory
with one file, `agent.md`: YAML frontmatter for what the machinery needs
(purpose, writes, and a `harness:` block for whatever it runs on differently)
and, below it, the prose that says who the agent is.
Its name is the directory's name, so it cannot be misspelt in two places, and
its task is not here at all — that belongs to the stage that calls it
(`engine.tasks`).

What this module produces is the same `FactoryConfig` the rest of the engine has
always run on, so nothing downstream — session, worktree, permissions, the
trace — knows the roster changed shape.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml
from pydantic import ValidationError

from . import agents, frontmatter, git_helper, harnesses, integration, mcp, worktree
from .data_types import AgentConfig, FactoryConfig, HarnessDefaults
from .forge.github import RETIRED
from .utils import anchor

DEFAULT_CONFIG = "asf/factory.yaml"
DEFAULTS_FILE = "factory-defaults.yaml"
# The two lists an overlay only ever ADDS to: each narrows what an agent may do,
# so one that could be replaced could be emptied — and an overlay could
# unprotect `asf/engine/`, or hand back an MCP tool the defaults withhold.
ADDED_ONLY = (("protected_files",), ("harness", "deny_tools"))
# Keys an older factory.yaml may still say, and what became of each. Refused
# like any key the defaults lack — but with the answer, not just the name.
OBSOLETE = {"observability": "`observability:` is gone since 1.2 — nothing reads it, so "
                             "delete the block"}
# The forge commands factory.yaml spelt before 1.3 (`forge.github.RETIRED`). One
# that still says its old default is DROPPED, with a warning: nothing is lost,
# and a watcher under cron must not stop because its factory was upgraded. One
# a person changed is REFUSED by name — the one case where a customisation
# would otherwise vanish without a word.
_WARNED: set[tuple[str, str]] = set()
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


def defaults_of(config_path: str | Path) -> Path:
    """The defaults file a config is an overlay on: the one beside it."""
    return root_of(config_path) / DEFAULTS_FILE


def load(config_path: str | Path = DEFAULT_CONFIG) -> FactoryConfig:
    """factory.yaml merged onto factory-defaults.yaml, + every
    agents/<name>/agent.md, each merged over the factory's `harness:` block."""
    path = Path(config_path)
    raw = settings(path)
    try:                            # first, and alone: every agent is merged over it
        harness = HarnessDefaults.model_validate(raw.get("harness") or {}).name
    except ValidationError as error:
        raise SystemExit(f"{path}: {refusal(error, defaults_of(path), 'harness')}") from None
    raw["agents"] = [_agent_entry(directory, harness) for directory in agent_dirs(root_of(path))]
    try:
        cfg = agents.merge_harness(raw)
    except ValidationError as error:
        raise SystemExit(f"{path}: {refusal(error, defaults_of(path))}") from None
    main_root = git_helper.main_root(path.resolve().parent)
    problems = _roster_refused(cfg, main_root)
    if problems:
        raise SystemExit(f"{path}: the roster is not runnable:\n- " + "\n- ".join(problems))
    problems = worktree.refused(main_root, cfg.worktree)
    if problems:
        raise SystemExit(f"{path}: a session's worktree could not be made safely:\n- "
                         + "\n- ".join(problems))
    return cfg


def settings(config_path: str | Path = DEFAULT_CONFIG) -> dict:
    """The config as the engine runs it, before it is validated: factory.yaml
    merged onto the defaults file beside it (`resolve`)."""
    path = Path(config_path)
    if not path.is_file():
        raise SystemExit(f"no config at {path} — is the factory installed here?")
    defaults = defaults_of(path)
    if not defaults.is_file():
        raise SystemExit(f"no {defaults} beside {path} — it holds every setting's default, and "
                         f"the skill's installer writes it: run `install.py` again from the "
                         f"skill (your factory.yaml is kept)")
    base, raw = _mapping(defaults), _mapping(path)
    if "agents" in raw:
        raise SystemExit(f"{path}: `agents:` does not belong in factory.yaml — an agent is "
                         f"a directory under {root_of(path) / 'agents'} with an "
                         f"{AGENT_FILE} in it")
    refused = _refused(raw, (base.get("harness") or {}).get("name") or "") or _retired(path, raw)
    if refused:
        raise SystemExit(f"{path}: {refused}")
    return resolve(base, raw)


def _retired(path: Path, raw: dict) -> str:
    """The refusal naming every retired forge command a person changed, or "";
    when there is none, each one still at its old default is dropped from
    `raw` — never merged — with a warning, once per process."""
    said = {}
    for keys, (default, axis) in RETIRED.items():
        block = raw
        for parent in keys[:-1]:
            block = block.get(parent) if isinstance(block, dict) else None
        if isinstance(block, dict) and keys[-1] in block:
            said[keys] = (block, default, axis)
    changed = [f"`{'.'.join(keys)}: {block[keys[-1]]}`"
               for keys, (block, default, _) in said.items() if block[keys[-1]] != default]
    if changed:
        return (f"{', '.join(changed)} — gone since 1.3, and changed from the default, so a "
                f"customisation would vanish here: `forge:` and `tracker:` now select an "
                f"implementation in asf/engine/forge/ that owns its own commands, and only "
                f"`github` ships. Delete the key; a forge or tracker other than GitHub is a "
                f"new module there")
    for keys, (block, _, axis) in said.items():
        del block[keys[-1]]
        name = ".".join(keys)
        if (str(path), name) not in _WARNED:
            _WARNED.add((str(path), name))
            print(f"warning: {path}: `{name}` is retired since 1.3 and still holds its old "
                  f"default, so it is dropped — `{axis}: github` runs the same commands. "
                  f"Delete it from factory.yaml", file=sys.stderr)
    return ""


def _mapping(path: Path) -> dict:
    raw = yaml.safe_load(path.read_text()) or {}
    if not isinstance(raw, dict):
        raise SystemExit(f"{path} is not a mapping of settings")
    return raw


def resolve(defaults: dict, overlay: dict) -> dict:
    """`overlay` merged onto `defaults`: a map merges key by key, a scalar or a
    list replaces, `null` deletes a map entry — a default route, say. The
    lists in `ADDED_ONLY` are added to and never replaced, and a `null` on one
    takes nothing away.

    A `harness:` on another harness than the defaults' inherits from theirs
    only what an agent.md on another harness would (`agents.NEUTRAL_KEYS`):
    tools, options and extensions are one harness's vocabulary, and the model is
    the new harness's own unless the overlay names one.
    """
    base = dict(defaults)
    block = overlay.get("harness")
    if isinstance(block, dict) and isinstance(base.get("harness"), dict):
        base["harness"] = _harness_base(base["harness"], block.get("name"))
    return _merge(base, overlay, ())


def _harness_base(block: dict, name: str | None) -> dict:
    if not name or name == block.get("name"):
        return block
    driver = harnesses.HARNESSES.get(name)
    # Not defaults: what an agent.md on another harness is given of these —
    # nothing (`agents.harness_settings`), and its `tools` left unset.
    return {**{key: block[key] for key in agents.NEUTRAL_KEYS if key in block},
            "model": driver.DEFAULT_MODEL if driver else block.get("model"),
            "harness_engineering": [], "deny_tools": [], "options": {}}


def _merge(base: dict, overlay: dict, at: tuple[str, ...]) -> dict:
    merged = dict(base)
    for key, value in overlay.items():
        path = (*at, key)
        if path in ADDED_ONLY:
            if isinstance(value, list) and isinstance(merged.get(key), list):
                merged[key] = agents.added(merged[key], value)
            elif value is not None:
                merged[key] = value                    # not a list: validation says so
        elif value is None:
            merged.pop(key, None)
        elif isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value, path)
        else:
            merged[key] = value
    return merged


def refusal(error: ValidationError, defaults: Path, block: str = "") -> str:
    """A validation error as one line per key, each named by its path — a key
    the defaults lack (a typo, most often) and one they no longer hold are
    said as what they are rather than as pydantic's words."""
    lines = []
    for problem in error.errors():
        key = ".".join(str(part) for part in [*([block] if block else []), *problem["loc"]])
        if problem["type"] == "extra_forbidden":
            lines.append(f"`{key}` is not a setting — {defaults.name} holds every key there is, "
                         f"spelt as it is there")
        elif problem["type"] == "missing":
            lines.append(f"`{key}` has no value — factory.yaml deletes it with `null`, or "
                         f"{defaults}, which holds every key's default, lost it (`install.py` "
                         f"again from the skill restores that file)")
        else:
            lines.append(f"`{key}`: {problem['msg']}")
    return "\n- ".join(["", *lines]) if len(lines) > 1 else lines[0] if lines else str(error)


def _refused(raw: dict, harness: str) -> str:
    """What this config says that the engine no longer runs, or "".

    Read off the YAML before it is validated, so the refusal names what to say
    instead rather than listing the values a field accepts — and so `check`,
    `doctor` and every run say the same thing. `harness` is the defaults'.
    """
    if "defaults" in raw:
        return _defaults_refused(raw["defaults"] or {}, harness)
    for key, why in OBSOLETE.items():
        if key in raw:
            return why
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
            for problem in _block_refused(root, block_of(agent, cfg.harness.deny_tools))]


def block_of(agent: AgentConfig, inherited: list[str] = ()) -> HarnessDefaults:
    """An agent's merged settings as the block they were merged from — less the
    denials it `inherited`, which were judged where they were written. A
    factory-wide denial of a server this agent is not given withholds nothing
    from it, and is no reason to refuse it."""
    return HarnessDefaults(name=agent.harness, model=agent.model, thinking=agent.thinking,
                           timeout_seconds=agent.timeout_seconds, tools=agent.tools,
                           skills=agent.skills, context=agent.context,
                           harness_engineering=agent.harness_engineering,
                           deny_tools=[denied for denied in agent.deny_tools
                                       if denied not in inherited],
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
    problems += mcp_refused(root, block)
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


def mcp_refused(root: Path, block: HarnessDefaults) -> list[str]:
    """What a block's MCP servers and denials say that no run could honour:
    either one on a harness without MCP, a file that is not there, a denial
    that is not an MCP tool of a server the block gives. Read by a workflow's
    binding as well, which can add denials."""
    driver = harnesses.HARNESSES.get(block.name)
    if driver is None:
        return []
    if not driver.MCP:
        if not (mcp.files(block.harness_engineering) or block.deny_tools):
            return []
        return [f"the {block.name} harness cannot give an agent "
                f"{harnesses.CAPABILITIES['MCP']} (MCP) — drop its `mcp:` files and "
                f"`deny_tools`, or run it on a harness that can "
                f"({', '.join(harnesses.able('MCP'))})"]
    return mcp.denials_refused(root, block.harness_engineering, block.deny_tools)


def _removed(harness: str) -> dict[str, str]:
    """The options `harness` no longer takes, each with what replaced it."""
    return getattr(harnesses.HARNESSES.get(harness), "REMOVED_OPTIONS", {})


def _defaults_refused(defaults: dict, harness: str) -> str:
    """`defaults:` (before 1.3), refused with the literal block that replaces it.

    No loader reads both shapes: one that did would keep the old one alive in
    every stamp nobody re-read, and with it `setting_sources: [project]` —
    which handed an agent the repository's hooks along with its skills.
    """
    name = defaults.get("harness") or harness
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

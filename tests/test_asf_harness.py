"""One `harness:` block — in factory.yaml, in an agent.md, in a binding.

What an agent runs on (model, tools, skills, the files it is handed) is said in
one block with one vocabulary wherever it is said, and merged key by key. The
factory's own settings (`protected_files`, `data_dir`) are not the harness's,
so they sit at the top of factory.yaml. These run the loader in-process against
a stamped repo, and each refusal is asserted on its message: the message is the
rewrite.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from engine import factory, frontmatter, workflow
from .conftest import TEMPLATES
from .asf_helpers import (adw_id_of, asf, commit_all, envelope, fake_roster, session_dir,
                          write_workflow)

OLD_DEFAULTS = """\
defaults:
  harness: claude_code
  model: sonnet
  thinking: medium
  timeout_seconds: 1800
  harness_engineering: []
  tools: [Read, Bash]
  harness_options:
    claude_code:
      safe_mode: false
      bare: false
      setting_sources: [project]
      strict_mcp_config: true
      permission_mode: acceptEdits
      add_dirs: []
      max_budget_usd: 0
  protected_files: [asf/engine/]
  data_dir: asf/runtime
"""


@pytest.fixture
def here(stamped: Path, monkeypatch) -> Path:
    monkeypatch.chdir(stamped)
    return stamped


def refused() -> str:
    with pytest.raises(SystemExit) as stop:
        factory.load()
    return str(stop.value)


def config(repo: Path) -> dict:
    """The stamped overlay, with a `harness.options` block to edit — merged
    onto the defaults' own key by key, like every map in it."""
    raw = yaml.safe_load((repo / "asf" / "factory.yaml").read_text()) or {}
    raw.setdefault("harness", {}).setdefault("options", {})
    return raw


def save(repo: Path, raw: dict) -> None:
    (repo / "asf" / "factory.yaml").write_text(yaml.safe_dump(raw, sort_keys=False))


def agent(repo: Path, name: str, entry: dict, identity: str = "# Agent\n\nWho.\n") -> None:
    directory = repo / "asf" / "agents" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "agent.md").write_text(f"---\n{yaml.safe_dump(entry)}---\n\n{identity}")


def loaded(name: str):
    return next(a for a in factory.load().agents if a.name == name)


def test_the_stamped_config_says_the_harness_once_and_the_factory_s_settings_beside_it(here):
    raw = yaml.safe_load((here / "asf" / "factory-defaults.yaml").read_text())
    assert "defaults" not in raw
    assert raw["harness"]["name"] == "claude_code" and raw["harness"]["skills"] == []
    assert raw["data_dir"] == "asf/data" and "asf/engine/" in raw["protected_files"]

    cfg = factory.load()
    assert cfg.harness.name == "claude_code" and cfg.harness.model == "sonnet"
    assert cfg.data_dir == "asf/data" and "asf/factory.yaml" in cfg.protected_files
    # Everything the installer stamps under asf/ is protected — the machinery,
    # the release record, the cockpit's compose file — and so is the CI check.
    stamped_entries = {f"asf/{p.name}/" if p.is_dir() else f"asf/{p.name}"
                       for p in TEMPLATES.iterdir() if p.name != "__pycache__"}
    assert stamped_entries <= set(cfg.protected_files)
    assert ".github/workflows/asf-check.yml" in cfg.protected_files
    assert cfg.protected_files == raw["protected_files"]       # an overlay that adds none
    builder = next(a for a in cfg.agents if a.name == "builder")
    assert builder.harness == "claude_code" and builder.model == "opus"
    assert builder.tools == ["Read", "Bash", "Edit", "Write", "Grep", "Glob"]


def test_a_defaults_block_is_refused_with_the_block_that_replaces_it(here):
    raw = config(here)
    for key in ("harness", "protected_files", "data_dir"):
        raw.pop(key, None)
    save(here, {**yaml.safe_load(OLD_DEFAULTS), **raw})

    message = refused()
    assert "`defaults:`" in message
    assert "`setting_sources` is gone" in message and "`bare` is gone" in message
    rewrite = yaml.safe_load(message[message.index("\nharness:"):])
    assert rewrite == {
        "harness": {"name": "claude_code", "model": "sonnet", "thinking": "medium",
                    "timeout_seconds": 1800, "tools": ["Read", "Bash"],
                    "harness_engineering": [], "skills": [], "context": ["CLAUDE.md"],
                    "options": {"permission_mode": "acceptEdits", "add_dirs": [],
                                "max_budget_usd": 0}},
        "protected_files": ["asf/engine/"],
        "data_dir": "asf/runtime",
    }


def test_an_agent_s_flat_harness_keys_are_refused_with_its_harness_block(here):
    agent(here, "old", {"purpose": "x", "writes": [], "harness": "claude_code", "model": "opus",
                        "tools": ["Read"], "harness_options": {"permission_mode": "acceptEdits",
                                                               "safe_mode": False,
                                                               "setting_sources": ["project"]}})
    message = refused()
    assert "asf/agents/old/agent.md" in message
    assert "`harness`, `model`, `tools`, `harness_options`" in message
    rewrite = yaml.safe_load(message[message.index("\nharness:"):])
    assert rewrite == {"harness": {"name": "claude_code", "model": "opus", "tools": ["Read"],
                                   "options": {"permission_mode": "acceptEdits"},
                                   "context": ["CLAUDE.md"]}}
    assert "`safe_mode` is gone" in message


def test_an_agent_s_block_replaces_lists_and_merges_options_key_by_key(here):
    raw = config(here)
    raw["harness"]["options"]["add_dirs"] = ["../shared"]
    raw["harness"]["context"] = ["README.md"]
    save(here, raw)
    agent(here, "narrow", {"purpose": "x", "harness": {
        "tools": ["Read"], "context": [], "options": {"permission_mode": "acceptEdits"}}})

    narrow = loaded("narrow")
    assert narrow.tools == ["Read"]                       # replaced, not appended to
    assert narrow.context == []                           # an empty list is a list too
    assert narrow.model == "sonnet" and narrow.thinking == "medium"   # the factory's
    assert narrow.harness_options == {"permission_mode": "acceptEdits",
                                      "add_dirs": ["../shared"], "max_budget_usd": 0}
    assert loaded("scout").context == ["README.md"]        # said nothing: inherits


def test_an_agent_on_another_harness_inherits_only_what_means_the_same_there(here):
    raw = config(here)
    raw["harness"].update({"thinking": "high", "timeout_seconds": 60, "context": ["README.md"],
                           "harness_engineering": ["mcp:servers.json"]})
    save(here, raw)
    agent(here, "elsewhere", {"purpose": "x", "harness": {"name": "pi"}})
    agent(here, "own", {"purpose": "x", "harness": {"name": "pi", "model": "openai/gpt-6",
                                                    "tools": ["read"]}})

    elsewhere = loaded("elsewhere")
    assert elsewhere.harness == "pi"
    assert (elsewhere.thinking, elsewhere.timeout_seconds, elsewhere.context) == (
        "high", 60, ["README.md"])                                      # neutral: crossed over
    assert elsewhere.model == "google/gemini-3.6-flash"                 # pi's, not `sonnet`
    assert elsewhere.tools is None                                      # not claude_code's
    assert elsewhere.harness_options == {} and elsewhere.harness_engineering == []
    own = loaded("own")
    assert own.model == "openai/gpt-6" and own.tools == ["read"]


# ── a workflow binding narrows, in the same block ───────────────────────────

def skill(repo: Path, name: str, home: str = ".claude/skills") -> None:
    directory = repo / home / name
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name}\n---\n")


def bind(repo: Path, binding: dict) -> None:
    write_workflow(repo, "bound", {"description": "x", "agents": {"builder": binding},
                                   "stages": [{"implement": {"agent": "builder"}}]})


def bound_refusal() -> str:
    with pytest.raises(SystemExit) as stop:
        workflow.load("bound")
    return str(stop.value)


def test_a_binding_s_flat_harness_keys_are_refused_with_its_harness_block(here):
    bind(here, {"from": "builder", "model": "sonnet", "tools": ["Read"], "writes": ["src/"]})
    message = bound_refusal()
    assert "agents.builder" in message and "`model`, `tools`" in message
    assert "harness: {model: sonnet, tools: [Read]}" in message


def test_a_binding_narrows_tools_skills_and_context_and_widens_none_of_them(here):
    skill(here, "tdd")
    skill(here, "debug", home=".agents/skills")
    (here / "CLAUDE.md").write_text("# House rules\n")
    (here / "README.md").write_text("# Readme\n")
    agent(here, "builder", {"purpose": "x", "harness": {
        "tools": ["Read", "Edit"], "skills": ["tdd", "debug"],
        "context": ["CLAUDE.md", "README.md"]}})

    bind(here, {"from": "builder", "harness": {"model": "haiku", "tools": ["Read"],
                                               "skills": ["tdd"], "context": ["CLAUDE.md"]}})
    builder = next(a for a in workflow.load("bound").cfg.agents if a.name == "builder")
    assert (builder.model, builder.tools, builder.skills, builder.context) == (
        "haiku", ["Read"], ["tdd"], ["CLAUDE.md"])

    skill(here, "deploy")
    bind(here, {"from": "builder", "harness": {"skills": ["tdd", "deploy"]}})
    assert "skills ['deploy'] are not in builder's" in bound_refusal()
    bind(here, {"from": "builder", "harness": {"context": ["CLAUDE.md", "pyproject.toml"]}})
    assert "context ['pyproject.toml'] are not in builder's" in bound_refusal()
    bind(here, {"from": "builder", "harness": {"tools": ["Read", "Bash"]}})
    assert "tools ['Bash'] are not in builder's" in bound_refusal()
    bind(here, {"from": "builder", "harness": {"options": {"add_dirs": ["/"]}}})
    assert "options" in bound_refusal()


# ── deny_tools: the narrowing an MCP server's tools have ────────────────────

def servers(repo: Path, name: str = "servers.json", *keys: str) -> str:
    """An `mcp:` file giving these servers, as a harness_engineering entry."""
    (repo / name).write_text(json.dumps({"mcpServers": {
        key: {"command": "npx", "args": [f"{key}-mcp"]} for key in keys or ("playwright",)}}))
    return f"mcp:{name}"


def test_a_denial_names_a_tool_of_a_server_the_agent_is_given(here):
    given = servers(here)
    agent(here, "qa2", {"purpose": "x", "harness": {
        "harness_engineering": [given], "deny_tools": ["mcp__playwright__browser_file_upload"]}})
    assert loaded("qa2").deny_tools == ["mcp__playwright__browser_file_upload"]

    agent(here, "qa2", {"purpose": "x", "harness": {"harness_engineering": [given],
                                                    "deny_tools": ["Bash"]}})
    message = refused()
    assert "agent 'qa2': deny_tools 'Bash' is not `mcp__<server>__<tool>`" in message
    assert "`tools:`" in message                       # where a built-in tool is narrowed

    agent(here, "qa2", {"purpose": "x", "harness": {"harness_engineering": [given],
                                                    "deny_tools": ["mcp__github__create_issue"]}})
    message = refused()
    assert "deny_tools 'mcp__github__create_issue' names server 'github'" in message
    assert "playwright" in message                     # the servers it IS given

    agent(here, "qa2", {"purpose": "x", "harness": {
        "harness_engineering": ["mcp:ghost.json"],
        "deny_tools": ["mcp__playwright__browser_file_upload"]}})
    assert "agent 'qa2': mcp:ghost.json is not a file" in refused()


def test_mcp_servers_and_denials_on_a_harness_without_mcp_are_refused_by_its_flag(here):
    given = servers(here)
    agent(here, "elsewhere", {"purpose": "x", "harness": {
        "name": "pi", "harness_engineering": [given],
        "deny_tools": ["mcp__playwright__browser_file_upload"]}})
    message = refused()
    assert "agent 'elsewhere': the pi harness cannot give an agent MCP servers (MCP)" in message
    assert "claude_code" in message                    # the harness that can


def test_denials_are_added_to_wherever_they_are_written_and_never_taken_back(here):
    given = servers(here, "servers.json", "playwright", "github")
    raw = config(here)
    raw["harness"].update({"harness_engineering": [given],
                           "deny_tools": ["mcp__github__delete_repository"]})
    save(here, raw)
    agent(here, "builder", {"purpose": "x", "harness": {
        "deny_tools": ["mcp__playwright__browser_run_code_unsafe"]}})
    builder = loaded("builder")
    assert builder.deny_tools == ["mcp__github__delete_repository",          # the factory's,
                                  "mcp__playwright__browser_run_code_unsafe"]   # and its own

    bind(here, {"from": "builder", "harness": {"deny_tools": []}})
    bound = next(a for a in workflow.load("bound").cfg.agents if a.name == "builder")
    assert bound.deny_tools == builder.deny_tools                            # [] removes nothing
    bind(here, {"from": "builder", "harness": {
        "deny_tools": ["mcp__playwright__browser_file_upload"]}})
    bound = next(a for a in workflow.load("bound").cfg.agents if a.name == "builder")
    assert bound.deny_tools == [*builder.deny_tools, "mcp__playwright__browser_file_upload"]
    bind(here, {"from": "builder", "harness": {"deny_tools": ["mcp__slack__post"]}})
    assert "agents.builder: deny_tools 'mcp__slack__post' names server 'slack'" in bound_refusal()


# ── what `check` refuses before anything is spent ───────────────────────────

def test_skill_in_tools_is_refused_because_skills_are_granted_in_one_place(here):
    agent(here, "skilled", {"purpose": "x", "harness": {"tools": ["Read", "Skill"]}})
    assert "agent 'skilled': tools names `Skill`" in refused()
    assert "skills: [<name>]" in refused()


def test_a_skill_resolves_from_the_repository_or_is_refused(here):
    skill(here, "tdd")
    skill(here, "debug", home=".agents/skills")
    agent(here, "skilled", {"purpose": "x", "harness": {"skills": ["tdd", "debug"]}})
    assert loaded("skilled").skills == ["tdd", "debug"]

    agent(here, "skilled", {"purpose": "x", "harness": {"skills": ["tdd", "ghost"]}})
    message = refused()
    assert "agent 'skilled': skill 'ghost'" in message
    assert ".claude/skills/ghost/SKILL.md" in message and ".agents/skills/ghost/SKILL.md" in message


def test_a_context_file_that_is_not_there_is_refused(here):
    agent(here, "told", {"purpose": "x", "harness": {"context": ["CLAUDE.md"]}})
    assert "agent 'told': context CLAUDE.md is not a file" in refused()
    (here / "CLAUDE.md").write_text("# House rules\n")
    assert loaded("told").context == ["CLAUDE.md"]
    agent(here, "told", {"purpose": "x", "harness": {"context": ["../outside.md"]}})
    (here.parent / "outside.md").write_text("not the repo's\n")
    assert "context ../outside.md is not in the repository" in refused()


def test_skills_on_a_harness_that_cannot_load_them_are_refused(here):
    skill(here, "tdd")
    agent(here, "pi_agent", {"purpose": "x", "harness": {"name": "pi", "skills": ["tdd"]}})
    assert "agent 'pi_agent': the pi harness cannot load skills" in refused()
    assert "`skills: []`" in refused()


def test_an_option_a_release_removed_is_refused_with_what_replaced_it(here):
    raw = config(here)
    raw["harness"]["options"]["safe_mode"] = False
    save(here, raw)
    message = refused()
    assert "harness.options.safe_mode" in message and "derived" in message

    raw["harness"]["options"].pop("safe_mode")
    save(here, raw)
    agent(here, "old", {"purpose": "x", "harness": {"options": {"setting_sources": ["project"]}}})
    message = refused()
    assert "agent 'old': harness.options.setting_sources" in message
    assert "context: [CLAUDE.md]" in message


# ── claude_code: flags derived, not chosen ──────────────────────────────────

STUB_CLAUDE = """#!{python}
import json, sys
open({record!r}, "w").write(json.dumps(sys.argv[1:]))
print(json.dumps({{"type": "result", "result": "done", "session_id": "s"}}))
"""


@pytest.fixture
def claude(tmp_path: Path, monkeypatch):
    """`claude_code.run` against a stub CLI that records the argv it was given."""
    import sys

    from engine.data_types import AgentRequest
    from engine.harnesses import claude_code

    record = tmp_path / "argv.json"
    stub = tmp_path / "claude"
    stub.write_text(STUB_CLAUDE.format(python=sys.executable, record=str(record)))
    stub.chmod(0o755)
    monkeypatch.setattr(claude_code, "CLAUDE_PATH", str(stub))
    runtime = tmp_path / "session"

    def turn(**fields) -> list[str]:
        request = AgentRequest(prompt="go", system_prompt="You build.", model="sonnet",
                               session_id="00000000-0000-0000-0000-000000000000",
                               session_dir=str(runtime / "sessions"),
                               raw_output_path=str(runtime / "raw.jsonl"),
                               runtime_dir=str(runtime), cwd=str(tmp_path),
                               agent="builder", **fields)
        claude_code.run(request)
        return json.loads(record.read_text())

    turn.runtime = runtime
    return turn


def flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


def test_a_plain_turn_reads_nothing_of_the_operator_s_machine(claude):
    argv = claude(tools=["Read", "Edit"])
    assert "--safe-mode" in argv and "--strict-mcp-config" in argv
    assert flag(argv, "--setting-sources") == ""
    assert "--bare" not in argv and "--plugin-dir" not in argv
    assert flag(argv, "--tools") == "Read,Edit"


def test_a_turn_with_skills_gets_exactly_those_skills_as_a_plugin(claude, tmp_path):
    homes = {}
    for name in ("tdd", "debug", "unasked"):
        homes[name] = tmp_path / "repo" / ".claude" / "skills" / name
        homes[name].mkdir(parents=True)
        (homes[name] / "SKILL.md").write_text(f"---\nname: {name}\n---\n")

    argv = claude(tools=["Read"], skills=[str(homes["tdd"]), str(homes["debug"])])
    plugin = Path(flag(argv, "--plugin-dir"))
    assert plugin == claude.runtime / "skills" / "builder"
    assert flag(argv, "--tools") == "Read,Skill"
    assert "--safe-mode" not in argv                  # it would suppress the plugin
    assert flag(argv, "--setting-sources") == "" and "--strict-mcp-config" in argv
    assert json.loads((plugin / ".claude-plugin" / "plugin.json").read_text()) == {"name": "asf"}
    assert sorted(p.name for p in (plugin / "skills").iterdir()) == ["debug", "tdd"]
    assert (plugin / "skills" / "tdd").resolve() == homes["tdd"].resolve()

    argv = claude(tools=["Read"], skills=[str(homes["debug"])])     # the next turn, narrower
    assert [p.name for p in (plugin / "skills").iterdir()] == ["debug"]


def test_harness_engineering_turns_safe_mode_off_too(claude):
    argv = claude(extensions=["mcp:servers.json"])
    assert "--safe-mode" not in argv and flag(argv, "--mcp-config") == "servers.json"
    assert "--strict-mcp-config" in argv and "--tools" not in argv


DENIED = ["mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_file_upload"]


def test_denied_mcp_tools_reach_claude_code_as_disallowed_tools(claude):
    argv = claude(tools=["Read"], extensions=["mcp:a.json", "mcp:b.json"], deny_tools=DENIED)
    assert flag(argv, "--disallowedTools") == ",".join(DENIED)
    assert "--disallowedTools" not in claude(tools=["Read"])           # nothing denied, no flag


STUB_INIT = """#!{python}
import json
print(json.dumps({{"type": "system", "subtype": "init", "tools": {tools!r}}}))
print(json.dumps({{"type": "result", "result": "done", "session_id": "s"}}))
"""


def test_a_denial_that_holds_nothing_is_said_once_the_server_has_started(tmp_path, monkeypatch):
    """Claude Code drops a denied tool from the tools its `init` lists, so a
    misspelt denial shows as the real tool still there beside it."""
    import sys

    from engine.data_types import AgentRequest
    from engine.harnesses import claude_code

    offered = ["Read", "mcp__playwright__browser_click", "mcp__playwright__browser_file_upload",
               "mcp__playwright__browser_evaluate"]
    stub = tmp_path / "claude"
    stub.write_text(STUB_INIT.format(python=sys.executable, tools=offered))
    stub.chmod(0o755)
    monkeypatch.setattr(claude_code, "CLAUDE_PATH", str(stub))
    monkeypatch.setattr(claude_code, "_WARNED", set())
    said: list[str] = []

    def turn(deny: list[str]) -> None:
        claude_code.run(AgentRequest(
            prompt="go", system_prompt="You test.", model="sonnet", session_id="s",
            session_dir=str(tmp_path / "s"), raw_output_path=str(tmp_path / "raw.jsonl"),
            cwd=str(tmp_path), agent="qa", deny_tools=deny),
            on_event=lambda event: said.append(event.get("message", ""))
            if event.get("subtype") == "asf_warning" else None)

    turn(["mcp__playwright__browser_run_code_unsafe"])               # held: it is not offered
    assert said == []
    turn(["mcp__playwright__browser_file_uploadd", "mcp__playwright__browser_evaluate"])
    turn(["mcp__playwright__browser_file_uploadd", "mcp__playwright__browser_evaluate"])
    assert len(said) == 2                                             # once each, not per turn
    typo, kept = said
    assert "mcp__playwright__browser_file_uploadd" in typo
    assert "mcp__playwright__browser_file_upload is still offered" in typo
    assert "mcp__playwright__browser_evaluate" in kept and "still offered" in kept


# A reviewer that hands one perspective to a subagent: the `Task` call, the
# subagent's own Grep under it (its messages carry the Task's id), and the Task
# returning last. The subagent's turn reports a far fuller window than the
# reviewer's own — it is a context of its own.
SUBAGENT_STREAM = [
    {"type": "assistant", "parent_tool_use_id": None, "message": {
        "usage": {"input_tokens": 1000, "output_tokens": 200},
        "content": [{"type": "tool_use", "id": "toolu_task", "name": "Task",
                     "input": {"description": "security pass", "prompt": "look"}}]}},
    {"type": "assistant", "parent_tool_use_id": "toolu_task", "message": {
        "usage": {"input_tokens": 50000, "output_tokens": 10},
        "content": [{"type": "tool_use", "id": "toolu_grep", "name": "Grep",
                     "input": {"pattern": "eval"}}]}},
    {"type": "user", "parent_tool_use_id": "toolu_task", "message": {
        "content": [{"type": "tool_result", "tool_use_id": "toolu_grep", "content": "none"}]}},
    {"type": "user", "parent_tool_use_id": None, "message": {
        "content": [{"type": "tool_result", "tool_use_id": "toolu_task", "content": "clean"}]}},
    {"type": "result", "result": "done", "session_id": "s"},
]

STUB_STREAM = """#!{python}
import json
for event in {stream!r}:
    print(json.dumps(event))
"""


def test_a_subagent_s_calls_name_the_call_they_ran_under_and_not_the_agent_s_window(
        tmp_path, monkeypatch):
    import sys

    from engine.data_types import AgentRequest
    from engine.harnesses import claude_code

    stub = tmp_path / "claude"
    stub.write_text(STUB_STREAM.format(python=sys.executable, stream=SUBAGENT_STREAM))
    stub.chmod(0o755)
    monkeypatch.setattr(claude_code, "CLAUDE_PATH", str(stub))
    tracker, records = claude_code.ToolCallTracker(), []

    result = claude_code.run(
        AgentRequest(prompt="go", system_prompt="You review.", model="sonnet", session_id="s",
                     session_dir=str(tmp_path / "s"), raw_output_path=str(tmp_path / "raw.jsonl"),
                     cwd=str(tmp_path), agent="reviewer"),
        on_event=lambda event: records.extend(tracker.observe(event)))

    assert [(r["tool"], r["tool_call_id"], r["parent_call_id"]) for r in records] == [
        ("Grep", "toolu_grep", "toolu_task"),        # the subagent's, returned first
        ("Task", "toolu_task", ""),                  # the reviewer's own
    ]
    assert result.context_tokens == 1200             # the reviewer's turn, not the subagent's


# Each takes several values, and swallows a prompt placed right after it as one more.
MULTI_VALUE = {"--tools", "--disallowedTools", "--mcp-config", "--add-dir", "--plugin-dir"}


@pytest.mark.parametrize("resume", [False, True])
def test_no_flag_that_takes_several_values_sits_before_the_prompt(claude, tmp_path, resume):
    home = tmp_path / "repo" / ".claude" / "skills" / "tdd"
    home.mkdir(parents=True)
    (home / "SKILL.md").write_text("---\nname: tdd\n---\n")
    argv = claude(tools=["Read"], skills=[str(home)], extensions=["mcp:a.json"],
                  deny_tools=DENIED, options={"add_dirs": ["/elsewhere"]}, resume=resume)
    assert argv[-1] == "go"
    flags = [arg for arg in argv[:-1] if arg.startswith("--")]
    assert flags[-1] not in MULTI_VALUE and argv[-3] == flags[-1]      # one value, then the prompt


# ── context: repository files, after the identity ────────────────────────────

def test_context_reaches_the_agent_after_its_identity_and_never_instead_of_it(stamped: Path):
    fake_roster(stamped, builder=[{"writes": {"app.py": "ok = 1\n"}, "envelope": envelope(
        changed_files=["app.py"], commit_message="feat: app")}])
    (stamped / "CLAUDE.md").write_text("HOUSE-RULE-3: tabs, never spaces.\n")
    skill(stamped, "tdd")
    spec = stamped / "asf" / "agents" / "builder" / "agent.md"
    entry, identity = frontmatter.split(spec.read_text())
    entry["harness"].update({"context": ["CLAUDE.md"], "skills": ["tdd"]})
    spec.write_text(f"---\n{yaml.safe_dump(entry)}---\n\n{identity}")
    write_workflow(stamped, "told", {
        "description": "the builder, told the house rules",
        "agents": {"builder": {"from": "builder", "system_append": ["agents/builder.md"]}},
        "stages": [{"implement": {"agent": "builder"}}, {"commit": {"of": "implement"}}],
    }, appends={"builder.md": "IDENTITY-MARKER-9: never touch the Makefile.\n"})
    commit_all(stamped)

    result = asf(stamped, "run", "told", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    system = (session_dir(stamped, adw_id_of(result)) / "builder" / "prompts"
              / "system.md").read_text()
    assert system.startswith("# Builder")
    identity_at, append_at = system.index("# Builder"), system.index("IDENTITY-MARKER-9")
    heading_at = system.index("# Context: CLAUDE.md")
    assert identity_at < append_at < heading_at < system.index("HOUSE-RULE-3")

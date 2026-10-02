"""The events a cockpit's session view is built from (#47), read off one real session.

`test_asf_events.py` guards the wire itself — the corpus, the writer, the
projection. This file is about what a session SAYS on that wire beyond its
phases: the chapters it reads in, the artifacts its phases wrote, the commits
that landed them, the tools its agents called, and what a resume replayed.

One session, told by three processes and read here facet by facet:

  1. `asf run told 42` — an issue workflow. The scout files findings too long
     to ship whole, the planner writes its plan twice (the handoff copy and the
     repo's), the plan is committed, and the builder claims a file it never
     wrote: the chapter fails.
  2. `asf resume` — the same chapter, picked up. The recorded phases replay,
     the build runs live, and its commit lands.
  3. `asf run again … --adw-id` — a second workflow on the same session, which
     is a second chapter.

Transcripts are a separate, smaller session at the bottom: they exist only
where a factory asked for them.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from engine import events
from engine.data_types import EventLine

from . import projection
from .asf_helpers import (adw_id_of, asf, commit_all, envelope, fake_roster, forge, forge_data,
                          git, issue_json, new_repo, session_dir, set_config, stamp,
                          write_workflow)

TOLD_ID = "7e11ed00"           # pinned, so scripted agents can name the handoff dir


def handoff(repo: Path, name: str) -> str:
    return str(session_dir(repo, TOLD_ID) / "context_handoff" / name)


PLAN = "# Plan\n\n1. add app.py with `ok = 1`\n"
# One byte, then two-byte characters: the 256 KB cap falls in the middle of one.
FINDINGS = "x" + "é" * 150_000
DUMP = "\x00" * 4_000 + "not text"           # what an agent may well leave in its handoff dir
SECRET_ARGUMENT = "cat /etc/vault/unseal-key"
SECRET_RESULT = "s3cr3t-unseal-key-material"


def build_reply(content: str, message: str) -> dict:
    return {"writes": {"app.py": content},
            "envelope": envelope(changed_files=["app.py"], commit_message=message)}


def tell(repo: Path) -> None:
    base = forge(repo)
    set_config(repo, issues={
        "enabled": True, "project": "acme/widgets",
        "fetch_command": [*base, "view"], "comments_command": [*base, "view"],
        "body_command": [*base, "edit"], "state_command": [*base, "edit"],
        "comment_command": [*base, "comment"], "list_command": [*base, "list"]})
    forge_data(repo, "issue.json", issue_json())
    fake_roster(
        repo,
        scout=[{"writes": {handoff(repo, "scout_findings.md"): FINDINGS,
                           handoff(repo, "core.dump"): DUMP},
                "tool_calls": [
                    {"tool": "bash", "args": {"command": SECRET_ARGUMENT},
                     "result": SECRET_RESULT},
                    {"tool": "read", "args": {"path": "app.py"}, "ok": False,
                     "result": "no such file"}],
                "envelope": envelope(findings=[{"file": "app.py", "note": "missing"}],
                                     artifacts=[handoff(repo, "scout_findings.md"),
                                                handoff(repo, "core.dump")])}],
        planner=[{"writes": {handoff(repo, "plan.md"): PLAN, "docs/asf/spec/plan.md": PLAN},
                  "envelope": envelope(artifacts=[handoff(repo, "plan.md"),
                                                  "docs/asf/spec/plan.md"],
                                       commit_message="docs: plan")}],
        # Claims a file it never writes: the gate refuses it twice and the phase fails.
        builder=[{"envelope": envelope(changed_files=["app.py"], commit_message="feat: app")}])
    write_workflow(repo, "told", {
        "description": "a work item, scouted, planned, built and committed",
        "input": "issue",
        "stages": [{"scout": {}}, {"plan": {}}, {"commit": {"of": "plan"}},
                   {"implement": {}}, {"commit": {"of": "implement"}}]})
    write_workflow(repo, "again", {
        "description": "one more change on a session that already has work on it",
        "stages": [{"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(repo)

    failed = asf(repo, "run", "told", "42", "--adw-id", TOLD_ID)
    assert failed.returncode == 1, failed.stdout + failed.stderr

    fake_roster(repo, builder=[build_reply("ok = 1\n", "feat: app")])
    resumed = asf(repo, "resume", TOLD_ID)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr

    fake_roster(repo, builder=[{
        "writes": {"app.py": "ok = 2\n", "naïve.py": "ok = 2\n"},
        "envelope": envelope(changed_files=["app.py", "naïve.py"],
                             commit_message="feat: ok is 2")}])
    joined = asf(repo, "run", "again", "make ok 2", "--adw-id", TOLD_ID)
    assert joined.returncode == 0, joined.stdout + joined.stderr


@pytest.fixture(scope="module")
def told(tmp_path_factory) -> Path:
    """The stamped repo the session above ran in. Told once; every test reads it."""
    repo = stamp(new_repo(tmp_path_factory.mktemp("told") / "repo"))
    tell(repo)
    return repo


def lines_of(repo: Path, *kinds: str) -> list[EventLine]:
    return [line for line in events.read(session_dir(repo, TOLD_ID))
            if not kinds or line.kind in kinds]


def processes(lines: list[EventLine]) -> list[list[EventLine]]:
    """The session's events, split at each `session_started`."""
    split: list[list[EventLine]] = []
    for line in lines:
        if line.kind == "session_started":
            split.append([])
        split[-1].append(line)
    return split


# ── the wire still holds ─────────────────────────────────────────────────────

def test_every_line_is_a_typed_event_and_the_session_s_files_still_rebuild_from_them(told: Path):
    session = session_dir(told, TOLD_ID)
    lines = events.read(session)

    assert len(lines) == len(events.path(session).read_text().splitlines())
    assert [line.seq for line in lines] == list(range(1, len(lines) + 1))
    assert all(events.payload(line) is not None for line in lines)

    rebuilt, written = projection.replay(session), projection.on_disk(session)
    assert written.run["status"] == "success" and written.run["workflows"] == ["told", "again"]
    assert rebuilt.run == written.run
    assert rebuilt.envelopes == written.envelopes
    assert rebuilt.agent_envelopes == written.agent_envelopes
    assert rebuilt.journal == written.journal


# ── chapters ─────────────────────────────────────────────────────────────────

def test_a_session_reads_in_chapters_one_per_workflow_it_passes_through(told: Path):
    lines = lines_of(told)
    story = [(line.kind, line.payload["workflow"], line.payload["chapter"])
             for line in lines
             if line.kind in ("workflow_started", "session_resumed", "workflow_finished")]

    assert story == [
        ("workflow_started", "told", 1), ("workflow_finished", "told", 1),    # the build failed
        ("session_resumed", "told", 1), ("workflow_finished", "told", 1),     # ...and was resumed
        ("workflow_started", "again", 2), ("workflow_finished", "again", 2)]
    opened = lines_of(told, "workflow_started")
    assert [line.payload["input"] for line in opened] == ["issue", "prompt"]
    closed = lines_of(told, "workflow_finished")
    assert [line.payload["status"] for line in closed] == ["fail", "success", "success"]
    assert closed[0].payload["reason"].startswith("implement failed: builder failed gates")

    # Every process says which chapter it works on before it opens a phase, and
    # the chapter closes right before the session says how it ended.
    for process in processes(lines):
        kinds = [line.kind for line in process]
        assert kinds[1] in ("workflow_started", "session_resumed")
        assert kinds[-2:] == ["workflow_finished", "session_finished"]


def test_a_resume_continues_its_own_workflow_s_chapter_and_opens_one_when_it_has_none(
        stamped: Path):
    fake_roster(stamped, builder=[
        {"envelope": envelope(changed_files=["app.py"], commit_message="feat: app")}])
    for name in ("first", "second", "third"):
        write_workflow(stamped, name, {
            "description": f"build and commit, as the {name} workflow on the session",
            "stages": [{"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    # `first` fails, `second` joins the session and lands the file, and then
    # `first` is resumed although it is no longer the session's latest chapter.
    failed = asf(stamped, "run", "first", "add app.py")
    assert failed.returncode == 1, failed.stdout + failed.stderr
    adw_id = adw_id_of(failed)
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    for argv in (["second", "add app.py"], ["first", "add app.py", "--resume"],
                 ["third", "add app.py", "--resume"]):    # ...and one it never ran
        result = asf(stamped, "run", *argv, "--adw-id", adw_id)
        assert result.returncode == 0, result.stdout + result.stderr

    story = [(line.kind, line.payload["workflow"], line.payload["chapter"])
             for line in events.read(session_dir(stamped, adw_id))
             if line.kind in ("workflow_started", "session_resumed", "workflow_finished")]
    assert story == [
        ("workflow_started", "first", 1), ("workflow_finished", "first", 1),
        ("workflow_started", "second", 2), ("workflow_finished", "second", 2),
        ("session_resumed", "first", 1), ("workflow_finished", "first", 1),
        ("workflow_started", "third", 3), ("session_resumed", "third", 3),
        ("workflow_finished", "third", 3)]


# ── a resume ─────────────────────────────────────────────────────────────────

def test_a_resume_names_the_phases_it_answered_from_the_record(told: Path):
    first, resumed, _ = processes(lines_of(told))
    opened_first = {line.payload["name"]: line.payload["phase_id"]
                    for line in first if line.kind == "phase_started"}

    replayed = [line.payload for line in resumed if line.kind == "phase_replayed"]

    # The scout and the planner were on record; the build had failed, so it ran live.
    assert [(each["name"], each["agent"]) for each in replayed] == [
        ("scout", "scout"), ("plan", "planner")]
    # Each is the phase the session already has, not a second one beside it.
    assert [each["phase_id"] for each in replayed] == [
        opened_first["scout"], opened_first["plan"]]
    # ...and nowhere else: neither the first walk nor the second workflow replayed anything.
    assert len(lines_of(told, "phase_replayed")) == 2


def test_a_replay_its_gates_refuse_is_announced_again_as_the_live_call_it_became(
        stamped: Path):
    fake_roster(stamped,
                planner=[{"writes": {"docs/asf/spec/plan.md": PLAN},
                          "envelope": envelope(artifacts=["docs/asf/spec/plan.md"])}],
                builder=[{"envelope": envelope(changed_files=["app.py"],
                                               commit_message="feat: app")}])
    write_workflow(stamped, "recoverable", {
        "description": "a plan, then a build that fails the first time",
        "stages": [{"plan": {}}, {"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)
    failed = asf(stamped, "run", "recoverable", "add app.py")
    assert failed.returncode == 1, failed.stdout + failed.stderr
    adw_id = adw_id_of(failed)

    # The recorded plan claims a file the tree no longer has: its replay cannot hold.
    (stamped / ".asf-worktrees" / adw_id / "docs" / "asf" / "spec" / "plan.md").unlink()
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    resumed = asf(stamped, "resume", adw_id)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr

    _, second = processes(events.read(session_dir(stamped, adw_id)))
    walk = [(line.kind, line.payload.get("prompt_digest", line.payload.get("passed")))
            for line in second if line.kind in ("phase_started", "gate_result")
            and line.payload["phase_id"].endswith("_plan")]
    sent = hashlib.sha256("\0".join(
        (session_dir(stamped, adw_id) / "planner" / "prompts" / name).read_text()
        for name in ("system.md", "user.md")).encode()).hexdigest()
    # Announced for the replay, which sends no prompt; refused by the gate that
    # looks for the file; announced again for the call that replaced it.
    assert walk == [
        ("phase_started", ""), ("gate_result", False), ("gate_result", True),
        ("phase_started", sent), ("gate_result", True), ("gate_result", True)]
    # The build had never passed either, so nothing at all was answered from the record.
    assert [line for line in second if line.kind == "phase_replayed"] == []
    # The plan was written again, with the same bytes — so it is not shipped again.
    assert len([line for line in events.read(session_dir(stamped, adw_id))
                if line.kind == "artifact_written"]) == 1


# ── tool calls ───────────────────────────────────────────────────────────────

def test_a_tool_call_travels_as_its_name_outcome_and_duration_and_nothing_else(told: Path):
    scout = next(line.payload["phase_id"] for line in lines_of(told, "phase_started")
                 if line.payload["name"] == "scout")

    called = [line.payload for line in lines_of(told, "tool_called")]

    assert [(each["tool"], each["ok"]) for each in called] == [("bash", True), ("read", False)]
    for each in called:
        assert set(each) == {"phase_id", "agent", "tool", "ok", "duration_ms"}
        assert each["phase_id"] == scout and each["agent"] == "scout"
        assert isinstance(each["duration_ms"], int) and each["duration_ms"] >= 0
    # What a tool was asked and what it answered never leave the station.
    log = events.path(session_dir(told, TOLD_ID)).read_text()
    assert SECRET_ARGUMENT not in log and SECRET_RESULT not in log


# ── artifacts ────────────────────────────────────────────────────────────────

def artifact(repo: Path, path: str) -> list[dict]:
    return [line.payload for line in lines_of(repo, "artifact_written")
            if line.payload["path"] == path]


def test_the_request_a_workflow_answers_is_shipped_inline_and_only_once(told: Path):
    body = Path(handoff(told, "issue.md")).read_text()
    asked_in = next(line.payload["phase_id"] for line in lines_of(told, "phase_started")
                    if line.payload["name"] == "issue")

    # Read from the tracker by the first process and again by the resume — the
    # same bytes, so shipped once.
    [request] = artifact(told, "context_handoff/issue.md")

    assert request["role"] == "request" and request["location"] == "handoff"
    assert request["phase_id"] == asked_in
    assert "The /health endpoint returns 500." in body and request["content"] == body
    assert request["size"] == len(body.encode()) and request["truncated"] is False


CAP = 256 * 1024               # bytes of a handoff file a cockpit is sent (#40)


def test_a_handoff_file_longer_than_the_cap_is_cut_on_a_character_and_says_so(told: Path):
    written_by = next(line.payload["phase_id"] for line in lines_of(told, "phase_started")
                      if line.payload["name"] == "scout")

    # Declared by the scout, and replayed by the resume — shipped once.
    [findings] = artifact(told, "context_handoff/scout_findings.md")

    assert findings["role"] == "output" and findings["location"] == "handoff"
    assert findings["phase_id"] == written_by
    # The cap falls inside a two-byte character; the cut backs off to before it.
    assert findings["content"] == "x" + "é" * 131_071
    assert len(findings["content"].encode()) == CAP - 1
    assert findings["truncated"] is True
    assert findings["size"] == 300_001                      # the file, not what was sent of it
    assert findings["digest"] == hashlib.sha256(FINDINGS.encode()).hexdigest()


def test_a_handoff_file_that_is_not_text_is_named_and_measured_but_not_shipped(told: Path):
    [dump] = artifact(told, "context_handoff/core.dump")

    assert (dump["size"], dump["digest"]) == (4_008, hashlib.sha256(DUMP.encode()).hexdigest())
    assert dump["content"] == "" and dump["truncated"] is True


def test_a_repo_artifact_is_a_reference_and_its_handoff_twin_is_not_shipped_again(told: Path):
    planned_in = next(line.payload["phase_id"] for line in lines_of(told, "phase_started")
                      if line.payload["name"] == "plan")

    [plan] = artifact(told, "docs/asf/spec/plan.md")

    # No content: a cockpit reads a repo file from the forge, at the commit that landed it.
    assert plan == {"phase_id": planned_in, "role": "output", "location": "repo",
                    "path": "docs/asf/spec/plan.md", "size": len(PLAN.encode()),
                    "digest": hashlib.sha256(PLAN.encode()).hexdigest(),
                    "content": "", "truncated": False}
    # The planner's handoff copy holds the same bytes, so the repo file is all that is said.
    assert Path(handoff(told, "plan.md")).read_text() == PLAN
    assert artifact(told, "context_handoff/plan.md") == []
    assert [line.payload["path"] for line in lines_of(told, "artifact_written")] == [
        "context_handoff/issue.md", "context_handoff/scout_findings.md",
        "context_handoff/core.dump", "docs/asf/spec/plan.md"]


# ── commits ──────────────────────────────────────────────────────────────────

def test_every_commit_a_session_makes_names_its_sha_and_the_files_it_landed(told: Path):
    on_the_branch = [tuple(entry.split(" ", 1)) for entry in git(
        told, "log", "--reverse", "--format=%H %s", f"main..asf/{TOLD_ID}").splitlines()]
    assert [subject for _, subject in on_the_branch] == [
        "docs: plan", "feat: app", "feat: ok is 2"]
    phases = {line.payload["phase_id"]: line.payload["name"]
              for line in lines_of(told, "phase_started")}

    committed = [line.payload for line in lines_of(told, "committed")]

    # One per commit — the resume walked `commit_plan` again and landed nothing.
    assert [(each["sha"], each["message"]) for each in committed] == on_the_branch
    # Paths as they are on disk — not as git quotes one it finds unusual.
    assert [each["files"] for each in committed] == [
        ["docs/asf/spec/plan.md"], ["app.py"], ["app.py", "naïve.py"]]
    assert [each["files_total"] for each in committed] == [1, 1, 2]
    assert [phases[each["phase_id"]] for each in committed] == [
        "commit_plan", "commit_implement", "commit_implement"]


def test_a_commit_of_more_files_than_one_event_names_says_how_many_there_were(stamped: Path):
    many = {f"gen/{index:03d}.txt": f"{index}\n" for index in range(501)}
    fake_roster(stamped, builder=[{
        "writes": many,
        "envelope": envelope(changed_files=["gen/000.txt"], commit_message="feat: gen")}])
    write_workflow(stamped, "bulk", {
        "description": "one commit of very many files",
        "stages": [{"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "bulk", "generate")
    assert result.returncode == 0, result.stdout + result.stderr

    [committed] = [line.payload for line in events.read(session_dir(stamped, adw_id_of(result)))
                   if line.kind == "committed"]
    assert committed["files"] == sorted(many)[:500] and committed["files_total"] == 501


# ── what a phase was given ───────────────────────────────────────────────────

def sent_to(repo: Path, agent: str) -> str:
    """The digest of the prompt files the factory saved for `agent`'s latest call."""
    prompts = session_dir(repo, TOLD_ID) / agent / "prompts"
    sent = f"{(prompts / 'system.md').read_text()}\0{(prompts / 'user.md').read_text()}"
    return hashlib.sha256(sent.encode()).hexdigest()


def test_an_agent_phase_names_its_task_file_and_the_digest_of_the_prompt_it_was_sent(told: Path):
    first, resumed, again = (
        {line.payload["name"]: line.payload for line in process if line.kind == "phase_started"}
        for process in processes(lines_of(told)))

    assert {name: first[name]["task"] for name in ("scout", "plan", "implement")} == {
        "scout": "asf/stages/scout/task.md", "plan": "asf/stages/plan/task.md",
        "implement": "asf/stages/implement/task.md"}
    # The scout and the planner were each called once, by the first process; the
    # builder's latest call is the second workflow's.
    assert first["scout"]["prompt_digest"] == sent_to(told, "scout")
    assert first["plan"]["prompt_digest"] == sent_to(told, "planner")
    assert again["implement"]["prompt_digest"] == sent_to(told, "builder")
    # A replayed phase still names its task, and was sent nothing.
    assert resumed["plan"]["task"] == "asf/stages/plan/task.md"
    assert resumed["plan"]["prompt_digest"] == ""
    # A code phase has neither.
    assert (first["commit_plan"]["task"], first["commit_plan"]["prompt_digest"]) == ("", "")


def test_a_phase_is_announced_before_anything_else_is_said_about_it(told: Path):
    for process in processes(lines_of(told)):
        seen: set[str] = set()
        for line in process:
            phase_id = line.payload.get("phase_id")
            if line.kind == "phase_started":
                seen.add(phase_id)
            elif phase_id:
                assert phase_id in seen, f"{line.kind} (seq {line.seq}) before its phase_started"


# ── transcripts: only where a factory asked for them ─────────────────────────

TRANSCRIPT_KINDS = ("prompt_rendered", "harness_output")


def test_a_factory_that_did_not_opt_in_writes_no_transcript_event(told: Path):
    assert lines_of(told, *TRANSCRIPT_KINDS) == []


def test_a_factory_that_opts_in_ships_the_prompts_sent_and_the_harness_output_in_chunks(
        stamped: Path):
    set_config(stamped, cockpit={"transcripts": True})
    long_answer = "line of tool output\n" * 8_000                   # 160 KB: several chunks
    fake_roster(stamped, builder=[
        {"text": "let me think about this first"},                  # not JSON: re-prompted
        {**build_reply("ok = 1\n", "feat: app"),
         "tool_calls": [{"tool": "bash", "args": {"command": "make"}, "result": long_answer}]}])
    write_workflow(stamped, "spoken", {
        "description": "build and commit, with the transcript on the record",
        "stages": [{"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "spoken", "add app.py")
    assert result.returncode == 0, result.stdout + result.stderr
    session = session_dir(stamped, adw_id_of(result))
    lines = events.read(session)
    assert all(events.payload(line) is not None for line in lines)
    built = next(line.payload for line in lines
                 if line.kind == "phase_started" and line.payload["name"] == "implement")

    # Every prompt the agent was sent, in order: the task, then the correction.
    first, correction = (line.payload for line in lines if line.kind == "prompt_rendered")
    system = (session / "builder" / "prompts" / "system.md").read_text()
    user = (session / "builder" / "prompts" / "user.md").read_text()
    assert (first["phase_id"], first["agent"], first["send"]) == (
        built["phase_id"], "builder", 1)
    assert "add app.py" in user and (first["system"], first["prompt"]) == (system, user)
    assert first["digest"] == built["prompt_digest"]
    assert first["digest"] == hashlib.sha256(f"{system}\0{user}".encode()).hexdigest()
    # The same agent session, continued: the text sent, and no second copy of the identity.
    assert correction["send"] == 2 and correction["system"] == ""
    assert correction["prompt"].startswith("Your response was not valid JSON")
    assert first["truncated"] is False and correction["truncated"] is False

    # The harness's own stream, cut into chunks that put back together are the file.
    output = [line.payload for line in lines if line.kind == "harness_output"]
    raw = (session / "builder" / "raw_output.jsonl").read_text()
    assert [each["chunk"] for each in output] == list(range(1, len(output) + 1))
    assert "".join(each["text"] for each in output) == raw and len(raw) > len(long_answer)
    assert len(output) >= 3 and all(len(each["text"]) <= 64_000 for each in output)
    assert {(each["phase_id"], each["agent"]) for each in output} == {
        (built["phase_id"], "builder")}


# ── how long a cockpit keeps them: the deployment's maximum, or less ─────────

def test_a_session_carries_the_transcript_retention_its_factory_set(stamped: Path):
    set_config(stamped, cockpit={"transcripts": True, "transcript_retention_days": 7})
    fake_roster(stamped, builder=[build_reply("ok = 1\n", "feat: app")])
    write_workflow(stamped, "kept", {
        "description": "build and commit, with a transcript kept a week",
        "stages": [{"implement": {}}, {"commit": {"of": "implement"}}]})
    commit_all(stamped)

    result = asf(stamped, "run", "kept", "add app.py")

    assert result.returncode == 0, result.stdout + result.stderr
    started = [line for line in events.read(session_dir(stamped, adw_id_of(result)))
               if line.kind == "session_started"]
    assert [line.payload["transcript_retention_days"] for line in started] == [7]


def test_a_session_whose_factory_sets_no_retention_leaves_it_to_the_cockpit(told: Path):
    started = lines_of(told, "session_started")
    assert started and {line.payload["transcript_retention_days"] for line in started} == {0}


@pytest.mark.parametrize("days", [0, -3, "a month", 1.5])
def test_check_refuses_a_transcript_retention_that_is_not_a_whole_number_of_days(
        stamped: Path, days):
    set_config(stamped, cockpit={"transcripts": True, "transcript_retention_days": days})

    checked = asf(stamped, "check")

    assert checked.returncode != 0
    assert "transcript_retention_days" in checked.stdout + checked.stderr

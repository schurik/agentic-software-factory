#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""asf — the one entry point. A workflow is a directory; this runs it.

Usage:
    uv run asf/asf.py list                       every workflow, one line each
    uv run asf/asf.py check [<workflow>]         load and validate, spawn nothing
    uv run asf/asf.py check --json [--ship]      the factory's self-description, as JSON;
                                                 --ship sends it to the cockpit as a CI station
    uv run asf/asf.py doctor                     is this repo ready to run? checks + fixes
    uv run asf/asf.py labels [--create]          the forge labels this config names
    uv run asf/asf.py onboard [--json] [--mark step[=value]] [--forget step]
                                                 where onboarding stands, and its next step
    uv run asf/asf.py run <workflow> "<prompt or path/to/prompt.md>"
                        [--adw-id a1b2c3d4] [--resume] [--hitl all|none|every|plan]
    uv run asf/asf.py run <workflow> <number> [--force]
                                                 for a workflow with input: issue | pr;
                                                 --force starts it without a claim

    uv run asf/asf.py sessions [--limit 10]      the newest sessions, from their own records
    uv run asf/asf.py pending                    runs stopped at a gate, waiting for you
    uv run asf/asf.py show <adw_id>              what a waiting run wants you to read
    uv run asf/asf.py approve <adw_id> [-m "remarks"]
    uv run asf/asf.py reject  <adw_id>  -m "what to change"
    uv run asf/asf.py abort   <adw_id> [-m "why"]
    uv run asf/asf.py resume  <adw_id> [--dry-run]   pick a failed run back up
    uv run asf/asf.py kill    <adw_id> [--force]     stop a run: agents first, then the workflow

    uv run asf/asf.py issues  once|loop|status [--interval 120]   a run per labelled issue
    uv run asf/asf.py answers once|loop|status [--interval 120]   resume what was answered
    uv run asf/asf.py prs     once|loop|status [--interval 120] [--pr 17]   answer review threads
    uv run asf/asf.py up      [--only cockpit,issues,answers,prs] [--interval 120]
                                                 the station loop, the local cockpit, every watcher
    uv run asf/asf.py status                     what is watching, running, waiting, left behind
    uv run asf/asf.py worktrees list|prune|remove <adw_id> [--force]
    uv run asf/asf.py station                    the station loop alone: ships, starts no watcher
    uv run asf/asf.py station sync               ship every session a cockpit has not acknowledged
    uv run asf/asf.py station register           connect this checkout to a shared cockpit

`--config asf/factory.yaml` is accepted before or after the subcommand. Run
from the repository root — every path in factory.yaml is relative to it.
`check` is what `run` does before it opens a session, so a workflow that
`check` accepts is one `run` will start; a repository can put it in CI.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import (commands, describe, factory, git_helper, onboarding, operate,  # noqa: E402
                    station, supervise, utils, watch, workflow)
from engine.data_types import Invocation  # noqa: E402

DEFAULT_CONFIG = factory.DEFAULT_CONFIG


def cmd_list(args) -> int:
    rows = workflow.available(args.config)
    if not rows:
        print(f"no workflows under {workflow.workflows_dir(args.config)}")
        return 1
    width = max(len(name) for name, _ in rows)
    for name, description in rows:
        print(f"  {name.ljust(width)}   {description}")
    return 0


def cmd_check(args) -> int:
    if getattr(args, "json", False):
        return cmd_describe(args)
    if getattr(args, "ship", False):
        raise SystemExit("--ship sends the self-description: it goes with --json")
    try:
        factory.load(args.config)     # a refused config is said once, not once per workflow
    except SystemExit as error:
        print(f"✗ {args.config}\n  {error}")
        return 1
    names = [args.workflow] if args.workflow else [n for n, _ in workflow.available(args.config)]
    if not names:
        print(f"no workflows under {workflow.workflows_dir(args.config)}")
        return 1
    failed = False
    for name in names:
        try:
            loaded = workflow.load(name, args.config)
        except SystemExit as error:
            print(f"✗ {name}\n  {error}")
            failed = True
            continue
        chain = " -> ".join(step.stage.name for step in loaded.steps)
        print(f"✓ {name}: {chain}   agents: {', '.join(loaded.required_agents)}")
        for warning in loaded.warnings:
            print(f"  ~ {warning}")
    return 1 if failed else 0


def cmd_describe(args) -> int:
    """`check --json`: every workflow, described — the JSON on stdout and nothing
    else, so a CI job can keep it. Exits as `check` does."""
    if args.workflow:
        raise SystemExit("check --json describes the whole factory: name no workflow")
    description = describe.build(args.config)
    sys.stdout.write(describe.dumps(description))
    sys.stdout.flush()
    code = 0 if description.ok else 1
    if args.ship:
        code = max(code, describe.ship(description, factory.load(args.config)))
    return code


def cmd_doctor(args) -> int:
    code = operate.doctor(factory.load(args.config))
    print()
    args.workflow = None
    return max(code, cmd_check(args))


def cmd_onboard(args) -> int:
    cfg = factory.load(args.config)
    root = git_helper.main_root()
    for spoken in args.mark:
        onboarding.mark(cfg, root, spoken)
    for step in args.forget:
        onboarding.forget(cfg, root, step)
    found = onboarding.progress(cfg, root)
    sys.stdout.write(onboarding.dumps(found) if args.json else onboarding.show(found, root) + "\n")
    return 0


def cmd_labels(args) -> int:
    return operate.labels(factory.load(args.config), args.create)


def cmd_run(args) -> int:
    loaded = workflow.load(args.workflow, args.config)
    # A prompt may be a path to a file; an issue or pull request number is not.
    request = args.prompt if loaded.input != "prompt" else utils.resolve_prompt(args.prompt)
    return workflow.run(loaded, Invocation(request=request, adw_id=args.adw_id, resume=args.resume,
                                           hitl=args.hitl, force=args.force))


def cmd_sessions(args) -> int:
    return operate.sessions(factory.load(args.config), args.limit)


def cmd_pending(args) -> int:
    return operate.pending(factory.load(args.config))


def cmd_show(args) -> int:
    return operate.show(factory.load(args.config), args.adw_id)


def cmd_decide(args) -> int:
    return operate.decide(factory.load(args.config), args.config, args.command, args.adw_id,
                          args.notes, args.no_resume)


def cmd_resume(args) -> int:
    return operate.relaunch(factory.load(args.config), args.config, args.adw_id, args.dry_run)


def cmd_kill(args) -> int:
    return operate.kill(factory.load(args.config), args.adw_id, args.force)


def cmd_worktrees(args) -> int:
    return operate.worktrees(factory.load(args.config), args.action, args.adw_id or "",
                             args.force)


def cmd_issues(args) -> int:
    cfg = factory.load(args.config)
    if args.action == "status":
        return watch.issues_status(cfg)
    _watched_workflows(args.config, cfg.issues.route.values(), "issue")
    if args.action == "once":
        watch.warn_alone()
        return watch.issues_once(cfg, args.config)
    return watch.issues_loop(cfg, args.config, args.interval)


def cmd_answers(args) -> int:
    cfg = factory.load(args.config)
    if args.action == "status":
        return watch.answers_status(cfg)
    # No `_watched_workflows` check: this poller launches nothing. It resumes
    # runs that already loaded their workflow once, and a workflow that has
    # since been edited into something unloadable fails in that run's own
    # process, where the record of it belongs.
    if args.action == "once":
        return watch.answers_once(cfg, args.config)
    return watch.answers_loop(cfg, args.config, args.interval)


def cmd_prs(args) -> int:
    cfg = factory.load(args.config)
    if args.action == "status":
        return watch.prs_status(cfg)
    _watched_workflows(args.config, [cfg.pull_requests.workflow], "pr")
    if args.action == "once":
        code = watch.prs_once(cfg, args.config, args.pr)
        return 0 if code == 3 else code
    return watch.prs_loop(cfg, args.config, args.interval, args.pr)


def _watched_workflows(config: str, names, kind: str) -> None:
    """A watcher is refused before its first poll if a workflow it would launch
    does not load, or takes the wrong input — a poller that launches a refused
    run on every pass is the silent nothing `up` exists to remove."""
    for name in names:
        loaded = workflow.load(name, config)
        if loaded.input != kind:
            raise SystemExit(f"workflow {name!r} takes input: {loaded.input}, and the "
                             f"{kind} watcher launches workflows with input: {kind}")


def cmd_up(args) -> int:
    return supervise.up(factory.load(args.config), args.config,
                        supervise.Children(args.only, True, args.interval))


def cmd_status(args) -> int:
    return supervise.status(factory.load(args.config))


def cmd_station(args) -> int:
    cfg = factory.load(args.config)
    if args.action == "sync":
        return station.sync(cfg)
    if args.action == "register":
        return commands.register(cfg)
    return supervise.up(cfg, args.config, supervise.Children(watchers=False))


def _config_on(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    """`--config` after the subcommand too. SUPPRESS, never a default, on the
    subcommand's copy: argparse copies a subcommand's namespace over the outer
    one, and a copy carrying a default would silently overwrite a `--config`
    typed before the subcommand."""
    parser.add_argument("--config", default=argparse.SUPPRESS)
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="asf", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    sub = parser.add_subparsers(dest="command", required=True)

    _config_on(sub.add_parser("list", help="every workflow, one line each")
               ).set_defaults(func=cmd_list)
    check = _config_on(sub.add_parser("check", help="load and validate, spawn nothing"))
    check.add_argument("workflow", nargs="?", help="one workflow; default: all")
    check.add_argument("--json", action="store_true",
                       help="print the factory's self-description — every workflow's stages, "
                            "agents, gates, the budget — as JSON, for a cockpit")
    check.add_argument("--ship", action="store_true",
                       help="with --json: send it to the cockpit ASF_COCKPIT_URL names, with "
                            "ASF_COCKPIT_TOKEN, as this checkout's station — the stamped CI "
                            "workflow's step; fails only when the cockpit refuses the token")
    check.set_defaults(func=cmd_check)
    _config_on(sub.add_parser("doctor", help="is this repo ready to run? checks + fixes")
               ).set_defaults(func=cmd_doctor)
    lbl = _config_on(sub.add_parser("labels", help="the forge labels this config names"))
    lbl.add_argument("--create", action="store_true",
                     help="define the missing ones; never edits or deletes an existing label")
    lbl.set_defaults(func=cmd_labels)
    onb = _config_on(sub.add_parser("onboard", help="where onboarding stands, and its next step"))
    onb.add_argument("--json", action="store_true", help="the steps as JSON, for an agent")
    onb.add_argument("--mark", action="append", default=[], metavar="STEP[=VALUE]",
                     help="record a decision that leaves no trace: settings, cockpit=local, "
                          "cockpit=team, ci=declined")
    onb.add_argument("--forget", action="append", default=[], metavar="STEP",
                     help="drop a recorded decision")
    onb.set_defaults(func=cmd_onboard)

    run = _config_on(sub.add_parser("run", help="run one workflow against a prompt"))
    run.add_argument("workflow")
    run.add_argument("prompt", help="inline text or a path to a prompt file")
    run.add_argument("--adw-id", default=None, help="join or pin an existing session")
    run.add_argument("--resume", action="store_true",
                     help="replay this session's recorded agent phases instead of "
                          "paying for them again; needs --adw-id")
    run.add_argument("--hitl", default="",
                     help="which gates stop for you: all | none | every | gate,names "
                          "— over the workflow's and factory.yaml's say")
    run.add_argument("--force", action="store_true",
                     help="start an issue or pull request run without asking the shared cockpit "
                          "for its claim — for recovering by hand")
    run.set_defaults(func=cmd_run)

    sessions = _config_on(sub.add_parser("sessions", help="the newest sessions, from their "
                                                          "own records"))
    sessions.add_argument("--limit", type=int, default=10, help="how many (default 10)")
    sessions.set_defaults(func=cmd_sessions)
    _config_on(sub.add_parser("pending", help="runs stopped at a gate")
               ).set_defaults(func=cmd_pending)
    show = _config_on(sub.add_parser("show", help="what a waiting run wants you to read"))
    show.add_argument("adw_id")
    show.set_defaults(func=cmd_show)
    # Four verbs, two waits. A GATE shows a work product and takes a verdict on
    # it; a QUESTION ROUND shows what an agent could not settle and takes the
    # missing input. `hitl.answer()` refuses the verb that does not fit the wait
    # in front of it, so a wrong one costs a second command rather than a run.
    for verdict, what in (("approve", "approve the gate a run waits at, or take every "
                                      "recommendation a question round offered"),
                          ("reject", "send the artifact back to the agent that made it"),
                          ("answer", "supply what a question round asked for"),
                          ("abort", "end the run where it stands")):
        one = _config_on(sub.add_parser(verdict, help=what))
        one.add_argument("adw_id")
        one.add_argument("-m", "--notes", default="",
                         help="your words for the agent (required on reject and answer)")
        one.add_argument("--no-resume", action="store_true",
                         help="record the decision and stop; do not relaunch the run")
        one.set_defaults(func=cmd_decide)
    resume = _config_on(sub.add_parser("resume", help="pick a failed run back up"))
    resume.add_argument("adw_id")
    resume.add_argument("--dry-run", action="store_true", help="print the command only")
    resume.set_defaults(func=cmd_resume)
    kill = _config_on(sub.add_parser("kill", help="stop a run: agents first, then the workflow"))
    kill.add_argument("adw_id")
    kill.add_argument("--force", action="store_true",
                      help="SIGKILL after the grace period; signal recycled pids too")
    kill.set_defaults(func=cmd_kill)

    for kind, help_text in (("issues", "a run per labelled issue"),
                            ("answers", "resume a run somebody answered on its work item"),
                            ("prs", "answer review threads on this factory's pull requests")):
        one = _config_on(sub.add_parser(kind, help=help_text))
        one.add_argument("action", choices=["once", "loop", "status"])
        one.add_argument("--interval", type=int, default=120, help="loop: seconds between polls")
        if kind == "prs":
            one.add_argument("--pr", type=int, default=0,
                             help="watch one pull request; loop exits when it is merged or closed")
        one.set_defaults(func={"issues": cmd_issues, "answers": cmd_answers,
                               "prs": cmd_prs}[kind])
    up = _config_on(sub.add_parser("up", help="the station loop, the local cockpit and every "
                                              "watcher, in one process"))
    up.add_argument("--interval", type=int, default=120, help="seconds between polls")
    up.add_argument("--only", default="",
                    help="comma-separated subset of cockpit,issues,answers,prs "
                         "(the station loop always runs)")
    up.set_defaults(func=cmd_up)
    _config_on(sub.add_parser("status", help="what is watching, running, waiting, left behind")
               ).set_defaults(func=cmd_status)
    trees = _config_on(sub.add_parser("worktrees", help="list, prune or remove run worktrees"))
    trees.add_argument("action", choices=["list", "prune", "remove"])
    trees.add_argument("adw_id", nargs="?", help="remove: which run's worktree")
    trees.add_argument("--force", action="store_true",
                       help="also take worktrees holding uncommitted work")
    trees.set_defaults(func=cmd_worktrees)
    stations = _config_on(sub.add_parser("station", help="this checkout as a cockpit's station"))
    stations.add_argument("action", nargs="?", choices=["sync", "register"],
                          help="none: the station loop — `asf up` without watchers, shipping "
                               "every session, polling for commands (and starting the local "
                               "cockpit when no shared one is configured). sync: ship every "
                               "session the cockpit has not acknowledged, once — a CI job's last "
                               "step; fails only when the cockpit refuses the token. register: "
                               "print a code to approve in the shared cockpit, and keep the "
                               "command token it then issues — and, without ASF_COCKPIT_TOKEN, "
                               "the ingest token it hands over with it")
    stations.set_defaults(func=cmd_station)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

"""Deterministic lint, typecheck, build, and test blocks.

A known command is not a judgement call. Anything whose invocation you can write
down belongs here as code — it runs in milliseconds, costs nothing, and returns
the same answer every time. Agents are for the parts that need reading and
deciding.

╔══════════════════════════════════════════════════════════════════════════════╗
║  REPLACE THE PLACEHOLDER COMMANDS BELOW.                                     ║
║                                                                              ║
║  A block that has not been wired up FAILS. It runs nothing, spawns nothing,   ║
║  and reports exit 78 with the line you are reading — because the alternative  ║
║  is a chain that reports a green suite it never ran, and then a pull request  ║
║  that says "tests pass". An unwired block is a missing answer, and a missing  ║
║  answer is not a passing one.                                                ║
║                                                                              ║
║  A stamped repo has no way to guess your test runner; `install.py` tries      ║
║  (bun.lock, pyproject.toml, package.json scripts, playwright.config.*),      ║
║  writes in what it finds, so some of the blocks below may already name a     ║
║  real command. `just doctor` lists whichever are still unwired.              ║
║                                                                              ║
║  For each block you want: swap `_placeholder(...)` for the real argv, e.g.    ║
║      argv=["bun", "test", "apps/web/server.test.ts"]                         ║
║      argv=["uv", "run", "pytest", "-q"]                                      ║
║      argv=["npm", "run", "lint"]                                             ║
║  Delete the blocks you don't need, and drop them from DEFAULT.               ║
║                                                                              ║
║  `e2e` is opt-in: browser tests against a dev server Playwright's webServer  ║
║  starts itself. It is not in DEFAULT, so it runs only where a workflow names  ║
║  it (verify.blocks, review.retest), and doctor asks about it only then. Keep  ║
║  `--output str(evidence)` in its argv; its config reads PORT.                ║
║                                                                              ║
║  `serve` is the other opt-in: the command that starts this repo's dev        ║
║  server on a port it is given, for the `accept` stage. Code starts it, waits  ║
║  until it answers and stops it; an agent is handed only its URL.             ║
║                                                                              ║
║  Two rules when you write the real command:                                  ║
║    1. argv LIST, never a shell string — no quoting bugs, no shell injection.  ║
║    2. Call binaries by BARE NAME. These blocks inherit the operator's         ║
║       environment (see utils.operator_env), so `bun`, `uv`, `pytest` resolve  ║
║       exactly as they do in their terminal. Never hard-code an absolute path  ║
║       like /Users/you/.bun/bin/bun — that bakes your machine into the trace.  ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

from __future__ import annotations

import inspect
import re
import shlex
import socket
import subprocess
import time
from pathlib import Path
from typing import Callable

from .data_types import (RAW_TAIL_CHARS, CommandFinished, QualityCheckResult,
                         QualityCheckSpec, QualityResult, VerifyOutput)
from .utils import operator_env, write_atomic

# How much of a failing command's output rides back inside the envelope. Enough
# for a builder to act on without opening the artifact; bounded so a runaway
# stack trace can't swamp the next agent's context.
TAIL_CHARS = 4_000


# Not a command — a marker. `_run` recognises it and fails the check without
# spawning anything, which is the whole point: there is no shell string that
# both fails loudly and cannot be mistaken for a real invocation in the trace.
UNWIRED = "__asf_unwired__"
EXIT_UNWIRED = 78                  # sysexits.h EX_CONFIG: the configuration is wrong


def _placeholder(name: str) -> list[str]:
    """The argv of a block nobody has wired up yet. Replace every call to this.

    It used to be an `echo` that exited 0, and a stamped repo therefore shipped
    with a test phase that passed without testing anything — the most expensive
    default the factory had. Now it fails, and says exactly what to edit.
    """
    return [UNWIRED, name]


# One example per block, so the fix reads like the thing it is asking for. A
# `lint` block told to look like `bun test` is a fix nobody follows literally.
EXAMPLES = {
    "test": '["bun", "test"] or ["uv", "run", "pytest", "-q"]',
    "lint": '["npm", "run", "lint"] or ["uv", "run", "ruff", "check", "."]',
    "typecheck": '["bunx", "tsc", "--noEmit"] or ["uv", "run", "mypy", "."]',
    "build": '["npm", "run", "build"] or ["cargo", "build"]',
    "e2e": '["bunx", "playwright", "test", "--output", str(evidence)]',
    "serve": '["bun", "run", "dev", "--port", str(port)] or '
             '["npx", "next", "dev", "-p", str(port)]',
}


def _unwired_message(name: str) -> str:
    """What a block that was never wired up reports. Rides back in the envelope,
    so the builder reads it too — hence the fix rather than just the complaint."""
    example = EXAMPLES.get(name, '["your", "command", "here"]')
    return (f"No {name} command is wired up. asf/engine/quality.py ships this "
            f"block as a placeholder, and a placeholder FAILS rather than passing: a "
            f"green suite that never ran is worse than a red one.\n\n"
            f"Fix: open asf/engine/quality.py and replace "
            f"`_placeholder(\"{name}\")` with the argv that {name}s this repo — "
            f"{example} — or delete the block and drop it from BLOCKS there.")


def placeholders(names: list[str] | None = None) -> list[str]:
    """Which of `names` (DEFAULT when not given) still carry the shipped
    placeholder instead of a command.

    Read off the source of the blocks themselves rather than a list somebody
    has to remember to update: a block whose argv you replaced no longer
    mentions `_placeholder`, and that IS the answer. `preflight.quality()` and
    `just doctor` ask about DEFAULT; a stage's `check` asks about what its
    workflow names (`refused` below).
    """
    return [name for name in (DEFAULT if names is None else names)
            if _unwired(BLOCKS[name])]


def _unwired(function: Callable) -> bool:
    """Whether `function` still returns the shipped placeholder."""
    try:
        return "_placeholder(" in inspect.getsource(function)
    except OSError:                          # a block defined outside a file
        return False


def _check_dir(run, name: str) -> Path:
    seq = run.phases[-1].seq if run.phases else 0
    path = run.context_handoff_dir / "quality" / f"{seq:02d}_{name}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run(spec: QualityCheckSpec, run) -> QualityCheckResult:
    phase = run.phases[-1]
    output_dir = _check_dir(run, spec.name)
    output_artifact = output_dir / "command.log"
    # An unwired block is a check that cannot be performed, so it is reported as
    # a failure — never spawned, never passed. Everything after this branch is
    # identical for both paths on purpose: artifact, trace event, console line
    # and envelope, so an unwired block reaches the builder through exactly the
    # same door a red test suite does.
    unwired = spec.argv[:1] == [UNWIRED]
    command = (f"<unwired {spec.name} block — asf/engine/quality.py>"
               if unwired else shlex.join(spec.argv))

    run.console.note(f"quality {spec.name}: {command}")
    clock = time.monotonic()
    stdout = ""
    stderr = ""
    if unwired:
        returncode = EXIT_UNWIRED
        stderr = _unwired_message(spec.name)
    else:
        try:
            completed = subprocess.run(
                spec.argv,
                cwd=run.repo_root,
                # The engineer's own shell environment, and what this check adds to it.
                env={**operator_env(), **spec.env},
                capture_output=True,
                text=True,
                timeout=spec.timeout_seconds,
            )
            returncode = completed.returncode
            stdout = completed.stdout
            stderr = completed.stderr
        except subprocess.TimeoutExpired as error:
            returncode = 124
            stdout = error.stdout or ""
            stderr = (error.stderr or "") + f"\nTimed out after {spec.timeout_seconds}s."
        except OSError as error:
            # A missing binary lands here as exit 127 with the real message — no
            # pre-flight probe needed, and none wanted.
            returncode = 127
            stderr = str(error)

    duration = time.monotonic() - clock
    write_atomic(
        output_artifact,
        f"$ {command}\nexit: {returncode}\nduration_seconds: {duration:.3f}\n"
        f"\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n"
    )
    passed = returncode == 0
    # The log above stays on this machine; the event is what travels, and its
    # tail is where a red suite says why.
    run.tracer.event(CommandFinished(
        phase_id=phase.phase_id, name=spec.name, argv=list(spec.argv), exit_code=returncode,
        duration_seconds=round(duration, 3), output_tail=(stdout + stderr)[-RAW_TAIL_CHARS:]))
    run.console.note(
        f"quality {spec.name}: {'passed' if passed else 'failed'} "
        f"(exit {returncode}, {duration:.1f}s)"
    )
    return QualityCheckResult(
        name=spec.name,
        area=spec.area,
        operation=spec.operation,
        command=command,
        returncode=returncode,
        passed=passed,
        duration_seconds=duration,
        output_artifact=str(output_artifact),
        output_tail=(stdout + stderr)[-TAIL_CHARS:],
        evidence=[path for path in spec.evidence if Path(path).exists()],
    )


def _failure(check: QualityCheckResult) -> str:
    """One failed check as the builder reads it: the command, its exit code, and
    what it actually printed — everything needed to repair it without opening a
    log, or being told what the error "means" by a parser that guessed. A
    diagnosis leads, when the block knows what the exit code alone hides."""
    lead = f"{check.diagnosis}\n" if check.diagnosis else ""
    return (f"{check.name}: {lead}`{check.command}` exited {check.returncode}\n"
            f"{check.output_tail}").rstrip()


def _artifacts(checks: list[QualityCheckResult]) -> list[str]:
    return [path for check in checks for path in (check.output_artifact, *check.evidence)]


# ── Blocks ────────────────────────────────────────────────────────────────────
# Replace every argv below. See the banner at the top of this file.

def test(run) -> QualityCheckResult:
    """Run the project's test suite. The highest-value block to wire up first."""
    return _run(QualityCheckSpec(
        name="test",
        area="backend",
        operation="build",
        argv=_placeholder("test"),        # e.g. ["bun", "test"] or ["uv", "run", "pytest", "-q"]
        timeout_seconds=600,
    ), run)


def lint(run) -> QualityCheckResult:
    return _run(QualityCheckSpec(
        name="lint",
        area="backend",
        operation="lint",
        argv=_placeholder("lint"),        # e.g. ["bun", "x", "oxlint@1.36.0", "src"]
    ), run)


def typecheck(run) -> QualityCheckResult:
    return _run(QualityCheckSpec(
        name="typecheck",
        area="backend",
        operation="typecheck",
        argv=_placeholder("typecheck"),   # e.g. ["bun", "x", "tsc", "--noEmit"]
    ), run)


def build(run) -> QualityCheckResult:
    # Where a wired-up build writes its bundle, created here so the argv below
    # can simply point at it. `_check_dir` makes the check's own directory; the
    # bundle subdirectory under it is this block's, and a build tool that will
    # not create its own --outdir would otherwise fail on a path that does not
    # exist yet.
    output_dir = _check_dir(run, "build") / "bundle"
    output_dir.mkdir(parents=True, exist_ok=True)
    return _run(QualityCheckSpec(
        name="build",
        area="backend",
        operation="build",
        argv=_placeholder("build"),       # e.g. ["bun", "build", "src/index.ts", "--outdir", str(output_dir)]
    ), run)


def free_port() -> int:
    """A port nothing on this machine is listening on, as the OS picks one.

    Sessions run side by side, each in its own worktree, and a dev server on a
    fixed port (3000) would meet the one next to it there — the second session's
    server fails to start, or worse, its specs pass against the first one's.
    """
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# Every way Playwright says its `webServer` never answered — timed out, exited
# early, could not start, found its port taken — is an `Error:` line naming the
# config key, and exits 1 exactly like a failing spec does. Anchored to that
# line, so a spec or a server that merely prints the words is not mistaken for it.
SERVER_DOWN = re.compile(r"^Error: .*\bconfig\.webServer\b", re.MULTILINE)


def _diagnose_server_down(check: QualityCheckResult) -> QualityCheckResult:
    """A red e2e check whose dev server never answered, said as that: no spec
    ran, so none failed, and a builder told otherwise goes hunting in specs."""
    # The whole log, not the tail: Playwright says it first and the server's
    # own output, which can run long, follows.
    if check.passed or not SERVER_DOWN.search(Path(check.output_artifact).read_text()):
        return check
    return check.model_copy(update={"diagnosis": (
        "the dev server never came up (Playwright's webServer), so no spec ran and none "
        "failed. Its output is below: a crash there may be the change; a missing .env, "
        "package or PORT is the worktree's setup (worktree.copy, worktree.setup in "
        "asf/factory.yaml) or the webServer config.")})


def e2e(run) -> QualityCheckResult:
    """Browser tests against a dev server the command starts itself — Playwright's
    `webServer` config starts it and stops it, so code never runs one beside it.

    Opt-in: not in DEFAULT below, so it runs only where a workflow names it.

    What the command is handed, so a browser test fits a factory: `PORT`, free
    for this check alone, which the webServer config and `use.baseURL` read;
    `ASF_CHECK_DIR`, this check's directory; and the evidence directory, which
    Playwright's `--output` points at and which the builder repairing a red run
    is handed — traces and screenshots, not just the log. The HTML report goes
    beside it and never opens a browser that would wait for someone.
    """
    check_dir = _check_dir(run, "e2e")
    evidence = check_dir / "test-results"
    report = check_dir / "report"
    return _diagnose_server_down(_run(QualityCheckSpec(
        name="e2e",
        area="frontend",
        operation="test",
        argv=_placeholder("e2e"),         # e.g. ["bunx", "playwright", "test", "--output", str(evidence)]
        env={"PORT": str(free_port()), "ASF_CHECK_DIR": str(check_dir),
             "PLAYWRIGHT_HTML_OUTPUT_DIR": str(report), "PLAYWRIGHT_HTML_OPEN": "never"},
        evidence=[str(evidence), str(report)],
        timeout_seconds=900,
    ), run))


# ── The dev server ────────────────────────────────────────────────────────────

def serve(port: int) -> list[str]:
    """The command that starts this repository's dev server on `port` — what the
    `accept` stage runs, so an agent can drive the app in a browser.

    Not a block: nothing here judges it by its exit code. `engine/serve.py`
    starts it in the run's worktree with `PORT` set as well, waits until
    `http://localhost:<port>/` answers, hands the agent that URL, and stops it
    — its whole process group — however the stage ends, so an agent never
    runs a server, picks a port, or leaves one behind. Keep it a server that
    reloads on change: a revision lands while it runs.
    """
    return _placeholder("serve")   # e.g. ["bun", "run", "dev", "--port", str(port)]


def serve_refused() -> list[str]:
    """Why a workflow running `accept` must not run yet: `serve` is still the
    placeholder. Said by `asf check`, like an opt-in block's."""
    return (["serve is still a placeholder in asf/engine/quality.py, and this workflow runs "
             "accept — replace `_placeholder(\"serve\")` with the argv that starts the dev "
             f"server on `port`, e.g. {EXAMPLES['serve']}"] if _unwired(serve) else [])


# Every block this file offers, by name — what `run_blocks` resolves a
# workflow's `blocks:` and `retest:` against, and what `placeholders` inspects.
# One registry, so a block added or deleted here cannot be half-registered.
BLOCKS: dict[str, Callable] = {
    "test": test,
    "lint": lint,
    "typecheck": typecheck,
    "build": build,
    "e2e": e2e,
}

# What `run_quality` runs, and what `just doctor` asks about on every stamp.
# Not BLOCKS: a block left out of here is opt-in — it exists, a workflow can
# name it, and a stamp that never asks for it never runs it or hears about it.
DEFAULT: list[str] = ["test", "lint", "typecheck", "build"]


def _unknown(name: str) -> str:
    return f"no block {name!r} in asf/engine/quality.py — it offers {', '.join(BLOCKS)}"


def refused(names: list[str]) -> list[str]:
    """Why a workflow naming these blocks must not run, said by `asf check`
    before anything costs anything: a name this file does not offer, and an
    opt-in block still a placeholder.

    Not a DEFAULT block still a placeholder. That is how every stamp starts,
    `just doctor` says so on every run, and a check that refused it would
    refuse the stamped workflows on day one. An opt-in block is named only by
    someone who asked for it, so one still unwired is a mistake in that
    workflow — and it would otherwise surface as a red phase, after an agent
    had already been paid for the build in front of it.
    """
    problems = [_unknown(name) for name in names if name not in BLOCKS]
    opt_in = [name for name in names if name in BLOCKS and name not in DEFAULT]
    problems += [f"{name} is still a placeholder in asf/engine/quality.py, and this "
                 f"workflow names it — replace `_placeholder(\"{name}\")` with the argv "
                 f"that runs it" for name in placeholders(opt_in)]
    return problems


def run_blocks(run, names: list[str]) -> QualityResult:
    """The named blocks, in order, as one QualityResult — what a `verify` stage
    runs. A name that is not in BLOCKS is refused here, before anything spawns,
    because a workflow that asks for a block this repository never wired up is
    a configuration error and not a red suite.
    """
    unknown = [_unknown(name) for name in names if name not in BLOCKS]
    if unknown:
        raise RuntimeError("quality: " + "; ".join(unknown))
    checks = [BLOCKS[name](run) for name in names]
    failures = [_failure(check) for check in checks if not check.passed]
    return QualityResult(passed=not failures, checks=checks, failures=failures,
                         artifacts=_artifacts(checks))


def run_tests(run) -> QualityResult:
    """The test suite alone, as a QualityResult — the deterministic test phase.

    This is what replaces a `tester` agent once the command is written down. An
    agent rediscovering the runner on every run costs a fortune to learn what a
    subprocess already knows; the repair loop is unchanged, because a failure
    still reaches the builder through `as_envelope` below.
    """
    check = test(run)
    failures = [] if check.passed else [_failure(check)]
    return QualityResult(passed=check.passed, checks=[check], failures=failures,
                         artifacts=_artifacts([check]))


def as_envelope(result: QualityResult, what: str) -> VerifyOutput:
    """Wrap a deterministic result so an agent can be handed it directly.

    Agents hand each other typed envelopes; code blocks return QualityResult.
    This is the adapter, so a failing lint or test run flows back into the
    builder through exactly the same door an agent's report would — the ADW
    script is the only thing that knows the difference.
    """
    return VerifyOutput(
        status="success" if result.passed else "fail",
        summary=(f"{what}: all {len(result.checks)} check(s) passed" if result.passed
                 else f"{what}: {len(result.failures)} of {len(result.checks)} check(s) failed"),
        artifacts=result.artifacts,
        notes_for_next_agent=("" if result.passed else
                              "Fix every failure below. The output is verbatim from the "
                              "command — trust it over any summary."),
        passed=result.passed,
        failures=result.failures,
    )


def run_quality(run) -> QualityResult:
    """Run every block and collect ALL failures — one pass tells you everything.

    Ordering contract for the caller: a failing block does NOT fail the phase.
    The runner did its job; the CODE is what failed. Hand this result to the
    builder and let the bounded repair loop decide the run's fate.

    Which blocks run is `DEFAULT` above — drop the ones this repo has no use
    for there, in the one place `placeholders()` and `just doctor` also read.
    """
    checks = [BLOCKS[name](run) for name in DEFAULT]
    failures = [_failure(check) for check in checks if not check.passed]
    return QualityResult(
        passed=not failures,
        checks=checks,
        failures=failures,
        artifacts=_artifacts(checks),
    )

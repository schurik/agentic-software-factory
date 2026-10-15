"""A bug report as a failing test: the claim `reproduce` makes, and what holds it.

`reproduce` (asf/stages/reproduce) asks a builder to turn a report into a test
that fails BECAUSE of the bug, before anyone fixes it. Everything that keeps
that test honest is code, and it is here rather than in the stage, because
three stages lean on it and none of them owns it:

  * `reproduces` — the gate on the claim. It runs the declared command and
    needs three things: the test RAN (not an import or collection error, not a
    command that was never found), it FAILED, and it printed the failure the
    agent said the bug produces. Anything else goes back to the same session.
    A claim checked after the fact, never predicted (invariant 4).
  * `freeze` — once the gate passed, the file's digest is pinned and a
    STANDING gate (`run.standing_gates`) holds every later agent call in the
    run to it: restore the test, fix the code. `permissions.py` cannot do this
    job — the test is uncommitted until it lands with the fix, and rolling
    back an untracked file deletes it.
  * `checks` — what `verify`, and a review's retest, run beside their blocks:
    the repro, by its declared command, so a red one reaches the builder like
    any red check whether or not the `test` block happens to collect it.
  * `pr_section` — the proof that it failed first, for the pull request. The
    test lands in the same commit as the fix, green; that it was ever red is
    otherwise only in the session's record.
"""

from __future__ import annotations

import hashlib
import re
import shlex
from pathlib import Path
from typing import Callable, Optional

from . import gates, quality
from .data_types import EnvelopeBase, GateReport, QualityCheckResult, ReproOutput
from .utils import anchor, write_atomic

NAME = "repro"                     # the check's name, on its `command_finished` events
PROOF = "reproduction.md"          # in context_handoff/: what the gate saw, for the PR
KEPT = "frozen"                    # context_handoff/frozen/<path>: the frozen copy
EXCERPT_CHARS = 1500

# Exit codes that mean the command never got as far as running a test.
NOT_RUN_EXITS = {124: "it timed out", 126: "the command is not executable",
                 127: "the command was not found"}

# How common runners say that nothing ran: a test that cannot be imported or
# collected, a filter that matched nothing, a build that did not compile. Each
# exits non-zero exactly like a failing test, which is why the exit code alone
# cannot tell a reproduction from a broken one. Not exhaustive, and it does not
# need to be: a runner that says it some other way still has to print the
# declared failure, which a test that never ran does not.
NOT_RUN = re.compile("|".join([
    r"ERROR collecting", r"ImportError while importing test module",       # pytest
    r"\bno tests ran\b", r"collected 0 items", r"ERROR: (?:file or directory )?not found",
    r"^(?:E\s+)?(?:[\w.]+\.)?(?:ModuleNotFoundError|ImportError|SyntaxError|"
    r"IndentationError)\b",                                                # python
    r"Cannot find module", r"Test suite failed to run",                    # node runners
    r"[Nn]o tests? (?:files? )?found", r"\berror TS\d+",
    r"\[(?:setup|build) failed\]", r"could not compile",                   # go, cargo
    r"^Error: .*\bconfig\.webServer\b",                                    # playwright
]), re.MULTILINE)


# ── the gate on the claim ────────────────────────────────────────────────────

def reproduces(envelope: EnvelopeBase, run) -> GateReport:
    """`reproduced: true` holds: the declared test runs, fails, and prints
    `expected_failure`. `reproduced: false` claims nothing this can run —
    what it must name is refused at parse time (`ReproOutput`)."""
    report = GateReport()
    if not getattr(envelope, "reproduced", False):
        return report.check("reproduced", True, "not claimed — what was tried and what is "
                                                "missing go to the reporter")
    path = gates._in_tree(run, envelope.repro_test)
    if path is None:
        return report.check(envelope.repro_test, False,
                            "the declared repro test resolves outside this run's own tree")
    if not path.is_file():
        return report.check(envelope.repro_test, False, "the declared repro test does not exist")
    test = _relative(run, path)
    command = shlex.join(envelope.repro_command)
    named = any(test in arg or str(path) in arg for arg in envelope.repro_command)
    report.check("repro_command", named,
                 f"runs {test}" if named else
                 f"`{command}` does not name {test} — the command runs ONLY the declared "
                 f"test, so that a red run says one thing")
    if not named:
        return report
    digest = _digest(path)
    if run.pinned(_pin(test)) == digest:
        # A resumed run re-walking this phase: the claim was shown when it was
        # made, and the fix since is supposed to make the test pass. What must
        # still hold is that it is the SAME test.
        return report.check(test, True, f"shown failing as declared when it was claimed, "
                                        f"and unchanged since ({digest[:12]})")
    result = quality.command(run, NAME, envelope.repro_command)
    printed = _printed(result)
    why = NOT_RUN_EXITS.get(result.returncode) or result.diagnosis or _not_run(printed)
    report.check(f"{test} · ran", not why,
                 f"exit {result.returncode}" if not why else
                 f"it never ran — {why}. A test that cannot be collected or imported is "
                 f"not one that fails because of the bug:\n{_tail(printed)}")
    if why:
        return report
    failed = result.returncode != 0
    report.check(f"{test} · failed", failed,
                 f"exit {result.returncode}" if failed else
                 f"it passed (exit 0) — whatever it tests, it is not the reported bug, "
                 f"which is still in the code:\n{_tail(printed)}")
    if not failed:
        return report
    expected = envelope.expected_failure
    seen = _flat(expected) in _flat(printed)
    report.check(f"{test} · failed as declared", seen,
                 f"printed {expected!r}:\n{_excerpt(printed, expected)}" if seen else
                 f"it failed, but did not print {expected!r} — it fails for some other "
                 f"reason than the reported bug, or `expected_failure` is not what the "
                 f"bug prints:\n{_tail(printed)}")
    if seen:
        _prove(run, envelope, result)
    return report


# ── frozen: no later call may weaken it ──────────────────────────────────────

def freeze(run, repro: ReproOutput) -> str:
    """Hold every later agent call in this run to the repro test as it was shown
    failing. Returns the digest it is held to.

    The digest is pinned, so a resumed run holds the test to what the FIRST
    run showed, not to whatever the tree holds by then. A copy is kept outside
    the tree, which is what a correction tells the agent to restore it from:
    the file is uncommitted, so git has no earlier version of it to offer.
    """
    path = anchor(run.repo_root, repro.repro_test)
    test = _relative(run, path)
    current = _digest(path)
    frozen = run.pin(_pin(test), lambda: current)
    kept = run.context_handoff_dir / KEPT / test
    if frozen == current:
        kept.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(kept, path.read_bytes().decode())   # bytes as they are: \r\n too
    run.standing_gates.append(unchanged(test, frozen, kept))
    return frozen


def unchanged(test: str, digest: str, kept: Path) -> Callable:
    """The standing gate `freeze` puts on the run: the repro test, byte for byte."""
    def repro_unchanged(envelope: EnvelopeBase, run) -> GateReport:
        path = anchor(run.repo_root, test)
        now = _digest(path) if path.is_file() else ""
        if now == digest:
            return GateReport().check(test, True, f"unchanged since it was shown failing "
                                                  f"({digest[:12]})")
        return GateReport().check(test, False, (
            f"this call {'deleted' if not now else 'changed'} the repro test. It is the "
            f"reported bug, as code, frozen when it was shown failing, and nothing after "
            f"that may weaken it: restore it byte for byte from {kept}, and make it pass "
            f"by fixing the code instead"))
    return repro_unchanged


# ── what verify runs beside its blocks ───────────────────────────────────────

def held(latest: dict) -> Optional[ReproOutput]:
    """The run's reproduction, when it has one that a gate showed failing."""
    repro = latest.get(ReproOutput)
    return repro if repro is not None and repro.reproduced else None


def checks(latest: dict) -> list[Callable]:
    """The checks a run holds beside its workflow's blocks (`quality.run_blocks`'s
    `also`): its repro test, by the command it was declared with — [] for a run
    that reproduced nothing."""
    repro = held(latest)
    if repro is None:
        return []

    def repro_check(run) -> QualityCheckResult:
        return quality.command(run, NAME, repro.repro_command)
    return [repro_check]


# ── the proof, for the pull request ──────────────────────────────────────────

def pr_section(handoff_dir: Path) -> str:
    """What the gate saw when it accepted the reproduction, as markdown for the
    pull request's description; "" when the run reproduced nothing."""
    proof = Path(handoff_dir) / PROOF
    return proof.read_text().strip() if proof.is_file() else ""


def _prove(run, repro: ReproOutput, result: QualityCheckResult) -> None:
    test = _relative(run, anchor(run.repo_root, repro.repro_test))
    printed = _printed(result)
    write_atomic(run.context_handoff_dir / PROOF, "\n".join([
        "### Reproduced before the fix",
        "",
        f"`{test}` was written from the report and shown failing before any code changed, "
        f"the way the report says the bug behaves. It lands in the same commit as the fix, "
        f"and passes there.",
        "",
        f"- Command: `{shlex.join(repro.repro_command)}` — exit {result.returncode}",
        f"- Declared failure: `{repro.expected_failure}`",
        "",
        "<details><summary>What the gate saw</summary>",
        "",
        "```",
        _excerpt(printed, repro.expected_failure),
        "```",
        "",
        "</details>",
        ""]))


# ── internals ────────────────────────────────────────────────────────────────

def _pin(test: str) -> str:
    return f"repro:{test}"


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _relative(run, path: Path) -> str:
    resolved, root = path.resolve(), run.repo_root.resolve()
    return resolved.relative_to(root).as_posix() if root in resolved.parents else str(path)


def _printed(result: QualityCheckResult) -> str:
    """What the command printed, from its whole log — not the header naming the
    command, which could carry the very words the check looks for."""
    log = Path(result.output_artifact).read_text()
    body = log.split("\n--- stdout ---\n", 1)[-1]
    return body.replace("\n--- stderr ---\n", "\n")


def _not_run(printed: str) -> str:
    found = NOT_RUN.search(printed)
    return f"the runner said {found.group(0).strip()!r}" if found else ""


def _flat(text: str) -> str:
    return " ".join(text.split())


def _tail(printed: str) -> str:
    return printed.strip()[-EXCERPT_CHARS:]


def _excerpt(printed: str, expected: str) -> str:
    """The lines around where the declared failure was printed — the tail when
    it matched only once whitespace was folded."""
    at = printed.find(expected)
    if at < 0:
        return _tail(printed)
    start = printed.rfind("\n", 0, max(0, at - EXCERPT_CHARS + 300)) + 1
    end = printed.find("\n", at + len(expected) + 300)
    return printed[start:end if end >= 0 else None].strip()

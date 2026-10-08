"""Everything that would fail later, asked now.

WHY THIS EXISTS. A factory run is cheap to start and expensive to lose. The
failures that hurt most are not the interesting ones — they are a missing
provider key, a `base_ref` that does not exist, a `data_dir` nothing can write
to. Every one of them is knowable in milliseconds, and every one of them used
to surface partway into a chain, after a planner had already been paid for.

So the checks live here, in one module, and they are asked in two places:

  * `before_run(cfg)` — the cheap, unconditional subset, called by
    `session.ensure()` before the worktree, the session's own `run.json` or a
    process record exists. A fatal finding aborts while the repo is untouched.
  * `everything(cfg)` — the full sweep, which is what `just doctor` prints.
    It includes the checks that are too slow, too situational or too noisy to
    put in front of every run: harness reachability, the forge CLI, the quality
    blocks, Docker and the local cockpit's images.

Two rules for anything added here:

1. **A check that cannot be sure says `warn`, never `fatal`.** Refusing to
   start on a guess is worse than the failure it was guessing about. The
   credential check is the live example: pi's provider-to-key mapping is
   authoritative only when `models.json` declares it.
2. **Every finding carries its `fix`.** Naming a problem without naming the
   command that ends it just moves the search earlier; the point of asking now
   is that the answer is actionable while nothing has been spent.

Nothing here knows what a phase is, and nothing here writes to a session's
record. Every answer comes from the config, the filesystem, the environment,
or the harness itself.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

from . import cockpit as local_cockpit
from . import git_helper, harnesses, publish, station
from . import labels as labels_module
from .data_types import AgentConfig, Finding, FactoryConfig
from .utils import anchor, write_atomic

# ── git: the tree a run cuts from ────────────────────────────────────────────

def repo(cfg: FactoryConfig, main_root: Path) -> list[Finding]:
    """Whether this checkout can do what the config says runs will do.

    None of it is fatal on its own — `worktree.ensure()` falls back to running
    in place when there is no repository and no commit, which is a legitimate
    way to run a read-only chain. It is fatal the moment a phase tries to
    commit, and that is an hour later, so it is said out loud now.
    """
    findings: list[Finding] = []
    if not git_helper.is_repo(main_root):
        return [Finding(
            check="git", level="warn",
            detail=f"not a git repository — runs work directly in {main_root}, with "
                   f"no worktree and no branch",
            fix="git init && git commit --allow-empty -m init — without one, a commit "
                "or integrate phase raises")]

    if not git_helper.ref_exists(main_root, "HEAD"):
        findings.append(Finding(
            check="git", level="warn",
            detail="the repository has no commit yet, so there is nothing to branch "
                   "from — runs work directly in this checkout",
            fix="git commit --allow-empty -m init"))
        return findings

    # A configured base_ref that does not resolve is the one git problem that IS
    # fatal: `git worktree add <path> <branch> <base>` fails with a raw git
    # error and the run dies before its first phase, having already minted a
    # session. Better to say which ref, and where it is configured.
    base_ref = cfg.worktree.base_ref
    if cfg.worktree.enabled and base_ref and not git_helper.ref_exists(main_root, base_ref):
        findings.append(Finding(
            check="git", level="fatal",
            detail=f"worktree.base_ref is {base_ref!r}, which does not resolve to a "
                   f"commit in this checkout",
            fix=f"fetch or create {base_ref!r}, or clear worktree.base_ref in the "
                f"config to cut from whatever main has checked out"))
        return findings

    # The engineer's checkout on a session's branch — fixing review feedback by
    # hand — holds that branch, so the session's next run cannot re-create its
    # worktree from it (`worktree.ensure` refuses), and a new run with no
    # base_ref would be cut from another session's work. A warning, not a
    # fatal: it is a perfectly good place to be, until a run needs the branch.
    current = git_helper.current_branch(main_root)
    if cfg.worktree.enabled and current.startswith(cfg.worktree.branch_prefix):
        findings.append(Finding(
            check="git", level="warn",
            detail=f"the main checkout is on {current} — a session's branch, so that "
                   f"session's next run is refused until the checkout leaves it",
            fix="push what you committed there, then `git checkout <your base branch>`"))

    # A check that says nothing when it passes reads as a check that never ran,
    # which in a report is worse than noise — so the good news is a line too.
    cut_from = base_ref or git_helper.current_branch(main_root)
    findings.append(Finding(
        check="git",
        detail=(f"runs branch from {cut_from} into {cfg.worktree.dir}/<adw_id>"
                if cfg.worktree.enabled else
                f"worktree.enabled is false — runs work directly in {main_root}")))
    return findings


# ── publishing: when a session's branch reaches the remote ───────────────────

def publishing(cfg: FactoryConfig, main_root: Path) -> list[Finding]:
    """Which `worktree.publish` this factory runs under, and whether it can.

    Said every time, because the default MOVES: the day a cockpit is configured
    a repository that never set the key starts pushing every session's branch
    as it is created, and the place to learn that is here rather than on the
    forge. The one thing that can be wrong is `on_create` with no remote to
    push to — a warning, not a refusal: the run is the run it always was, and
    only the cockpit is poorer for it.
    """
    if not git_helper.is_repo(main_root) or not git_helper.ref_exists(main_root, "HEAD"):
        return []                       # `repo` has said why nothing branches here
    mode, why = publish.resolve(cfg, main_root)
    remote = cfg.worktree.integration.remote
    if mode == publish.ON_INTEGRATE:
        return [Finding(
            check="publish",
            detail=f"on_integrate ({why}) — a session's branch stays on this machine "
                   f"until an integrate stage pushes it, and a cockpit cannot show what "
                   f"its gates ask about")] if cfg.worktree.enabled else []
    unpublished = "nothing is published, and a cockpit cannot show what a gate asks about"
    if not cfg.worktree.enabled:
        return [Finding(
            check="publish", level="warn",
            detail=f"on_create ({why}), but worktree.enabled is false — a session has no "
                   f"branch of its own, so {unpublished}",
            fix="set `worktree.enabled: true` in asf/factory.yaml, or `worktree.publish: "
                "on_integrate` to say that nothing is meant to be published")]
    if not git_helper.has_remote(main_root, remote):
        return [Finding(
            check="publish", level="warn",
            detail=f"on_create ({why}), but there is no remote named {remote!r} — "
                   f"{unpublished}",
            fix=f"git remote add {remote} <url>, or set `worktree.publish: on_integrate` "
                f"in asf/factory.yaml")]
    return [Finding(
        check="publish",
        detail=f"on_create ({why}) — a session's branch is pushed to {remote} when it is "
               f"created and before every suspend, with the gate's subject committed")]


# ── runtime: where the record is written ─────────────────────────────────────

def runtime(cfg: FactoryConfig, main_root: Path) -> list[Finding]:
    """Whether the session's own directory can be written.

    Anchored to the MAIN checkout, exactly as `session.ensure` anchors it, so
    this asks the same question about the same directory. `data_dir` holds
    `sessions/<adw_id>/`, and with it `run.json`, `events.jsonl`,
    `processes.jsonl`, `context_handoff/` and every envelope — the record every
    other command in the factory reads back (`artifacts.py`). Unwritable, the
    session dies at its first event, after the first agent has been spawned.

    Probed by creating the directory if missing and writing a file that is then
    removed — the same two things the run itself would do a moment later, which
    is the only way to answer honestly. Nothing else is touched.
    """
    target = anchor(main_root, cfg.defaults.data_dir)
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".asf-write-probe"
        write_atomic(probe, "")
        probe.unlink()
    except OSError as error:
        return [Finding(check="runtime", level="fatal",
                        detail=f"data_dir {target} cannot be written: {error}",
                        fix=f"fix the permissions on {target}, or point defaults.data_dir "
                            f"somewhere writable")]
    return [Finding(check="runtime", detail=f"the record is written to {target}")]


# ── credentials: the key the model needs ─────────────────────────────────────

def credentials(agent: AgentConfig) -> list[Finding]:
    """Whether this agent's harness can authenticate, asked of the harness.

    `agents.validate()` checks that a model is WRITTEN correctly. This is the
    other half — that the credential behind it exists — and it is the failure
    that used to land mid-chain, because a provider only complains when it is
    called. A harness that does not implement `credentials` (its CLI brings its
    own auth, as Claude Code's does) contributes nothing here.
    """
    driver = harnesses.HARNESSES.get(agent.harness)
    ask = getattr(driver, "credentials", None)
    return list(ask(agent)) if ask else []


def roster(cfg: FactoryConfig) -> list[Finding]:
    """Every agent in the config: is its harness there, and can it authenticate."""
    findings: list[Finding] = []
    for name in sorted({agent.harness for agent in cfg.agents}):
        driver = harnesses.HARNESSES.get(name)
        if driver is None:
            findings.append(Finding(
                check=f"harness: {name}", level="fatal",
                detail=f"{name!r} is not one of {' | '.join(harnesses.NAMES)}",
                fix="fix `harness:` in the roster, or add the harness — "
                    "references/harnesses.md"))
            continue
        try:
            driver.reachable()
            findings.append(Finding(check=f"harness: {name}",
                                    detail="CLI reachable"))
        except RuntimeError as error:
            findings.append(Finding(
                check=f"harness: {name}", level="fatal", detail=str(error),
                fix="install that CLI and put it on PATH"))
    for agent in cfg.agents:
        findings += credentials(agent)
    return findings


# ── quality: the blocks that decide whether code is done ─────────────────────

def quality(main_root: Path) -> list[Finding]:
    """Which quality blocks are still unwired placeholders.

    The single most expensive default in the factory, which is why it is asked
    twice: the block itself fails when it runs (see `quality.py`), and doctor
    says so before anything runs at all.
    """
    try:
        from . import quality as quality_module
        unwired = quality_module.placeholders()
    except Exception as error:                       # a hand-edited quality.py
        return [Finding(check="quality", level="warn",
                        detail=f"could not inspect asf/engine/quality.py: {error}",
                        fix="open it and confirm every block names a real command")]
    if not unwired:
        return [Finding(check="quality", detail="every block names a real command")]
    return [Finding(
        check="quality", level="warn",
        detail=f"{len(unwired)} block(s) are still placeholders: {', '.join(unwired)}",
        fix="replace the `_placeholder(...)` argv in asf/engine/quality.py with "
            "this repo's real commands, and delete the blocks you do not want. A "
            "placeholder FAILS its phase rather than passing it")]


# ── the forge CLI: what the watchers and integration shell out to ────────────

# `gh pr edit` and `gh issue edit` asked for `projectCards` on every edit until
# this release, and GitHub now answers that field with a hard error — so on
# anything older EVERY label edit fails, whatever the edit was for. That is not
# cosmetic: the label is how both watchers mark a run's outcome, and a `failed`
# that cannot be applied means the next poll finds the same work and buys the
# same failing run again. cli/cli#13282, released in gh 2.98.0.
GH_LABELS_FIXED = (2, 98)


def _gh_version(binary: str) -> tuple[int, ...]:
    """(major, minor) of the CLI's own `--version`, or () when it cannot be read.

    A QUESTION, not a command — an unreadable answer is not a finding. `gh
    version 2.70.0 (2025-04-11)` is the shape; distribution and enterprise
    builds append to it and are read by the same expression.
    """
    try:
        completed = subprocess.run([binary, "--version"], capture_output=True,
                                   text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ()
    found = re.search(r"(\d+)\.(\d+)\.\d+", completed.stdout or "")
    return (int(found.group(1)), int(found.group(2))) if found else ()


def forge(cfg: FactoryConfig) -> list[Finding]:
    """Whether the CLI each enabled forge path needs is on PATH, and can label.

    Only asked about the paths this repository actually turned on. A repo that
    integrates with `mode: merge` and has both watchers off needs no forge CLI
    at all, and telling it about `gh` would be noise.

    THE VERSION IS ASKED BECAUSE PRESENCE IS NOT ENOUGH. An authenticated `gh`
    on PATH that cannot move a label passes every check this used to make, and
    fails the one thing the watchers need it for. `before_run` says a CLI version
    probe belongs here rather than in front of every run, which is where it is.
    """
    wanted: dict[str, list[str]] = {}
    integration = cfg.worktree.integration
    if integration.mode == "pr" and integration.open_pr and integration.pr_command:
        wanted.setdefault(integration.pr_command[0], []).append("worktree.integration.open_pr")
    if cfg.issues.enabled and cfg.issues.list_command:
        wanted.setdefault(cfg.issues.list_command[0], []).append("issues.enabled")
    if cfg.pull_requests.enabled and cfg.pull_requests.list_command:
        wanted.setdefault(cfg.pull_requests.list_command[0], []).append("pull_requests.enabled")

    labels_wanted = (cfg.issues.enabled and cfg.issues.state_command) or \
                    (cfg.pull_requests.enabled and cfg.pull_requests.state_command)

    findings: list[Finding] = []
    for binary, wanted_by in sorted(wanted.items()):
        if shutil.which(binary):
            findings.append(Finding(check=f"forge: {binary}",
                                    detail=f"on PATH, needed by {', '.join(wanted_by)}"))
            version = _gh_version(binary) if binary == "gh" and labels_wanted else ()
            if version and version < GH_LABELS_FIXED:
                findings.append(Finding(
                    check=f"forge: {binary}", level="warn",
                    detail=f"gh {version[0]}.{version[1]} cannot move a label: "
                           f"`gh pr edit` and `gh issue edit` still ask for Projects "
                           f"(classic), which GitHub answers with an error, so every "
                           f"edit fails. The watchers mark a run's outcome with a label "
                           f"— unmarked, a failed run is relaunched on the next poll",
                    fix=f"upgrade gh to {GH_LABELS_FIXED[0]}.{GH_LABELS_FIXED[1]} or "
                        f"newer (`brew upgrade gh`, or your package manager)"))
        else:
            findings.append(Finding(
                check=f"forge: {binary}", level="warn",
                detail=f"{binary!r} is not on PATH, but {', '.join(wanted_by)} needs it",
                fix=f"install {binary} and authenticate it, or turn that path off in "
                    f"the config. A watcher without it polls forever and lists nothing"))
    return findings


# ── the labels the config names, and whether the forge defines them ──────────

def labels(cfg: FactoryConfig, main_root: Path) -> list[Finding]:
    """Whether every label this config will try to apply actually exists.

    Doctor-only, never `before_run`: it is a network round-trip, and what it
    asks about changes roughly twice a year. It is also the check that catches
    the UPGRADE path, which is the one the installer can never reach — a repo
    stamped a release ago keeps its own factory.yaml (that is the whole point
    of `--force` not eating it), so a release that adds a label adds a
    reference and no way for the name to exist. This says so.

    Warn, never fatal, in both directions: a label that is missing does not stop
    the run that does not use it, and a forge that could not be asked has told
    us nothing — see `labels.survey`, and rule 1 at the top of this module.
    """
    found = labels_module.survey(cfg, main_root)
    if not found.applicable:
        return []                                  # nothing to check, or not this tracker
    if not found.asked:
        return [Finding(
            check="forge labels", level="warn",
            detail=f"could not ask which labels the project defines — {found.note}",
            fix="name the project in issues.project, authenticate the forge CLI, or "
                "clear issues.labels_list_command if this tracker does not define "
                "labels that way. Nothing is assumed either way: the labels below "
                "may all be fine")]
    # Said in both outcomes, never only the green one: a renamed route leaves its
    # old label behind, and the items still carrying it are evidence rather than
    # litter — which is also why nothing here offers to delete it.
    aside = (f" · {', '.join(found.stale)} defined here but named by nothing in the "
             f"config" if found.stale else "")
    if not found.missing:
        return [Finding(
            check="forge labels",
            detail=f"{len(found.referenced)} label(s) the config names are all "
                   f"defined{aside}")]
    return [Finding(
        check="forge labels", level="warn",
        detail=f"{len(found.missing)} label(s) this config applies do not exist at the "
               f"forge: {', '.join(label.name for label in found.missing)} — "
               f"a route nobody can label is a workflow nothing can trigger, and "
               f"`--add-label` on an undefined name fails the write it rides on{aside}",
        fix="uv run asf/asf.py labels --create  (adds exactly these, nothing else)")]


# ── the skill this factory was stamped from ──────────────────────────────────

def stamped_version(main_root: Path) -> list[Finding]:
    """Which release stamped this factory, against the release the skill is.

    Never a refusal: an old stamp runs exactly as it did. What an older one
    gets is the way forward — the upgrade cookbook, which walks a stamp to the
    skill's release one decision at a time, because `install.py --force` alone
    refreshes the code and leaves every key the operator's config lacks unset.
    A stamp NEWER than the skill is the other way round: the checkout of the
    skill was left behind, and a `--force` from it would stamp older code."""
    record = main_root / "asf" / ".skill-version"
    recorded = record.read_text().strip() if record.is_file() else ""
    stamped = f"stamped at {recorded}" if recorded else "stamped before 1.1"
    root = _skill_root()
    if root is None:
        return [Finding(check="skill version", level="ok" if recorded else "warn",
                        detail=f"{stamped} · the skill's own release is unknown: ASF_SKILL "
                               f"does not point at it",
                        fix="set ASF_SKILL in .env to the skill directory, then `doctor` "
                            "again: a stamp that records no release is older than any "
                            "that does, and the skill's cookbooks/upgrade.md walks it forward")]
    current = (root / "templates" / "asf" / ".skill-version").read_text().strip()
    detail = f"{stamped} · skill is {current}"
    if recorded == current:
        return [Finding(check="skill version", detail=detail)]
    if recorded and None not in (_release(recorded), _release(current)) \
            and _release(recorded) > _release(current):
        return [Finding(check="skill version", level="warn",
                        detail=f"{detail} — the skill is older than the stamp",
                        fix=f"update the skill at {root} before installing from it: "
                            f"`install.py --force` from there would stamp older code over "
                            f"this")]
    return [Finding(check="skill version", level="warn",
                    detail=f"{detail} — this factory runs an older release's code",
                    fix=f"upgrade it: {root / 'cookbooks' / 'upgrade.md'} — nothing is "
                        f"refused meanwhile")]


def _release(version: str) -> tuple[int, int, int, int] | None:
    """A version's place in release order, or None when it is not semver. A
    pre-release (`1.2.0-rc1`) sorts before the release it leads to."""
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(-)?", version)
    if not match:
        return None
    return int(match[1]), int(match[2]), int(match[3]), 0 if match[4] else 1


def _skill_root() -> Path | None:
    """The skill directory ASF_SKILL names, or None when it names none.

    The one way a stamp can find the skill it came from: `install.py` writes
    the path into `.env`. Whoever retires ASF_SKILL owes `stamped_version`
    another way to read the skill's release."""
    raw = os.environ.get("ASF_SKILL", "").strip()
    root = Path(raw).expanduser() if raw else None
    if root is None or not (root / "templates" / "asf" / ".skill-version").is_file():
        return None
    return root


def skill() -> list[Finding]:
    """Whether ASF_SKILL still points at the agentic-sf skill directory.

    install.py writes it into .env, and a `.env` that travelled to another
    machine with the repo is the way this goes wrong — the path is real on
    somebody's laptop and absent here.
    """
    raw = os.environ.get("ASF_SKILL", "").strip()
    if not raw:
        return [Finding(
            check="ASF_SKILL", level="warn",
            detail="unset — `just uninstall`, and re-installing or upgrading the factory, "
                   "cannot find the skill",
            fix="re-run install.py from the target repo root; it writes the path "
                "into .env. A repo cloned without its (gitignored) .env lands here")]
    root = Path(raw).expanduser()
    if not (root / "scripts" / "install.py").is_file():
        return [Finding(
            check="ASF_SKILL", level="warn",
            detail=f"{raw} does not look like the agentic-sf skill (no scripts/install.py) — "
                   f"a .env from another machine does exactly this",
            fix="set ASF_SKILL in .env to this machine's skill directory, or "
                "re-run install.py from the target repo root")]
    return [Finding(check="ASF_SKILL", detail=str(root))]


# ── the cockpit `asf up` starts ──────────────────────────────────────────────

def cockpit(data: Path | None = None) -> list[Finding]:
    """Whether `asf up` can start the local cockpit, and which one it would run
    — or, with a shared cockpit configured, what this station ships to it with.

    With ASF_COCKPIT_URL set nothing here needs Docker: the question is the
    ingest token, ASF_COCKPIT_TOKEN or the one a registration kept under
    `data` (the data_dir, anchored), and without either nothing ships. Warn, never fatal — without Docker `up` still
    runs every watcher, and a run never needed a cockpit at all. The images
    are asked about so the first `up` is not a surprise: a missing one is
    pulled then, and that is minutes on a slow line.
    """
    shared = local_cockpit.shared()
    if shared:
        return [_shared(shared, data)]
    problem = local_cockpit.docker_problem()
    if problem:
        return [Finding(
            check="cockpit", level="warn",
            detail=f"{problem} — `asf up` runs the watchers without the local cockpit "
                   f"{local_cockpit.version()}, and nothing is shipped",
            fix="install Docker (Docker Desktop, or docker-ce with the compose plugin) and "
                "start it — or set ASF_COCKPIT_URL (and ASF_COCKPIT_TOKEN) in .env to a "
                "shared cockpit")]
    findings: list[Finding] = []
    running = local_cockpit.version()
    pinned = local_cockpit.ignored_pin()
    if pinned:
        findings.append(Finding(
            check="cockpit", level="warn",
            detail=f"ASF_COCKPIT_VERSION is {pinned!r}, which is not a release at least "
                   f"{local_cockpit.minimum()} (this stamp's minimum) — `asf up` runs {running}",
            fix="remove ASF_COCKPIT_VERSION from .env, or set it to a release at least "
                "that new"))
    already = local_cockpit.running()
    if already and local_cockpit.newer(already):
        findings.append(Finding(
            check="cockpit",
            detail=f"local {already} is running on this machine — `asf up` joins it "
                   f"rather than starting {running}"))
        return findings
    # The `up` that starts the local cockpit is the one whose token it asks
    # the forge with; one that joins another's hands over nothing.
    forge = local_cockpit.forge_credential()
    findings.append(Finding(
        check="cockpit forge", level="ok" if forge.token else "warn", detail=forge.line,
        fix="" if forge.token else
            "gh auth login (with GH_HOST set for an Enterprise Server) — the local cockpit "
            "asks the forge with your own token, and without one its Factories page shows "
            "only what this machine's stations ship"))
    if already and already != running:
        findings.append(Finding(
            check="cockpit", level="warn",
            detail=f"local {already} is running on this machine, older than {running} — "
                   f"`asf up` here replaces it, for every factory that ships to it",
            fix="nothing to do if that is what you want: the cockpit reads every older "
                "factory's events, so upgrading it first is always safe"))
    missing = local_cockpit.missing_images(running)
    findings.append(Finding(
        check="cockpit",
        detail=(f"local {running} at {local_cockpit.app_url()} — " +
                (f"not pulled yet ({', '.join(missing)}); the first `asf up` pulls it"
                 if missing else "its images are here"))))
    return findings


# ── composition ──────────────────────────────────────────────────────────────

def _shared(url: str, data: Path | None) -> Finding:
    """A shared cockpit, and the ingest token this station ships to it with."""
    token = station.shipped_with(data)
    if token:
        return Finding(check="cockpit", detail=f"shared: {url} — ships with {token}; `asf up` "
                                               f"starts no local one")
    return Finding(check="cockpit", level="warn",
                   detail=f"shared: {url} — no ingest token, so nothing ships to it",
                   fix="`just station-register`, and have someone with write on the repository "
                       "approve the code in the cockpit (cookbooks/connect_cockpit.md) — or set "
                       "ASF_COCKPIT_TOKEN to an ingest token the cockpit issued")


def before_run(cfg: FactoryConfig, main_root: Path | None = None) -> list[Finding]:
    """The subset every run is worth paying for. Raises SystemExit on a fatal.

    Deliberately small and deliberately fast: git questions the run is about to
    ask anyway, and one write probe. Everything slower — a CLI version probe, a
    port bind, a forge lookup — belongs to `doctor`, because a check that adds a
    second to every run is a check people turn off.

    Returns the warnings, for the caller to surface once it has a console.
    """
    root = Path(main_root) if main_root else git_helper.main_root()
    findings = (repo(cfg, root) + publishing(cfg, root)
                + runtime(cfg, root))                 # ok findings are dropped below
    fatal = [finding for finding in findings if finding.level == "fatal"]
    if fatal:
        raise SystemExit("preflight failed:\n" + "\n".join(
            f"- {finding.line}\n  fix: {finding.fix}" for finding in fatal))
    return [finding for finding in findings if finding.level == "warn"]


def everything(cfg: FactoryConfig, main_root: Path | None = None) -> list[Finding]:
    """Every check there is, ordered the way an engineer would read them."""
    root = Path(main_root) if main_root else git_helper.main_root()
    return (repo(cfg, root) + runtime(cfg, root) + roster(cfg) + quality(root)
            + forge(cfg) + labels(cfg, root) + stamped_version(root) + cockpit(anchor(root, cfg.defaults.data_dir))
            + publishing(cfg, root) + skill())

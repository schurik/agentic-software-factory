"""GitHub, through `gh`: the one module that knows the CLI's flags and the
shapes it answers in.

Commands rather than API calls, still: `gh` is installed and authenticated in
the engineer's shell already, and every call here runs under `operator_env()`,
so it resolves exactly as it does in their terminal — not through the ephemeral
venv `uv run` hands this process. GitHub Enterprise is `gh`'s own business:
GH_HOST names the host, and nothing here assumes github.com beyond its default.

WHY GRAPHQL FOR A PULL REQUEST, when everything else is a CLI subcommand.
Review threads are the one thing the factory needs that `gh pr view --json`
cannot produce: it returns issue-level comments and review bodies, but the
inline threads — where the actual asks live, and the only place `isResolved`
exists — are reachable only through graphql. One query returns the state AND
the threads in one consistent snapshot. An issue's `labeled` events are read the
same way, because `gh issue view --json` has no timeline.

Every call is aimed with `--repo` when a project is known, never at whatever
the working directory happens to be: a watcher under cron has an arbitrary one.
A benchmark's session makes no call at all (`benchmark_session.refused`).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from typing import Optional

from .. import benchmark_session, git_helper
from ..data_types import (FactoryConfig, Finding, IssueComment, IssueUpdate, Label, NewIssue,
                          OpenIssue, OpenPull, Proposal, Pull, PullRequestClosed,
                          PullRequestContext, PullRequestUpdate, ReviewComment, ReviewThread)
from ..utils import operator_env
from . import ForgeError

HOST = "github.com"
SIGN_IN = "`gh auth login` (with GH_HOST set for an Enterprise Server)"

# `gh label list` answers 30 at a time unless told otherwise, and a repository
# with a real taxonomy has more than that. A truncated listing would report
# labels as missing and then try to create ones that already exist.
LABEL_LIMIT = "500"

# `gh pr edit` and `gh issue edit` asked for `projectCards` on every edit until
# this release, and GitHub now answers that field with a hard error — so on
# anything older EVERY label edit fails, whatever the edit was for. That is not
# cosmetic: the label is how both watchers mark a run's outcome, and a `failed`
# that cannot be applied means the next poll finds the same work and buys the
# same failing run again. cli/cli#13282, released in gh 2.98.0.
LABELS_FIXED = (2, 98)

# The commands factory.yaml spelt before 1.3, each with the default it was
# stamped with and the key that took its place — this module, behind `forge:`
# or `tracker:`. Only `gh` ever worked behind them. The loader drops one still
# at its default and refuses one a person changed (`factory._retired`), and the
# installer says which is which (`install.py`'s own copy of this table).
RETIRED: dict[tuple[str, ...], tuple[list[str], str]] = {
    ("worktree", "integration", "pr_command"): (["gh", "pr", "create", "--fill"], "forge"),
    ("issues", "fetch_command"): (["gh", "issue", "view"], "tracker"),
    ("issues", "list_command"): (["gh", "issue", "list"], "tracker"),
    ("issues", "comment_command"): (["gh", "issue", "comment"], "tracker"),
    ("issues", "state_command"): (["gh", "issue", "edit"], "tracker"),
    ("issues", "comments_command"): (["gh", "issue", "view"], "tracker"),
    ("issues", "body_command"): (["gh", "issue", "edit"], "tracker"),
    ("issues", "create_command"): (["gh", "issue", "create"], "tracker"),
    ("issues", "labels_list_command"): (["gh", "label", "list"], "tracker"),
    ("issues", "labels_create_command"): (["gh", "label", "create"], "tracker"),
    ("issues", "labeller_command"): (["gh", "api", "graphql"], "tracker"),
    ("pull_requests", "list_command"): (["gh", "pr", "list"], "forge"),
    ("pull_requests", "comment_command"): (["gh", "pr", "comment"], "forge"),
    ("pull_requests", "state_command"): (["gh", "pr", "edit"], "forge"),
    ("pull_requests", "graphql_command"): (["gh", "api", "graphql"], "forge"),
}


def _run(argv: list[str], tree) -> subprocess.CompletedProcess:
    """Run one `gh` command. Never raises: a CLI that is not installed is an
    answer too — `doctor` on a bare machine is exactly when it is asked."""
    refused = benchmark_session.refused(argv)
    if refused is not None:
        return refused
    try:
        return subprocess.run(argv, cwd=str(tree), env=operator_env(),
                              capture_output=True, text=True)
    except OSError as error:
        return subprocess.CompletedProcess(argv, 127, "", str(error))


def _said(completed: subprocess.CompletedProcess, keep: int = 500) -> str:
    return (completed.stderr or completed.stdout or "").strip()[-keep:]


def _aim(argv: list[str], project: str, number: Optional[int] = None) -> list[str]:
    aimed = [*argv, *([str(number)] if number is not None else [])]
    return aimed + (["--repo", project] if project else [])


def _write(argv: list[str], tree, verb: str) -> subprocess.CompletedProcess:
    """A write. Raises with the command named: the caller turns it into evidence."""
    completed = _run(argv, tree)
    if completed.returncode != 0:
        raise ForgeError(f"`gh {verb}` failed: {_said(completed)}")
    return completed


def _read(argv: list[str], tree, verb: str, what: str):
    """A read, parsed as JSON. Raises naming `what` it was reading."""
    completed = _run(argv, tree)
    if completed.returncode != 0:
        raise ForgeError(f"could not read {what}: {_said(completed)}")
    try:
        return json.loads(completed.stdout or "null")
    except json.JSONDecodeError as error:
        raise ForgeError(f"`gh {verb}` did not return JSON for {what}: {error}") from error


def _login(entry) -> str:
    return str(entry.get("login", "")) if isinstance(entry, dict) else str(entry or "")


def _names(labels) -> list[str]:
    return [entry.get("name", "") if isinstance(entry, dict) else str(entry)
            for entry in labels or []]


def _split(project: str) -> tuple[str, str]:
    owner, _, name = project.partition("/")
    return owner, name


def _in(project: str) -> str:
    return f" in {project}" if project else ""


def _graphql(tree, query: str, **variables) -> dict:
    """One graphql call, its `data`. Raises on an error — and `gh` reports a
    graphql error with exit code 0 and an `errors` key often enough that the
    return code alone is not enough: a caller that trusted it would read a
    missing pull request as an empty one."""
    argv = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        argv += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    completed = _run(argv, tree)
    text = (completed.stdout or "").strip()
    if completed.returncode != 0 and not text:
        raise ForgeError((completed.stderr or "").strip()[-500:] or "`gh api graphql` failed")
    try:
        payload = json.loads(text or "{}")
    except json.JSONDecodeError:
        raise ForgeError(f"`gh api graphql` did not return JSON: {text[-300:]}") from None
    if payload.get("errors"):
        raise ForgeError("; ".join(entry.get("message", "")
                                   for entry in payload["errors"])[-500:])
    return payload.get("data") or {}


# ── work items ───────────────────────────────────────────────────────────────

# The issue's `labeled` events, newest last. A hundred is far more label
# changes than an issue sees, and the newest are what is asked about.
_LABELLED = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
        nodes { ... on LabeledEvent { createdAt actor { login } label { name } } }
      }
    }
  }
}"""


class GitHubTracker:
    """GitHub Issues: the tracker `tracker: github` selects."""

    def _view(self, tree, project: str, number: int, fields: str) -> dict:
        payload = _read(_aim(["gh", "issue", "view"], project, number) + ["--json", fields],
                        tree, "issue view", f"issue #{number}{_in(project)}")
        return payload if isinstance(payload, dict) else {}

    def issue(self, tree, project: str, number: int) -> OpenIssue:
        payload = self._view(tree, project, number,
                             "number,title,body,labels,author,assignees,state,url")
        return OpenIssue(number=int(payload.get("number") or number),
                         url=payload.get("url") or "", title=payload.get("title") or "",
                         body=payload.get("body") or "", labels=_names(payload.get("labels")),
                         author=_login(payload.get("author")),
                         assignees=[_login(entry) for entry in payload.get("assignees") or []],
                         state=payload.get("state") or "")

    def comments(self, tree, project: str, number: int) -> list[IssueComment]:
        payload = self._view(tree, project, number, "comments")
        return [IssueComment(id=str(entry.get("id", "")), author=_login(entry.get("author")),
                             body=entry.get("body") or "",
                             created_at=entry.get("createdAt") or entry.get("created_at") or "",
                             url=entry.get("url") or "")
                for entry in payload.get("comments") or []]

    def _list(self, tree, project: str, label: str, fields: str, limit: int) -> list[dict]:
        argv = _aim(["gh", "issue", "list"], project) + [
            "--label", label, "--state", "open", "--json", fields, "--limit", str(limit)]
        listed = _read(argv, tree, "issue list", f"the open issues labelled {label}")
        return [entry for entry in listed or [] if isinstance(entry, dict)]

    def queued(self, tree, project: str, label: str) -> list[OpenIssue]:
        return [OpenIssue(number=int(entry.get("number") or 0), title=entry.get("title") or "",
                          labels=_names(entry.get("labels")),
                          author=_login(entry.get("author")))
                for entry in self._list(tree, project, label, "number,title,labels,author", 50)]

    def labelled(self, tree, project: str, label: str) -> list[OpenIssue]:
        return [OpenIssue(number=int(entry.get("number") or 0), url=str(entry.get("url") or ""),
                          title=str(entry.get("title") or ""), body=str(entry.get("body") or ""),
                          comments=[str((each or {}).get("body") or "")
                                    for each in entry.get("comments") or []])
                for entry in self._list(tree, project, label,
                                        "number,url,title,body,comments", 20)]

    def comment(self, tree, project: str, number: int, body: str) -> None:
        _write(_aim(["gh", "issue", "comment"], project, number) + ["--body", body], tree,
               "issue comment")

    def set_labels(self, tree, update: IssueUpdate) -> None:
        _write(_aim(["gh", "issue", "edit"], update.project, update.number)
               + _label_flags(update.add_labels, update.remove_labels), tree, "issue edit")

    def set_body(self, tree, project: str, number: int, body: str) -> None:
        _write(_aim(["gh", "issue", "edit"], project, number) + ["--body", body], tree,
               "issue edit")

    def create(self, tree, project: str, issue: NewIssue) -> str:
        argv = _aim(["gh", "issue", "create"], project) + ["--title", issue.title,
                                                         "--body", issue.body]
        for label in issue.labels:
            argv += ["--label", label]
        printed = _write(argv, tree, "issue create").stdout.strip()
        last = printed.splitlines()[-1].strip() if printed else ""     # the filed issue's url
        return last if last.startswith("http") else ""

    def labels(self, tree, project: str) -> Optional[list[str]]:
        argv = ["gh", "label", "list", *(["--repo", project] if project else []),
                "--limit", LABEL_LIMIT, "--json", "name"]
        payload = _read(argv, tree, "label list", f"the labels{_in(project)}")
        return [entry.get("name", "") for entry in payload or [] if isinstance(entry, dict)]

    def define_label(self, tree, project: str, label: Label) -> None:
        argv = ["gh", "label", "create", label.name, *(["--repo", project] if project else []),
                "--color", label.color, "--description", label.why]
        completed = _run(argv, tree)
        if completed.returncode != 0:
            raise ForgeError(f"{label.name}: {_said(completed, 300)}")

    def labeller(self, tree, project: str, number: int, labels: list[str]) -> str:
        # A route label stays on an issue for good, so somebody who queues it
        # again is the one who started this run — and `gh issue edit
        # --add-label` on a label the issue already carries adds no event.
        owner, name = _split(project)
        if not owner or not name:
            return ""
        try:
            data = _graphql(tree, _LABELLED, owner=owner, name=name, number=int(number))
        except ForgeError:                              # nobody said
            return ""
        issue = ((data.get("repository") or {}).get("issue") or {})
        for node in reversed((issue.get("timelineItems") or {}).get("nodes") or []):
            if ((node or {}).get("label") or {}).get("name") in labels:
                return _login(node.get("actor"))
        return ""

    def doctor(self, cfg: FactoryConfig) -> list[Finding]:
        return _doctor(cfg)


def _label_flags(add: list[str], remove: list[str]) -> list[str]:
    flags: list[str] = []
    for label in add:
        flags += ["--add-label", label]
    for label in remove:
        flags += ["--remove-label", label]
    return flags


# ── pull requests ────────────────────────────────────────────────────────────

# One query for the state, the threads and the conversation. `first: 100` on
# threads and `50` on their comments is not pagination — it is a ceiling, and
# `max_threads` narrows what is acted on afterwards. The conversation is read
# from its END (`last:`), because what is outstanding there is what came after
# the factory's own latest word.
_PR_QUERY = """
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      number title url state isDraft baseRefName headRefName reviewDecision
      author { login }
      reviewThreads(first:100) {
        nodes {
          id isResolved isOutdated path line
          comments(first:50) { nodes { databaseId body createdAt author { login } } }
        }
      }
      comments(last:100) { nodes { databaseId body createdAt author { login } } }
      reviews(last:50) { nodes { databaseId body state submittedAt author { login } } }
    }
  }
}
"""

# What a pull request that closed is read for, and only then — one query more
# per pull request reaped, never one per poll. `commits` is capped where the
# forge caps a pull request's commits anyway; `parents` is how a merge commit
# is told from the commits around it. Reviews come oldest first.
_CLOSED_QUERY = """
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      number url state mergedAt additions deletions
      reviews(first:1) { nodes { submittedAt } }
      commits(first:250) {
        nodes { commit { oid parents(first:2) { nodes { oid } } } }
      }
    }
  }
}
"""

_REPLY_MUTATION = """
mutation($threadId:ID!, $body:String!) {
  addPullRequestReviewThreadReply(
    input:{pullRequestReviewThreadId:$threadId, body:$body}) {
    comment { id }
  }
}
"""

_RESOLVE_MUTATION = """
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) { thread { isResolved } }
}
"""


def _comment(entry: dict, at: str = "") -> ReviewComment:
    return ReviewComment(comment_id=int(entry.get("databaseId") or 0),
                         author=_login(entry.get("author")), body=entry.get("body") or "",
                         created_at=at or entry.get("createdAt") or "")


def _threads_of(payload: dict) -> list[ReviewThread]:
    return [ReviewThread(thread_id=node.get("id") or "", path=node.get("path") or "",
                         line=node.get("line"), resolved=bool(node.get("isResolved")),
                         outdated=bool(node.get("isOutdated")),
                         comments=[_comment(entry) for entry in
                                   (node.get("comments") or {}).get("nodes") or []])
            for node in (payload.get("reviewThreads") or {}).get("nodes") or []]


def _comments_of(payload: dict) -> list[ReviewComment]:
    """The conversation, oldest first: plain comments, and the body of every
    submitted review. A review with no body is the envelope its inline comments
    came in — they are in the threads already — and a PENDING one is a draft
    only its author can see, which the forge still hands that author's token."""
    plain = [_comment(entry) for entry in (payload.get("comments") or {}).get("nodes") or []]
    reviews = [_comment(entry, entry.get("submittedAt") or "")
               for entry in (payload.get("reviews") or {}).get("nodes") or []
               if (entry.get("body") or "").strip()
               and str(entry.get("state") or "").upper() != "PENDING"]
    return sorted([*plain, *reviews], key=lambda comment: comment.created_at)


def _existing_pr_url(output: str) -> str:
    """The url `gh` names when it refuses to open a second pull request — `a
    pull request for branch "x" into branch "main" already exists:` and the url.
    A url is required before the refusal is read as "there is already one":
    this must not turn an authentication error into a success."""
    lowered = output.lower()
    if not any(phrase in lowered for phrase in
               ("already exists", "already open", "existing pull request")):
        return ""
    return next((word.rstrip(".,);") for word in output.split()
                 if word.startswith("http")), "")


class GitHubForge:
    """GitHub pull requests and review threads: the forge `forge: github` selects."""

    sign_in = SIGN_IN

    def pulls(self, tree, project: str, limit: int) -> list[OpenPull]:
        argv = _aim(["gh", "pr", "list"], project) + [
            "--state", "open", "--json", "number,headRefName,labels,isDraft",
            "--limit", str(limit)]
        listed = _read(argv, tree, "pr list", f"the open pull requests{_in(project)}")
        return [OpenPull(number=int(entry.get("number") or 0),
                         branch=str(entry.get("headRefName") or ""),
                         labels=_names(entry.get("labels")), draft=bool(entry.get("isDraft")))
                for entry in listed or [] if isinstance(entry, dict)]

    def pull_request(self, tree, project: str, number: int) -> PullRequestContext:
        owner, name = _split(project)
        try:
            data = _graphql(tree, _PR_QUERY, owner=owner, name=name, number=int(number))
        except ForgeError as error:
            raise ForgeError(f"could not read pull request #{number} in {project}: "
                             f"{error}") from None
        payload = ((data.get("repository") or {}).get("pullRequest") or {})
        if not payload:
            raise ForgeError(f"there is no pull request #{number} in {project}")
        return PullRequestContext(
            number=int(payload.get("number", number)), project=project,
            url=payload.get("url") or "", title=payload.get("title") or "",
            state=payload.get("state") or "", draft=bool(payload.get("isDraft")),
            author=_login(payload.get("author")), branch=payload.get("headRefName") or "",
            base_ref=payload.get("baseRefName") or "",
            review_decision=payload.get("reviewDecision") or "",
            threads=_threads_of(payload), comments=_comments_of(payload))

    def closed(self, tree, project: str, number: int) -> PullRequestClosed:
        # A BASE MERGE is a commit with a parent outside the pull request's own
        # commits other than its first: it brought history from elsewhere in —
        # "Update branch", or a person merging the base by hand. The first
        # commit's own parent is outside too, which is why only a second counts.
        owner, name = _split(project)
        try:
            data = _graphql(tree, _CLOSED_QUERY, owner=owner, name=name, number=int(number))
        except ForgeError as error:
            raise ForgeError(f"could not read how #{number} in {project} closed: "
                             f"{error}") from None
        payload = ((data.get("repository") or {}).get("pullRequest") or {})
        if not payload:
            raise ForgeError(f"could not read how #{number} in {project} closed: "
                             f"there is no such pull request")
        commits = [node.get("commit") or {}
                   for node in (payload.get("commits") or {}).get("nodes") or []]
        shas = [commit.get("oid") or "" for commit in commits]
        ours = set(shas)
        merges = [commit.get("oid") or "" for commit in commits
                  if any(parent.get("oid") not in ours
                         for parent in ((commit.get("parents") or {}).get("nodes") or [])[1:])]
        reviews = (payload.get("reviews") or {}).get("nodes") or []
        return PullRequestClosed(
            url=payload.get("url") or "", number=int(payload.get("number") or number),
            merged=str(payload.get("state") or "").upper() == "MERGED",
            merged_at=payload.get("mergedAt") or "",
            first_review_at=(reviews[0].get("submittedAt") or "") if reviews else "",
            head_shas=shas, base_merges=merges,
            additions=int(payload.get("additions") or 0),
            deletions=int(payload.get("deletions") or 0))

    def comment(self, tree, project: str, number: int, body: str) -> None:
        _write(_aim(["gh", "pr", "comment"], project, number) + ["--body", body], tree,
               "pr comment")

    def reply(self, tree, thread_id: str, body: str) -> None:
        _graphql(tree, _REPLY_MUTATION, threadId=thread_id, body=body)

    def resolve(self, tree, thread_id: str) -> None:
        _graphql(tree, _RESOLVE_MUTATION, threadId=thread_id)

    def set_labels(self, tree, update: PullRequestUpdate) -> None:
        _write(_aim(["gh", "pr", "edit"], update.project, update.number)
               + _label_flags(update.add_labels, update.remove_labels), tree, "pr edit")

    def pull(self, tree, proposal: Proposal) -> Pull:
        argv = ["gh", "pr", "create", "--base", proposal.base, "--head", proposal.head]
        title = proposal.title
        if proposal.body and not title:
            # `--fill` would have supplied the title, but gh rejects it beside
            # an explicit `--body`, and refuses to run non-interactively with
            # neither `--fill` nor `--title`. The first commit unique to the
            # branch is what `--fill` itself falls back to for one commit, and
            # reads fine for several.
            title = git_helper.first_subject(tree, proposal.base, proposal.head)
        if title:
            argv += ["--title", title]
        argv += ["--body", proposal.body] if proposal.body else ["--fill"]
        completed = _run(argv, tree)
        output = _said(completed, 100_000)
        if completed.returncode != 0:
            existing = _existing_pr_url(output)
            if not existing:
                raise ForgeError(f"`gh pr create` failed: {output[-500:]}")
            return Pull(url=existing, existing=True)
        return Pull(url=next((word for word in (completed.stdout or "").split()
                              if word.startswith("http")), ""))

    def host(self) -> str:
        return os.environ.get("GH_HOST", "").strip() or HOST

    def person(self) -> str:
        """The account `gh` acts as on its host, from `gh`'s own config — no
        network — else, in a GitHub Actions job, the actor it runs for."""
        try:
            done = subprocess.run(["gh", "config", "get", "-h", self.host(), "user"],
                                  capture_output=True, text=True, timeout=10,
                                  env=operator_env())
        except (OSError, subprocess.SubprocessError):
            done = None
        login = done.stdout.strip() if done is not None and done.returncode == 0 else ""
        if len(login.split()) == 1:
            return login
        return os.environ.get("GITHUB_ACTOR", "").strip()

    def token(self) -> str:
        """What `gh auth token` prints for the host — stdout only: stderr is
        `gh` explaining itself."""
        try:
            done = subprocess.run(["gh", "auth", "token", "--hostname", self.host()],
                                  capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            return ""
        token = (done.stdout or "").strip() if done.returncode == 0 else ""
        return token if len(token.split()) == 1 else ""

    def ci_ref(self) -> str:
        """In a GitHub Actions job the checkout is detached — a pull request's
        merge commit, or the pushed commit — so the job's own word for it: the
        pull request's branch, else the pushed one."""
        for name in ("GITHUB_HEAD_REF", "GITHUB_REF_NAME"):
            value = os.environ.get(name, "").strip()
            if value:
                return value
        return ""

    def doctor(self, cfg: FactoryConfig) -> list[Finding]:
        return _doctor(cfg)


# ── doctor ───────────────────────────────────────────────────────────────────

def _version() -> tuple[int, ...]:
    """(major, minor) of `gh --version`, or () when it cannot be read — a
    question, not a command: an unreadable answer is not a finding. `gh version
    2.70.0 (2025-04-11)` is the shape; distribution and enterprise builds append
    to it and are read by the same expression."""
    try:
        completed = subprocess.run(["gh", "--version"], capture_output=True, text=True,
                                   timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ()
    found = re.search(r"(\d+)\.(\d+)\.\d+", completed.stdout or "")
    return (int(found.group(1)), int(found.group(2))) if found else ()


def _doctor(cfg: FactoryConfig) -> list[Finding]:
    """Whether `gh` is on PATH for each path on GitHub that is on, and can move
    a label. A repository that integrates with `mode: merge` and has both
    watchers off needs no `gh` at all, and telling it about one is noise.

    THE VERSION IS ASKED BECAUSE PRESENCE IS NOT ENOUGH: an authenticated `gh`
    that cannot move a label passes every other check, and fails the one thing
    the watchers need it for."""
    integration = cfg.worktree.integration
    on_forge, on_tracker = cfg.forge == "github", cfg.tracker == "github"
    wanted = [*(["worktree.integration.open_pr"] if on_forge and integration.mode == "pr"
                and integration.open_pr else []),
              *(["issues.enabled"] if on_tracker and cfg.issues.enabled else []),
              *(["pull_requests.enabled"] if on_forge and cfg.pull_requests.enabled else [])]
    if not wanted:
        return []
    if not shutil.which("gh"):
        return [Finding(check="forge: gh", level="warn",
                        detail=f"'gh' is not on PATH, but {', '.join(wanted)} needs it",
                        fix="install gh and authenticate it, or turn that path off in the "
                            "config. A watcher without it polls forever and lists nothing")]
    found = [Finding(check="forge: gh", detail=f"on PATH, needed by {', '.join(wanted)}")]
    labelling = (on_tracker and cfg.issues.enabled) or (on_forge and cfg.pull_requests.enabled)
    version = _version() if labelling else ()
    if version and version < LABELS_FIXED:
        found.append(Finding(
            check="forge: gh", level="warn",
            detail=f"gh {version[0]}.{version[1]} cannot move a label: `gh pr edit` and "
                   f"`gh issue edit` still ask for Projects (classic), which GitHub answers "
                   f"with an error, so every edit fails. The watchers mark a run's outcome "
                   f"with a label — unmarked, a failed run is relaunched on the next poll",
            fix=f"upgrade gh to {LABELS_FIXED[0]}.{LABELS_FIXED[1]} or newer (`brew upgrade "
                f"gh`, or your package manager)"))
    return found

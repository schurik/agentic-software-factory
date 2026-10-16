"""A forge and a tracker in memory: the development tool, as the fake harness is.

`forge: fake` / `tracker: fake` select `FAKE`, one object for both, so a test
seeds it, runs the engine in the same process and reads back what was written.
It also answers the questions GitHub never declines — a tracker that defines no
labels (`defines_labels`), one that cannot say who applied one
(`knows_labellers`) — which is how the engine's handling of those is tested.
Nothing offers it, and a separate process does not share its memory.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from ..data_types import (FactoryConfig, Finding, IssueComment, IssueUpdate, Label, NewIssue,
                          OpenIssue, OpenPull, Proposal, Pull, PullRequestClosed,
                          PullRequestContext, PullRequestUpdate, ReviewComment)
from . import ForgeError


class Fake:
    """Issues and pull requests share one number space, as they do on GitHub."""

    sign_in = "nothing to sign in to: the fake forge lives in memory"

    def __init__(self) -> None:
        self.issues: dict[int, OpenIssue] = {}
        self.issue_comments: dict[int, list[IssueComment]] = {}
        self.pull_requests: dict[int, PullRequestContext] = {}
        self.closings: dict[int, PullRequestClosed] = {}
        self.pull_labels: dict[int, list[str]] = {}
        self.defined: list[str] = []
        self.applied_by: dict[str, str] = {}          # label -> the login that applied it
        self.defines_labels = True
        self.knows_labellers = True
        self.refuse: set[str] = set()                 # method names that fail
        self.login = ""
        self.calls: list[tuple] = []

    def _call(self, name: str, *args) -> None:
        self.calls.append((name, *args))
        if name in self.refuse:
            raise ForgeError(f"the fake refuses {name}")

    def _issue(self, number: int) -> OpenIssue:
        if number not in self.issues:
            raise ForgeError(f"could not read issue #{number}: there is none")
        return self.issues[number]

    # ── Tracker ──────────────────────────────────────────────────────────────

    def issue(self, tree: Path, project: str, number: int) -> OpenIssue:
        self._call("issue", number)
        return self._issue(number).model_copy(deep=True)

    def comments(self, tree: Path, project: str, number: int) -> list[IssueComment]:
        self._call("comments", number)
        self._issue(number)
        return list(self.issue_comments.get(number, []))

    def _open(self, label: str) -> list[OpenIssue]:
        return [issue.model_copy(deep=True) for issue in self.issues.values()
                if label in issue.labels and issue.state.upper() == "OPEN"]

    def queued(self, tree: Path, project: str, label: str) -> list[OpenIssue]:
        self._call("queued", label)
        return self._open(label)

    def labelled(self, tree: Path, project: str, label: str) -> list[OpenIssue]:
        self._call("labelled", label)
        found = self._open(label)
        for issue in found:
            issue.comments = [each.body for each in self.issue_comments.get(issue.number, [])]
        return found

    def comment(self, tree: Path, project: str, number: int, body: str) -> None:
        self._call("comment", number, body)
        if number in self.pull_requests:
            self.pull_requests[number].comments.append(ReviewComment(body=body))
            return
        self.issue_comments.setdefault(number, []).append(
            IssueComment(id=f"IC_{len(self.issue_comments.get(number, [])) + 1}", body=body))

    def set_labels(self, tree: Path, update: IssueUpdate | PullRequestUpdate) -> None:
        number, add, remove = update.number, update.add_labels, update.remove_labels
        self._call("set_labels", number, list(add), list(remove))
        if number in self.issues:
            labels = self.issues[number].labels
        else:
            labels = self.pull_labels.setdefault(number, [])
        labels[:] = [name for name in labels if name not in remove]
        labels.extend(name for name in add if name not in labels)

    def set_body(self, tree: Path, project: str, number: int, body: str) -> None:
        self._call("set_body", number, body)
        self._issue(number).body = body

    def create(self, tree: Path, project: str, issue: NewIssue) -> str:
        self._call("create", issue.title)
        number = max([0, *self.issues, *self.pull_requests]) + 1
        url = f"https://fake.forge/{project or 'fake/fake'}/issues/{number}"
        self.issues[number] = OpenIssue(number=number, url=url, title=issue.title,
                                        body=issue.body, labels=list(issue.labels),
                                        state="OPEN")
        return url

    def labels(self, tree: Path, project: str) -> Optional[list[str]]:
        self._call("labels")
        return list(self.defined) if self.defines_labels else None

    def define_label(self, tree: Path, project: str, label: Label) -> None:
        self._call("define_label", label.name)
        if label.name in self.defined:
            raise ForgeError(f"{label.name}: already exists")
        self.defined.append(label.name)

    def labeller(self, tree: Path, project: str, number: int, labels: list[str]) -> str:
        if not self.knows_labellers:
            return ""
        return next((self.applied_by[name] for name in reversed(labels)
                     if name in self.applied_by), "")

    # ── Forge ────────────────────────────────────────────────────────────────

    def pulls(self, tree: Path, project: str, limit: int) -> list[OpenPull]:
        self._call("pulls")
        return [OpenPull(number=number, branch=pull.branch, draft=pull.draft,
                         labels=list(self.pull_labels.get(number, [])))
                for number, pull in self.pull_requests.items() if pull.open][:limit]

    def pull_request(self, tree: Path, project: str, number: int) -> PullRequestContext:
        self._call("pull_request", number)
        if number not in self.pull_requests:
            raise ForgeError(f"there is no pull request #{number} in {project}")
        return self.pull_requests[number].model_copy(deep=True)

    def closed(self, tree: Path, project: str, number: int) -> PullRequestClosed:
        self._call("closed", number)
        if number not in self.closings:
            raise ForgeError(f"could not read how #{number} in {project} closed")
        return self.closings[number]

    def reply(self, tree: Path, thread_id: str, body: str) -> None:
        self._call("reply", thread_id, body)

    def resolve(self, tree: Path, thread_id: str) -> None:
        self._call("resolve", thread_id)

    def pull(self, tree: Path, proposal: Proposal) -> Pull:
        self._call("pull", proposal.head)
        for number, pull in self.pull_requests.items():
            if pull.branch == proposal.head and pull.open:
                return Pull(url=pull.url, existing=True)
        number = max([0, *self.issues, *self.pull_requests]) + 1
        url = f"https://fake.forge/fake/fake/pull/{number}"
        self.pull_requests[number] = PullRequestContext(
            number=number, url=url, title=proposal.title, state="OPEN",
            branch=proposal.head, base_ref=proposal.base)
        return Pull(url=url)

    def host(self) -> str:
        return "fake.forge"

    def person(self) -> str:
        return self.login

    def token(self) -> str:
        return ""

    def ci_ref(self) -> str:
        return ""

    def doctor(self, cfg: FactoryConfig) -> list[Finding]:
        return [Finding(check="forge: fake", detail="in memory, for tests")]


FAKE = Fake()

"""Where branches are proposed and where work items live, behind two seams.

`forge:` in factory.yaml names what holds the branches, the pull requests and
their review threads; `tracker:` names what holds the work items, their labels
and the label queue. Two keys because they are two axes — a team can track in
one place and review in another — and each selects an implementation HERE, in
Python, which owns the whole conversation with its service: the command line,
the flags, the shape of what comes back. Nothing outside the implementation
knows any of it, and nothing in factory.yaml spells it.

It used to be config: an argv prefix per verb, with the claim that other CLIs
fit the same verbs. They did not — the engine appended one CLI's flags, parsed
its JSON and spoke its forge's graphql whatever the prefix said — and a key
that only works with one value is a promise the code cannot keep. A second
forge is a second module here, implementing `Tracker`, `Forge` or both; until
one needs otherwise, an issue is an integer and a project an `owner/name`.

THE CONTRACT. Every method takes the tree to run in (a forge CLI resolves its
own login and host from the operator's environment), and one that reads or
writes a project's items takes the project it is aimed at, never inferred from
a working directory — a thread id names its own, and a pull request is opened
from the tree's own remote. A READ raises `ForgeError` when it
cannot answer — a caller deciding something must not decide it against an empty
answer. A WRITE raises `ForgeError` too, and the domain modules (`issues.py`,
`pull_requests.py`, `labels.py`; the watchers list through it directly) turn
that into evidence on a result: a tracker
that did not hear about a finished run is not a failed run. Three questions a
service may have no answer to are answered with None or "", never invented:
which labels a tracker defines (`Tracker.labels`), who applied a label
(`Tracker.labeller`), and who the person at this machine is (`Forge.person`).

Method names follow the cockpit's `apps/cockpit/convex/forge/forge.ts` where
they mean the same thing: `issue`, `comment`, `labels`, `labelled`, `pulls`,
`pull`, `person`.

`fake` is the development tool, as the fake harness is: an in-memory forge and
tracker a test selects with `forge: fake` / `tracker: fake`. Nothing offers it.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Optional, Protocol

if TYPE_CHECKING:
    from ..data_types import (FactoryConfig, Finding, IssueComment, IssueUpdate, Label, NewIssue,
                              OpenIssue, OpenPull, Proposal, Pull, PullRequestClosed,
                              PullRequestContext, PullRequestUpdate)


class ForgeError(RuntimeError):
    """A forge or tracker that could not do what it was asked, in its own words.

    A RuntimeError, so a caller that already guarded a read against one keeps
    guarding it."""


class Tracker(Protocol):
    """Work items: read one, list the queue, comment, move labels, edit the
    description, file one, and the labels the project defines."""

    def issue(self, tree: Path, project: str, number: int) -> "OpenIssue":
        """One issue: number, url, title, body, labels, author, assignees, state."""

    def comments(self, tree: Path, project: str, number: int) -> list["IssueComment"]:
        """Every comment on one issue, oldest first."""

    def queued(self, tree: Path, project: str, label: str) -> list["OpenIssue"]:
        """The open issues carrying `label`: number, title, labels, author — the
        watcher's poll, so no bodies and no comments."""

    def labelled(self, tree: Path, project: str, label: str) -> list["OpenIssue"]:
        """The open issues carrying `label`, each with its url, body and comments."""

    def comment(self, tree: Path, project: str, number: int, body: str) -> None: ...

    def set_labels(self, tree: Path, update: "IssueUpdate") -> None:
        """One edit of `update.number` in `update.project`: what is added and
        what is removed land together or not at all."""

    def set_body(self, tree: Path, project: str, number: int, body: str) -> None: ...

    def create(self, tree: Path, project: str, issue: "NewIssue") -> str:
        """File one issue with its labels; the url it was filed at."""

    def labels(self, tree: Path, project: str) -> Optional[list[str]]:
        """The label names the project defines — None when this tracker does
        not define labels this way, which is an answer, not a failure."""

    def define_label(self, tree: Path, project: str, label: "Label") -> None: ...

    def labeller(self, tree: Path, project: str, number: int, labels: list[str]) -> str:
        """Who last applied any of `labels`; "" when the tracker will not say.
        Never raises: not knowing who triggered a run is no reason to refuse it."""

    def doctor(self, cfg: "FactoryConfig") -> list["Finding"]:
        """Whether what this tracker needs on this machine is here, for the
        paths `cfg` turns on — nothing for a path that is off."""


class Forge(Protocol):
    """Pull requests and their review threads, and who the forge knows as the
    person at this machine."""

    # The command that signs a person in, for a finding that has to say how.
    sign_in: str

    def pulls(self, tree: Path, project: str, limit: int) -> list["OpenPull"]:
        """The open pull requests: number, branch, labels, draft."""

    def pull_request(self, tree: Path, project: str, number: int) -> "PullRequestContext":
        """One pull request with its review threads and its conversation, in ONE
        consistent read: a pull request merged between two reads would be
        worked as open."""

    def closed(self, tree: Path, project: str, number: int) -> "PullRequestClosed":
        """How a pull request that is no longer open ended."""

    def comment(self, tree: Path, project: str, number: int, body: str) -> None: ...

    def reply(self, tree: Path, thread_id: str, body: str) -> None: ...

    def resolve(self, tree: Path, thread_id: str) -> None: ...

    def set_labels(self, tree: Path, update: "PullRequestUpdate") -> None: ...

    def pull(self, tree: Path, proposal: "Proposal") -> "Pull":
        """Open a pull request — or name the one this branch already has."""

    def host(self) -> str:
        """The host this forge is reached at."""

    def person(self) -> str:
        """The login the forge knows the person at this machine by, read
        without the network; "" when it cannot say."""

    def token(self) -> str:
        """That person's own token for `host()`, or "" — what a local cockpit
        asks the forge with."""

    def ci_ref(self) -> str:
        """The branch a CI job of this forge says it is building, or "" outside one."""

    def doctor(self, cfg: "FactoryConfig") -> list["Finding"]:
        """Whether what this forge needs on this machine is here, for the paths
        `cfg` turns on — nothing for a path that is off."""


def tracker_of(cfg: "FactoryConfig") -> Tracker:
    """The implementation `tracker:` names."""
    return _implementation(cfg.tracker, "tracker")


def forge_of(cfg: "FactoryConfig") -> Forge:
    """The implementation `forge:` names."""
    return _implementation(cfg.forge, "forge")


def _implementation(name: str, axis: str):
    # Imported here, not above: each implementation imports ForgeError from
    # this package, and a validated config only ever names one of these.
    from . import fake, github
    found = {("github", "tracker"): github.GitHubTracker, ("github", "forge"): github.GitHubForge,
             ("fake", "tracker"): lambda: fake.FAKE, ("fake", "forge"): lambda: fake.FAKE}
    if (name, axis) not in found:
        raise ValueError(f"no {axis} named {name!r}")
    return found[(name, axis)]()

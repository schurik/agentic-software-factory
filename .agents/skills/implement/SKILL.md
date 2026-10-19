---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the affected tests once at the end
(`pytest --affected`): what the change since main can reach, with the rule behind each path
printed. Leave the full suite to CI, which runs it on every pull request — unless `--affected`
itself says it is running everything (a change to `conftest.py`, `asf_helpers.py`,
`pyproject.toml`, the templates outside `engine/`, the installers, or a path no rule knows); then
that full run is the one to wait for.

Once done, use /matt-code-review to review the work.

Commit your work to the current branch.

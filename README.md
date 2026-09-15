# Agentic Software Factory

**Deterministic code owns sequencing, retries and acceptance. Coding agents work inside bounded
phases. Typed envelopes cross the seams. Every event streams into SQLite.**

`agentic-sf` is an *agent skill*: you install it once into your agent harness, point it at a
repository, and it stamps a small Python control plane — `asf/` — into that repository. From then
on, a workflow is something you run, read, check and edit, not a chat you supervise.

```bash
just do "add rate limiting to the public API"   # plan → implement → verify → commit
just list                                        # every workflow this repo has
just check                                       # would they run? spawns nothing, costs nothing
```

> Extracted from [`schurik/software-factory`](https://github.com/schurik/software-factory) — a fork
> of [disler/super-simple-software-factory](https://github.com/disler/super-simple-software-factory)
> — so this second factory could grow on its own. It shares that lineage and none of its code.

---

## Why this shape

The obvious design for an agent factory is one script per workflow. It fails the first time you
want a second workflow: a hundred-line chain is not a list of phases, its value is the *wiring
between* them — the fix loop, retest-only-if-revised, commit-after-green. "Copy the closest one and
edit it" turns every variation into a fork of the machinery.

So here a **workflow is a directory** over a **closed stage vocabulary**:

```yaml
# asf/workflows/ship/workflow.yaml
name: ship
description: plan, build, verify, review and document — three commits, three authors
input: prompt
agents:
  fixer: {from: builder, thinking: high, writes: [src/]}   # bindings may only NARROW
stages:
  - plan:      {agent: planner, hitl: true}
  - commit:    {of: plan}
  - implement: {agent: builder}
  - verify:    {blocks: [test, lint], max_fix_loops: 3, fix: {agent: fixer}}
  - commit:    {of: implement}
```

Loops and conditions live in the stages, in Python. The YAML gets numbers. A shape the vocabulary
cannot express is a new stage — not an `if:` key.

## Three layers, three owners

| Layer | Where | Owns | Edited |
|---|---|---|---|
| Roster | `asf/agents/<name>/agent.md` | identity, model, tools, `writes` — the security boundary | rarely, reviewed |
| Stages | `asf/stages/<name>/stage.py` | the contract, loops, conditions, default task files | when the vocabulary grows |
| Workflows | `asf/workflows/<name>/` | which stages, their options, agent bindings, task overrides | often |

An **agent is one file**. YAML frontmatter for the engine (model, thinking, tools, `writes`),
prose below it for the model. Its *task* is not in there: a task belongs to the stage that calls
the agent, and a workflow may override it with `tasks/<key>.md`.

The eight stages: `scout`, `plan`, `implement`, `verify`, `review`, `document`, `commit`,
`integrate`. Five starter workflows: `sdlc`, `quick`, `ship`, `issue`, `pr-review`.

## The rules that make it hold

1. **Code owns sequencing, retries and acceptance; an agent owns one bounded phase.** A known
   invocation (`pytest`, `bun test`, `ruff check`) is a code phase, never an agent's self-report.
2. **A workflow is refused before it costs anything.** `check` loads the whole directory: unknown
   stage or option, a `verify` with no build before it, a missing agent, a task whose report block
   drifted from its envelope type, a binding that widens `writes` or `tools`.
3. **Typed envelopes only.** An agent answers with JSON matching its output type or the phase fails.
4. **Gates verify claims after the fact** — against the tree, never against a prediction. A failed
   gate re-prompts the *same* session as a correction; nothing restarts.
5. **`writes:` is enforced in code.** The engine diffs the repo after every agent call and rolls
   back unauthorized changes. `protected_files` keeps the factory's own machinery off-limits.
6. **Bindings narrow, identity is appended.** Five workflows must not quietly become five builders.
7. **Every run works in its own git worktree** on branch `asf/<adw_id>`. Your checkout is never
   touched. A run that is not accepted keeps its worktree so you can look.
8. **The factory never reads its own trace db.** Every question about a session is answered from
   that session's directory; the db is for you and the UI.

## Human in the loop

Any stage takes `hitl: true`. The run stops after that phase with exit 75 and the session reading
`waiting`, and hands you its artifact:

```bash
just pending             # what is waiting, and on what
just show <id>           # the artifact it wants a decision on
just approve <id>        # continue
just reject <id> -m "…"  # the same agent revises, in the same session
just abort <id>
```

`--hitl all|none|plan` overrides the workflow's own gates for one run.

## Issues and reviews close the loop

Turn them on in `factory.yaml` and a labelled issue starts a run that reports back on the issue,
while review feedback on the factory's own pull requests comes back as a `pr-review` run that
answers in the threads.

```bash
just issue 42        # work a tracked issue
just pr-review 17    # answer the review on a pull request
just up              # both watchers + the trace UI, supervised; ctrl-c stops all
just status          # is anything actually polling?
```

Issue- and review-triggered runs can never merge: `integrate` downgrades a configured merge to a
pull request on those inputs, in code.

## Observability

Everything streams into SQLite (WAL) while the run is in flight — phases, tool calls, envelopes,
gate verdicts, token spend.

```bash
just sessions        # recent runs
just phases <id>     # the phase-by-phase record
just tail <id>       # follow a live run
just obs             # the trace UI (Vue + Vite on Bun, ships with the skill)
```

## Install

Into a target repository, from that repository's root:

```bash
uv run /path/to/agentic-software-factory/skills/agentic-sf/scripts/install.py --harness claude_code
just doctor          # keys, git, quality commands — every check with its fix; spawns nothing
just check           # every workflow loaded and validated
```

Harnesses: `claude_code` (runs `claude -p`, model aliases, brings its own auth — no API key) and
`pi` (runs `pi -p --mode json`, `provider/model-id`, needs that provider's key). The installer asks
if you do not say.

It is the only supported way in. Stamping `templates/asf/` by hand reproduces the files and none of
the decisions around them — `.env` with `ASF_SKILL=`, the `.gitignore` block that keeps the run
record out of your history, and the quality detection that reads your `package.json` / lockfiles /
`pyproject.toml` and writes the real test, lint, typecheck and build commands. **An undetected
quality block fails the run rather than passing it**, because a chain that reports a green suite it
never ran is the most expensive default a factory could ship.

Four decisions belong to the repository and are worth answering at install time: the harness, how
the repo runs its checks, how a run's branch lands (`merge` / `pr` / `none`), and whether issues and
reviews may start runs (off until you opt in). See
[`skills/agentic-sf/cookbooks/install.md`](skills/agentic-sf/cookbooks/install.md).

Removing it is one command and it is the one irreversible thing here:

```bash
just uninstall --dry-run    # the plan, first
just uninstall
```

### As a Claude Code plugin

```
/plugin marketplace add schurik/agentic-software-factory
/plugin install agentic-sf@agentic-sf
```

Then `/agentic-sf install` from the repository you want the factory in.

## Developing the skill

This repository is not an application and not an installable package. It is the source of the
skill; `skills/agentic-sf/templates/` is exactly what `install.py` copies into a target repo, and
the tests import straight out of it and install into a real `git init`'d tmpdir.

```bash
pytest                  # nothing calls a model, opens a socket or needs a token
ruff check .
```

The `fake` harness answers from a script, so the whole machinery — stages, gates, retries,
envelopes, permissions, budgets, the trace — is exercised for free in CI. `CLAUDE.md` is the
orientation for agents working in here, and [`skills/agentic-sf/references/design.md`](skills/agentic-sf/references/design.md)
is why each rule exists.

`docs/` is the inherited phase roadmap from the fork this skill came out of; phases 1, 2, 5, 6, 7
and 9 are built, 3 (a central trace store), 4 (a learning loop) and 8 (linked branches) are not.
Parts of it are written against the older `adws/` paths of the sibling factory.

## License

MIT. See [LICENSE](LICENSE).

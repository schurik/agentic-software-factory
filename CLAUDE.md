# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This repo is **not an application and not an installable package**. It is the source of one
*agent skill* — `skills/agentic-sf` — which stamps a deterministic Python control plane
("a factory") into *someone else's* repository.

Consequences that shape every change here:

- `skills/agentic-sf/templates/` is **exactly what `install.py` copies into a target repo**. Code
  under `templates/` is never imported from here in production; it runs as `asf/` in the target
  repo, with paths relative to *that* repo's root.
- The tests live at the repo root in `tests/`, **not** inside the skill: every installer
  (`npx skills add`, a plugin marketplace clone) copies a skill directory wholesale and none of
  them offer an ignore file, so anything under `skills/agentic-sf/` ships to every user. They
  import straight out of the template directories anyway (see `tests/conftest.py`) and install
  into a real `git init`'d `tmp_path`. So a fix goes in `templates/`, never in a stamped copy.
- `skills/agentic-sf/SKILL.md` + `cookbooks/` + `references/` are **read by an agent at runtime**.
  They are product surface, not documentation about the product — editing behaviour usually means
  editing both the Python and the SKILL.md routing/rules that describe it.

`README.md` is the long-form explanation of the design. There is no `docs/` directory for prose
on purpose (`docs/agents/` is agent configuration, not documentation — see `## Agent skills` — and
`docs/diagrams/` holds the pictures the READMEs show, each explained where it is shown):
what the factory does is documented where an agent will actually read it — `SKILL.md`, the
cookbooks, and `references/design.md` — and the rest is prose next to the code.

## Commands

```bash
pytest                                                       # testpaths + addopts in pyproject.toml
pytest tests/test_asf_e2e.py                                 # one file
pytest tests/test_asf_e2e.py::test_name                      # one test
pytest -k permissions                                        # by name
ruff check .                            # line-length 100; apps/ (TypeScript) excluded
```

Nothing in the suite calls a model, opens a socket, or needs a token — the `fake` harness answers
from a script. `filterwarnings = ["error::DeprecationWarning"]` is deliberate: a dependency release
can turn CI red with no PR change, and the fix belongs in the module the traceback names.

Manual smoke test — stamping into a scratch repo is what CI does and the only thing that proves the
PEP-723 headers resolve (pytest invokes installers with `sys.executable`, which ignores them):

```bash
mkdir /tmp/scratch && cd /tmp/scratch && git init -q . && git commit -q --allow-empty -m init
uv run /path/to/agentic-software-factory/skills/agentic-sf/scripts/install.py --harness claude_code
uv run asf/asf.py list && uv run asf/asf.py check      # loads every workflow, spawns nothing
uv run /path/to/agentic-software-factory/skills/agentic-sf/scripts/uninstall.py --dry-run
```

The visualizer (`skills/agentic-sf/apps/visualizer`, Vue + Vite on Bun) has its own scripts:
`bun run typecheck`, `bun run lint` (oxlint), `bun run build`. CI does not run them.

The cockpit (`apps/cockpit`, Next.js on self-hosted Convex, outside the skill per ADR 0001) is run
with bun: `bun run typecheck`, `bun run lint`, `bun run test` (vitest + `convex-test`, no backend
needed), and CI runs all three. `bun run test`, not `bun test`: the latter is Bun's own runner. Its tests ingest every fixture under `tests/golden/events/`, so a
new event kind or version needs a reader in `apps/cockpit/convex/model/session.ts` in the same PR.
`docker compose up --build` in that directory brings up the backend, dashboard and app.

## The factory

A workflow is a **directory** (`asf/workflows/<name>/workflow.yaml` + optional `tasks/*.md` +
agent bindings) built from a **closed stage vocabulary** (`asf/stages/<name>/stage.py`); one entry
point, `asf/asf.py` (`list | check | run | doctor | resume | kill | up | status | …`). An agent is
one `agent.md`: frontmatter for the engine, prose for the model. Manifest is `asf/factory.yaml`
(no agents in it). The engine is `session`, `worktree`, `gates`, `permissions`, `limits`, `hitl`,
`tracer`, `harnesses/{pi,claude_code,fake}`.

## Invariants the code (and the tests) enforce

These are load-bearing. Breaking one is a red suite, and in most cases the test exists because the
bug already shipped once.

1. **Code owns sequencing, retries and acceptance; an agent owns one bounded phase.** A known
   invocation (`bun test`, `ruff check`) is a `kind="code"` phase via `quality.py`, never an agent.
2. **The factory never reads the trace db.** `tracer.py` writes SQLite; every question about a
   session is answered from that session's own directory under `data_dir`. A run must still work
   with the db deleted. Tests may read it to assert.
3. **Typed envelopes only, and the contract is a synced triad**: the `EnvelopeBase` subclass in
   `data_types.py`, the JSON example in the task file's `## Report` block, and `output_type=` at
   the call site. Change one, change all three in the same edit.
4. **Gates verify claims after the fact**, against the envelope's own declarations — never predictions.
   A failed gate or unparseable JSON re-prompts the *same* session as a correction; nothing restarts.
5. **`tools:` is a capability list, `writes:` is the boundary.** `permissions.py` diffs the repo after
   every agent call and rolls back unauthorized changes. Workflow bindings may only *narrow*
   `writes`/`tools`, and identity is *appended* (`system_append`), never replaced.
6. **Every phase carries a real description** (a restatement of the name is rejected at construction),
   and **every run ends through `run.finish(accepted=)`** — phases passing ≠ the run being acceptable.
7. **The vocabulary is closed**: no `loop:` or `if:` in `workflow.yaml`. A shape the vocabulary
   cannot express is a new stage in Python. `check` refuses a workflow before it costs anything
   (unknown stage/option, missing agent, drifted report block, widened binding).
8. **Context flows forward on one timeline, and code carries it.** `journal.py` holds what
   each phase did, what an agent declared on an accepted envelope (`for_the_record`) and what
   a person typed at a gate, and appends the lot to every agent prompt rendered afterwards —
   not through a `{{placeholder}}`, because a task file that forgot to name one would silently
   drop it. An agent DECLARES a note; code files it. A remark and a note differ in authority
   (instruction vs report), which is the preamble's job, not a second module's.
9. Functions over four parameters take one concrete type instead (`AgentCall`, `PhaseParams`).
10. **A change to an event kind or the self-description bumps its version and adds a fixture.**
   A session's `events.jsonl` is typed domain events (`engine/events.py`, payloads in
   `data_types.py` under "Domain events"), and it is a contract with a cockpit this repo does not
   run. Any change to a payload bumps that kind's `VERSION` and adds
   `tests/golden/events/<kind>/v<N>.json` beside the old fixture, which is never edited — the
   cockpit reads every version ever written. An event that describes a session file is appended by
   the function that writes that file, and `tests/projection.py` must still rebuild `run.json`, the
   decisions, the envelopes and the journal from the events alone.
11. **A tool's arguments and results, the prompts and the harness's raw stream leave the machine
   only when the repository opted in.** `tool_called` is a tool's name, outcome and duration and
   nothing else. `prompt_rendered` and `harness_output` are TRANSCRIPT events: written only under
   `cockpit: {transcripts: true}` in `factory.yaml`, and only through `Run.transcript`. A handoff
   artifact travels inline up to `BODY_BYTES` and says when it was cut; a repo artifact travels as
   a path, read from the forge at the sha its `committed` names — which is why a stage commits
   through `run.commit`, never `git_helper.commit_all`.
12. **A published branch is a copy until something integrates it, and only a copy is deleted.**
   Under `worktree.publish: on_create` (`engine/publish.py`) a session's branch is on the remote
   from its first moment so a cockpit can read a gate's subject at `head_sha`, and that copy is
   deleted when the session is aborted or finishes without integrating — kept on failure, for
   `resume`. What keeps a pull request's head from being deleted is `publish.integrated`:
   `run.pr_url`, the upstream an integration's `push -u` set, or the commits being on the base
   branch. So every push that only keeps the copy current (`publish.py`,
   `integration.keep_published`) passes `set_upstream=False`, and nothing decides "not published"
   from a missing remote-tracking ref — a narrowed clone has none.

## Working in here

- **Build for the tracker first: issue, then pull request, then prompt.** When something new
  needs a default, a channel, a code path or an example, the work item is the case to design
  for and the typed prompt is the fallback — not the other way round. A factory is normally
  reached from a tracker by someone who is already looking at that page; the engineer at a
  keyboard is the exception, and under cron, in a watcher or in CI there is no keyboard at all.
  A default that assumes one makes the exception the assumption (see `hitl.channel_of`, and
  `WaitingFor.channel` defaulting to `issue`).
- **Prompts are stamped per harness.** `templates/harnesses/{pi,claude_code}/` each carry their own
  roster, defaults, `env.sample` and prompt set — pi's prompts reference `subagent_*` tools Claude
  Code does not have. Moving an agent between harnesses means moving its prose too; validation only
  catches the `tools:` half. Adding a harness = one module in `harnesses/` + one template directory.
- **The `fake` harness is the development tool.** Put a new workflow's roster on it until the shape
  holds; it is never offered by the installer.
- **Installers are idempotent.** A second run skips what exists and reports it (a drift check).
  `--force` overwrites everything stamped, prompts and agent prose included — with one
  deliberate exception: the assembled config (`factory.yaml`) is never rewritten. A fresh render
  that differs lands beside it as `.new` and is named loudly, because the file the installer told
  the operator to own is the one `--force` must not eat.
- **A release is a semver tag, `vX.Y.Z`, and `.claude-plugin/plugin.json` is its one version
  source**, bumped in the PR that cuts it along with its mirrors — `marketplace.json` and
  `templates/asf/.skill-version`, the file a stamp records the release in (a mirror because
  `npx skills add` copies the skill directory and nothing above it) — and with
  `skills/agentic-sf/CHANGELOG.md`'s `Unreleased` heading renamed and dated. A test pins the
  mirrors to `plugin.json`, and every changelog entry names its `### Upgrade` steps. Pushing the
  tag publishes the cockpit images (`.github/workflows/release.yml`), and
  `templates/asf/cockpit/min-version` is the oldest of those a stamp's `asf up` will run — raise it
  when the factory starts writing something an older cockpit cannot read.
- **Runtime must stay gitignored.** CI fails the install if `asf/data/`, `.asf-worktrees/`, `.env`
  or `.pyc` files end up staged — a workflow's commit stage runs `git add -A` in the user's repo.
- Scripts carry `#!/usr/bin/env -S uv run` + PEP-723 deps (`pydantic`, `python-dotenv`, `pyyaml`,
  `rich`); nothing is pinned, so CI meets the versions a stamped repo would resolve that day.
- Commit subjects follow `<area>: <what changed, in the imperative, lowercase>` — e.g.
  `issues: the four state labels are mutually exclusive, and now stay that way`.
- When a claim in this repo is worth making, it is usually made in prose *next to the code* (see the
  comment headers in `pyproject.toml`, `ci.yml`, `stage.py`). Match that register rather than
  stripping it.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven by the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, both created
lazily when a term or decision actually gets resolved. See `docs/agents/domain.md`.

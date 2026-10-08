# Agentic Software Factory

**Deterministic code owns sequencing, retries and acceptance. Coding agents work inside bounded
phases. Typed envelopes cross the seams. Every event lands in the session's own record.**

`agentic-sf` is an *agent skill*: you install it once into your agent harness, point it at a
repository, and it stamps a small Python control plane — `asf/` — into that repository. From then
on, a workflow is something you run, read, check and edit, not a chat you supervise.

```bash
npx skills add schurik/agentic-software-factory --skill agentic-sf --agent claude-code pi -y
```

Then, from the repository you want a factory in, ask your agent to **install agentic-sf here**. It
reads [the install cookbook](skills/agentic-sf/cookbooks/install.md) and walks you through the four
decisions that belong to the repo. From then on:

```bash
just do "add rate limiting to the public API"   # plan → implement → verify → commit
just list                                        # every workflow this repo has
just check                                       # would they run? spawns nothing, costs nothing
```

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
8. **The session directory is the record.** Every question about a session is answered from
   that session's directory; a cockpit receives its events and is never asked.

## Human in the loop

Any stage takes `hitl: true`. The run stops after that phase with exit 75 and the session reading
`waiting`, and hands you its artifact:

```bash
just pending             # what is waiting, and on what
just show <id>           # the artifact, and everything already said to this run
just approve <id>        # continue
just approve <id> -m "…" # continue, and amend the request while you are at it
just reject <id> -m "…"  # the same agent revises, in the same session
just abort <id>
```

`--hitl all|none|plan` overrides the workflow's own gates for one run.

What you type after `-m` goes on the run's journal, below.

## The run keeps a journal

`asf/data/sessions/<id>/context_handoff/journal.md` is the run's record of itself, and the same
content is appended to every agent prompt rendered afterwards. Everything that is true of the run
and not of the plan goes on it.

```
2. plan · planner · success — Split the probe out of the handler
3. approve_plan · engineer · success — approve by schurik
   ✎ schurik said, approve at the plan gate (round 1): and make the probe time out after 2s
4. implement · builder · success — Added app.py with the /health route, probe capped at 2s
   ⚑ deviation (builder, in implement): used `httpx` for the probe
     instead of: the plan names `requests`
     because: `requests` is not in this repo's lockfile
5. verify_1 · quality · success — passed: False, checks: 0/1
```

- **`✎`** — what you typed after `-m` at a gate or a question round. An *instruction*: it amends
  the request and outranks the plan, so the builder acts on it and the reviewer knows it was asked
  for.
- **`⚑`** — a note an agent declared on its envelope (`for_the_record`, typed `deviation`,
  `discovery` or `risk`). A *report*: it may be judged, but a departure it accounts for is not
  unrequested work. **Code** lifts it into the journal once the envelope is accepted — nothing lets
  an agent write the journal itself. A `deviation` that does not say what it departed from and why
  is refused at parse time and re-prompted in the same session.

Both fix the same failure from opposite directions: an agent late in a workflow judging work
against a spec that has since moved. The reviewer used to hold only the plan, so it asked for the
flag you requested to be removed, and for the library that does not exist to be put back.

## Issues and reviews close the loop

A run lands as a pull request by default. With the watchers up, an issue labelled `asf:queued` and
`asf:ship` starts a run that reports back on the issue, while review feedback on the factory's own
pull requests comes back as a `pr-review` run that answers in the threads.

```bash
just issue 42        # work a tracked issue
just pr-review 17    # answer the review on a pull request
just up              # the station loop, the local cockpit and both watchers; ctrl-c stops all
just status          # is anything actually polling?
```

Issue- and review-triggered runs can never merge: `integrate` downgrades a configured merge to a
pull request on those inputs, in code.

## Observability

Every session writes typed domain events to its own `events.jsonl` while the run is in flight —
phases, tool calls, envelopes, gate verdicts, token spend — and a **cockpit** (`apps/cockpit`)
builds its views from them.

```bash
just sessions        # recent runs, from their own records
just tail <id>       # follow a live run's events
```

`just up` is the station loop: it ships every session on the checkout to the shared
cockpit `ASF_COCKPIT_URL` names or, without one, starts a local cockpit from the same published
images a team deploys (Docker; `http://localhost:3000`). What travels is the session's story — chapters, phases, gates, spend, commits, the handoff files
its phases wrote, and each tool call's name, outcome and duration. A tool's arguments and results,
the prompts and the harness's raw output are the transcript, which a factory sends only if its
`factory.yaml` says `cockpit: {transcripts: true}`.

A cockpit shows what a gate asks about by reading it from the forge, at the commit the run stopped
on. So once a cockpit is configured a session's branch is pushed as it starts and before every
suspend, with the gate's subject committed (`worktree.publish: on_create`); a branch that was never
integrated leaves the remote again when its session finishes or is aborted. `on_integrate` keeps
every branch on the machine until an `integrate` stage pushes it, which is also the default without
a cockpit.

The forge also says which factories there are, and who may see them. A cockpit's Factories page
lists every repository it can reach whose default branch holds `asf/factory.yaml` — nothing is
registered in the cockpit. A team's cockpit reaches the forge through a GitHub App the team
registers for itself, people sign in with it, and each sees what the forge lets them read. The
local one has no sign-in: `asf up` hands it your own `gh auth token`, and it asks as you.

![A stamped repo as a station, the Docker project asf-cockpit with the Next.js app and the Convex backend, and the browser](docs/diagrams/local-cockpit-components.svg)

The watchers, the station loop and the cockpit child all live in the one `asf up` process; a session
is its own `asf run`. The only data that crosses into the cockpit is the loop's `POST /ingest` to
the backend's site on `:3211`, and, once as it starts, the `gh auth token` it asks the forge with. [`apps/cockpit/README.md`](apps/cockpit/README.md#how-the-pieces-connect)
has the sequence: start-up, page load, and what happens for each event.

## Install the skill

```bash
npx skills add schurik/agentic-software-factory --skill agentic-sf --agent claude-code pi -y
```

That writes the skill to `.agents/skills/agentic-sf/` in this project and links
`.claude/skills/agentic-sf` to it; add `-g` for every project (`~/.agents/skills/`, linked from
`~/.claude/skills/`). The same command updates it.

Name two agents, not `claude-code` alone. When every agent named shares one skills directory, the
CLI copies instead of linking, so `--agent claude-code` by itself puts a real directory in
`.claude/skills/`, and every agent reading `.agents/skills/` (pi, Codex, Cursor, opencode…) keeps
whatever was there. pi reads `.agents/skills/` itself, which is what makes the CLI write there and
link Claude Code to it. Naming the agents also keeps `-y` from choosing for you: in a repository
with an Eve agent, `-y` without `--agent` installs for Eve alone — which is also why `npx skills
update` is not how to update it ([`cookbooks/upgrade.md`](skills/agentic-sf/cookbooks/upgrade.md#update-the-skill-first)).
Any agent that reads a `SKILL.md` works — the CLI targets Claude Code, Codex, Cursor, opencode,
Windsurf, Zed, Cline, Roo, Amp, Goose, Devin, Antigravity and Eve.

As a Claude Code plugin instead, which also brings the `/agentic-sf` command:

```
/plugin marketplace add schurik/agentic-software-factory
/plugin install agentic-sf@agentic-sf
```

That is the whole of what you install on your machine. **Putting a factory into a repository is a
separate step with decisions in it, and it lives in
[`cookbooks/install.md`](skills/agentic-sf/cookbooks/install.md)** — which harness (`claude_code`
brings its own auth and needs no API key; `pi` needs that provider's key), how this repo runs its
tests and lint, how a run's branch lands, and whether issues may start runs. Ask your agent to
install agentic-sf and it reads that cookbook for you; `just doctor` then answers whether the repo
is ready. Taking the factory back out again is [`cookbooks/uninstall.md`](skills/agentic-sf/cookbooks/uninstall.md).
New to all of it? `/agentic-sf onboard` (or "how do I start?") has your agent read
[`cookbooks/onboard.md`](skills/agentic-sf/cookbooks/onboard.md): where your repository stands, and
the answer to each first question — install, setup, the cockpit and stations, updating, workflows.

## Developing the skill

This repository is not an application and not an installable package. It is the source of the
skill; `skills/agentic-sf/templates/` is exactly what `install.py` copies into a target repo, and
the tests — at the repo root in `tests/`, so they never ship to anyone who installs the skill —
import straight out of it and install into a real `git init`'d tmpdir.

```bash
pytest                  # nothing calls a model, opens a socket or needs a token
ruff check .
```

The `fake` harness answers from a script, so the whole machinery — stages, gates, retries,
envelopes, permissions, budgets, the trace — is exercised for free in CI. `CLAUDE.md` is the
orientation for agents working in here, and [`skills/agentic-sf/references/design.md`](skills/agentic-sf/references/design.md)
is why each rule exists.

## License

MIT. See [LICENSE](LICENSE).

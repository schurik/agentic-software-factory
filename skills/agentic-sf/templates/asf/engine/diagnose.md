# Diagnose

## Variables

### prompt

The criteria of scorer `{{scorer}}`, in the words of the team that wrote it:

{{prompt}}

### previous_envelope

A diagnosis is the only phase of its run, so there is none: {{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## The pattern

Scorer `{{scorer}}` judges chapters of the `{{workflow}}` workflow, {{focus}}, and has failed on {{failed_on}}. One failing score is a bad chapter; this many, across distinct sessions, is a pattern — and a self-improvement issue is about to be filed on this repository's tracker. Your diagnosis goes into its body, for a person to judge and the `issue` workflow to plan from.

Its classes:

{{classes}}

The failing sessions, each with the seqs its failing scores cite:

{{sessions}}

Each session's directory is its whole record: `events.jsonl` (every event, by `seq`), `envelopes/` and `<agent>/envelope.json` (what each agent answered), `<agent>/prompts/` and `<agent>/raw_output.jsonl` (what each was sent and streamed), `context_handoff/journal.md` (its journal). Read them; never write to them.

You run in a checkout of the repository at the station's `HEAD`, which is removed once you answer. The factory is under `{{factory_dir}}/`: its workflows, the stages' task files, the agents' prose, `factory.yaml`. Everything else is the application.

## Task

1. Read the criteria in `prompt`, then the failing sessions — the cited events first, then whatever they point to.
2. Find what the failing chapters have in common: the one cause that, changed, would have changed their class.
3. Decide where that cause lives: in the factory (a task file, an agent's prose, a workflow's options, `factory.yaml`) or in the application (its code, its tests, its docs).
4. Name the files whose text causes it, as the repository has them, and the change to make in them.
5. Emit your `Report` JSON.

## Rules

- Name a file by the path the repository has it at, relative to its root. A file that does not exist is refused, and you are asked again. A change that would add a file is named by the existing file whose behaviour it changes.
- One diagnosis has one surface: `factory` when every file is under `{{factory_dir}}/`, `application` when none is.
- A stage's own task file (`{{factory_dir}}/stages/<stage>/*.md`) belongs to the skill this factory was stamped from, and a re-stamp overwrites it. Name it anyway: the change is redirected to the workflow's own override, `{{factory_dir}}/workflows/{{workflow}}/tasks/<key>.md`, and marked for a person to carry to the skill.
- Factory code — any `.py` under `{{factory_dir}}/` — is where every gate is and what decides whether work is accepted. If the cause is there, say so: it is reported in the issue, never proposed as a change, because a change to what blocks work is a person's to make, in code.
- Set `upstreamable` when the change would help every factory stamped from the skill, not this one alone.
- What you write is posted on a tracker, which may be public. Cite events by seq; never quote a prompt, an agent's raw output, a secret or a person's words.

## Report

Respond with ONLY valid JSON matching `DiagnosisOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence: the cause, and where the change goes>",
  "cause": "<a few sentences: what the failing chapters have in common, citing seqs>",
  "surface": "<factory | application>",
  "files": ["<path relative to the repository root>"],
  "proposed_change": "<what to change in those files, concretely enough to plan from>",
  "upstreamable": false,
  "artifacts": [],
  "for_the_record": [],
  "notes_for_next_agent": ""
}
```

`status` is `success` when you diagnosed the pattern. `fail` only when you could not, and `summary` says why.

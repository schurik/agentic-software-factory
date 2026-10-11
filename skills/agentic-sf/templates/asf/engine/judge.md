# Judge

## Variables

### prompt

The criteria of scorer `{{scorer}}`, in the words of the team that wrote it:

{{prompt}}

### previous_envelope

The last envelope accepted in the chapter — the work product as its agent last stated it:

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## The chapter

Chapter {{chapter}} of session `{{session}}`, a chapter of the `{{workflow}}` workflow. Judge {{focus}}.

The session's record is `{{session_dir}}`:

- `events.jsonl` — every event of the session in full, one JSON object per line, by `seq`
- `<agent>/envelope.json` and `envelopes/<phase_id>.json` — what each agent answered
- `<agent>/prompts/` — the prompts each agent was last sent; `<agent>/raw_output.jsonl` — what its harness streamed
- `context_handoff/journal.md` — the session's journal: its phases, the notes its agents filed, what people said at its gates

You run in a checkout of the chapter's last commit — its tree as it left it, or the station's
`HEAD` when it made none — which is removed once you answer. The commits the chapter made, each
readable with `git show <sha>`:

{{commits}}

The chapter's events — the only seqs you may cite:

{{events}}

## Classes

{{classes}}

## Task

1. Read the criteria in `prompt`. They are the only question.
2. Read the chapter's record — the events first, then whatever the criteria need: envelopes, the journal, the diffs at each commit, the prompts and raw output.
3. Choose the one class the chapter earned.
4. Emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `JudgeOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence: the class, and the one fact that decided it>",
  "class": "<exactly one of the classes above>",
  "reasoning": "<a few sentences: what you read, and why it earns this class>",
  "evidence": [14, 22],
  "artifacts": [],
  "for_the_record": [],
  "notes_for_next_agent": ""
}
```

`status` is `success` when you judged the chapter, whichever class you gave — a failing class is a score, not a failure. `fail` only when you could not judge it at all, and `summary` says why.

`evidence` is the seqs your class rests on, each one from the chapter's events above. A seq from anywhere else is refused, and you are asked again.

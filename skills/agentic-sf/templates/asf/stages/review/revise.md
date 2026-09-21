# Revise

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

A reviewer read your build against what was asked and withheld approval.
`previous_envelope` is their review: `blocking` names what must change, and
every `findings` entry with `"met": false` says what is missing and where.
`<context_handoff_dir>/review.md` has the full text.

Close every blocking item and every unmet finding. The request in `prompt`
is unchanged, and the plan, if there is one, is still the spec: this is a
correction of your existing work in the same session, not a new build. Keep
the same paths, do not widen the change, and do not argue with the review in
code comments. Verify the tree still runs before you report, by exit status.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on which findings you closed and how>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line git subject for the code as it now stands — build and revisions land as one commit>",
  "for_the_record": [
    { "kind": "deviation", "what": "<what is now true>", "instead_of": "<what the plan or the request said>", "because": "<the evidence — why the other way was not possible>" }
  ],
  "notes_for_next_agent": "<which blocking item each change addressed>"
}
```

`changed_files` is every file this turn touched. The reviewer reads them next.

`for_the_record` is for the REST OF THE RUN, not for the next agent: the factory
lifts it into the run's journal and every agent after you reads it. Leave it `[]`
unless one of these is true.

- `deviation` — you did something other than what the plan or the request said.
  Name what you did instead and why. Filing it is what stops a later agent from
  reading your work as a mistake and asking for it to be undone; a deviation
  without `instead_of` and `because` is refused.
- `discovery` — something true of this repository that nobody knew going in, and
  that changes what somebody after you should do.
- `risk` — something you left standing on purpose that the next agent should weigh.

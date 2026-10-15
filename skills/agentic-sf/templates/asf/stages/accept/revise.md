# Revise

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

An acceptance check drove your build in a browser, against what was asked, and
withheld approval. `previous_envelope` is its verdict: `blocking` names what
must change, every `findings` entry with `"met": false` says what the running
app did instead, `steps` is how to get there, and `console_errors` is what the
page logged. Its `screenshots` show it, and
`<context_handoff_dir>/acceptance.md` has the full text.

Close every blocking item and every unmet finding. The request in `prompt`
is unchanged, and the plan, if there is one, is still the spec: this is a
correction of your existing work in the same session, not a new build. Keep
the same paths and do not widen the change. Do not start the app's dev
server — one is already running on this tree, and the acceptance check runs
again on your change. Verify the tree still runs before you report, by exit
status.

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
  "notes_for_next_agent": "<which blocking item each change addressed, and where to see it in the app>"
}
```

`changed_files` is every file this turn touched. The acceptance check runs the app on them next.

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

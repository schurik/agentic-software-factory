# Fix

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

The repository's own checks ran against your build and came back red.
`previous_envelope` holds their verdict: `failures` is the command, its exit
code and what it printed, verbatim. That output is the spec for this turn —
trust it over any summary, including your own from the build.

Address every reported failure, not the first one. Do not widen the change:
the request in `prompt` is unchanged, and a failing check is a bug in how it
was met, not a new ask. Re-run the same command yourself before you report,
and judge it by exit status.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what was wrong and what you changed>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line git subject for the code as it now stands — the build plus this fix land as one commit>",
  "for_the_record": [
    { "kind": "deviation", "what": "<what is now true>", "instead_of": "<what the plan or the request said>", "because": "<the evidence — why the other way was not possible>" }
  ],
  "notes_for_next_agent": "<which failure each change addressed>"
}
```

`changed_files` is every file this turn touched. The commit lands your build
and every fix together, so the message describes the whole change, not the
repair alone.

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

# Scout

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Find the code `prompt` is about, so the plan that follows is written against
this repository and not against a guess.

1. Search for the modules, functions, config and tests the request touches or
   depends on. Read enough of each to say what it does today.
2. Write `<context_handoff_dir>/scout_findings.md`: one section per finding —
   the path, what lives there, why it matters to the request. Close with what
   you did NOT find, if the request assumes something that is not there.
3. Emit your `Report` JSON. `findings` is the same list, one entry per file;
   `artifacts` names the findings file you wrote.

Change nothing in the repository.

## Report

Respond with ONLY valid JSON matching `ScoutOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what you found>",
  "findings": [
    { "file": "src/server.ts", "note": "<why this file matters to the request>" }
  ],
  "artifacts": ["<context_handoff_dir>/scout_findings.md"],
  "for_the_record": [
    { "kind": "deviation", "what": "<what is now true>", "instead_of": "<what the plan or the request said>", "because": "<the evidence — why the other way was not possible>" }
  ],
  "notes_for_next_agent": "<what the planner should read first, and what is NOT there>"
}
```

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

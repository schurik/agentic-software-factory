# Review

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Confirm that the work reported in `previous_envelope` is what was asked for.

1. Establish the spec: read `<context_handoff_dir>/plan.md` if it exists, else use `prompt`.
   The *This run so far* section below amends it and outranks it: a `✎` is an
   instruction somebody gave, a `⚑` is a departure somebody already made.
2. Read the code that was actually written, starting from `previous_envelope.changed_files`.
3. Rule on every requirement in the spec, the timeline's own included — one `findings`
   entry each, with evidence. Work a `✎` asked for and work a `⚑ deviation` accounts for
   are both requested work: never file either as `blocking` for being absent from the plan.
4. Write the review to `<context_handoff_dir>/review.md`, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ReviewOutput` — no prose before or after:

```json
{
  "status": "success",
  "approved": false,
  "summary": "<one sentence: N of M requirements met>",
  "findings": [
    { "requirement": "<the ask, in the requester's words>", "met": true, "evidence": "src/server.ts:42 — handler registered" }
  ],
  "blocking": ["<what must change before this can be approved>"],
  "artifacts": ["<context_handoff_dir>/review.md"],
  "for_the_record": [
    { "kind": "deviation", "what": "<what is now true>", "instead_of": "<what the plan or the request said>", "because": "<the evidence — why the other way was not possible>" }
  ],
  "notes_for_next_agent": "<what the builder must fix, or how to verify if approved>"
}
```

`status` is `success` when the review itself completed — it is not the verdict. The verdict is `approved`, and it is true only when `findings` has no unmet entry and `blocking` is empty.

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

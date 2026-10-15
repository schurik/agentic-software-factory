# Fix the reproduced bug

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

A reproduction: `repro_test` is a test this run wrote from the report and
watched fail, `repro_command` runs it, and `expected_failure` is what it prints
because of the bug. The reporter's own text and the scout's findings are among
its `artifacts`. Read them in full before you change anything.

### context_handoff_dir

{{context_handoff_dir}}

## Task

Fix the bug the reproduction shows. The failing test is your spec: when you are
done, `repro_command` passes, and nothing else the repository's tests cover has
broken.

1. Read the test and run `repro_command` yourself, so you see the failure and
   not a description of it.
2. Find the cause in the code and fix it there. Make the smallest change that
   makes the test pass for the right reason — not one that special-cases its
   inputs.
3. **Do not touch `repro_test`.** It is frozen: a gate compares it, byte for
   byte, with the version that was shown failing, and refuses your report if it
   differs. If you believe the test itself is wrong, leave it as it is and say
   so in `for_the_record` as a `risk`.
4. Run `repro_command` again before you report, and judge it by exit status.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what caused the bug and what you changed>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<imperative one-line git subject for the fix — the repro test lands in the same commit>",
  "for_the_record": [
    { "kind": "deviation", "what": "<what is now true>", "instead_of": "<what the plan or the request said>", "because": "<the evidence — why the other way was not possible>" }
  ],
  "notes_for_next_agent": "<what caused the bug, and how the fix addresses it>"
}
```

`changed_files` is every file you created, edited or deleted, by path from the
repository root. The repro test is the run's, not yours: leave it out.

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

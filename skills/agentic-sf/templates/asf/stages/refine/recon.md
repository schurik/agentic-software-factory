# Recon, for the analyst

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Find what this repository actually does today, so the requirements are written
against the code and not against a guess.

`prompt` ends with what this pass is for. On the first round that is the
request itself and the sweep is wide. On any later round the **analyst has
named what it needs to know** — answer THAT question about the code, and do not
re-survey what an earlier pass already found.

1. Search for the modules, functions, config and tests the request touches or
   depends on. Read enough of each to say what it does today.
2. Write `<context_handoff_dir>/recon_<n>.md`, where `<n>` makes the name unique
   among the files already in that directory — an earlier pass's findings must
   stay readable. One section per finding: the path, what lives there, why it
   matters here.
3. Close with what you did **not** find. A request that assumes something which
   is not there is the single most useful thing you can report, because it is
   the requirement nobody will write otherwise.
4. Recon is not a decision. Report what is there, not what should change. A file
   you name is a place to look, not a commitment to touch it.

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
  "artifacts": ["<context_handoff_dir>/recon_1.md"],
  "notes_for_next_agent": "<what the analyst should read first, and what is NOT there>"
}
```

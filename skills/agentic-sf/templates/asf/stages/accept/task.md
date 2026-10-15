# Accept

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

### app_url

{{app_url}}

### server_log

{{server_log}}

## Task

The app built in `previous_envelope` is running at `app_url`. Drive it in the
browser and confirm that it does what was asked.

1. Establish the spec: read `<context_handoff_dir>/plan.md` if it exists, else use `prompt`.
   The *This run so far* section below amends it and outranks it: a `✎` is an
   instruction somebody gave, a `⚑` is a departure somebody already made.
2. Break it into requirements a person could check in the running app. Read
   `previous_envelope.changed_files` only to know where to look.
3. For each, use the app the way its user would — navigate, click, type, submit —
   starting from `app_url`. Do not start a server, and do not change the code or the
   data on disk: the server is already running, and it is stopped for you.
4. Rule on every requirement: one `findings` entry each, `met` or not, with what you saw.
   Read the browser console; copy every error the page logged into `console_errors`.
   The server's own output is in `server_log`.
5. Take a screenshot for each requirement you rule on, saved by its ABSOLUTE path under
   `<context_handoff_dir>/accept/` — never a relative path, never into the repository —
   and list every one in `screenshots`.
6. Write what you did and found to `<context_handoff_dir>/acceptance.md`, then emit your
   `Report` JSON.

## Report

Respond with ONLY valid JSON matching `AcceptanceOutput` — no prose before or after:

```json
{
  "status": "success",
  "approved": false,
  "summary": "<one sentence: N of M requirements met in the running app>",
  "findings": [
    { "requirement": "<the ask, in the requester's words>", "met": false, "evidence": "<what the app did — the page, the action, what it showed>" }
  ],
  "blocking": ["<what must change before this can be accepted, as the user would see it>"],
  "steps": ["opened <app_url>", "clicked Save with the title empty"],
  "console_errors": ["<an error the page logged, verbatim>"],
  "screenshots": ["<context_handoff_dir>/accept/01-empty-title.png"],
  "artifacts": ["<context_handoff_dir>/acceptance.md"],
  "for_the_record": [
    { "kind": "deviation", "what": "<what is now true>", "instead_of": "<what the plan or the request said>", "because": "<the evidence — why the other way was not possible>" }
  ],
  "notes_for_next_agent": "<what the builder must fix, and how to see it in the app>"
}
```

`status` is `success` when the check itself completed — it is not the verdict. The verdict is `approved`, and it is true only when `findings` has no unmet entry and `blocking` is empty. A console error is not on its own a finding: it is one when it stops a requirement from being met.

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

# Document

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Document the completed work described by `previous_envelope`, using `prompt` for what was originally asked.

Read `previous_envelope.diff_path` in full before you write anything, plus any changed file that needs context. Document only what the diff shows: if the diff does not show it, do not claim it.

1. Write the write-up to `<context_handoff_dir>/document.md`. Cover: what changed and why it matters, the files that carry it, and how to use or verify it.
2. Copy that file into the repo under `docs/asf/`:
   - **Never `cd` anywhere and never use an absolute path for this step.** `previous_envelope.diff_path` and `context_handoff_dir` are absolute paths into a different tree — the run's own bookkeeping checkout, not the tree you are writing into. Run the `mkdir`/`cp` below exactly as given, from your current directory. After copying, verify with the relative form `ls docs/asf/<adw_id>_<slug>.md`.
   - **List `docs/asf/` before you pick the name.** A session that documents more than once reuses its `<adw_id>`, so the obvious name may already be taken.
   - Base name: `docs/asf/<adw_id>_<slug>.md`, where `<adw_id>` is the session directory name inside `context_handoff_dir` (`.../sessions/<adw_id>/context_handoff`) and `<slug>` is two to four kebab-case words naming the work.
   - If a file with that name already exists, use `_v2`, then `_v3`, and so on. **Never overwrite an existing write-up** — it describes a change that already shipped.
   - **Copy it, do not retype it.** One bash call does the whole step:
     `mkdir -p docs/asf && cp "<context_handoff_dir>/document.md" "docs/asf/<adw_id>_<slug>.md"`
3. Emit your `Report` JSON, declaring BOTH paths in `artifacts`.

## Report

Respond with ONLY valid JSON matching `DocumentOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence describing what you documented>",
  "document_path": "docs/asf/<adw_id>_<slug>.md",
  "documented_files": ["src/server.ts"],
  "artifacts": ["<context_handoff_dir>/document.md", "docs/asf/<adw_id>_<slug>.md"],
  "commit_message": "<imperative one-line git subject for committing THIS WRITE-UP, not the change it describes — e.g. 'Document the /health endpoint'>",
  "notes_for_next_agent": "<anything the diff left unexplained>"
}
```

`document_path` and the `docs/asf/` entry in `artifacts` are the path you ACTUALLY wrote, `_v2` suffix and all. Gates open these files — a name you meant to use fails them.

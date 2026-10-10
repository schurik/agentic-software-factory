---
recording: issue-then-two-reviews-scored
recorded_on: '2026-10-10'
recorder: tests/test_asf_golden_sessions.py
tree: 4c15ac9
release: 1.2.0
harness: fake
trace_db: false
---
# issue-then-two-reviews-scored

Recorded on 2026-10-10 by `tests/test_asf_golden_sessions.py`, run with
`ASF_RECORD_SESSIONS=1` on top of `4c15ac9` — agentic-sf 1.2.0 — on the
`fake` harness, whose scripted replies set every token count and cost.

These events are the session's only record.

## What it tells

Chapter 1 is issue #42. The scout writes a file outside its `writes:`, which
is rolled back and fails the chapter; `asf resume` scouts again. The plan
stops at the plan gate, where a person rejects it with a remark and approves
the second one with another. The approval resumes the session, and the
session's cost ceiling refuses the builder's first turn, a limit hit that
fails the chapter again. With the ceiling raised, `asf resume` builds, and the
review, documentation and pull request follow; the gates hitl leaves off pass
by policy. Chapters 2 and 3 are two rounds of review on that pull request.
Every time a chapter ends it is scored: the issue's by the four scorers a
stamp ships, which find the rollback and the limit hit, and each review
round by a team's `review_chapters_above(1)`, which the second one fails.
Transcripts are on, so the prompts each agent was sent are in the stream.

## What was changed

Only the machine: the repository's path reads `/work/widgets`, the Python interpreter
`python`, and the station's name was set (`ASF_STATION_NAME`) rather than this
machine's. Nothing else was edited, and the recording never is.

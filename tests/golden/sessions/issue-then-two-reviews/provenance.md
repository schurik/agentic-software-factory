---
recording: issue-then-two-reviews
recorded_on: '2026-09-30'
recorder: tests/test_asf_golden_sessions.py
tree: 1dda423
release: 1.0.0
harness: fake
trace_db: true
---
# issue-then-two-reviews

Recorded on 2026-09-30 by `tests/test_asf_golden_sessions.py`, run with
`ASF_RECORD_SESSIONS=1` on top of `1dda423` — agentic-sf 1.0.0 — on the
`fake` harness, whose scripted replies set every token count and cost.

The factory still kept its trace db (`asf/data/asf.db`) beside these events, and the
session was in it: recorded under the old factory, it is a session the legacy
visualizer could show.

## What it tells

Chapter 1 is issue #42: scouted, planned, and stopped at the plan gate,
where a person rejects the plan with a remark and approves the second one
with another. The approval resumes the session — the scout and the planner
are replayed from the record, not called again — and the build, review,
documentation and pull request follow; the gates hitl leaves off pass by
policy. Chapters 2 and 3 are two rounds of review on that pull request.
Transcripts are on, so the prompts each agent was sent are in the stream.

## What was changed

Only the machine: the repository's path reads `/work/widgets`, the Python interpreter
`python`, and the station's name was set (`ASF_STATION_NAME`) rather than this
machine's. Nothing else was edited, and the recording never is.

This note was written on 2026-10-02, for the visualizer-parity test (#65), after the
recording was checked in with `189be2a`; its facts are that commit's, and the recording was
not touched.

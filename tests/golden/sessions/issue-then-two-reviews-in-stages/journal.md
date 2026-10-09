## This run so far

The factory wrote this as the run went. Each numbered line is a phase that closed;
the marked lines under one are what came out of it. Nothing here is a plan — it is
what already happened, and it is later than the plan.

⚑ is a note an agent filed on work that was then accepted: a `deviation`,
a `discovery` or a `risk`. It is a REPORT. Judge it like any other claim, and say
so if the reason does not hold. But a deviation is a departure somebody already
made, with the reason they made it — the plan is the thing that is out of date, so
do not report the departure itself as unrequested work, and do not ask for it to be
undone because no plan mentions it.

✎ is something a PERSON typed at a gate or a question round. It is not a
report, it is an INSTRUCTION: it amends the request, it is later than the request
and the plan both, and where they disagree it wins. Work it asks for is in scope
even where no plan mentions it, and an agent that already acted on one did what it
was told — that work is not yours to take back out.

1. issue · tracker · success — url: https://forge/acme/widgets/issues/42, title: Resolve relative due dates via the meeting date, author: schurik, labels: asf:queued, asf:ship, body: /work/widgets/asf/data/sessions/a9f259f0/context_handoff/issue.md
2. scout · scout · success — the prompt is built in app.py; no date reaches it
3. plan · planner · success — a required meeting date, and a test for its format
   ⚑ risk (planner, in plan): the date is local midnight
     because: converted in UTC it is the previous day
4. approve_plan · asf tests · success
   ✎ asf tests said, reject at the plan gate (round 1): name the module the date is converted in
5. plan_revise_1 · planner · success — the plan now names the module
6. approve_plan_2 · asf tests · success
   ✎ asf tests said, approve at the plan gate (round 2): keep the prompt in English
7. commit_plan · git · success — sha: a189a3c, message: docs: plan the meeting date, pushed: False, notes: 
   ⚑ deviation (builder, in implement): kept the summary helpers
     instead of: reworking every prompt
     because: only the action items need a date
10. review_1 · reviewer · success — approved: R1 and R2 are met
12. changes · git · success — base: 2029981 @ 2029981, reason: HEAD is ahead of 2029981 — diffing every commit since, plus the working tree, files: 2, lines: +7 -0, diff: /work/widgets/asf/data/sessions/a9f259f0/context_handoff/changes.diff
13. document · documenter · success — documented the meeting date
14. commit_document · git · success — sha: 5d47344, message: docs: the meeting date, pushed: False, notes: 
15. integrate · git · success — mode: pr, landed: True, merged_into: , pushed: True, pr_url: https://forge/acme/widgets/pull/9, notes: pushed asf/a9f259f0 to origin · opened a pull request: https://forge/acme/widgets/pull/9
22. pr · review · success — url: https://forge/acme/widgets/pull/9, branch: asf/a9f259f0, base: main, decision: none, threads: 1 open of 1, feedback: /work/widgets/asf/data/sessions/a9f259f0/context_handoff/pr_review.md
23. implement · builder · success — addressed: use that format two lines below too
24. verify_1 · quality · success — passed: True, checks: 1/1, artifacts: /work/widgets/asf/data/sessions/a9f259f0/context_handoff/quality/24_test/command.log
25. commit_implement · git · success — sha: b938966, message: fix: one date format throughout, pushed: True, notes: pushed b938966 to origin/asf/a9f259f0, updating https://forge/acme/widgets/pull/9
26. report · review · success — outcome: addressed, threads: 1, replied: 1, resolved: 1, notes: commented on #9

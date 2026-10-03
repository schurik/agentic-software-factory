# PROTOTYPE — cockpit redesign (throwaway)

Not the cockpit. A clickable, static mock of the redesigned cockpit's **Now** page and **session
page**. It lets the visual direction and the stage graph be judged by eye before `/to-spec`. It
lives only on the `prototype/cockpit-redesign` branch and never merges to `main`. The real build
is a rewrite inside `apps/cockpit`.

```bash
cd apps/cockpit-prototype && bun install && bun run dev    # http://localhost:3100
```

No Convex, no forge, no persistence. All data is in `lib/data.ts`, hand-derived from
`tests/golden/sessions/issue-then-two-reviews/` and varied into 8 sessions. Phases are mapped to
stages **by hand**, because today's events don't carry a stage index. Answering a gate only
updates in-memory state and shows a toast. Nothing is sent.

## The question

Three variants of the **stage graph** sit on one route, switched with `?variant=A|B|C`, the
floating bar at the bottom, or the ← → keys. The variant changes the full graph on the session page
and the one-row mini graph on Now. Everything else is the IA the grilling session settled.

| key | name   | shape |
|-----|--------|-------|
| A   | Cards  | stages are cards on a chain, and phases are sub-nodes stacked inside the card |
| B   | Rail   | a metro line: stages are stations, and phases hang below as beads |
| C   | Ribbon | one bar where each stage is a segment sized by time, phases are slices, and expanded stages are listed below |

All three use the same rule: a stage is expanded when it is current, failed, or had a rejected gate,
and shows a count otherwise (click to expand). Earlier chapters collapse to one line.

## Where to look

| what | URL |
|------|-----|
| Now: Inbox → Needs attention → Running → Waiting on others | `/` (`j`/`k`, `Enter`, then `a`/`r` in the drawer) |
| the recorded 3-chapter session, plan rejected once | `/sessions/a9f259f0` (expand chapter 1) |
| waiting on you at round 2 | `/sessions/c41e7b02` |
| running | `/sessions/7d2f90aa`, `/sessions/3b8e11d0` (chapter 2) |
| failed in verify, after a fix | `/sessions/e5b3a118` |
| waiting on someone else | `/sessions/0f9a6c3d` |

Check each at 1440 and 375, in light and dark (the header toggle is system / light / dark and is
remembered).

## What building it already showed

- **A (Cards)** doesn't fit the 10-stage `issue` workflow on one row at 1440 once a stage is
  expanded. Wrapping left a hole under the expanded card, so the chain now scrolls sideways:
  the edges fade where stages are hidden, an arrow scrolls, and the current stage is scrolled
  into view. On a phone it is a vertical list.
- **B (Rail)** always fits, because stage columns are equal width. With the 3-stage `pr-review`
  workflow those columns are very wide. Beads have to overflow their column to stay readable.
- **C (Ribbon)** is the only one that shows *where time went*: a 36-minute wait at a gate dominates
  the bar, which is honest but squashes stages still to come, so weights are clamped. Its phase
  list lives below the bar rather than in it.
- The mini graphs differ the most on Now. C's thin bar is the quietest, and A's chips are the
  most legible.
- The drawer (Base UI Drawer) holds both jobs: answering a gate shows the plan, earlier rounds, a
  note and Approve/Reject; a phase shows the existing tab set. On a phone it becomes a bottom sheet.
- A gate is a phase of a stage (`approve_plan` belongs to `plan`). Drawn as a sub-node with a
  diamond, it needs no vocabulary of its own.

## Feedback so far (2026-10-03)

**A (Cards) is preferred.** Folded in on this branch:

- Now: all four lists use one row grid (status icon · title + detail lines · factory above
  when/next on the right), so their icons and text line up. Needs attention lost its
  per-factory column to that right-hand meta, Running gained an icon, and Waiting on others
  has a title that lines up with the others and a Show/Hide on the right.
- Sessions: status is a coloured dot in an untitled first column, with the word on hover. The
  Status column is gone, Cost and Started are narrow, and Session and Where take the room.
- Session page: the Cards chain scrolls sideways instead of wrapping.
- Session page tabs: **Details · Timeline · Journal**, with Details open first.

### Round 2

- **Running** puts the current stage's icon in the icon column, with one icon per stage of the
  closed vocabulary (scout, plan, commit, implement, verify, review, document, integrate). The
  mini graph keeps the only spinner, and the "who is on what" sentence is gone.
- **The gate drawer** is a dialog now. Its 56px header lines up with the page header, the body
  scrolls, and the footer is fixed: notes, then Reject and the primary action (blue, not green),
  with Abort at the far left. Session, station and spend are gone from it; they aren't decision
  material and are one click away on the session. What it shows depends on the gate
  (`GateKind` in `lib/data.ts`):
  - **plan, round 1:** the plan · the issue in the reporter's words · the scout's findings
  - **plan, round 2+:** *changes since the rejected round* first, under the person's own note
    from that round, then the plan, the issue and the findings
  - **integrate:** the branch's diff · checks · the reviewer's verdict · the issue

  At every gate the agents' ⚑ flags sit above the tabs, because a flagged risk is decision
  material.
- **Forge things carry their icon and state colour:** issue (open green, closed purple), pull
  request (open green, merged purple, closed red, draft grey), branch and commit. Each one links
  to the forge: in the session header and Details, gate headers, timeline commits, and the
  sessions table. Inside a row that is already a link they are shown, not linked.
- **Diffs** come from jsdiff and are drawn here, unified or split, with line numbers and the
  changed words marked. Prose files wrap and code keeps its columns. They appear at the gates,
  in a **Diff** tab on a commit phase, and in a **Changes** tab on the session (the branch
  against its base). In the real build the before and after come from the forge at two shas.
- **Markdown** goes through react-markdown + GFM + hard breaks: plans, issues, findings,
  reviews, artifacts and the Journal. The recorded session's Journal is its real `journal.md`.
  Building it found that a stock renderer **renumbers** journal.py's list (seqs 7, 10, 12 came out
  as 7, 8, 9), so the Journal draws its own numbers and renders markdown inside each entry.

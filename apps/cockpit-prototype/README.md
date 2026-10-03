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
- **Now:** Needs attention, Running and Waiting on others all fold behind the same Show/Hide.
  The first two start open and Waiting on others starts closed. Inbox never folds.

### Round 3: the review's findings

**Bugs**
- **Now card:** the button is named for the gate ("Review the plan / the changes and answer"), and a failed session links its latest failure (verify #2).
- **Away station:** Resume becomes "Queue resume", with a line saying it runs when the station is back.
- **Graph overflow:** the chain gets gutters for its arrows only when it overflows, and its scrollbar is hidden.
- **Phone gate footer:** it stacks, primary first.

**Header**
- **Layout:** it is flat, and the active place is underlined on the header's own rule. Now's content starts under the logo (x=104 on every page).
- **Mode:** "local" sits under "cockpit" in a local cockpit; a team cockpit shows nothing there.
- **Now count:** the Now item carries the amber count of gates waiting on you.
- **Avatar menu:** Run a prompt plus an avatar menu (who you are, the mode, the theme) replace three controls, on phones too.

**Now**
- **Order:** no subtitle; Inbox, then Needs attention, Running and Waiting on others.
- **Icons:** Inbox and Waiting on others show the gate's stage icon in amber, Running shows the current stage's icon in blue, and Needs attention keeps status marks.
- **Needs attention:** every row opens its target.
- **Running:** says "17m in verify" when a phase has run over 10 minutes, and shows "$0.21 of $0.25" when spend passes 80% of the ceiling. Nothing is shown otherwise.
- **Folding:** a folded section is only its title. The chevron hangs in the gutter, so section titles keep one left edge.

**Session page**
- **Gate button:** the Now card holds it, and the header no longer has one.
- **Details:** keeps only what is shown nowhere else.
- **Purge:** moved to a ⋯ menu, alongside copying the session id.
- **Numbers:** no chapter count on the Now card. Durations drop seconds past 10 minutes.
- **Status:** the chapter in progress has no second status mark.
- **Phone order:** the Now card comes first.

**Drawers**
- **Top bar:** one pattern, icon and name, for gate, stage and phase.
- **Waiting gate phase:** opens as its gate.
- **Phase tabs:** only tabs with content; cost moves into the header line.
- **Names:** every phase name is humanised (plan revision 1, verify #2, commit code). Raw names stay in the Events tab and the journal.
- **Viewer:** shown as "you" everywhere.
- **Stage config:** the line is gone.

**Colour:** every text token clears AA on both backgrounds:
- `--faint` is `#6b6b74` in light and `#86868f` in dark.
- The dark primary uses `--accent-strong` (`#3a64d8`).
- Amber is `#925500`.
- The page background is `#f4f4f5`, so white cards stand off it.
- Badges on amber or red use dark text in dark mode.
- The rule for the one extra hue (merged purple) is in `globals.css`.

**Consistency**
- A chevron on the left for chapters and diff files. Now's sections went back to Show/Hide on the right (round 4).
- The pill / dot / icon rule is written in `ui.tsx`.
- Refs carry their icon everywhere.
- The run dialog uses Base UI Selects, can't run an empty prompt, and has a close button.
- Only refs and shas are mono.
- Key hints hide on touch screens.

Left out on purpose: the Needs-attention warning triangle (the Inbox's gate icons were chosen instead) and the S items.

### Round 4

- **Now:** sections fold behind Show/Hide on the right again; the leading chevron didn't look right.
- **Header:** the Now count is a small badge in the icons' amber tint, with the number centred. The active place is underlined in the accent.
- **Session Now card:** a cost gauge, accent below 80%, amber from 80%, red at the ceiling.
- **⋯ menu:** purge's note is shortened to two lines.
- **Chapters:** each one is a Base UI Collapsible. The header keeps one size open or closed, so nothing jumps. The panel animates its height and fades in, and the small graph in the header fades out as the big one arrives, then back on close.

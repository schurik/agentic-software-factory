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

*(Rounds 1–7: which **stage graph**: Cards, Rail or Ribbon. Cards won, and Rail and Ribbon are
in this branch's history. Since round 8 the switch compares **contrast treatments** of the Cards
graph instead; see "Round 8".)*

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
- **Now sections:** they fold the same way as chapters (Base UI Collapsible). The title row keeps one size, the gap under it folds away with the list, and the panel animates its height and opacity.

### Round 5: Factories

Not in the first rounds; prototyped before the spec. Shown at `/factories` and `/factories/<owner>/<repo>`, with sample data in `lib/factories.ts` that follows today's cockpit and the self-description fixture.

- **Factories list:** drawn with Now's rows. A factory that needs attention comes first, then the most recently active. Each row has:
  - what needs you (gates on you, a failing check, other attention)
  - what's moving (running, stations online, workflows)
  - spend this month, and the last activity
- **Factory page:**
  - **Header:** the name (with a forge link), the check status, the default branch at its sha, stations online, and the per-session budget. **Run a prompt** opens with this factory chosen.
  - **Tabs:** **Overview · Workflows · Stations · Config**, kept in the URL (`?tab=`), so Now's attention rows land on the tab that answers them. A dot on a tab flags something there: a broken workflow, a drifted station, a failing check. **All sessions →** links to `/sessions?factory=…`.
- **Overview:**
  - waiting on you (gate rows, which open the gate drawer)
  - needs attention
  - running (no factory column; it's the page's own)
  - **Spend** for this month or the last 30 days: the total, then bars by workflow, by station ("whose key paid") and by person ("who started it"). This replaces the old top-level Cost page and the factory Cost tab.
  - recent sessions
- **Workflows:**
  - **Broken workflows:** listed first, with `asf check`'s error.
  - **Each workflow:** its input kind, what it does, what starts it, and its shape drawn with the **session page's stage graph**, so a workflow and a run of it read alike. Each stage shows its icon, the agents bound to it, and whether its gate asks a person or passes by policy.
  - **Agents:** a collapsible agent table (model and effort, tools, writes).
  - **Run:** prompt workflows get a **Run** button with the workflow chosen.
- **Stations:** a table with a state dot (online / away / never polled), whose machine it is (or CI and its jobs), last seen, claims held, and the config sha it runs, either the same as main or drifted (with what differs). This replaces the old top-level Stations page.
- **Config:**
  - **`asf check`:** its status on the default branch, with each workflow ✓/✗.
  - **Settings from `asf/factory.yaml`:** per-session budget and tokens, gates that ask a person, transcripts and their retention, with a link to the file.
  - **Drift:** a pointer to Stations.
  - **Retention:** the purge log.

### Round 6: the factory Overview is about the factory

- **Overview** shows only what no other page shows. Waits, attention, running and recent sessions are gone; they are Now's and Sessions'. In their place, for a chosen period (last 7 / 30 days, one filter row above everything it filters):
  - **Spend:**
    - the total with tokens, per day, and per session
    - a **daily spend column chart**: one series so no legend, 24px-capped columns, a hairline grid at clean values, and a tooltip per day
    - spend by station ("whose key paid") and by person ("who started it")
  - **Outcomes:** sessions (done · failed · open), the share that finished well, median time to finish, and the median wait at gates (rounds, and how many were rejected).
  - **By workflow:** sessions, how they finished, median time, spend with a bar, and the last run. This is what a factory's owner tunes.
- **Run a prompt:** one dialog, owned by the app header, which **preselects the factory in context**: a factory page, a session's factory, or the sessions list filtered to one. The factory page's own button is gone. A workflow's **Run** opens the same dialog with that workflow chosen. The workflow list follows the chosen factory's prompt workflows.

### Round 7: Workflows, Stations and Config rethought from the data that exists

**What exists** (checked against the code):
- **Self-description** (`asf check --json`), per workflow:
  - description, input, trigger (labels + whether a station loop watches)
  - stages (kind, agents, gate)
  - agents (harness, model, thinking, purpose, tools, writes)
  - gates on/off, warnings
- **A station's report on every poll:** watchers it runs, commands it obeys, its checkout's head and config hash. Plus `seenAt`, claims, queued commands, and pending registrations.
- **From the events:** a station's release (`skill_version`), the sessions it ran, and the spend through its key.
- **`factory.yaml`:** budget, hitl, cockpit, worktree/integration, issues, pull_requests.
- **The forge:** the cockpit speaks only GitHub, through the App or the person's `gh` token. The factory reaches the tracker through configurable `gh` commands.
- **Config editing exists today** (spec #40/#58): someone with write access edits `asf/` as text, and the cockpit proposes a pull request in their name.

**Workflows:**
- **Header:** the trigger labels, and how many online stations watch for it (amber when none do).
- **Record:** the last 30 days (sessions, done/failed, median time, spend) with a link to sessions.
- **Warnings:** `asf check` warnings sit on the workflow they belong to.
- **Graph:** annotated per stage with median time and cost, the **slowest stage**, **failures**, and, on gates that ask a person, rejections and median wait.
- **Agent table:** harness, model and thinking, tools, and the **writes boundary** (with the rollback rule stated).

**Stations:**
- **Registrations:** pending ones on top. Approve only when the code matches what its terminal shows.
- **One card per station:**
  - online/away/never, and whose it is
  - what it **watches** and what **commands it takes**
  - the **release** it runs (behind main's, in amber), its checkout commit, config same/drifted (with what differs)
  - running now and claims held
  - last 30 days (sessions, failed, spend on its key)
  - **commands waiting for it** with their expiry
  - Revoke

**Config:**
- **Top:** "Edit config" opens an editor of the files under `asf/` with a live diff, a pull-request title and the branch it will use (`cockpit/<login>/<slug>`). It proposes the PR in your name. Open proposals are listed.
- **Grouped by what each part decides:**
  - **Check:** per workflow ✓ / warning / ✗.
  - **Forge and tracker:** GitHub · github.com, how this cockpit reaches it, GitHub Issues of the project through `gh`, which workflow answers reviews.
  - **Where work comes from:** label → workflow routes, the queued label, trusted authors, concurrency, review behaviour, ignored bots, prompt workflows.
  - **People at gates:** which gates ask a person, the attended wait then suspend, unattended behaviour, rounds, notify.
  - **How work lands:** PR or merge, branches, base, worktrees.
  - **Limits and data:** budget, transcripts, which commands the cockpit may send, drift, purges.
- **Not shown:** the raw `gh` command arrays. They only name the tracker, and the editor still has them.

### Round 8: the Cards graph's contrast

The graph was hard to read: white cards on a white chapter card, with finished stages bordered in
`--line` (about 1.3:1 against white). Finished stages are the most common kind, so most of the
graph nearly vanished. The `?variant=` switch (bottom bar, ← →) now compares four treatments of
the Cards graph, on session chapters, Now's mini graphs and the Workflows tab, in both themes:

| key | name | how it gets contrast |
|---|---|---|
| A | **Well** | the chain sits on a tinted canvas (page background in dark), white cards with a real border and a shadow |
| B | **Tint** | each card filled with its status' tint: done green, running blue, waiting amber, failed red. Connectors are coloured by progress |
| C | **Edge** | white cards, a stronger border and a 3px status-coloured top edge. Connectors carry arrowheads |
| D | **Ink** | finished stages outlined in ink. The current stage gets a solid status header (NOW stays on top), with its phases on white below |

Not-yet stages stay dashed and quiet in every treatment: they are the least important part of
the graph.

Two blends followed, "more C than B":

| key | name | what it takes from each |
|---|---|---|
| E | **Edge + progress** | C's white cards, stronger border and status top edge, plus B's progress-coloured connectors (green up to the current stage) and a status-tinted title row. The body stays white |
| F | **Edge + wash** | E's connectors, plus a light status wash over the whole card (5% in light, about 10% in dark), about half of B's tint |
- **Workflows tab:** a workflow's stages have no status, so their cards get a **neutral tint**: the text colour mixed into the surface at 3% in light and 8% in dark, where the surfaces sit close together. Dark also gets a visible border. The tab's connectors and end pills are neutral ink, because a static workflow has no progress to colour.

### Round 9: one look

- **F (Edge + wash) is the look.** A–E and the variant switcher are gone; they are in this branch's history. The stage graph:
  - white cards with a stronger border and a 3px status-coloured top edge
  - a light status wash over each card (5% in light, about 10% in dark)
  - connectors in green up to the current stage, with arrowheads
  - on the Workflows tab: neutral tinted cards and neutral connectors

  `?variant=` no longer does anything.
- **The header stands up from the page.** It is the card surface (white in light, the raised grey in dark) over the page's grey, with a hairline and a soft shadow (a darker rule in dark). The active place keeps its accent underline.

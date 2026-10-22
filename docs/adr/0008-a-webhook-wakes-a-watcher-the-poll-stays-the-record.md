# A webhook wakes a watcher through the cockpit; the poll stays the record

_Status: proposed, in [#245](https://github.com/schurik/agentic-software-factory/issues/245)._

A station's watchers poll the forge on a fixed interval: `issues`, `answers` and `prs` each list
their queue every 120 seconds (`asf up --interval`). So a label, a reply or a review waits up to two
minutes before anything happens, and every idle pass spends forge rate limit on an empty answer. A
station cannot receive a GitHub webhook itself: it is a laptop behind NAT, or a CI job, and GitHub
refuses to deliver to an address it cannot reach.

A shared cockpit can receive them. Its GitHub App already registers a webhook at `/forge/webhook` and
subscribes to `issues`, `issue_comment`, `pull_request` and `pull_request_review`, but
`model/webhook.ts` acts only on `push`, `installation` and `repository` and drops the rest. Each
station also already opens a channel to the cockpit: its station loop polls `/commands` every 2.5
seconds. That outbound poll is a way back to the station that needs no inbound port.

So a delivery about a work item becomes a **nudge**: the cockpit records `(repository, kind,
number)` against the factory, hands it to that factory's online stations in the answer to their next
command poll, and the station loop wakes the matching watcher, which looks at that item now instead
of at its next interval. The watcher then does exactly what a poll would have done: it reads the
item from the forge, checks the route label and `trusted_authors`, and asks for a claim (ADR 0003).
When every station gets the same nudge, the claim lets only one of them start.

A nudge is a hint, never the record, for the reason `model/webhook.ts` already gives: GitHub sends a
delivery once and does not retry. So the poll stays. It only runs less often while the station knows
its cockpit receives webhooks, and it remains the only mechanism wherever no webhook arrives.

## Considered options

- **Deliver webhooks to the station directly**, through a tunnel (smee.io, `gh webhook forward`,
  cloudflared). Rejected because each station would need its own tunnel and secret, a sleeping laptop
  loses deliveries that nothing replays, and a CI station has no address at all. It also bypasses
  the cockpit, which already holds the App and its webhook secret.
- **Make a nudge a command.** Rejected. A command (`engine/commands.py`) is steering a person asked
  for: it names a session, its verb is opted in by `cockpit.commands`, and its `by` is held to
  `trusted_authors`. A nudge authorizes nothing and names no session. It only moves a read forward,
  so it needs no opt-in, and it must not be counted as one.
- **Let the cockpit start the session.** Rejected because a cockpit never runs a factory's agents
  (`CONTEXT.md`, Cockpit), and a factory has to work without one.
- **Long-poll `/commands`** so a nudge arrives without waiting for the next 2.5 s poll. Not needed:
  2.5 s is already well below what a person notices on a tracker. It can be added later without
  changing anything here.
- **Drop the poll once webhooks arrive.** Rejected because one lost delivery would leave an item
  queued until something else moved. The catch-up poll in `discovery.ts` exists for the same
  reason.

## Consequences

- **Nothing changes without a deliverable shared cockpit.** Local mode, a cockpit GitHub cannot
  reach (`deliverable()` is false), no cockpit, and a CI station (which takes no commands) all keep
  the interval they have today.
- **The poll interval becomes two numbers**: the fallback interval while nudges are live, and today's
  interval otherwise. The station learns which applies from the answer to its command poll, which
  says whether the cockpit has a webhook secret and when the last delivery arrived. The station
  never decides it from its own configuration alone.
- **The station loop signals its children.** `asf up` owns the watcher processes (`supervise.py`),
  so a nudge reaches a watcher as a wake from its parent. `_loop`'s `time.sleep(interval)` becomes an
  interruptible wait. A watcher started on its own (`asf issues loop`) has no parent loop, so it
  keeps polling.
- **The answer to a poll is a contract.** A nudge in the `/commands` answer is a new field that an
  older station ignores. `templates/asf/cockpit/min-version` does not move for it.
- **A nudge is not a domain event.** It never enters a session's record. The session the watcher
  starts or resumes is recorded as it is today.
- **"Nudge" enters `CONTEXT.md`** once this is accepted, next to Command, with "command" and
  "trigger" as the words to avoid for it.

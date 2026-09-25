# The cockpit replaces the visualizer, and lives outside the skill

The per-repo visualizer (`skills/agentic-sf/apps/visualizer`) is a poll-only reader of one repo's
trace db; a team steering many factories needs push ingest, forge identity and a cross-repo inbox,
which that shape cannot grow into. So the cockpit is rebuilt from the ground up — its stack is not
inherited — and it also ships a local single-user mode, which is what keeps a factory fully usable
without a *shared* cockpit. The visualizer is legacy and is deleted once the cockpit covers it.

The cockpit's code lives in a top-level `apps/cockpit/` of this repo, not under `skills/agentic-sf/`:
everything in the skill directory ships to every skill user, and a server they did not ask for does
not belong in a stamp. It stays in this repo rather than its own while the station ↔ cockpit protocol
is still moving, so one pull request can change both ends. The stack itself is recorded in ADR 0002.

## Considered Options

- **Evolve the visualizer to read from either the local db or a cockpit** — rejected: it keeps the
  poll-a-sqlite-file model at the centre of a system whose data now arrives by push.
- **Stamp the cockpit with the factory** — rejected: one copy per repo is the opposite of a cockpit.
- **A separate repository** — deferred, not rejected: worth it once the protocol is stable.

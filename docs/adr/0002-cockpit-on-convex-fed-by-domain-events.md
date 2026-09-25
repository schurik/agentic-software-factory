# The cockpit runs on self-hosted Convex, fed by domain events rather than files

The cockpit is a Next.js front end on a self-hosted Convex backend, in both the team deployment and
the local mode that `asf up` starts. What the inbox needs most is reactivity, and Convex's reactive
queries give it without SSE or client polling. Stations do not ship the session directory. They
ship **typed domain events** that the factory emits at `Tracer.event`, one per Convex document and
versioned per event kind, over plain HTTP. So a stamped factory never depends on the cockpit's
database vendor, and the wire is a deliberate contract, not whatever the files happen to hold. The
session directory stays the factory's working state, and a projection test keeps the two in step.

## Considered Options

- **Python + htmx + SQLite, shipping files verbatim**: one language with the factory, but weaker
  live paths. With files as the wire, the cockpit would have to reassemble append-only files and
  diff snapshots of rewritten ones.
- **Next.js on Vercel**: serverless has no persistent disk, and it fights the long-lived paths.
- **Full event sourcing in the factory**, deriving `run.json` and friends from the log: deferred,
  not rejected. The projection test covers the gap until then.

## Consequences

Gate subjects are not shipped. They are read from GitHub at the exact commit the question was asked
about, which is why the factory now pushes a work branch when it is created and why
`integration: none` is gone.
